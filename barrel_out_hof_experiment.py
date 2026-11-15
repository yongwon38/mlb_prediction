"""
배럴 아웃 제외 효과를 HOF-Net-R(3단계)에서 확인 (시드 42 고정, 운영 반영 없음)

실행 : python barrel_out_hof_experiment.py [--smoke]   (먼저 barrel_out_experiment.py 로 outputs/barrel_out/y3_ab.parquet 생성)
  A : 기준선 1단계로 만든 y3 / B : 1단계 학습에서 배럴 아웃을 뺀 y3
  각 y3 로 HOF-Net-R 을 hofnet_diag_experiment.py 기준선과 같은 호출로 학습 -> P1 (MSE 평균) · P4 (ZIB 헤드)
  지표 : barrel_out_experiment.py 5절과 같음 (whiff% · xwOBAcon · 배럴% · 하드힛%, 투수 군집 bootstrap B − A CI)
출력 : outputs/barrel_out/hof/ (results.csv · compare.csv · epochs.csv · log.txt)
"""
import argparse, os, sys, time, warnings
import numpy as np
import pandas as pd
import torch
from scipy import stats

import export_web_data as ew
import hof_net as hn
import hof_net_r as hr
import stuff_model as sm
import stuff_pipeline as sp

warnings.filterwarnings('ignore')
sys.stdout.reconfigure(encoding='utf-8')
ap = argparse.ArgumentParser()
ap.add_argument('--smoke', action='store_true')
SMOKE = ap.parse_args().smoke
SEED = 42
EPOCHS = 2 if SMOKE else 30
B = 50 if SMOKE else 1000
DEV = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
OUT = os.path.join('outputs', 'barrel_out', 'hof', 'smoke') if SMOKE else os.path.join('outputs', 'barrel_out', 'hof')
os.makedirs(OUT, exist_ok=True)
CACHE = os.path.join('outputs', 'vaa_exp', 'cache')
T0 = time.time()
LOG = open(os.path.join(OUT, 'log.txt'), 'a', encoding='utf-8')


def log(*a):
    s = f'[{time.time() - T0:7.0f}s] ' + ' '.join(str(x) for x in a)
    print(s, flush=True); LOG.write(s + '\n'); LOG.flush()


def save(df, name, **kw):
    df.to_csv(os.path.join(OUT, name), encoding='utf-8-sig', **kw)


log('시작', 'smoke' if SMOKE else 'full', 'device', DEV)

# ---------------------------------------------------------------------------
# 1. 데이터 (hofnet_diag_experiment.py 1절과 같은 캐시 · split · 변수) + y3 A/B
# ---------------------------------------------------------------------------
v4 = sm.load_model(os.path.join('models', 'v4'))
FEATS = list(v4.features)
NUM = [f for f in FEATS if f not in sp.STUFF_CAT_FEATURES]
CAT = [c for c in sp.STUFF_CAT_FEATURES if c in FEATS]
cols = sorted(set(v4.input_features) | {'pitcher', 'game_date', 'description', 'type', 'events', 'estimated_woba_using_speedangle', 'waste'})
BB_COLS = ['launch_speed', 'launch_angle', 'launch_speed_angle']
fr = {}
for y, path in [(2025, 'games_25_final.pkl'), (2026, 'games_26.pkl')]:
    fr[y] = pd.read_parquet(os.path.join(CACHE, f'frame_{y}.parquet'), columns=cols + (['y3', 'split'] if y == 2025 else []))
    fr[y]['vaa_aa'] = v4.model_frame(fr[y][v4.input_features])['vaa_aa'].to_numpy()
    fr[y] = fr[y].join(sp.load_regular_season(path, year=y)[BB_COLS])
valid_start = pd.Timestamp(pd.read_json(os.path.join(CACHE, 'meta.json'), typ='series')['valid_start'])
d25 = fr[2025]
y3ab = pd.read_parquet(os.path.join('outputs', 'barrel_out', 'y3_ab.parquet')).reindex(d25.index)
VARIANTS = {'A': '기준선', 'B': '배럴 아웃 제외'}
samp = d25[d25['y3'].notna()]
assert y3ab.loc[samp.index].notna().all().all()
tr_rows, es_rows = samp[samp['split'] == 'tr'], samp[samp['split'] == 'es']
if SMOKE:
    tr_rows, es_rows = tr_rows.sample(20000, random_state=SEED), es_rows.sample(4000, random_state=SEED)
is_tr = (d25['game_date'] < valid_start).to_numpy()
waste = {y: fr[y]['waste'].fillna(True).to_numpy(bool) for y in fr}
log('표본 train', len(tr_rows), 'holdout', len(es_rows), '| 시즌', {y: len(d) for y, d in fr.items()})

prep = hn.Prep(tr_rows, NUM, CAT)
X_tr, X_es = prep(tr_rows), prep(es_rows)
season_t = {y: prep(fr[y]) for y in fr}
yt = lambda k, rows: torch.tensor(y3ab.loc[rows.index, f'y3_{k}'].to_numpy(np.float32))

# ---------------------------------------------------------------------------
# 2. HOF-Net-R 학습 (hofnet_diag_experiment.py run_hof('base') · p4 와 같은 호출, 타깃만 변형의 y3)
# ---------------------------------------------------------------------------
pred, hists = {}, []
for k in VARIANTS:
    y_tr, y_es = yt(k, tr_rows), yt(k, es_rows)
    tr, es = (*X_tr, y_tr), (*X_es, y_es)
    y_mean, y_std = float(y_tr.mean()), float(y_tr.std())
    torch.manual_seed(SEED)
    net = hr.HOFNetR(len(NUM), prep.cat_cards).to(DEV)
    t = time.time()
    hist = hr.fit_mean(net, tr, es, y_mean, y_std, epochs=EPOCHS, seed=SEED, log=lambda s: log('   ', s))
    hists.append(pd.DataFrame(hist).assign(variant=k))
    pred[f'{k} P1'] = {y: hr.encode_all(net, season_t[y], y_mean, y_std)[0] for y in fr}
    _, z_tr, h_tr = hr.encode_all(net, tr, y_mean, y_std, flat=True)
    _, z_es, h_es = hr.encode_all(net, es, y_mean, y_std, flat=True)
    zh, _ = hr.fit_zib_head(h_tr, torch.from_numpy(z_tr), y_tr, h_es, torch.from_numpy(z_es), y_es, epochs=EPOCHS, seed=SEED,
                            log=lambda s: None, device=DEV)
    zh.to(DEV)
    del h_tr, h_es
    pred[f'{k} P4'] = {y: hr.zib_predict_net(net, zh, season_t[y], M=4, seed=SEED)['mean'] for y in fr}
    log(f'[{k}] 학습 {time.time() - t:.0f}초, epoch {len(hist)}, 최적 홀드아웃 RMSE {min(h["holdout_rmse"] for h in hist):.5f}')
    del net, zh
    torch.cuda.empty_cache()
save(pd.concat(hists), 'epochs.csv', index=False)

# ---------------------------------------------------------------------------
# 3. 구위 지표 (barrel_out_experiment.py 5절과 같음)
# ---------------------------------------------------------------------------
for m, p in pred.items():
    sc = sp.StuffScaler().fit(p[2025][is_tr & ~waste[2025]])
    for y in fr:
        fr[y][f's_{m}'] = pd.Series(sc.transform(p[y]).astype('float32'), index=fr[y].index).where(~waste[y])
MODELS = list(pred)


def pt_table(d, min_n=100):
    """투수×구종 집계 : 스윙 대비 헛스윙, 인플레이 대비 배럴·하드힛, xwOBAcon"""
    ip = sp.inplay_mask(d) & d['launch_speed'].notna()
    x = d.assign(pitch_type=d['pitch_type'].astype(str), sw=d['description'].isin(ew.SWING_DESC), wh=d['description'].isin(sp.WHIFF_DESC),
                 ip=ip, brl=ip & (d['launch_speed_angle'] == 6).fillna(False), hh=ip & (d['launch_speed'] >= 95),
                 xc=d['estimated_woba_using_speedangle'].where(d['type'] == 'X'))
    g = x.groupby(['pitcher', 'pitch_type']).agg(n=('sw', 'size'), sw=('sw', 'sum'), wh=('wh', 'sum'), ip=('ip', 'sum'),
                                                  brl=('brl', 'sum'), hh=('hh', 'sum'), xc=('xc', 'mean'),
                                                  **{f's_{m}': (f's_{m}', 'mean') for m in MODELS})
    g = g[g['n'] >= min_n]
    return g.assign(whiff=g['wh'] / g['sw'], barrel=g['brl'] / g['ip'], hardhit=g['hh'] / g['ip'])


def rho(a, b):
    return stats.spearmanr(a, b, nan_policy='omit').statistic


TARGETS = {'whiff': ('whiff%', 1), 'xc': ('xwOBAcon', -1), 'barrel': ('배럴%/인플레이', -1), 'hardhit': ('하드힛%/인플레이', -1)}
pv25 = pt_table(fr[2025][~is_tr])
both = pt_table(fr[2025])[[f's_{m}' for m in MODELS]].join(pt_table(fr[2026])[list(TARGETS)], how='inner')
_pits = pv25.index.get_level_values('pitcher').to_numpy()
_upits = np.unique(_pits)
_rows_of = {p_: np.where(_pits == p_)[0] for p_ in _upits}
_rng = np.random.default_rng(SEED)
BOOT = [np.concatenate([_rows_of[p_] for p_ in _rng.choice(_upits, len(_upits))]) for _ in range(B)]

rows = []
for head in ('P1', 'P4'):
    for t, (name, sign) in TARGETS.items():
        tv = pv25[t].to_numpy()
        r = {'헤드': head, '지표': f'검증 투수×구종 ρ(구위, {name})'}
        boots = {}
        for k in VARIANTS:
            s = pv25[f's_{k} {head}'].to_numpy()
            r[k] = rho(s, tv)
            boots[k] = np.array([rho(s[i], tv[i]) for i in BOOT])
        d_ = boots['B'] - boots['A']
        r.update({'B − A': r['B'] - r['A'], 'CI 하한': float(np.quantile(d_, 0.025)), 'CI 상한': float(np.quantile(d_, 0.975)), '좋은 방향': '+' if sign > 0 else '−'})
        rows.append(r)
    for t, (name, sign) in TARGETS.items():
        r = {'헤드': head, '지표': f'예측력 ρ(구위 2025, {name} 2026)', **{k: rho(both[f's_{k} {head}'], both[t]) for k in VARIANTS}, '좋은 방향': '+' if sign > 0 else '−'}
        r['B − A'] = r['B'] - r['A']
        rows.append(r)
    rows.append({'헤드': head, '지표': 'A·B 투구 구위 점수 상관 (2025)', 'A': 1.0,
                 'B': float(np.corrcoef(fr[2025][f's_A {head}'].fillna(50), fr[2025][f's_B {head}'].fillna(50))[0, 1])})
out = pd.DataFrame(rows)
save(out, 'results.csv', index=False)
log(f'구위 지표 (투수×구종 {len(pv25)}개, bootstrap {B}회)\n' + out.round(4).to_string(index=False))

# LGBM 결과와 나란히 (B − A)
lg = pd.read_csv(os.path.join('outputs', 'barrel_out', 'results.csv'), encoding='utf-8-sig').set_index('지표')
cmp_ = pd.DataFrame({'LGBM v4': lg['B − A'], **{f'HOF {h}': out[out['헤드'] == h].set_index('지표')['B − A'] for h in ('P1', 'P4')}}).dropna(how='all')
cmp_ = cmp_.loc[[i for i in out['지표'].unique() if i in cmp_.index]]
save(cmp_, 'compare.csv')
log('B − A 비교 (LGBM vs HOF)\n' + cmp_.round(4).to_string())
log('끝', f'{time.time() - T0:.0f}s')
