"""
구위 모델 선택 검토 : LGBM v4 (웹) vs HOF-Net-R P4 (ZIB) 웹 어댑터 (models/hof_r)

실행 : python model_choice_analysis.py --part perf|explain|cost [--n 20000]
  perf    : 구위 지표 (hofnet_experiment.py 4절 정의) — LGBM v4, HOF 앙상블, 시드별 단일 모델 + 2026 점수 일치
  explain : 구위 산출 근거 비교 (2026 표본) — 가법성, 요인 비중, LGBM TreeSHAP 와의 일치, K·시드 안정성, 단조성 점검
  cost    : 근거 계산 시간 (GPU / CPU 4스레드), 시드 수 × 배경 K
출력 : outputs/model_choice/
"""
import argparse, json, os, sys, time, warnings
os.environ.setdefault('LOKY_MAX_CPU_COUNT', str(os.cpu_count()))
import joblib
import numpy as np
import pandas as pd
import torch
from scipy import stats

import export_web_data as ew
import hof_net_r as hr
import stuff_model as sm
import stuff_pipeline as sp

warnings.filterwarnings('ignore')
sys.stdout.reconfigure(encoding='utf-8')
ap = argparse.ArgumentParser()
ap.add_argument('--part', choices=['perf', 'explain', 'cost'], required=True)
ap.add_argument('--n', type=int, default=20000)
ARGS = ap.parse_args()
OUT = os.path.join('outputs', 'model_choice')
os.makedirs(OUT, exist_ok=True)
CACHE = os.path.join('outputs', 'vaa_exp', 'cache')
SEED = 42
T0 = time.time()
LOG = open(os.path.join(OUT, f'{ARGS.part}_log.txt'), 'a', encoding='utf-8')


def log(*a):
    s = f'[{time.time() - T0:6.0f}s] ' + ' '.join(str(x) for x in a)
    print(s, flush=True); LOG.write(s + '\n'); LOG.flush()


def save(df, name, **kw):
    df.to_csv(os.path.join(OUT, name), encoding='utf-8-sig', **kw)


num = lambda s: s.to_numpy('float64', na_value=np.nan)
v4 = sm.load_model(os.path.join('models', 'v4'))
v4_scaler = joblib.load(os.path.join('models', 'v4', 'stage4_stuff_scaler.joblib'))
hof = sm.load_model(os.path.join('models', 'hof_r'))
hof_scaler = joblib.load(os.path.join('models', 'hof_r', 'stage4_stuff_scaler.joblib'))
SEEDS = json.load(open(os.path.join('models', 'hof_r', 'features.json'), encoding='utf-8'))['seeds']
single = {s: hr.HOFNetRStuffModel([hof.members[i]], hof.prep, hof.angle, ew.EXPLAIN_GROUPS, hof.refs, hof.k_exact) for i, s in enumerate(SEEDS)}
GROUPS = [g for g, _ in ew.EXPLAIN_GROUPS]
log('시작', vars(ARGS), 'CUDA', torch.cuda.is_available(), 'HOF 시드', SEEDS, 'k_exact', hof.k_exact)

WEB = ['pa_event', 'is_swing', 'is_whiff', 'result', 'xwoba', 'plate_z_norm']
cols = sorted(set(v4.input_features) | {'pitcher', 'game_date', 'description', 'type', 'estimated_woba_using_speedangle', 'zone',
                                        'plate_x', 'waste'} | set(WEB))
fr = {y: pd.read_parquet(os.path.join(CACHE, f'frame_{y}.parquet'), columns=cols) for y in (2024, 2025, 2026)}
valid_start = pd.Timestamp(pd.read_json(os.path.join(CACHE, 'meta.json'), typ='series')['valid_start'])
is_tr = (fr[2025]['game_date'] < valid_start).to_numpy()

if ARGS.part == 'perf':
    # 구위 지표 정의 = hofnet_experiment.py 4절 (hofnet_r_experiment.py 와 같은 방식으로 가져옴)
    _src = open('hofnet_experiment.py', encoding='utf-8').read()
    exec(_src[_src.index('def within_corr'):_src.index('scalers, stuff_cols, rows = {}, {}, {}')])
    preds = {}
    models = {'LGBM v4': (v4, v4_scaler), 'HOF-Net-R 앙상블': (hof, hof_scaler)}
    models.update({f'HOF-Net-R 시드 {s}': (m, None) for s, m in single.items()})
    stuff_rows = []
    for name, (m, sc) in models.items():
        pred = {y: m.predict(fr[y][v4.input_features]) for y in fr}
        if sc is None:
            sc = sp.StuffScaler().fit(pred[2025][is_tr & ~fr[2025]['waste'].to_numpy()])
        for y in fr:
            fr[y]['s_cur'] = pd.Series(sc.transform(pred[y]).astype('float32'), index=fr[y].index).where(~fr[y]['waste'])
        preds[name] = {y: fr[y]['s_cur'].to_numpy().copy() for y in fr}
        r = {'model': name, **{f'검증 {a}': v for a, v in validity(fr[2025][~is_tr], 's_cur').items()}}
        for y in (2024, 2026):
            b = buckets(fr[y], 's_cur')
            r[f'{y} BA 격차'] = b.loc['<40', 'ba'] - b.loc['60+', 'ba']
            r[f'{y} Whiff 격차'] = b.loc['60+', 'whiff'] - b.loc['<40', 'whiff']
        for a, b_ in [(2024, 2025), (2025, 2026)]:
            mm = pd.concat([pt_means(fr[a], 's_cur'), pt_means(fr[b_], 's_cur')], axis=1, join='inner')
            r[f'안정성 r(구위 {a}, 구위 {b_})'] = mm.corr().iloc[0, 1]
            ww = pd.concat([pt_means(fr[a], 's_cur'), pt_whiff(fr[b_])], axis=1, join='inner')
            r[f'예측력 ρ(구위 {a}, whiff% {b_})'] = stats.spearmanr(ww.iloc[:, 0], ww.iloc[:, 1]).statistic
        d26 = fr[2026]
        r['투수×구종 내 corr(점수, 높이 정규화)'] = within_corr(d26, 's_cur', 'plate_z_norm')
        stuff_rows.append(r)
        log('구위 지표', name, round(r['검증 투수×구종 ρ(구위, whiff%)'], 4), round(r['예측력 ρ(구위 2025, whiff% 2026)'], 4))
    perf = pd.DataFrame(stuff_rows).set_index('model')
    save(perf, 'perf_stuff_metrics.csv')
    log('구위 지표\n' + perf.T.round(4).to_string())
    # 2026 점수 일치 : 투구별, 투수×구종 평균 (100구 이상), 상위 50 겹침, 순위 차이 큰 사례
    d26 = fr[2026].assign(s_l=preds['LGBM v4'][2026], s_h=preds['HOF-Net-R 앙상블'][2026], pitch_type=fr[2026]['pitch_type'].astype(str))
    ok = d26['s_l'].notna()
    g = d26[ok].groupby(['pitcher', 'pitch_type']).agg(n=('s_l', 'size'), s_l=('s_l', 'mean'), s_h=('s_h', 'mean')).query('n >= 100')
    g['rank_l'], g['rank_h'] = g['s_l'].rank(ascending=False), g['s_h'].rank(ascending=False)
    g['순위 차이 (HOF − LGBM)'] = g['rank_h'] - g['rank_l']
    top = lambda c, k=50: set(g.nlargest(k, c).index)
    agree = {'투구별 상관 (2026)': float(np.corrcoef(d26.loc[ok, 's_l'], d26.loc[ok, 's_h'])[0, 1]),
             '투수×구종 평균 상관 (2026, 100구+)': float(g[['s_l', 's_h']].corr().iloc[0, 1]),
             '투수×구종 평균 Spearman (2026)': float(stats.spearmanr(g['s_l'], g['s_h']).statistic),
             '상위 50 겹침 (투수×구종)': len(top('s_l') & top('s_h')), '투수×구종 수': len(g),
             '|점수 차이| 평균 (투구별)': float((d26.loc[ok, 's_l'] - d26.loc[ok, 's_h']).abs().mean()),
             '|점수 차이| 평균 (투수×구종)': float((g['s_l'] - g['s_h']).abs().mean())}
    by_pt = g.reset_index().groupby('pitch_type').agg(n=('n', 'size'), LGBM=('s_l', 'mean'), HOF=('s_h', 'mean')).query('n >= 20')
    by_pt['HOF − LGBM'] = by_pt['HOF'] - by_pt['LGBM']
    save(by_pt.sort_values('HOF − LGBM'), 'agree_by_pitch_type.csv')
    big = g.reset_index().assign(diff=lambda x: x['s_h'] - x['s_l'])
    big = pd.concat([big.nlargest(10, 'diff'), big.nsmallest(10, 'diff')])
    save(big, 'agree_biggest_diff.csv', index=False)
    json.dump(agree, open(os.path.join(OUT, 'agree_scores.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    log('점수 일치', agree, '\n구종별\n' + by_pt.round(2).to_string())
    log('끝')
    raise SystemExit

# ---------------------------------------------------------------------------
# 근거 비교 · 비용 공통 : 2026 표본 (정규시즌, 비-waste)
# ---------------------------------------------------------------------------
d26 = fr[2026][~fr[2026]['waste']]
samp = d26.sample(ARGS.n, random_state=SEED)
X = samp[v4.input_features]


def to_groups(contrib, feats):
    return np.column_stack([contrib[:, [feats.index(f) for f in fs if f in feats]].sum(axis=1) for _, fs in ew.EXPLAIN_GROUPS])


if ARGS.part == 'cost':
    rows = []
    Xs = X.iloc[:2000]
    for dev in ('cuda', 'cpu'):
        if dev == 'cpu':
            torch.cuda.is_available = lambda: False
            torch.set_num_threads(4)
            Xs = X.iloc[:300]
        elif not torch.cuda.is_available():
            continue
        for E, m in (('1', single[SEEDS[0]]), (str(len(SEEDS)), hof)):
            for K in ((1, 4, 8, 16) if dev == 'cuda' else (1, 4)):
                m.k_exact = K
                t = time.time(); m.group_shapley(Xs, exact=True); dt = time.time() - t
                rows.append({'장치': 'GPU (RTX 4070 Ti)' if dev == 'cuda' else 'CPU 4스레드', '시드 수': int(E), 'K': K,
                             '1만 구당 초': dt / len(Xs) * 1e4, '13만 구 (일일 증분) 분': dt / len(Xs) * 1.3e5 / 60,
                             '70만 구 (한 시즌) 시간': dt / len(Xs) * 7e5 / 3600})
                log(rows[-1])
        t = time.time(); v4.explain(Xs, exact=True); dt = time.time() - t
        rows.append({'장치': 'CPU 12스레드' if dev == 'cuda' else 'CPU 4스레드', '시드 수': 0, 'K': 0, '1만 구당 초': dt / len(Xs) * 1e4,
                     '13만 구 (일일 증분) 분': dt / len(Xs) * 1.3e5 / 60, '70만 구 (한 시즌) 시간': dt / len(Xs) * 7e5 / 3600, '비고': 'LGBM TreeSHAP'})
        log(rows[-1])
    save(pd.DataFrame(rows), 'cost.csv', index=False)
    log('끝')
    raise SystemExit

# ---------------------------------------------------------------------------
# explain
# ---------------------------------------------------------------------------
feats = list(X.columns)
pred_l = v4.predict(X); score_l = v4_scaler.transform(pred_l)
c_l, b_l = v4.explain(X, exact=True)                        # TreeSHAP
cache = {}


def hof_groups(m, K, Xin=X):
    m.k_exact = K
    phi, base, pred = m.group_shapley(Xin, exact=True)
    return phi, base, pred


def to_score(phi, base, pred, sc):
    """export_web_data.explain_contrib 와 같은 점수 단위 변환 (비례 배분)"""
    score = sc.transform(pred)
    S0 = float(sc.transform([base])[0])
    diff = pred - base
    h = 2e-3
    deriv = (sc.transform(pred + h) - sc.transform(pred - h)) / (2 * h)
    near = np.abs(diff) < 1e-4
    k = np.where(near, deriv, (score - S0) / np.where(near, 1.0, diff))
    return phi * k[:, None], S0, score


G_l = to_groups(c_l, feats)
C_l, S0_l, sc_l = to_score(G_l, b_l, pred_l, v4_scaler)
t = time.time()
phi_h, base_h, pred_h = hof_groups(hof, hof.k_exact)
log('HOF 앙상블 Shapley', len(X), '구', round(time.time() - t, 1), '초')
C_h, S0_h, sc_h = to_score(phi_h, base_h, pred_h, hof_scaler)
expl = {'LGBM v4 (TreeSHAP)': (C_l, S0_l, sc_l, np.abs(b_l + c_l.sum(1) - pred_l).max()),
        f'HOF-Net-R 앙상블 (Shapley K={hof.k_exact})': (C_h, S0_h, sc_h, np.abs(base_h + phi_h.sum(1) - pred_h).max())}
rows_e = {}
for k, (C, S0, sc, err) in expl.items():
    share = np.abs(C).mean(0) / np.abs(C).mean(0).sum()
    rows_e[k] = {'기준 점수 S0': S0, '가법성 오차 최대 (예측 단위)': float(err), **{f'{g} 비중': float(share[j]) for j, g in enumerate(GROUPS)}}
k_h = list(expl)[1]
r = rows_e[k_h]
r['LGBM 과 구위 상관'] = float(np.corrcoef(sc_h, sc_l)[0, 1])
r['최대 + 요인 일치율'] = float(np.mean(C_l.argmax(1) == C_h.argmax(1)))
r['최대 − 요인 일치율'] = float(np.mean(C_l.argmin(1) == C_h.argmin(1)))
for j, g in enumerate(GROUPS):
    r[f'{g} 투구별 상관 (vs LGBM)'] = float(np.corrcoef(C_l[:, j], C_h[:, j])[0, 1])
# LGBM 의 같은 비교 기준선 : 시드 43 재학습 LGBM 의 TreeSHAP 와 운영 LGBM 의 일치 (모델 간 차이의 '자연 수준')
agree = pd.DataFrame(rows_e)
save(agree, 'explain_agreement.csv')
log('근거 비교\n' + agree.round(3).to_string())

# 안정성 : K (부분 표본 2,000구, K=64 기준) · 시드 (단일 시드 모델끼리, 같은 K)
sub = X.iloc[:2000]
ref64 = hof_groups(hof, 64, sub)[0]
stab = []
for K in (1, 4, 8, 16, 32):
    phi = hof_groups(hof, K, sub)[0]
    cs = [np.corrcoef(phi[:, j], ref64[:, j])[0, 1] for j in range(len(GROUPS))]
    stab.append({'비교': f'앙상블 K={K} vs K=64', '그룹별 상관 최소': min(cs), '그룹별 상관 평균': float(np.mean(cs)),
                 '최대 + 요인 일치율': float(np.mean(phi.argmax(1) == ref64.argmax(1)))})
    log(stab[-1])
seed_phi = {s: hof_groups(m, hof.k_exact, sub)[0] for s, m in single.items()}
ss = list(seed_phi)
for i in range(len(ss)):
    for j in range(i + 1, len(ss)):
        a, b = seed_phi[ss[i]], seed_phi[ss[j]]
        cs = [np.corrcoef(a[:, g], b[:, g])[0, 1] for g in range(len(GROUPS))]
        stab.append({'비교': f'시드 {ss[i]} vs {ss[j]}', '그룹별 상관 최소': min(cs), '그룹별 상관 평균': float(np.mean(cs)),
                     '최대 + 요인 일치율': float(np.mean(a.argmax(1) == b.argmax(1)))})
# LGBM 의 시드 간 근거 안정성 (같은 하이퍼파라미터, random_state 만 변경)
import lightgbm as lgb
d25 = fr[2025]
lg2 = None
try:
    tr = pd.read_parquet(os.path.join(CACHE, 'frame_2025.parquet'), columns=sorted(set(v4.input_features) | {'y3', 'split'}))
    tr = tr[tr['y3'].notna() & tr['split'].isin(['tr', 'es'])]
    lg2 = sm.AngleAdjustedStuffModel(lgb.LGBMRegressor(**{**v4.lgbm.get_params(), 'random_state': 43})
                                     .fit(v4.model_frame(tr[v4.input_features])[v4.features], tr['y3']), v4.features, v4.vaa_coef,
                                     vaa_default=getattr(v4, 'vaa_default', None), category_list=getattr(v4, 'category_list', None))
    c2 = to_groups(lg2.explain(sub, exact=True)[0], feats)
    c1 = G_l[:2000]
    cs = [np.corrcoef(c1[:, g], c2[:, g])[0, 1] for g in range(len(GROUPS))]
    stab.append({'비교': 'LGBM 운영(42) vs 재학습(43)', '그룹별 상관 최소': min(cs), '그룹별 상관 평균': float(np.mean(cs)),
                 '최대 + 요인 일치율': float(np.mean(c1.argmax(1) == c2.argmax(1)))})
except Exception as e:      # noqa
    log('LGBM 시드 비교 생략', e)
stab = pd.DataFrame(stab)
save(stab, 'explain_stability.csv', index=False)
log('안정성\n' + stab.round(4).to_string())

# 야구 상식 점검 : 구종 안에서 원값과 그 요인 기여의 Spearman (방향이 일관되면 |ρ| 큼)
chk = [('FF', '구속', 'release_speed', '+'), ('FF', '수직 무브먼트', 'pfx_z', '+'), ('FF', '진입각', 'vaa', '+'),
       ('FF', '익스텐션', 'release_extension', '+'), ('SL', '구속', 'release_speed', '+'), ('CH', '구속', 'velo_diff', '?'),
       ('SI', '수직 무브먼트', 'pfx_z', '−'), ('CU', '수직 무브먼트', 'pfx_z', '−')]
mono = []
ptype = samp['pitch_type'].astype(str).to_numpy()
for pt, g, f, exp in chk:
    msk = ptype == pt
    j = GROUPS.index(g)
    x = samp[f].to_numpy('float64')[msk]
    row = {'구종': pt, '요인': g, '원값': f, '기대 방향 (점수 기여)': exp, 'n': int(msk.sum())}
    for k, (C, *_ ) in expl.items():
        row[k] = float(stats.spearmanr(x, C[msk, j], nan_policy='omit').statistic)
    mono.append(row)
mono = pd.DataFrame(mono)
save(mono, 'explain_monotonic.csv', index=False)
log('단조성\n' + mono.round(3).to_string())

# 근거 예시 : HOF·LGBM 의 최대 + 요인이 다른 대표 투구 3개
diff = np.where(C_l.argmax(1) != C_h.argmax(1))[0]
ex = []
for i in list(diff[:3]) + list(np.argsort(-sc_h)[:2]):
    for k, (C, S0, sc, _) in expl.items():
        ex.append({'투구': int(i), '구종': ptype[i], '모델': k, '기준 점수': round(S0, 1), **{g: round(float(C[i, j]), 1) for j, g in enumerate(GROUPS)},
                   '구위': round(float(sc[i]), 1)})
save(pd.DataFrame(ex), 'explain_examples.csv', index=False)
log('끝')
