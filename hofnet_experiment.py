"""
HOF-Net vs LGBM(운영 v3) 비교 실험 — 같은 변수·표본·split·지표 (stuff_pipeline_261010_hofnet.ipynb 와 같은 코드)

실행 : python hofnet_experiment.py [--smoke] [--no-pitch-type]
       --smoke : 표본 2만 구, 2 epoch 로 코드 점검
       --no-pitch-type : 구종(pitch_type) 변수를 빼고 HOF-Net·비교용 LGBM 학습 (출력 outputs/hofnet_nopt/)
입력 : outputs/vaa_exp/cache/ (3차 실험 캐시), models/v3 (운영 LGBM)
출력 : outputs/hofnet/ (비교표 csv, 학습 기록, 요약 json, 모델 state_dict(.pt, git 제외))
"""
import json, os, sys, time, gc, warnings
os.environ.setdefault('LOKY_MAX_CPU_COUNT', str(os.cpu_count()))
import numpy as np
import pandas as pd
import torch
import lightgbm as lgb
from scipy import stats
from sklearn.metrics import mean_squared_error, mean_absolute_error, r2_score, roc_auc_score

import stuff_pipeline as sp
import stuff_model as sm
import export_web_data as ew
import hof_net as hn

warnings.filterwarnings('ignore')
SMOKE = '--smoke' in sys.argv
SEED = 42
torch.manual_seed(SEED); np.random.seed(SEED)
torch.set_num_threads(min(12, os.cpu_count()))
NOPT = '--no-pitch-type' in sys.argv
OUT = os.path.join('outputs', 'hofnet_nopt' if NOPT else 'hofnet')
CACHE = os.path.join('outputs', 'vaa_exp', 'cache')
os.makedirs(OUT, exist_ok=True)
T0 = time.time()
log = lambda *a: print(f'[{time.time() - T0:6.0f}s]', *a, flush=True)
num = lambda s: s.to_numpy('float64', na_value=np.nan)

# ---------------------------------------------------------------------------
# 1. 데이터 (운영 v3 와 같은 변수 : v3 모델 객체가 만드는 피처 15개)
# ---------------------------------------------------------------------------
v3 = sm.load_model(os.path.join('models', 'v3'))
v3_scaler = joblib_load = __import__('joblib').load(os.path.join('models', 'v3', 'stage4_stuff_scaler.joblib'))
FEATS = [f for f in v3.features if not (NOPT and f == 'pitch_type')]   # 구종 제외 실험 : 14개
NUM = [f for f in FEATS if f not in sp.STUFF_CAT_FEATURES]
CAT = [c for c in sp.STUFF_CAT_FEATURES if c in FEATS]
WEB = ['pa_event', 'is_swing', 'is_whiff', 'result', 'xwoba', 'plate_z_norm']
cols = sorted(set(v3.input_features) | {'pitcher', 'game_date', 'description', 'type', 'estimated_woba_using_speedangle', 'zone',
                                        'plate_x', 'waste'} | set(WEB))
fr = {}
for y in (2024, 2025, 2026):
    fr[y] = pd.read_parquet(os.path.join(CACHE, f'frame_{y}.parquet'), columns=cols + (['y3', 'split'] if y == 2025 else []))
    Xm = v3.model_frame(fr[y][v3.input_features])
    fr[y]['vaa_aa'] = Xm['vaa_aa'].to_numpy()
valid_start = pd.Timestamp(pd.read_json(os.path.join(CACHE, 'meta.json'), typ='series')['valid_start'])
d25 = fr[2025]
is_tr = (d25['game_date'] < valid_start).to_numpy()
samp = d25[d25['y3'].notna()]
tr_rows, es_rows, va_rows = samp[samp['split'] == 'tr'], samp[samp['split'] == 'es'], samp[samp['split'] == 'va']
if SMOKE:
    tr_rows, es_rows, va_rows = tr_rows.sample(20000, random_state=SEED), es_rows.sample(4000, random_state=SEED), va_rows.sample(4000, random_state=SEED)
log('표본 train', len(tr_rows), 'holdout', len(es_rows), 'valid', len(va_rows))

prep = hn.Prep(tr_rows, NUM, CAT)
T = lambda df: prep(df[FEATS])
Y = lambda df: torch.tensor(df['y3'].to_numpy(np.float32))
tr_t, es_t, va_t = (*T(tr_rows), Y(tr_rows)), (*T(es_rows), Y(es_rows)), T(va_rows)
y_va = va_rows['y3'].to_numpy()

# ---------------------------------------------------------------------------
# 2. HOF-Net 학습 : A0 전체(β = 1), A0 KL 가중 완화(β = 0.1, 0.01), A1 대각 사후분포(R = I), A5 결정적(W = μ)
#    β = 1 에서는 사후분포가 사전분포로 붕괴(평균 예측 = 상수)해서, 공정 비교용으로 β 완화판을 함께 학습
# ---------------------------------------------------------------------------
VARIANTS = {'A0': (dict(cov='full', latent=True), 1.0), 'A0-β0.1': (dict(cov='full', latent=True), 0.1),
            'A0-β0.01': (dict(cov='full', latent=True), 0.01), 'A1': (dict(cov='diag', latent=True), 1.0),
            'A5': (dict(cov='full', latent=False), 1.0),
            'A0-βNLL': (dict(cov='full', latent=True), 0.01, 0.5),    # β-NLL 0.5 + KL β 0.01
            'A5-βNLL': (dict(cov='full', latent=False), 1.0, 0.5)}
VARIANTS = {k: v if len(v) == 3 else (*v, 0.0) for k, v in VARIANTS.items()}
nets, hists, times = {}, {}, {}
for k, (kw, beta, nb) in VARIANTS.items():
    t = time.time()
    net = hn.HOFNet(len(NUM), prep.cat_cards, **kw)
    log(f'--- HOF-Net {k} {kw} β={beta} β-NLL={nb}')
    hists[k] = hn.fit(net, tr_t, es_t, beta=beta, nll_beta=nb, epochs=2 if SMOKE else 30, patience=4, log=lambda s: log('  ', s))
    times[k] = time.time() - t
    nets[k] = net
    torch.save({'state': net.state_dict(), 'kw': kw, 'beta': beta, 'nll_beta': nb, 'num': NUM, 'cat': CAT, 'mean': prep.mean.to_dict(), 'std': prep.std.to_dict(),
                'cats': prep.cats}, os.path.join(OUT, f'hof_{k}.pt'))
    hists[k].assign(variant=k).to_csv(os.path.join(OUT, f'train_history_{k}.csv'), index=False, encoding='utf-8-sig')
    log(f'  {k} 학습 {times[k]:.0f}초, {len(hists[k])} epoch')

# ---------------------------------------------------------------------------
# 3. 점 예측 · 확률 예측 (2025 검증)
# ---------------------------------------------------------------------------
def prob_metrics(mean, var, y=y_va):
    sd = np.sqrt(var)
    r = {'RMSE': np.sqrt(mean_squared_error(y, mean)), 'MAE': mean_absolute_error(y, mean), 'R2': r2_score(y, mean),
         'NLL': float(np.mean(0.5 * (np.log(2 * np.pi * var) + (y - mean) ** 2 / var))),
         'CRPS': float(np.mean(hn.gauss_crps(y, mean, sd)))}
    ce = []
    for c in (0.5, 0.8, 0.9, 0.95):
        zq = stats.norm.ppf(0.5 + c / 2)
        cov = float(np.mean(np.abs(y - mean) <= zq * sd))
        r[f'커버리지 {int(c * 100)}%'] = cov
        ce.append(abs(cov - c))
    r['보정 오차 (평균 |커버리지 − 명목|)'] = float(np.mean(ce))
    r['90% 구간 평균 폭'] = float(np.mean(2 * stats.norm.ppf(0.95) * sd))
    return r

fit_rows = pd.concat([tr_rows, es_rows])
lg_fit = v3.predict(fit_rows[v3.input_features])
lg_va = v3.predict(va_rows[v3.input_features])
res = {}
sig = float(np.std(fit_rows['y3'].to_numpy() - lg_fit))
res['LGBM v3 + 상수 분산'] = prob_metrics(lg_va, np.full(len(lg_va), sig ** 2))
params = dict(n_estimators=400, learning_rate=0.05, num_leaves=63, min_child_samples=200, random_state=SEED, verbose=-1)
Xfit, Xva = v3.model_frame(fit_rows[v3.input_features]), v3.model_frame(va_rows[v3.input_features])
var_m = lgb.LGBMRegressor(**params).fit(Xfit, np.log((fit_rows['y3'].to_numpy() - lg_fit) ** 2 + 1e-6))
res['LGBM v3 + 이분산 오차 모델'] = prob_metrics(lg_va, np.exp(var_m.predict(Xva) + 1.27))   # E[log χ²₁] = −1.27 보정 (×e^1.27 ≈ 3.56)
q = {a: lgb.LGBMRegressor(objective='quantile', alpha=a, **params).fit(Xfit, fit_rows['y3']).predict(Xva) for a in (0.05, 0.5, 0.95)}
qr = {'RMSE': np.sqrt(mean_squared_error(y_va, q[0.5])), 'MAE': mean_absolute_error(y_va, q[0.5]), 'R2': r2_score(y_va, q[0.5]),
      '커버리지 90%': float(np.mean((y_va >= q[0.05]) & (y_va <= q[0.95]))), '90% 구간 평균 폭': float(np.mean(q[0.95] - q[0.05]))}
res['LGBM 분위 회귀 (5·50·95%)'] = qr
LGB_NOPT = None
if NOPT:    # 사과 대 사과 : 같은 14개 변수 + v3 와 같은 하이퍼파라미터의 LGBM (HAVAA 계수도 v3 그대로)
    lgbm_np = lgb.LGBMRegressor(**v3.lgbm.get_params()).fit(Xfit[FEATS], fit_rows['y3'])
    LGB_NOPT = sm.AngleAdjustedStuffModel(lgbm_np, FEATS, v3.vaa_coef, vaa_default=getattr(v3, 'vaa_default', None))
    lgn_fit, lgn_va = LGB_NOPT.predict(fit_rows[v3.input_features]), LGB_NOPT.predict(va_rows[v3.input_features])
    res['LGBM 구종 제외 + 상수 분산'] = prob_metrics(lgn_va, np.full(len(lgn_va), float(np.std(fit_rows['y3'].to_numpy() - lgn_fit)) ** 2))
hof_va = {}
for k, net in nets.items():
    p = hn.predict(net, va_t)
    hof_va[k] = p
    res[f'HOF-Net {k}'] = prob_metrics(p['mean'], p['var'] + p['u_lat'])
point_prob = pd.DataFrame(res)
point_prob.to_csv(os.path.join(OUT, 'point_prob.csv'), encoding='utf-8-sig')
log('점·확률 예측\n' + point_prob.round(4).to_string())

dec = pd.DataFrame({'LGBM v3': lg_va, **{f'HOF {k}': hof_va[k]['mean'] for k in nets}, 'actual': y_va})
deciles = pd.DataFrame({m: dec.groupby(pd.qcut(dec[m], 10, labels=False))['actual'].mean() for m in dec.columns if m != 'actual'}).T
deciles.to_csv(os.path.join(OUT, 'deciles.csv'), encoding='utf-8-sig')

# ---------------------------------------------------------------------------
# 4. 구위 점수 단계 지표 (지금까지와 같은 정의)
# ---------------------------------------------------------------------------
def season_pred(k):
    out = {}
    for y in fr:
        if k == 'LGBM v3':
            out[y] = v3.predict(fr[y][v3.input_features])
        elif k == 'LGBM 구종 제외':
            out[y] = LGB_NOPT.predict(fr[y][v3.input_features])
        else:
            out[y] = hn.predict(nets[k], T(fr[y]))['mean']
    return out

def within_corr(d, col, loc, min_n=100):
    x = pd.DataFrame({'g1': d['pitcher'].to_numpy(), 'g2': d['pitch_type'].astype(str).to_numpy(), 'a': num(d[col]), 'b': num(d[loc])}).dropna()
    x = x.assign(ab=x['a'] * x['b'], aa=x['a'] ** 2, bb=x['b'] ** 2)
    s = x.groupby(['g1', 'g2']).agg(n=('a', 'size'), a=('a', 'sum'), b=('b', 'sum'), ab=('ab', 'sum'), aa=('aa', 'sum'), bb=('bb', 'sum'))
    s = s[s['n'] >= min_n]
    r = (s['ab'] - s['a'] * s['b'] / s['n']) / np.sqrt((s['aa'] - s['a'] ** 2 / s['n']) * (s['bb'] - s['b'] ** 2 / s['n']))
    ok = r.notna() & np.isfinite(r)
    return float(np.average(r[ok], weights=s['n'][ok]))

def validity(d, col):
    d = d.assign(swing=d['description'].isin(ew.SWING_DESC), whiff=d['description'].isin(sp.WHIFF_DESC), xc=d['estimated_woba_using_speedangle'].where(d['type'] == 'X'))
    pp = d.groupby(['pitcher', 'pitch_type'], observed=True).agg(n=('swing', 'size'), s=(col, 'mean'), sw=('swing', 'sum'), wh=('whiff', 'sum'), xc=('xc', 'mean')).query('n >= 100')
    pt = d.groupby('pitcher').agg(n=('swing', 'size'), s=(col, 'mean'), sw=('swing', 'sum'), wh=('whiff', 'sum')).query('n >= 300')
    return {'투수×구종 ρ(구위, whiff%)': stats.spearmanr(pp['s'], pp['wh'] / pp['sw']).statistic,
            '투수×구종 ρ(구위, xwOBAcon)': stats.spearmanr(pp['s'], pp['xc'], nan_policy='omit').statistic,
            '투수 ρ(구위, whiff%)': stats.spearmanr(pt['s'], pt['wh'] / pt['sw']).statistic}

def pt_means(d, col, min_n=100):
    g = d.assign(pitch_type=d['pitch_type'].astype(str)).groupby(['pitcher', 'pitch_type'])[col].agg(['mean', 'count'])
    return g[g['count'] >= min_n]['mean']

def pt_whiff(d, min_n=100):
    g = d.assign(pitch_type=d['pitch_type'].astype(str), sw=d['description'].isin(ew.SWING_DESC), wh=d['description'].isin(sp.WHIFF_DESC)) \
         .groupby(['pitcher', 'pitch_type']).agg(n=('sw', 'size'), sw=('sw', 'sum'), wh=('wh', 'sum'))
    g = g[g['n'] >= min_n]
    return g['wh'] / g['sw']

def buckets(d, col):
    bins = pd.cut(d[col], ew.STUFF_BINS, labels=ew.STUFF_BIN_LABELS, right=False)
    return pd.DataFrame({lab: ew.outcome_rates(d[bins == lab]) for lab in ew.STUFF_BIN_LABELS}).T

scalers, stuff_cols, rows = {}, {}, {}
for k in ['LGBM v3'] + (['LGBM 구종 제외'] if NOPT else []) + list(nets):
    pred = season_pred(k)
    sc = v3_scaler if k == 'LGBM v3' else sp.StuffScaler().fit(pred[2025][is_tr & ~d25['waste'].to_numpy()])
    scalers[k] = sc
    col = f's_{k}'
    for y in fr:
        raw = sc.transform(pred[y]).astype('float32')
        fr[y][f'raw_{k}'] = raw
        fr[y][col] = pd.Series(raw, index=fr[y].index).where(~fr[y]['waste'])
    r = {}
    r.update({f'검증 {a}': v for a, v in validity(fr[2025][~is_tr], col).items()})
    for y in (2024, 2026):
        b = buckets(fr[y], col)
        r[f'{y} BA 격차'] = b.loc['<40', 'ba'] - b.loc['60+', 'ba']
        r[f'{y} Whiff 격차'] = b.loc['60+', 'whiff'] - b.loc['<40', 'whiff']
    for a, b in [(2024, 2025), (2025, 2026)]:
        mm = pd.concat([pt_means(fr[a], col), pt_means(fr[b], col)], axis=1, join='inner')
        r[f'안정성 r(구위 {a}, 구위 {b})'] = mm.corr().iloc[0, 1]
        w = pd.concat([pt_means(fr[a], col), pt_whiff(fr[b])], axis=1, join='inner')
        r[f'예측력 ρ(구위 {a}, whiff% {b})'] = stats.spearmanr(w.iloc[:, 0], w.iloc[:, 1]).statistic
    d26 = fr[2026]
    r['투수×구종 내 corr(점수, 높이 정규화)'] = within_corr(d26, col, 'plate_z_norm')
    r['투수×구종 내 corr(점수, |plate_x|)'] = within_corr(d26.assign(abs_x=d26['plate_x'].abs()), col, 'abs_x')
    rawc = d26[f'raw_{k}']
    top = rawc >= rawc.quantile(0.99)
    ball, out_zone, hbp = d26['description'].isin(sp.BALL_DESC), d26['zone'] >= 11, d26['description'] == 'hit_by_pitch'
    r['사구 평균 점수 (raw)'] = float(rawc[hbp].mean())
    r['상위 1% 중 존 밖 볼 비율 (raw)'] = float((ball & out_zone)[top].mean())
    if k != 'LGBM v3':
        r['LGBM 과의 투구별 점수 상관 (2026)'] = float(np.corrcoef(d26[f'raw_{k}'], d26['raw_LGBM v3'])[0, 1])
        both = pd.concat([pt_means(d26, col), pt_means(d26, 's_LGBM v3')], axis=1, join='inner')
        r['LGBM 과의 투수×구종 평균 상관 (2026)'] = float(both.corr().iloc[0, 1])
    rows[k] = r
    log(f'구위 지표 {k} 완료')
stuff_cmp = pd.DataFrame(rows)
stuff_cmp.to_csv(os.path.join(OUT, 'stuff_metrics.csv'), encoding='utf-8-sig')
log('구위 지표\n' + stuff_cmp.round(4).to_string())

# ---------------------------------------------------------------------------
# 5. 구위 산출 근거 : 운영 export_web_data.explain_contrib 를 그대로 호출 (2026 표본 2만 구)
# ---------------------------------------------------------------------------
class TreeShapV3:    # LGBM 은 정확한 TreeSHAP 으로 비교 (운영도 SHAP 캐시 사용)
    def __init__(self, m): self.m = m
    def explain(self, X, exact=False): return self.m.explain(X, exact=True)
    def method(self, exact=False): return 'shap'

const_rmse = float(np.std(es_rows['y3'].to_numpy()))
best_rmse = {k: float(h['holdout_rmse'].min()) for k, h in hists.items()}
EK = min([k for k in nets if k.startswith('A0')], key=lambda k: best_rmse[k])   # 근거 비교 · Go/No-Go 대상 = 가장 잘 학습된 A0 계열
HK = f'HOF-Net {EK}'
log('근거 비교 대상', EK, best_rmse)
s26 = fr[2026].sample(20000 if not SMOKE else 3000, random_state=SEED)
X26 = s26[v3.input_features]
hof = hn.HOFNetStuffModel(nets[EK], prep, v3)
groups = [g for g, _ in ew.EXPLAIN_GROUPS]
targets = [('LGBM v3', TreeShapV3(v3), v3, scalers['LGBM v3'])]
if NOPT:
    targets.append(('LGBM 구종 제외', TreeShapV3(LGB_NOPT), LGB_NOPT, scalers['LGBM 구종 제외']))
for k in dict.fromkeys([EK, 'A0-βNLL', 'A5', 'A5-βNLL']):
    if k in nets:
        m_ = hn.HOFNetStuffModel(nets[k], prep, v3)
        targets.append((f'HOF-Net {k}', m_, m_, scalers[k]))
expl = {}
for k, model, pm, sc in targets:
    pred = pm.predict(X26)
    score = sc.transform(pred)
    c, S0, method = ew.explain_contrib(model, sc, X26, pred, score, 2026, None)
    err = np.abs(S0 + c.sum(1) - score)
    expl[k] = {'c': c, 'S0': S0, 'method': method, 'score': score, 'additivity_err_points': float(err.max())}
    log(f'근거 {k} : method {method}, S0 {S0:.2f}, 가법성 오차 최대 {err.max():.2e} · 99% {np.quantile(err, 0.99):.2e}')
rows_e = {}
for k, e in expl.items():
    c = e['c']
    share = np.abs(c).mean(0) / np.abs(c).mean(0).sum()
    r = {'method': e['method'], '기준 점수 S0': e['S0'], '가법성 오차 최대 (점)': e['additivity_err_points'],
         **{f'{g} 비중': float(share[j]) for j, g in enumerate(groups)}}
    for ref in [t[0] for t in targets if t[0].startswith('LGBM')]:
        if ref == k:
            continue
        cr = expl[ref]['c']
        r[f'[{ref}] 구위 상관'] = float(np.corrcoef(e['score'], expl[ref]['score'])[0, 1])
        r[f'[{ref}] 최대 + 요인 일치율'] = float(np.mean(cr.argmax(1) == c.argmax(1)))
        r[f'[{ref}] 최대 − 요인 일치율'] = float(np.mean(cr.argmin(1) == c.argmin(1)))
        for j, g in enumerate(groups):
            r[f'[{ref}] {g} 투구별 상관'] = float(np.corrcoef(cr[:, j], c[:, j])[0, 1]) if cr[:, j].std() > 0 and c[:, j].std() > 0 else np.nan
    rows_e[k] = r
agree = pd.DataFrame(rows_e)
agree.to_csv(os.path.join(OUT, 'explain_agreement_variants.csv'), encoding='utf-8-sig')
ca, cb = expl['LGBM v3']['c'], expl[HK]['c']
top_up = float(np.mean(ca.argmax(1) == cb.argmax(1)))
top_dn = float(np.mean(ca.argmin(1) == cb.argmin(1)))
log('근거 일치도 (버전별)' + chr(10) + agree.round(3).to_string())

ex_rows = []
pick = {'HOF 고득점 FF': s26.assign(sc=expl[HK]['score'])[s26['pitch_type'].astype(str) == 'FF']['sc'].idxmax(),
        'HOF 고득점 SL': s26.assign(sc=expl[HK]['score'])[s26['pitch_type'].astype(str) == 'SL']['sc'].idxmax(),
        'HOF 저득점': s26.assign(sc=expl[HK]['score'])['sc'].idxmin()}
pos = {ix: i for i, ix in enumerate(s26.index)}
for name, ix in pick.items():
    i = pos[ix]
    for k in expl:
        ex_rows.append({'투구': name, '구종': str(s26.loc[ix, 'pitch_type']), '모델': k, '기준 점수': round(expl[k]['S0'], 1),
                        **{g: round(float(expl[k]['c'][i, j]), 1) for j, g in enumerate(groups)}, '구위': round(float(expl[k]['score'][i]), 1)})
examples = pd.DataFrame(ex_rows)
examples.to_csv(os.path.join(OUT, 'explain_examples.csv'), index=False, encoding='utf-8-sig')
log('근거 예시\n' + examples.to_string())

# ---------------------------------------------------------------------------
# 6. 불확실성 · OOD · Go/No-Go
# ---------------------------------------------------------------------------
unc = {}
for k in [k for k, (kw, _, _) in VARIANTS.items() if kw['latent']]:
    p26 = hn.predict(nets[k], T(fr[2026]))
    v = fr[2026]['release_speed'].to_numpy('float64', na_value=np.nan)
    hi, lo = v > 98, v <= 95
    u = p26['u_lat']
    lab = np.r_[np.ones(hi.sum()), np.zeros(lo.sum())]
    unc[k] = {'U_latent 평균 (2025 검증)': float(hof_va[k]['u_lat'].mean()), 'U_alea 평균 (2025 검증)': float(hof_va[k]['var'].mean()),
              'U_latent 비중 (2025 검증)': float(hof_va[k]['u_lat'].mean() / (hof_va[k]['u_lat'] + hof_va[k]['var']).mean()),
              'OOD 구속 >98 vs ≤95 AUROC (U_latent)': float(roc_auc_score(lab, np.r_[u[hi], u[lo]])) if hi.sum() and lo.sum() else np.nan,
              'OOD 구속 >98 / ≤95 U_latent 평균비': float(u[hi].mean() / u[lo].mean()) if hi.sum() else np.nan,
              '2026 / 2025 검증 U_latent 평균비': float(u.mean() / hof_va[k]['u_lat'].mean())}
unc = pd.DataFrame(unc)
unc.to_csv(os.path.join(OUT, 'uncertainty_ood.csv'), encoding='utf-8-sig')
log('불확실성 · OOD\n' + unc.round(5).to_string())

net = nets[EK]; net.eval()
with torch.no_grad():
    b = slice(0, 4096)
    o = net(va_t[0][b], va_t[1][b], va_t[2][b])
    Sig = o['s'].unsqueeze(2) * o['R'] * o['s'].unsqueeze(1)
    lam_min = float(torch.linalg.eigvalsh(Sig.double()).min())
    mean_c, var_lat, _ = None, None, None
    mean_cf, var_a, u_l = net.predictive(o)
    mc = {}
    for M in (16, 32, 64):
        torch.manual_seed(SEED)
        mm, vv = net.sample_mean(o, M)
        mc[M] = (float((mm - mean_cf).abs().max()), float(((vv - (var_a + u_l)).abs() / (var_a + u_l)).mean()))
h0 = hists[EK]
gonogo = {'점검 대상': EK, 'Check 1 : Σ 최소 고윳값 (≥ −ε)': lam_min,
          'Check 2 : NaN 배치 / Cholesky 실패': f"{int(h0['nan_batches'].sum())} / {int(h0['chol_fail'].sum())}",
          'Check 3 : 마지막 epoch 학습 KL (붕괴 아님 > 0.01)': float(h0['train_kl'].iloc[-1]),
          'Check 4 : τ 최대 (폭주 아님)': float(h0['tau_max'].max()),
          **{f'Check 5 : MC M={M} 평균 최대 오차 / 분산 평균 상대오차': f'{a:.2e} / {r:.3f}' for M, (a, r) in mc.items()},
          'Check 6 : 대각(A1) 먼저 정상 동작 (A1 학습 완료, NaN 0)': f"{len(hists['A1'])} epoch, NaN {int(hists['A1']['nan_batches'].sum())}"}
collapse = pd.DataFrame({k: {'β': VARIANTS[k][1], 'β-NLL': VARIANTS[k][2], '마지막 epoch 학습 KL (투구당)': float(h['train_kl'].iloc[-1]),
                             '홀드아웃 RMSE (최저)': best_rmse[k], '상수 예측 RMSE': const_rmse,
                             '상수 대비 RMSE 개선 %': 100 * (1 - best_rmse[k] / const_rmse),
                             '검증 예측 표준편차': float(hof_va[k]['mean'].std()), 'epoch': len(h), '학습 초': times[k]}
                         for k, h in hists.items()}).T
collapse.to_csv(os.path.join(OUT, 'collapse_check.csv'), encoding='utf-8-sig')
log('붕괴 점검' + chr(10) + collapse.round(5).to_string())
summary = {'gonogo': gonogo, 'explain_variant': EK, 'lgbm_holdout_rmse': float(np.sqrt(np.mean((es_rows['y3'].to_numpy() - v3.predict(es_rows[v3.input_features])) ** 2))), 'times_sec': times, 'epochs': {k: len(h) for k, h in hists.items()},
           'top_factor_agreement': {'up': top_up, 'down': top_dn},
           'explain': {k: {'S0': v['S0'], 'method': v['method'], 'additivity_err_points': v['additivity_err_points']} for k, v in expl.items()},
           'n': {'train': len(tr_rows), 'holdout': len(es_rows), 'valid': len(va_rows)}, 'smoke': SMOKE, 'total_sec': time.time() - T0}
json.dump(summary, open(os.path.join(OUT, 'summary.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=str)
log('Go/No-Go', json.dumps(gonogo, ensure_ascii=False, indent=1))
log('끝')
