"""
모니터링 기준 생성 (1회성, 로컬 실행)

1. v4 학습 때 쓴 2단계 보정기 재현 : 2025 학습셋 1단계 OOF(RF 300, 5-fold, seed 42) -> GammaBetaCalibrator
   (stuff_pipeline_261010_vaa3.ipynb cell 1 과 같은 절차. 당시 보정기는 저장되지 않았다)
   -> 2025 검증 구간 y3 를 v4 학습 캐시(outputs/vaa_exp/cache/frame_2025.parquet)와 대조, 다르면 중단
2. monitoring/stage12/ : stage1_hit_rf.joblib(복사) + stage2_calib.joblib
3. monitoring/v4_ref.json : 14개 피처 기준 분포(2025 학습 기간, 점수 대상 투구), 2025 검증 구간 성능 + bootstrap CI

실행 : python build_monitor_ref.py            (기준 생성)
       python build_monitor_ref.py --upload   (stage12 를 온라인 저장소 HF models/stage12/ 에 업로드)
"""
import argparse
import os
import shutil
import time

import joblib
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedKFold, cross_val_predict

import mlops_common as mc
import stuff_pipeline as sp

T0 = time.time()
log = lambda *a: print(f'[{time.time() - T0:5.0f}s]', *a, flush=True)
CACHE = os.path.join('outputs', 'vaa_exp', 'cache', 'frame_2025.parquet')
KEY = ['pitcher', 'game_date', 'description']


def rebuild_calibrator(train_df, rf):
    X1, y1 = sp.build_hit_dataset(train_df)
    P = cross_val_predict(RandomForestClassifier(n_estimators=300, n_jobs=-1, random_state=sp.SEED, max_depth=rf.max_depth,
                                                 min_samples_leaf=rf.min_samples_leaf),
                          X1, y1, cv=StratifiedKFold(5, shuffle=True, random_state=sp.SEED), method='predict_proba')
    return sp.GammaBetaCalibrator().fit(sp.expected_value(P))


def check_y3(d_va, rf, calib):
    """검증 구간 y3 : 재현값 vs v4 학습 캐시 (같은 투구 순서 -> 투구 단위 정렬 키로 대조)"""
    cache = pd.read_parquet(CACHE, columns=['split', 'y3', 'pitcher', 'release_speed'])
    cache = cache[(cache['split'] == 'va') & cache['y3'].notna()]
    mine = mc.add_y3(d_va.copy(), rf, calib)
    mine = mine[mine['y3'].notna()]
    # 캐시와 같은 load_regular_season index (reset_index 후 행 번호) -> index 로 대조, 투수·구속으로 정렬 확인
    m = mine[['y3', 'pitcher', 'release_speed']].join(cache, how='inner', rsuffix='_ref')
    assert (m['pitcher'] == m['pitcher_ref']).all(), 'index 정렬 불일치'
    err = (m['y3'] - m['y3_ref']).abs()
    log(f'y3 재현 : 재현 {len(mine):,} / 캐시 {len(cache):,} / 매칭 {len(m):,}, 최대 오차 {err.max():.2e}, 평균 {err.mean():.2e}')
    return err.max(), len(m), len(mine), len(cache)


def recover_calibrator(d_va, rf, init):
    """v4 학습 캐시의 검증 구간 y3 = BetaPPF(GammaCDF(E)) 에서 (gamma_a, gamma_scale, beta_a, beta_b) 를 최소제곱으로 복원"""
    from scipy.optimize import least_squares
    cache = pd.read_parquet(CACHE, columns=['split', 'y3'])
    X, _ = sp.build_hit_dataset(d_va)
    y = cache['y3'].reindex(X.index)
    ok = y.notna().to_numpy() & (y > 0).to_numpy()
    E = sp.expected_value(rf.predict_proba(X))[ok]
    y = y.to_numpy()[ok]
    c = sp.GammaBetaCalibrator()

    def resid(th):
        c.gamma_a, c.gamma_scale, c.beta_a, c.beta_b = th
        return c.transform(E) - y

    th0 = [init.gamma_a, init.gamma_scale, init.beta_a, init.beta_b]
    r = least_squares(resid, th0, x_scale='jac', xtol=1e-15, ftol=1e-15, gtol=1e-15, max_nfev=2000)
    resid(r.x)
    return c


def main(upload=False):
    if upload:
        import data_store
        files = [(os.path.join(mc.STAGE12_DIR, f), f'models/stage12/{f}') for f in mc.STAGE12_FILES.values()]
        data_store.store().upload(files, 'v4 모니터링 : 1·2단계 아티팩트 (stage12)')
        log('업로드 완료', [r for _, r in files])
        return

    model, scaler = mc.load_v4()
    rf = joblib.load(os.path.join('models', 'stage1_hit_rf.joblib'))
    df = sp.load_regular_season('games_25_final.pkl', 2025)
    train_df, valid_df, valid_start = sp.split_last_month(df, months=1)
    log(f'2025 정규시즌 {len(df):,}구, 검증 시작 {valid_start.date()}')

    calib = rebuild_calibrator(train_df, rf)
    log('보정기', calib)
    d = mc.score_frame(df, model, scaler)
    is_va = d['game_date'] >= valid_start
    err, n_match, n_mine, n_cache = check_y3(d[is_va], rf, calib)
    if err >= 1e-9:
        # OOF 재적합은 RF 병렬·sklearn 버전 차이로 미세하게 달라진다 -> 보정기 4개 모수를 캐시 y3 에서 직접 복원
        calib = recover_calibrator(d[is_va], rf, calib)
        log('복원 보정기', calib)
        err, n_match, n_mine, n_cache = check_y3(d[is_va], rf, calib)
    if not (err < 1e-9 and n_match == n_mine == n_cache):
        raise SystemExit(f'y3 재현 실패 (최대 오차 {err:.2e}, 매칭 {n_match}/{n_mine}/{n_cache}) -> 기준 저장 중단')

    os.makedirs(mc.STAGE12_DIR, exist_ok=True)
    shutil.copy(os.path.join('models', 'stage1_hit_rf.joblib'), os.path.join(mc.STAGE12_DIR, mc.STAGE12_FILES['rf']))
    joblib.dump(calib, os.path.join(mc.STAGE12_DIR, mc.STAGE12_FILES['calib']))

    # 기준 분포 : 2025 학습 기간의 점수 대상 투구 (스케일러 적합 표본과 같은 범위)
    scored = d['stuff'].notna()
    X = mc.model_features(d[~is_va & scored], model)
    ref_dist = mc.psi_ref(X)

    # 기준 성능 : 2025 검증 구간
    va = mc.add_y3(d[is_va].copy(), rf, calib)
    g = mc.group_table(va)
    gm = mc.group_metrics(g, mc.boot_index(g.index.get_level_values('pitcher')))
    r, n = mc.rmse(va)
    tr_s = d.loc[~is_va, 'stuff']
    ref = {
        'model': 'v4',
        'trainPeriod': [str(df['game_date'].min().date()), str((valid_start - pd.Timedelta(days=1)).date())],
        'validPeriod': [str(valid_start.date()), str(df['game_date'].max().date())],
        'trainPitches': int(scored[~is_va].sum()),
        'features': list(X.columns),
        'calibrator': {k: float(getattr(calib, k)) for k in ('gamma_a', 'gamma_scale', 'beta_a', 'beta_b')},
        'baseline': {**{k: (mc.finite(v) if not isinstance(v, list) else [mc.finite(x) for x in v]) for k, v in gm.items()},
                     'rmse': mc.finite(r), 'rmseN': n,
                     'stuffMean': mc.finite(tr_s.mean(), 3), 'share60': mc.finite((tr_s >= 60).mean(), 4)},
        'dist': ref_dist,
    }
    mc.dump_json(ref, mc.REF_PATH)
    log('기준 성능 (2025 검증 구간)', ref['baseline'])
    log('저장', mc.REF_PATH, mc.STAGE12_DIR)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--upload', action='store_true')
    main(**vars(ap.parse_args()))
