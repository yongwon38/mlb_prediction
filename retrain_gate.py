"""
재학습 게이트 : v4 레시피로 다시 학습한 challenger 가 운영 모델(champion, v4)보다 확실히 나을 때만 '교체 권고'

- 홀드아웃 : 현재 시즌 정규시즌 마지막 4주 (28일)
- challenger : 2025 전체 + 현재 시즌(홀드아웃 이전)의 3단계 표본으로 학습
  v4 레시피 = v4.lgbm 하이퍼파라미터(seed 42) · 같은 14개 피처 · v4 의 HAVAA 보정 계수 · AngleAdjustedStuffModel
  y3 정의도 v4 와 같다 : 2025 학습 기간 = 1단계 RF OOF(5-fold), 그 외 = 1단계 RF 예측, 2단계 = v4 보정기
  스케일러는 challenger 자신의 학습 기간 예측(점수 대상 투구)으로 적합
- 비교 (홀드아웃) : 3단계 RMSE, 투수×구종(n >= 100) ρ(구위, whiff%) · ρ(구위, xwOBAcon), 투수 군집 paired bootstrap Δ 95% CI
- 판정 : Δρ(whiff) CI 하한 > 0 이고 RMSE(challenger) <= RMSE(champion) -> 'replace'(교체 권고), 그 외 'keep'(유지)
- 모델 파일은 바꾸지 않는다 (challenger 는 저장하지 않음). 교체는 사용자 승인 후 수동

실행 : python retrain_gate.py                 (데이터 기준일이 지난 판정과 같으면 건너뜀)
       python retrain_gate.py --force --push  (강제 실행 + 온라인 저장소 HF monitor/gate.json 업로드)
       python retrain_gate.py --aa            (A/A 점검 : champion 을 자기 자신과 비교 -> 반드시 'keep')
출력 : outputs/gate/gate.json (최근 판정), outputs/gate/{날짜}.md (판정 리포트)
"""
import argparse
import json
import os
import time

import joblib
import lightgbm as lgb
import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedKFold, cross_val_predict

import data_store
import export_web_data as ew
import mlops_common as mc
import stuff_model as sm
import stuff_pipeline as sp

T0 = time.time()
log = lambda *a: print(f'[{time.time() - T0:5.0f}s]', *a, flush=True)
GATE_DIR = os.path.join('outputs', 'gate')
GATE_JSON = os.path.join(GATE_DIR, 'gate.json')
HOLDOUT_DAYS = 28
KEEP_COLS = ['pitcher', 'pitch_type', 'game_date', 'description', 'type', 'events', 'estimated_woba_using_speedangle',
             'stuff', 'pred', 'y3']


def season_frame(season, model, scaler, rf, calib, oof_before=None):
    """정규시즌 -> 피처 + champion 점수 + y3. oof_before 이전 인플레이 타구의 y3 는 1단계 OOF (v4 학습 라벨과 같은 정의)"""
    raw = sp.load_regular_season(ew.SEASONS[season], season)
    d = mc.score_frame(raw, model, scaler)
    hs = mc.hit_score(d, rf, calib)
    if oof_before is not None:
        X1, y1 = sp.build_hit_dataset(d[d['game_date'] < oof_before])
        P = cross_val_predict(RandomForestClassifier(n_estimators=300, n_jobs=-1, random_state=sp.SEED, max_depth=rf.max_depth,
                                                     min_samples_leaf=rf.min_samples_leaf),
                              X1, y1, cv=StratifiedKFold(5, shuffle=True, random_state=sp.SEED), method='predict_proba')
        hs.loc[X1.index] = calib.transform(sp.expected_value(P))
    _, y3 = sp.build_stuff_dataset(d, hs, features=['pitcher'], include_looking_k=False)
    d['y3'] = y3.reindex(d.index)
    d['season'] = season
    return d[sorted(set(KEEP_COLS) | set(model.input_features) | {'season'})]


def fit_challenger(champ, fit_rows, score_rows):
    lgbm = lgb.LGBMRegressor(**champ.lgbm.get_params()).fit(
        champ.model_frame(fit_rows[champ.input_features])[champ.features], fit_rows['y3'])
    m = sm.AngleAdjustedStuffModel(lgbm, champ.features, champ.vaa_coef, vaa_default=champ.vaa_default,
                                   category_list=champ.categories)
    scaler = sp.StuffScaler().fit(m.predict(score_rows[champ.input_features]))
    return m, scaler


def compare(h, cols, boot):
    """홀드아웃 h : 모델별 RMSE·ρ, challenger - champion 의 paired bootstrap Δ"""
    res, gs = {}, {}
    for k, (pc, sc) in cols.items():
        g = mc.group_table(h, score_col=sc)
        gs[k] = g
        r, n = mc.rmse(h, pc)
        res[k] = {**{x: mc.finite(v) for x, v in mc.group_metrics(g).items()}, 'rmse': mc.finite(r, 5), 'rmseN': n}
    g0, g1 = gs['champion'], gs['challenger']
    assert g0.index.equals(g1.index)
    wh, xc = g0['whiff'].to_numpy(), g0['xc'].to_numpy()
    s0, s1 = g0['s'].to_numpy(), g1['s'].to_numpy()
    dw = np.array([mc.rho(s1[i], wh[i]) - mc.rho(s0[i], wh[i]) for i in boot])
    dx = np.array([mc.rho(s1[i], xc[i]) - mc.rho(s0[i], xc[i]) for i in boot])
    delta = {'rhoWhiff': mc.finite(res['challenger']['rhoWhiff'] - res['champion']['rhoWhiff']),
             'rhoWhiffCI': [mc.finite(np.nanquantile(dw, .025)), mc.finite(np.nanquantile(dw, .975))],
             'rhoXwoba': mc.finite(res['challenger']['rhoXwoba'] - res['champion']['rhoXwoba']),
             'rhoXwobaCI': [mc.finite(np.nanquantile(dx, .025)), mc.finite(np.nanquantile(dx, .975))],
             'rmse': mc.finite(res['challenger']['rmse'] - res['champion']['rmse'], 5)}
    return res, delta, g0.index


def decide(delta):
    lo = delta['rhoWhiffCI'][0]
    better = lo is not None and lo > 0
    no_worse = delta['rmse'] is not None and delta['rmse'] <= 0
    return ('replace' if better and no_worse else 'keep'), {'rhoWhiffCILowerAboveZero': bool(better), 'rmseNotWorse': bool(no_worse)}


def last_gate():
    try:
        path = data_store.store().download(mc.HOF_GATE_FILE)
    except Exception:
        path = GATE_JSON if os.path.exists(GATE_JSON) else None
    if not path:
        return None
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def report_md(g):
    c, h, dl = g['champion'], g['challenger'], g['delta']
    f = lambda v: '-' if v is None else f'{v:.4f}'
    ci = lambda v: f'[{f(v[0])}, {f(v[1])}]'
    lines = [
        f"# 재학습 게이트 판정 {g['date']}", '',
        f"- 판정 : **{'교체 권고' if g['decision'] == 'replace' else '유지'}** ({g['decision']}){' — A/A 점검' if g['aa'] else ''}",
        f"- 데이터 기준일 {g['dataThrough']}, 홀드아웃 {g['holdout'][0]} ~ {g['holdout'][1]} ({g['holdoutGroups']} 투수×구종, n ≥ {mc.MIN_N})",
        f"- challenger 학습 : {g['trainPeriod'][0]} ~ {g['trainPeriod'][1]} 3단계 표본 {g['trainRows']:,}건 (v4 레시피, seed {mc.SEED})",
        f"- 규칙 : Δρ(whiff) 95% CI 하한 > 0 그리고 RMSE 악화 없음 -> 교체 권고. 모델 파일은 자동으로 바꾸지 않음", '',
        '| 지표 (홀드아웃) | champion (v4) | challenger | Δ (challenger − champion) | Δ 95% CI |',
        '| --- | --- | --- | --- | --- |',
        f"| ρ(구위, whiff%) | {f(c['rhoWhiff'])} | {f(h['rhoWhiff'])} | {f(dl['rhoWhiff'])} | {ci(dl['rhoWhiffCI'])} |",
        f"| ρ(구위, xwOBAcon) | {f(c['rhoXwoba'])} | {f(h['rhoXwoba'])} | {f(dl['rhoXwoba'])} | {ci(dl['rhoXwobaCI'])} |",
        f"| 3단계 RMSE | {c['rmse']:.5f} | {h['rmse']:.5f} | {dl['rmse']:+.5f} | - |", '',
        f"- 조건 : Δρ(whiff) CI 하한 > 0 {'충족' if g['checks']['rhoWhiffCILowerAboveZero'] else '미충족'}, "
        f"RMSE 악화 없음 {'충족' if g['checks']['rmseNotWorse'] else '미충족'}",
        f"- bootstrap : 투수 군집 paired, {mc.B}회, seed {mc.SEED}. 실행 {g['elapsedSec']}초",
    ]
    return '\n'.join(lines) + '\n'


def main(force=False, push=False, aa=False):
    model, scaler = mc.load_v4()
    rf, calib = mc.load_stage12()
    season = data_store.current_season()
    valid_start = pd.Timestamp(mc.load_ref()['validPeriod'][0])    # 2025 학습/검증 경계 (OOF 라벨 범위)
    d25 = season_frame(2025, model, scaler, rf, calib, oof_before=valid_start)
    cur = season_frame(season, model, scaler, rf, calib)
    through = cur['game_date'].max()
    prev = last_gate()
    if prev and not (force or aa) and prev.get('dataThrough') == str(through.date()):
        log(f"데이터 기준일 {through.date()} 이 지난 판정({prev.get('date')})과 같음 -> 건너뜀")
        return
    h_start = through - pd.Timedelta(days=HOLDOUT_DAYS - 1)
    is_h = (cur['game_date'] >= h_start).to_numpy()
    h, train_cur = cur[is_h].copy(), cur[~is_h]
    log(f'{season} 홀드아웃 {h_start.date()} ~ {through.date()} {is_h.sum():,}구')

    if aa:
        h['pred_ch'], h['stuff_ch'] = h['pred'], h['stuff']
        train_rows = 0
        train_period = ['-', '-']
    else:
        pool = pd.concat([d25, train_cur])
        fit_rows = pool[pool['y3'].notna()]
        score_rows = pool[pool['stuff'].notna()]
        log(f'challenger 학습 표본 {len(fit_rows):,}건, 스케일러 표본 {len(score_rows):,}구')
        ch, ch_sc = fit_challenger(model, fit_rows, score_rows)
        h['pred_ch'] = ch.predict(h[model.input_features])
        h['stuff_ch'] = pd.Series(ch_sc.transform(h['pred_ch'].to_numpy()), index=h.index).where(h['stuff'].notna())
        train_rows = len(fit_rows)
        train_period = [str(pool['game_date'].min().date()), str(train_cur['game_date'].max().date())]

    g0 = mc.group_table(h)
    boot = mc.boot_index(g0.index.get_level_values('pitcher'))
    res, delta, idx = compare(h, {'champion': ('pred', 'stuff'), 'challenger': ('pred_ch', 'stuff_ch')}, boot)
    decision, checks = decide(delta)
    out = {
        'date': str(data_store.today()), 'aa': aa, 'decision': decision, 'checks': checks,
        'dataThrough': str(through.date()), 'holdout': [str(h_start.date()), str(through.date())],
        'holdoutGroups': int(len(idx)), 'trainPeriod': train_period, 'trainRows': int(train_rows),
        'champion': res['champion'], 'challenger': res['challenger'], 'delta': delta,
        'elapsedSec': int(time.time() - T0),
    }
    log('champion', res['champion'])
    log('challenger', res['challenger'])
    log('Δ', delta, '->', decision)
    if aa:
        assert decision == 'keep' and delta['rhoWhiff'] == 0, 'A/A 점검 실패'
        log('A/A 점검 통과 (keep, Δ = 0) — 결과는 저장하지 않음')
        return
    os.makedirs(GATE_DIR, exist_ok=True)
    mc.dump_json(out, GATE_JSON)
    md = os.path.join(GATE_DIR, f"{out['date']}.md")
    with open(md, 'w', encoding='utf-8') as f:
        f.write(report_md(out))
    log('저장', GATE_JSON, md)
    if push:
        data_store.store().upload([(GATE_JSON, mc.HOF_GATE_FILE)], f"gate : {out['date']} {decision}")
        log('업로드', mc.HOF_GATE_FILE)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--push', action='store_true')
    ap.add_argument('--aa', action='store_true')
    main(**vars(ap.parse_args()))
