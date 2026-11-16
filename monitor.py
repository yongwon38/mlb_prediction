"""
운영 모델(v4) 모니터링 : 시즌 정규시즌 투구의 ISO 주별 성능·입력 분포 -> web/public/data/monitor.json

- 성능 (누적) : 투수×구종(n >= 100) ρ(구위, whiff%) · ρ(구위, xwOBAcon) + 투수 군집 bootstrap 95% CI, 3단계 RMSE(y3 대비)
- 성능 (주간, 참고) : 같은 지표를 그 주 투구만으로 (투수×구종 n >= 30)
- 드리프트 : 14개 피처 PSI (2025 학습 분포 10분위 기준), 구위 평균, 60점 이상 비율
- 상태 : 누적 ρ whiff 가 2025 검증 구간 CI 하한 아래 / 최근 주 PSI > 0.2 -> warn, 누적 그룹 부족 -> insufficient
- 점수는 시즌 전체 투구로 계산 (주 패스트볼 기준 = 시즌 누적, 웹 점수와 같은 값). 지난 주 값도 매 실행 다시 계산한다

실행 : python monitor.py --season 2026           (로컬 산출)
       python monitor.py --season 2026 --push    (온라인 저장소 HF monitor/monitor.json 업로드, daily)
       python monitor.py --check                 (2025 검증 구간으로 기존 보고 수치 0.7172 / -0.2435 / 0.1682 재현 확인)
"""
import argparse
import json
import os
import time

import numpy as np
import pandas as pd

import data_store
import export_web_data as ew
import mlops_common as mc
import stuff_pipeline as sp

T0 = time.time()
log = lambda *a: print(f'[{time.time() - T0:5.0f}s]', *a, flush=True)
OUT = os.path.join(ew.OUT_DIR, 'monitor.json')
MIN_GROUPS = 100        # 누적 판정에 필요한 투수×구종 그룹 수
OFFSEASON_DAYS = 14     # 마지막 경기 후 이 기간이 지나면 비시즌
EXPECTED = {'rhoWhiff': 0.7172, 'rhoXwoba': -0.2435, 'rmse': 0.1682}   # 2025 검증 구간 기존 보고 수치 (outputs/hofnet_review)


def prepare(season):
    model, scaler = mc.load_v4()
    rf, calib = mc.load_stage12()
    raw = sp.load_regular_season(ew.SEASONS[season], season)
    d = mc.score_frame(raw, model, scaler)
    d = mc.add_y3(d, rf, calib)
    return d, model


def week_cols(d):
    iso = d['game_date'].dt.isocalendar()
    d['week'] = iso['year'].astype(str) + '-W' + iso['week'].astype(int).map('{:02d}'.format)
    return d


def check():
    """2025 검증 구간 : 기존 보고 수치와 ±0.005 이내인지"""
    d, _ = prepare(2025)
    _, _, valid_start = sp.split_last_month(d[['game_date']], months=1)
    va = d[d['game_date'] >= valid_start]
    g = mc.group_table(va)
    m = mc.group_metrics(g)
    m['rmse'], _ = mc.rmse(va)
    ok = True
    for k, v in EXPECTED.items():
        diff = abs(m[k] - v)
        ok &= diff <= 0.005
        log(f'{k} : {m[k]:.4f} (기존 {v:.4f}, 차이 {diff:.4f}) {"OK" if diff <= 0.005 else "불일치"}')
    raise SystemExit(0 if ok else 1)


def load_gate():
    """최근 게이트 판정 요약 (온라인 저장소 -> 로컬 outputs/gate/gate.json)"""
    path = None
    try:
        path = data_store.store().download(mc.HOF_GATE_FILE)
    except Exception:
        local = os.path.join('outputs', 'gate', 'gate.json')
        path = local if os.path.exists(local) else None
    if not path:
        return None
    with open(path, encoding='utf-8') as f:
        g = json.load(f)
    return {k: g.get(k) for k in ('date', 'decision', 'holdout', 'champion', 'challenger', 'delta', 'skipped')}


def run(season, push=False):
    ref = mc.load_ref()
    base = ref['baseline']
    d, model = prepare(season)
    d = week_cols(d)
    X = mc.model_features(d, model)
    scored = d['stuff'].notna().to_numpy()
    weeks = sorted(d['week'].unique())
    log(f'{season} 정규시즌 {len(d):,}구, {len(weeks)}주, 점수 대상 {scored.sum():,}구')

    rows = []
    for w in weeks:
        wk = (d['week'] == w).to_numpy()
        cum = (d['week'] <= w).to_numpy()
        gc = mc.group_table(d[cum])
        gw = mc.group_table(d[wk], min_n=mc.MIN_N_WEEK)
        boot = mc.boot_index(gc.index.get_level_values('pitcher')) if len(gc) >= MIN_GROUPS else None
        mcum, mwk = mc.group_metrics(gc, boot), mc.group_metrics(gw)
        mcum['rmse'], mcum['rmseN'] = mc.rmse(d[cum])
        mwk['rmse'], mwk['rmseN'] = mc.rmse(d[wk])
        psi = {c: mc.psi(ref['dist'][c], X.loc[wk & scored, c]) for c in ref['features']}
        s = d.loc[wk, 'stuff']
        gd = d.loc[wk, 'game_date']
        rows.append({
            'week': w, 'start': str(gd.min().date()), 'end': str(gd.max().date()), 'pitches': int(wk.sum()),
            'cum': {k: (mc.finite(v) if not isinstance(v, list) else [mc.finite(x) for x in v]) for k, v in mcum.items()},
            'wk': {k: mc.finite(v) for k, v in mwk.items()},
            'psi': {c: mc.finite(v) for c, v in psi.items()},
            'psiMax': mc.finite(max(psi.values())),
            'stuffMean': mc.finite(s.mean(), 3), 'share60': mc.finite((s >= 60).mean(), 4),
        })
        log(f"{w} {rows[-1]['pitches']:>6,}구 | 누적 ρ whiff {rows[-1]['cum']['rhoWhiff']} ({rows[-1]['cum']['groups']}그룹) "
            f"| 주간 ρ {rows[-1]['wk']['rhoWhiff']} | PSI max {rows[-1]['psiMax']}")

    last = rows[-1]
    season_psi = {c: mc.finite(mc.psi(ref['dist'][c], X.loc[scored, c])) for c in ref['features']}
    reasons = []
    if last['cum']['groups'] < MIN_GROUPS:
        status = 'insufficient'
    else:
        lo = base['rhoWhiffCI'][0]
        if last['cum']['rhoWhiff'] is not None and last['cum']['rhoWhiff'] < lo:
            reasons.append({'code': 'rho', 'value': last['cum']['rhoWhiff'], 'limit': lo})
        for c, v in last['psi'].items():
            if v is not None and v > mc.PSI_WARN:
                reasons.append({'code': 'psi', 'feature': c, 'value': v, 'limit': mc.PSI_WARN})
        status = 'warn' if reasons else 'ok'
    through = d['game_date'].max()
    offseason = (pd.Timestamp(data_store.today()) - through).days > OFFSEASON_DAYS
    out = {
        'generatedAt': pd.Timestamp.now(tz='Asia/Seoul').strftime('%Y-%m-%d %H:%M KST'),
        'season': season, 'model': ref['model'], 'dataThrough': str(through.date()),
        'status': status, 'offseason': bool(offseason), 'reasons': reasons,
        'thresholds': {'psiWarn': mc.PSI_WARN, 'psiWatch': mc.PSI_WATCH, 'minN': mc.MIN_N, 'minNWeek': mc.MIN_N_WEEK,
                       'minGroups': MIN_GROUPS, 'bootstrap': mc.B},
        'ref': {k: ref[k] for k in ('trainPeriod', 'validPeriod', 'trainPitches', 'features')} | {'baseline': base},
        'weeks': rows,
        'psiSeason': season_psi,
        'gate': load_gate(),
    }
    mc.dump_json(out, OUT)
    log(f'상태 {status} (비시즌 {offseason}), 사유 {reasons}, 저장 {OUT}')
    if push:
        data_store.store().upload([(OUT, mc.HOF_MONITOR_FILE)], f'monitor : {season} {out["dataThrough"]}')
        log('업로드', mc.HOF_MONITOR_FILE)


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--season', type=int, default=data_store.current_season())
    ap.add_argument('--push', action='store_true')
    ap.add_argument('--check', action='store_true')
    a = ap.parse_args()
    check() if a.check else run(a.season, a.push)
