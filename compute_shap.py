"""
정확한 SHAP(TreeSHAP) 기여도 계산 — 웹 '구위 산출 근거' 용 캐시

export_web_data.py 는 이 캐시(outputs/v2/shap/shap_{season}.npz)가 있으면 정확한 SHAP 을,
없으면 Saabas(경로 기반) 기여를 쓴다. 투구 213만 개 기준 약 9시간(16스레드)이 걸리므로
청크 단위로 저장하고, 중단되면 이어서 계산한다.

실행 : python compute_shap.py            (전체 시즌 : 정규시즌 + 시범·포스트시즌)
       python compute_shap.py 2026       (특정 시즌)
       python compute_shap.py --extra    (시범·포스트시즌만 -> shap_{season}_extra.npz)
끝나면 : python export_web_data.py -> web/ 에서 재배포
"""
import os
import sys
import time

import joblib
import numpy as np
import pandas as pd

import stuff_pipeline as sp
import export_web_data as ew

CHUNK = 20000


def season_frame(season, path, model):
    """export_web_data.score_season 과 같은 행·같은 피처 (구종 범주 정렬 포함)"""
    raw = sp.load_regular_season(path, year=season)
    d = sp.add_stuff_features(raw)
    for col, cats in zip(sp.STUFF_CAT_FEATURES, model.booster_.pandas_categorical):
        d[col] = pd.Categorical(d[col].astype(str), categories=cats)
    d = d[d['pitch_type'].notna()]
    return d[ew.CFG['features']], d[ew.KEY].astype('int64').to_numpy()


def extra_frame(season, path, model):
    """시범·포스트시즌 행 : export_web_data.stuff_frame 과 같은 피처 (정규시즌 청크 순서와 분리)"""
    raw = sp.load_season(path, year=season)
    d = ew.stuff_frame(raw, model)
    d = d[d['game_type'] != 'R']
    return d[ew.CFG['features']], d[ew.KEY].astype('int64').to_numpy()


def compute(season, path, model, extra=False):
    tag = f'{season}_extra' if extra else f'{season}'
    out = os.path.join(ew.SHAP_DIR, f'shap_{tag}.npz')
    if os.path.exists(out):
        print(f'[{tag}] 이미 있음 : {out}')
        return
    part_dir = os.path.join(ew.SHAP_DIR, f'parts_{tag}')
    os.makedirs(part_dir, exist_ok=True)
    X, keys = (extra_frame if extra else season_frame)(season, path, model)
    n_chunks = (len(X) + CHUNK - 1) // CHUNK
    print(f'[{tag}] {len(X):,}구, {n_chunks} 청크')
    t0 = time.time()
    for k in range(n_chunks):
        part = os.path.join(part_dir, f'{k:04d}.npy')
        if os.path.exists(part):
            continue
        c = model.booster_.predict(X.iloc[k * CHUNK:(k + 1) * CHUNK], pred_contrib=True, num_threads=os.cpu_count())
        np.save(part, c.astype(np.float64))
        done = k + 1
        el = time.time() - t0
        print(f'  {done}/{n_chunks} ({el / 60:.1f}분 경과)', flush=True)
    c = np.concatenate([np.load(os.path.join(part_dir, f'{k:04d}.npy')) for k in range(n_chunks)])
    base = float(c[0, -1])
    np.savez(out, contrib=c[:, :-1], base=base, keys=keys)
    print(f'[{tag}] 저장 : {out}')
    for f in os.listdir(part_dir):
        os.remove(os.path.join(part_dir, f))
    os.rmdir(part_dir)


def main():
    model = joblib.load(os.path.join(ew.CFG['dir'], 'stage3_stuff_lgbm.joblib'))
    os.makedirs(ew.SHAP_DIR, exist_ok=True)
    only_extra = '--extra' in sys.argv
    seasons = [int(a) for a in sys.argv[1:] if a.isdigit()] or list(ew.SEASONS)
    for season in seasons:
        compute(season, ew.SEASONS[season], model, extra=True)    # 시범·포스트시즌 (짧음) 먼저
        if not only_extra:
            compute(season, ew.SEASONS[season], model)


if __name__ == '__main__':
    main()
