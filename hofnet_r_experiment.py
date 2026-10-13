"""
HOF-Net-R vs 기존 HOF-Net vs LGBM(v4, 웹 모델) 비교 — HOF_Net_Failure_Analysis_Revision_v1.pdf 의 P0~P4 + E1

실행 : python hofnet_r_experiment.py --part synth|real [--smoke] [--threads 8]
       synth : E1 합성 데이터 점검 (Gate 0)  -> outputs/hofnet_r/synth_*.csv
       real  : 2025 실데이터 P0~P4 (시드 42–46) -> outputs/hofnet_r/*.csv, summary.json
       --smoke : 표본 축소 · 2 epoch 코드 점검 (출력 outputs/hofnet_r/smoke/)
입력 : outputs/vaa_exp/cache/ (hofnet_experiment.py 와 같은 캐시), models/v4, outputs/hofnet_nopt/hof_*.pt (기존 HOF-Net, 구종 제외판)
변수 : v4 14개 (구종 제외, HAVAA). split · 표본 · 구위 지표 정의는 hofnet_experiment.py 와 같다
"""
import argparse, json, os, time, warnings
os.environ.setdefault('LOKY_MAX_CPU_COUNT', str(os.cpu_count()))
import joblib
import numpy as np
import pandas as pd
import torch
import lightgbm as lgb
from scipy import stats
from sklearn.linear_model import Ridge
from sklearn.metrics import roc_auc_score

import stuff_pipeline as sp
import stuff_model as sm
import export_web_data as ew
import hof_net as hn
import hof_net_r as hr

warnings.filterwarnings("ignore")
import sys
sys.stdout.reconfigure(encoding="utf-8")
ap = argparse.ArgumentParser()
ap.add_argument('--part', choices=['synth', 'real'], required=True)
ap.add_argument('--smoke', action='store_true')
ap.add_argument('--threads', type=int, default=8)
ARGS = ap.parse_args()
SMOKE = ARGS.smoke
SEEDS = [42, 43] if SMOKE else [42, 43, 44, 45, 46]
EPOCHS = 2 if SMOKE else 30
torch.set_num_threads(ARGS.threads)
OUT = os.path.join('outputs', 'hofnet_r', 'smoke') if SMOKE else os.path.join('outputs', 'hofnet_r')
os.makedirs(OUT, exist_ok=True)
T0 = time.time()
LOG = open(os.path.join(OUT, f'{ARGS.part}_log.txt'), 'a', encoding='utf-8')


def log(*a):
    s = f'[{time.time() - T0:6.0f}s] ' + ' '.join(str(x) for x in a)
    print(s, flush=True); LOG.write(s + '\n'); LOG.flush()


def save(df, name, **kw):
    df.to_csv(os.path.join(OUT, name), encoding='utf-8-sig', **kw)


def raw_tensors(X):
    """범주 없는 합성 데이터용 (xn, miss, xc)"""
    xn = torch.from_numpy(X.astype(np.float32))
    return xn, torch.zeros_like(xn), torch.zeros(len(X), 0, dtype=torch.int64)


def run_r(tr, es, cat_cards, n_num, seed, log_fn, epochs=EPOCHS, batch=1024, patience=4):
    """Stage I (P1) + 상수 분산 BLR (P2) + 이분산 BLR (P2h). 반환 dict (net, 표준화 상수, BLR, 분산 헤드, 기록)"""
    y_tr = tr[3]
    y_mean, y_std = float(y_tr.mean()), float(y_tr.std())
    torch.manual_seed(seed)
    net = hr.HOFNetR(n_num, cat_cards)
    hist = hr.fit_mean(net, tr, es, y_mean, y_std, epochs=epochs, batch=batch, patience=patience, seed=seed, log=log_fn)
    f_tr, z_tr = hr.encode_all(net, tr, y_mean, y_std)
    f_es, z_es = hr.encode_all(net, es, y_mean, y_std)
    r_tr, r_es = tr[3].double().numpy() - f_tr, es[3].double().numpy() - f_es
    s2 = float(np.var(r_tr))
    # τ0 : 홀드아웃 예측 NLL 그리드 (상수 분산)
    best = None
    for tau0 in (0.01, 0.03, 0.1, 0.3, 1.0, 3.0):
        b = hr.BLRHead(tau0).fit(z_tr, r_tr, np.full(len(r_tr), s2))
        nll = float(hr.gauss_nll_np(r_es, b.shift(z_es), s2 + b.u_global(z_es)).mean())
        if best is None or nll < best[0]:
            best = (nll, tau0, b)
    _, tau0, blr = best
    vh = hr.fit_var_head(z_tr, r_tr, z_es, r_es, epochs=2 if SMOKE else 20, seed=seed, log=log_fn)
    v_tr = hr.var_of(vh, z_tr)
    blr_h = hr.BLRHead(tau0).fit(z_tr, r_tr, v_tr)
    return {'net': net, 'y_mean': y_mean, 'y_std': y_std, 's2': s2, 'tau0': tau0, 'blr': blr, 'vh': vh, 'blr_h': blr_h,
            'hist': hist, 'z_tr': z_tr, 'r_tr': r_tr, 'v_tr': v_tr, 'z_es': z_es}


def r_predict(m, tensors):
    """HOF-Net-R Gaussian 예측 : P1 평균, P2(상수 σ²) / P2h(σ_a²(x)) 평균·분산 분해"""
    f, z = hr.encode_all(m['net'], tensors, m['y_mean'], m['y_std'])
    va = hr.var_of(m['vh'], z)
    return {'P1': (f, np.full(len(f), m['s2']), np.zeros(len(f))),
            'P2': (f + m['blr'].shift(z), np.full(len(f), m['s2']), m['blr'].u_global(z)),
            'P2h': (f + m['blr_h'].shift(z), va, m['blr_h'].u_global(z)), 'z': z}


# ===========================================================================
# E1 : 합성 데이터 (7.1절, 식 34–37)
# ===========================================================================
if ARGS.part == 'synth':
    K = 15
    Sx = 0.3 ** np.abs(np.subtract.outer(np.arange(K), np.arange(K)))
    Lx = np.linalg.cholesky(Sx)
    sigm = lambda x: 0.15 + np.log1p(np.exp(0.5 * x))
    DGP = {'strong': lambda X, e: 2 * X[:, 0] - 1.5 * X[:, 1] + 1.2 * X[:, 0] * X[:, 2] + 0.3 * e,
           'weak': lambda X, e: 0.15 * X[:, 0] - 0.12 * X[:, 1] + 0.1 * X[:, 0] * X[:, 2] + e,
           'hetero': lambda X, e: X[:, 0] * X[:, 1] + sigm(X[:, 2]) * e}
    NS = [2000, 5000] if SMOKE else [2000, 10000, 50000]
    # 학습 예산 (기존·수정 모델 같은 값) : 작은 N 은 batch 256 으로 step 수 확보. 50,000 은 계산량 때문에 strong · 시드 42 만
    syn_cfg = lambda N: dict(epochs=2 if SMOKE else 100, batch=256 if N <= 2000 else 1024, patience=6)
    syn_seeds = lambda dgp, N: SEEDS if N < 50000 else ([42] if dgp == 'strong' else [])
    rows, hist_rows = [], []
    for dgp, fn in DGP.items():
        for N in NS:
            SYN = syn_cfg(N)
            for seed in syn_seeds(dgp, N):
                rng = np.random.default_rng(seed)
                gen = lambda n: (lambda X: (X, fn(X, rng.standard_normal(n))))(rng.standard_normal((n, K)) @ Lx.T)
                (Xtr, ytr), (Xes, yes), (Xte, yte) = gen(N), gen(max(N // 5, 500)), gen(10000)
                tr = (*raw_tensors(Xtr), torch.tensor(ytr, dtype=torch.float32))
                es = (*raw_tensors(Xes), torch.tensor(yes, dtype=torch.float32))
                te = raw_tensors(Xte)
                rec = lambda name, mean, var=None, **kw: rows.append(
                    {'DGP': dgp, 'N': N, 'seed': seed, 'model': name, 'RMSE': float(np.sqrt(np.mean((yte - mean) ** 2))),
                     'R2': float(1 - np.mean((yte - mean) ** 2) / np.var(yte)),
                     'NLL': float(hr.gauss_nll_np(yte, mean, var).mean()) if var is not None else np.nan,
                     'CRPS': float(hr.gauss_crps(yte, mean, np.sqrt(var)).mean()) if var is not None else np.nan,
                     'pred_sd': float(np.std(mean)), **kw})
                rec('상수 평균', np.full(len(yte), ytr.mean()), np.full(len(yte), ytr.var()))
                quiet = lambda s: None
                for name, kw, beta in (('기존 A0 (β=1)', dict(cov='full', latent=True), 1.0), ('기존 A5 (결정적)', dict(cov='full', latent=False), 1.0)):
                    torch.manual_seed(seed)
                    net = hn.HOFNet(K, [], **kw)
                    h = hn.fit(net, tr, es, beta=beta, seed=seed, **SYN, log=quiet)
                    p = hn.predict(net, te)
                    rec(name, p['mean'], p['var'] + p['u_lat'], kl_last=float(h['train_kl'].iloc[-1]), epochs=len(h))
                m = run_r(tr, es, [], K, seed, quiet, **SYN)
                p = r_predict(m, te)
                for k in ('P1', 'P2', 'P2h'):
                    mean, va, ug = p[k]
                    rec(f'HOF-Net-R {k}', mean, va + ug, epochs=len(m['hist']), u_global=float(ug.mean()))
                hist_rows += [{'DGP': dgp, 'N': N, 'seed': seed, **h} for h in m['hist']]
                log(dgp, N, seed, pd.DataFrame(rows[-6:])[['model', 'RMSE', 'R2', 'CRPS']].round(4).to_string(index=False))
    res = pd.DataFrame(rows)
    save(res, 'synth_runs.csv', index=False)
    save(pd.DataFrame(hist_rows), 'synth_train_history.csv', index=False)
    agg = res.groupby(['DGP', 'N', 'model'], sort=False)[['RMSE', 'R2', 'CRPS', 'pred_sd']].agg(['mean', 'std'])
    agg.columns = [f'{a} {b}' for a, b in agg.columns]
    save(agg, 'synth_summary.csv')
    log('E1 요약\n' + agg.round(4).to_string())
    # Gate 0 : 강한 신호에서 P1 이 상수 기준을 개선 (모든 시드, 모든 N)
    st = res[(res['DGP'] == 'strong') & (res['model'] == 'HOF-Net-R P1')]
    g0 = {'strong P1 R2 최소': float(st['R2'].min()), 'strong P1 R2 평균': float(st['R2'].mean()),
          'strong 기존 A0 R2 평균': float(res[(res['DGP'] == 'strong') & (res['model'] == '기존 A0 (β=1)')]['R2'].mean()),
          'Gate 0 통과 (P1 R2 > 0.5 모든 시드·N)': bool(st['R2'].min() > 0.5)}
    json.dump(g0, open(os.path.join(OUT, 'synth_gate0.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
    log('Gate 0', g0)
    log('끝')
    raise SystemExit

# ===========================================================================
# 실데이터 1. 데이터 (hofnet_experiment.py 1절과 같은 캐시 · split, v4 변수 14개)
# ===========================================================================
SEED = 42
CACHE = os.path.join('outputs', 'vaa_exp', 'cache')
num = lambda s: s.to_numpy('float64', na_value=np.nan)
v4 = sm.load_model(os.path.join('models', 'v4'))
v3 = sm.load_model(os.path.join('models', 'v3'))
v4_scaler = joblib.load(os.path.join('models', 'v4', 'stage4_stuff_scaler.joblib'))
FEATS = list(v4.features)
NUM = [f for f in FEATS if f not in sp.STUFF_CAT_FEATURES]
CAT = [c for c in sp.STUFF_CAT_FEATURES if c in FEATS]
WEB = ['pa_event', 'is_swing', 'is_whiff', 'result', 'xwoba', 'plate_z_norm']
cols = sorted(set(v4.input_features) | {'pitcher', 'game_date', 'description', 'type', 'estimated_woba_using_speedangle', 'zone',
                                        'plate_x', 'waste'} | set(WEB))
fr = {}
for y in (2024, 2025, 2026):
    fr[y] = pd.read_parquet(os.path.join(CACHE, f'frame_{y}.parquet'), columns=cols + (['y3', 'split'] if y == 2025 else []))
    fr[y]['vaa_aa'] = v4.model_frame(fr[y][v4.input_features])['vaa_aa'].to_numpy()
chk = fr[2025].iloc[:50000]
assert np.allclose(v3.model_frame(chk[v3.input_features])['vaa_aa'], chk['vaa_aa'], equal_nan=True), 'v3/v4 HAVAA 불일치'
valid_start = pd.Timestamp(pd.read_json(os.path.join(CACHE, 'meta.json'), typ='series')['valid_start'])
d25 = fr[2025]
is_tr = (d25['game_date'] < valid_start).to_numpy()
samp = d25[d25['y3'].notna()]
tr_rows, es_rows, va_rows = samp[samp['split'] == 'tr'], samp[samp['split'] == 'es'], samp[samp['split'] == 'va']
if SMOKE:
    tr_rows, es_rows, va_rows = tr_rows.sample(20000, random_state=SEED), es_rows.sample(4000, random_state=SEED), va_rows.sample(6000, random_state=SEED)
    fr = {y: d.sample(60000, random_state=SEED) for y, d in fr.items()}
    d25 = fr[2025]; is_tr = (d25['game_date'] < valid_start).to_numpy()
log('표본 train', len(tr_rows), 'holdout', len(es_rows), 'valid', len(va_rows))

prep = hn.Prep(tr_rows, NUM, CAT)
T = lambda df: prep(df[FEATS])
Y = lambda df: torch.tensor(df['y3'].to_numpy(np.float32))
tr_t, es_t, va_t = (*T(tr_rows), Y(tr_rows)), (*T(es_rows), Y(es_rows)), T(va_rows)
y_tr_np, y_es, y_va = tr_rows['y3'].to_numpy(), es_rows['y3'].to_numpy(), va_rows['y3'].to_numpy()

# 단위 점검 (부록 A.2 · Listing 2)
with torch.no_grad():
    mq, sq = torch.randn(17, dtype=torch.float64), torch.rand(17, dtype=torch.float64) + 0.1
    kl_ref = torch.distributions.kl_divergence(torch.distributions.Normal(mq, sq), torch.distributions.Normal(0.0, 0.7)).sum() / 1000
    lz = torch.randn(5)
    zib0 = hr.zero_inflated_beta_nll(torch.zeros(5), lz, torch.randn(5), torch.randn(5))
UNIT = {'KL/N 해석해 오차': float((hr.global_kl_per_observation(mq, sq, 0.7, 1000) - kl_ref).abs()),
        'ZIB y=0 NLL − (−log π) 최대 오차': float((zib0 + torch.nn.functional.logsigmoid(lz)).abs().max())}
log('단위 점검', UNIT)

# ===========================================================================
# 2. P0 기준선 : 상수 · Ridge · LGBM v4 (운영 + 시드 재학습) · LGBM+이분산 오차모델
# ===========================================================================
fit_rows = pd.concat([tr_rows, es_rows])
Xfit, Xva = v4.model_frame(fit_rows[v4.input_features]), v4.model_frame(va_rows[v4.input_features])
point, prob, preds_va = {}, {}, {}
res_rows = []    # 시드별 검증 지표 (model, seed, 지표...)


def add_res(model, seed, metrics):
    res_rows.append({'model': model, 'seed': seed, **metrics})


add_res('상수 평균', 0, hr.gauss_metrics(y_va, np.full(len(y_va), y_tr_np.mean()), np.full(len(y_va), y_tr_np.var())))


def ridge_design(df):
    xn, miss, xc = T(df)
    return np.column_stack([xn.numpy(), miss.numpy(), np.eye(prep.cat_cards[0] + 1)[xc[:, 0].numpy()]])


rg = Ridge(alpha=1.0).fit(ridge_design(tr_rows), y_tr_np)
rg_va = rg.predict(ridge_design(va_rows))
add_res('Ridge', 0, hr.gauss_metrics(y_va, rg_va, np.full(len(y_va), np.var(y_tr_np - rg.predict(ridge_design(tr_rows))))))

lgb_params = v4.lgbm.get_params()
var_params = dict(n_estimators=400, learning_rate=0.05, num_leaves=63, min_child_samples=200, random_state=SEED, verbose=-1)
LGBM = {}
for seed in SEEDS:
    if seed == 42:    # 시드 42 = 운영 모델 그대로, 나머지 = 같은 하이퍼파라미터 · random_state 만 변경
        mdl = v4
    else:
        mdl = sm.AngleAdjustedStuffModel(lgb.LGBMRegressor(**{**lgb_params, 'random_state': seed}).fit(Xfit[FEATS], fit_rows['y3']),
                                         FEATS, v4.vaa_coef, vaa_default=getattr(v4, 'vaa_default', None))
    LGBM[seed] = mdl
    lg_fit, lg_va = mdl.predict(fit_rows[v4.input_features]), mdl.predict(va_rows[v4.input_features])
    var_m = lgb.LGBMRegressor(**{**var_params, 'random_state': seed}).fit(Xfit, np.log((fit_rows['y3'].to_numpy() - lg_fit) ** 2 + 1e-6))
    add_res('LGBM v4 + 상수 분산', seed, hr.gauss_metrics(y_va, lg_va, np.full(len(y_va), np.var(fit_rows['y3'].to_numpy() - lg_fit))))
    add_res('LGBM v4 + 이분산 오차모델', seed, hr.gauss_metrics(y_va, lg_va, np.exp(var_m.predict(Xva) + 1.27)))
    preds_va[('LGBM v4', seed)] = lg_va
    log('LGBM seed', seed, res_rows[-1]['RMSE'], res_rows[-1]['CRPS'])
lgbm_es_rmse = float(np.sqrt(np.mean((y_es - v4.predict(es_rows[v4.input_features])) ** 2)))

# 기존 HOF-Net (구종 제외판, 재학습 없음)
OLD = {}
for k in ['A0', 'A0-β0.01', 'A5']:
    pth = os.path.join('outputs', 'hofnet_nopt', f'hof_{k}.pt')
    ck = torch.load(pth, weights_only=False)
    assert ck['num'] == NUM and ck['cat'] == CAT, '기존 HOF-Net 변수 순서 불일치'
    net = hn.HOFNet(len(NUM), prep.cat_cards, **ck['kw']); net.load_state_dict(ck['state']); net.eval()
    OLD[k] = net
    p = hn.predict(net, va_t)
    add_res(f'기존 HOF-Net {k}', 42, hr.gauss_metrics(y_va, p['mean'], p['var'] + p['u_lat']))
    preds_va[(f'기존 HOF-Net {k}', 42)] = p['mean']
    log('기존 HOF-Net', k, res_rows[-1]['RMSE'])

# ===========================================================================
# 3. HOF-Net-R : P1 → P2 · P2h · P3(VI) · P4(ZIB), 시드 5개
# ===========================================================================
R, ZIB, hist_rows, vi_rows, zib_hist = {}, {}, [], [], []
for seed in SEEDS:
    t = time.time()
    log(f'=== HOF-Net-R seed {seed}')
    m = run_r(tr_t, es_t, prep.cat_cards, len(NUM), seed, lambda s: log('  ', s))
    m['time_stage1_2'] = time.time() - t
    hist_rows += [{'seed': seed, **h} for h in m['hist']]
    p = r_predict(m, va_t)
    for k in ('P1', 'P2', 'P2h'):
        mean, va, ug = p[k]
        add_res(f'HOF-Net-R {k}', seed, {**hr.gauss_metrics(y_va, mean, va + ug), 'U_global 평균': float(ug.mean()),
                                         'U_global 비중': float(ug.mean() / (va + ug).mean())})
        preds_va[(f'HOF-Net-R {k}', seed)] = mean
    # P3 : 같은 이분산 헤드를 변분 q(ω) 로 (KL/N) -> BLR 과 비교
    vi, vh_hist = hr.fit_vi_head(m['z_tr'], m['r_tr'], m['v_tr'], m['tau0'], epochs=2 if SMOKE else 15, seed=seed)
    Zv = hr.add_bias(p['z'])
    vm, vs = vi.m.detach().numpy(), vi.s.detach().numpy()
    f_va = p['P1'][0]
    ug_vi = (Zv ** 2) @ vs ** 2
    add_res('HOF-Net-R P3 (VI)', seed, {**hr.gauss_metrics(y_va, f_va + Zv @ vm, p['P2h'][1] + ug_vi), 'U_global 평균': float(ug_vi.mean()),
                                        'U_global 비중': float(ug_vi.mean() / (p['P2h'][1] + ug_vi).mean())})
    vi_rows.append({'seed': seed, 'τ0': m['tau0'], '|m_VI − m_BLR| 최대': float(np.abs(vm - m['blr_h'].m).max()),
                    '|m_BLR| 최대': float(np.abs(m['blr_h'].m).max()),
                    '예측 평균 차이 최대 (VI vs BLR)': float(np.abs(Zv @ vm - m['blr_h'].shift(p['z'])).max()),
                    's_VI / sd_BLR 중앙값': float(np.median(vs / np.sqrt(np.diag(m['blr_h'].S)))),
                    '마지막 KL 총량': vh_hist[-1]['kl_total'], '마지막 KL/N': vh_hist[-1]['kl_per_n'], 'N': len(m['r_tr'])})
    # P4 : ZIB 헤드 (encoder 고정)
    t = time.time()
    _, z_tr_t, h_tr = hr.encode_all(m['net'], tr_t, m['y_mean'], m['y_std'], flat=True)
    _, z_es_t, h_es = hr.encode_all(m['net'], es_t, m['y_mean'], m['y_std'], flat=True)
    zh, zh_hist = hr.fit_zib_head(h_tr, torch.from_numpy(z_tr_t), tr_t[3], h_es, torch.from_numpy(z_es_t), es_t[3],
                                  epochs=EPOCHS, seed=seed, log=lambda s: log('   ZIB', s))
    del h_tr, h_es
    zib_hist += [{'seed': seed, **h} for h in zh_hist]
    zp = hr.zib_predict_net(m['net'], zh, va_t, seed=seed, y=torch.tensor(y_va, dtype=torch.float32))
    add_res('HOF-Net-R P4 (ZIB)', seed, {**hr.zib_metrics(y_va, zp['pi'], zp['a'], zp['b'], zp['mean']), 'U_global 평균': float(zp['u_global'].mean()),
                                         'ZIB NLL': float(zp['nll'].mean()),
                                         'corr(π, 헛스윙)': float(np.corrcoef(zp['pi'], va_rows['description'].isin(sp.WHIFF_DESC).to_numpy())[0, 1])})
    m['zib_u_va'] = zp['u_global']
    preds_va[('HOF-Net-R P4 (ZIB)', seed)] = zp['mean']
    m['time_zib'] = time.time() - t
    R[seed], ZIB[seed] = m, zh
    torch.save({'net': m['net'].state_dict(), 'vh': m['vh'].state_dict(), 'zib': zh.state_dict(), 'y_mean': m['y_mean'], 'y_std': m['y_std'],
                's2': m['s2'], 'tau0': m['tau0'], 'blr': (m['blr'].m, m['blr'].S), 'blr_h': (m['blr_h'].m, m['blr_h'].S),
                'num': NUM, 'cat': CAT, 'mean': prep.mean.to_dict(), 'std': prep.std.to_dict(), 'cats': prep.cats},
               os.path.join(OUT, f'hofnet_r_seed{seed}.pt'))
    log(pd.DataFrame(res_rows[-5:]).set_index('model')[['RMSE', 'R2', 'CRPS', '보정 오차']].round(5).to_string())

res = pd.DataFrame(res_rows)
save(res, 'point_prob_by_seed.csv', index=False)
metric_cols = [c for c in res.columns if c not in ('model', 'seed')]
agg = res.groupby('model', sort=False)[metric_cols].agg(['mean', 'std'])
agg.columns = [f'{a} {b}' for a, b in agg.columns]
save(agg, 'point_prob.csv')
log('점·확률 예측 (시드 평균)\n' + res.groupby('model', sort=False)[['RMSE', 'R2', 'CRPS', 'NLL (Gaussian)', '보정 오차', '0점 Brier', 'bin log score']].mean().round(5).to_string())
save(pd.DataFrame(hist_rows), 'train_history_stage1.csv', index=False)
save(pd.DataFrame(zib_hist), 'train_history_zib.csv', index=False)
save(pd.DataFrame(vi_rows), 'vi_vs_blr.csv', index=False)

# 분위별 실제값 (시드 42)
dec = pd.DataFrame({k[0]: v for k, v in preds_va.items() if k[1] == 42} | {'actual': y_va})
deciles = pd.DataFrame({c: dec.groupby(pd.qcut(dec[c].rank(method='first'), 10, labels=False))['actual'].mean() for c in dec.columns if c != 'actual'}).T
save(deciles, 'deciles.csv')

# ===========================================================================
# 4. 투수 단위 cluster bootstrap : LGBM v4 대비 검증 RMSE 차이 (시드 42)
# ===========================================================================
rng = np.random.default_rng(SEED)
pit = va_rows['pitcher'].to_numpy()
upit, inv = np.unique(pit, return_inverse=True)
B = 200 if SMOKE else 1000
boot_idx = [rng.integers(0, len(upit), len(upit)) for _ in range(B)]
cnt = np.stack([np.bincount(b, minlength=len(upit)) for b in boot_idx])          # (B, 투수) 재표본 횟수
se = {k: (y_va - v) ** 2 for k, v in preds_va.items() if k[1] == 42}
ref = se[('LGBM v4', 42)]
w = cnt[:, inv]                                                                     # (B, n) 투구별 가중
boot = {}
for k, s in se.items():
    if k[0] == 'LGBM v4':
        continue
    d = np.sqrt((w * s).sum(1) / w.sum(1)) - np.sqrt((w * ref).sum(1) / w.sum(1))
    boot[k[0]] = {'RMSE 차이 (모델 − LGBM)': float(np.sqrt(s.mean()) - np.sqrt(ref.mean())),
                  '95% CI 하한': float(np.quantile(d, 0.025)), '95% CI 상한': float(np.quantile(d, 0.975))}
const_se = (y_va - y_tr_np.mean()) ** 2
for k in ('HOF-Net-R P1', 'HOF-Net-R P2h'):
    d = np.sqrt((w * se[(k, 42)]).sum(1) / w.sum(1)) - np.sqrt((w * const_se).sum(1) / w.sum(1))
    boot[f'{k} vs 상수'] = {'RMSE 차이 (모델 − LGBM)': float(np.sqrt(se[(k, 42)].mean()) - np.sqrt(const_se.mean())),
                          '95% CI 하한': float(np.quantile(d, 0.025)), '95% CI 상한': float(np.quantile(d, 0.975))}
boot = pd.DataFrame(boot).T
save(boot, 'bootstrap_rmse.csv')
log('cluster bootstrap\n' + boot.round(5).to_string())
del w

# ===========================================================================
# 5. 구위 점수 지표 (hofnet_experiment.py 4절 정의를 그대로 실행)
# ===========================================================================
_src = open('hofnet_experiment.py', encoding='utf-8').read()
exec(_src[_src.index('def within_corr'):_src.index('scalers, stuff_cols, rows = {}, {}, {}')])


def season_pred(kind, seed):
    out = {}
    for y in fr:
        X = fr[y]
        if kind == 'LGBM v4':
            out[y] = LGBM[seed].predict(X[v4.input_features])
        elif kind.startswith('기존'):
            out[y] = hn.predict(OLD[kind.split()[-1]], T(X))['mean']
        else:
            m = R[seed]
            t_ = T(X)
            if kind == 'HOF-Net-R P2h':
                f, z = hr.encode_all(m['net'], t_, m['y_mean'], m['y_std'])
                out[y] = f + m['blr_h'].shift(z)
            else:
                out[y] = hr.zib_predict_net(m['net'], ZIB[seed], t_, M=4, seed=seed)['mean']
    return out


stuff_rows, u26 = [], {}
d26 = fr[2026]
kinds = [('LGBM v4', s) for s in SEEDS] + [(f'기존 HOF-Net {k}', 42) for k in OLD] + \
        [(k, s) for s in SEEDS for k in ('HOF-Net-R P2h', 'HOF-Net-R P4 (ZIB)')]
raw_lgbm, cand = None, {}
for kind, seed in kinds:
    pred = season_pred(kind, seed)
    if seed == 42 and kind in ('LGBM v4', 'HOF-Net-R P2h', 'HOF-Net-R P4 (ZIB)', '기존 HOF-Net A5'):
        cand[kind] = pred[2025]
    sc = v4_scaler if (kind == 'LGBM v4' and seed == 42) else sp.StuffScaler().fit(pred[2025][is_tr & ~d25['waste'].to_numpy()])
    col = 's_cur'
    for y in fr:
        raw = sc.transform(pred[y]).astype('float32')
        fr[y]['raw_cur'] = raw
        fr[y][col] = pd.Series(raw, index=fr[y].index).where(~fr[y]['waste'])
    r = {'model': kind, 'seed': seed}
    r.update({f'검증 {a}': v for a, v in validity(fr[2025][~is_tr], col).items()})
    for y in (2024, 2026):
        b = buckets(fr[y], col)
        r[f'{y} BA 격차'] = b.loc['<40', 'ba'] - b.loc['60+', 'ba']
        r[f'{y} Whiff 격차'] = b.loc['60+', 'whiff'] - b.loc['<40', 'whiff']
    for a, b in [(2024, 2025), (2025, 2026)]:
        mm = pd.concat([pt_means(fr[a], col), pt_means(fr[b], col)], axis=1, join='inner')
        r[f'안정성 r(구위 {a}, 구위 {b})'] = mm.corr().iloc[0, 1]
        ww = pd.concat([pt_means(fr[a], col), pt_whiff(fr[b])], axis=1, join='inner')
        r[f'예측력 ρ(구위 {a}, whiff% {b})'] = stats.spearmanr(ww.iloc[:, 0], ww.iloc[:, 1]).statistic
    r['투수×구종 내 corr(점수, 높이 정규화)'] = within_corr(d26, col, 'plate_z_norm')
    r['투수×구종 내 corr(점수, |plate_x|)'] = within_corr(d26.assign(abs_x=d26['plate_x'].abs()), col, 'abs_x')
    rawc = d26['raw_cur']
    top = rawc >= rawc.quantile(0.99)
    ball, out_zone, hbp = d26['description'].isin(sp.BALL_DESC), d26['zone'] >= 11, d26['description'] == 'hit_by_pitch'
    r['사구 평균 점수 (raw)'] = float(rawc[hbp].mean())
    r['상위 1% 중 존 밖 볼 비율 (raw)'] = float((ball & out_zone)[top].mean())
    if kind == 'LGBM v4' and seed == 42:
        raw_lgbm, pt_lgbm = rawc.to_numpy().copy(), pt_means(d26, col)
    else:
        r['LGBM v4 와의 투구별 점수 상관 (2026)'] = float(np.corrcoef(rawc, raw_lgbm)[0, 1])
        both = pd.concat([pt_means(d26, col), pt_lgbm], axis=1, join='inner')
        r['LGBM v4 와의 투수×구종 평균 상관 (2026)'] = float(both.corr().iloc[0, 1])
    stuff_rows.append(r)
    log('구위 지표', kind, seed, round(r['검증 투수×구종 ρ(구위, whiff%)'], 4))
stuff = pd.DataFrame(stuff_rows)
save(stuff, 'stuff_metrics_by_seed.csv', index=False)
sc_cols = [c for c in stuff.columns if c not in ('model', 'seed')]
sagg = stuff.groupby('model', sort=False)[sc_cols].agg(['mean', 'std'])
sagg.columns = [f'{a} {b}' for a, b in sagg.columns]
save(sagg, 'stuff_metrics.csv')
log('구위 지표 (시드 평균)\n' + stuff.groupby('model', sort=False)[sc_cols].mean().T.round(4).to_string())

# 검증 ρ(whiff) 투수 단위 cluster bootstrap (시드 42 : HOF-Net-R P2h·P4 vs LGBM v4)
dv = fr[2025][~is_tr].copy()
dv['swing'], dv['whiff'] = dv['description'].isin(ew.SWING_DESC), dv['description'].isin(sp.WHIFF_DESC)
for k, v in cand.items():
    dv[k] = pd.Series(-v[~is_tr], index=dv.index).where(~dv['waste'])    # 높을수록 좋은 구위, waste 제외 (validity 와 같은 처리)
pp = dv.groupby(['pitcher', 'pitch_type'], observed=True).agg(n=('swing', 'size'), sw=('swing', 'sum'), wh=('whiff', 'sum'),
                                                               **{k: (k, 'mean') for k in cand}).query('n >= 100').reset_index()
pp['wr'] = pp['wh'] / pp['sw']
pits = pp['pitcher'].unique()
grp = {p_: np.where(pp['pitcher'].to_numpy() == p_)[0] for p_ in pits}
rb = {k: [] for k in cand if k != 'LGBM v4'}
for _ in range(B if len(pits) >= 10 else 0):    # smoke 표본은 n ≥ 100 그룹이 거의 없음
    idx = np.concatenate([grp[p_] for p_ in rng.choice(pits, len(pits))])
    s = pp.iloc[idx]
    base = stats.spearmanr(s['LGBM v4'], s['wr']).statistic
    for k in rb:
        rb[k].append(stats.spearmanr(s[k], s['wr']).statistic - base)
rho_boot = pd.DataFrame({k: {'ρ 차이 (모델 − LGBM)': stats.spearmanr(pp[k], pp['wr']).statistic - stats.spearmanr(pp['LGBM v4'], pp['wr']).statistic,
                             '95% CI 하한': float(np.quantile(v, 0.025)) if v else np.nan, '95% CI 상한': float(np.quantile(v, 0.975)) if v else np.nan} for k, v in rb.items()}).T
save(rho_boot, 'bootstrap_rho_whiff.csv')
log('ρ whiff bootstrap\n' + rho_boot.round(4).to_string())

# ===========================================================================
# 6. 불확실성 : 학습표본 크기별 U_global (E4, BLR 은 단조 감소 보장) · OOD 구속
# ===========================================================================
m = R[42]
p_va = r_predict(m, va_t)
size_rows = []
for frac in (0.1, 0.25, 0.5, 1.0):
    idx = np.random.default_rng(SEED).permutation(len(m['r_tr']))[:int(frac * len(m['r_tr']))]
    b = hr.BLRHead(m['tau0']).fit(m['z_tr'][idx], m['r_tr'][idx], m['v_tr'][idx])
    ug = b.u_global(p_va['z'])
    size_rows.append({'학습표본 비율': frac, 'n': len(idx), 'U_global 평균 (검증)': float(ug.mean()),
                      'U_alea 평균 (검증)': float(p_va['P2h'][1].mean()), 'U_global 비중': float(ug.mean() / (ug + p_va['P2h'][1]).mean())})
size_curve = pd.DataFrame(size_rows)
save(size_curve, 'uncertainty_size_curve.csv', index=False)
log('표본 크기 곡선\n' + size_curve.to_string())

p26 = r_predict(m, T(d26))
v = d26['release_speed'].to_numpy('float64', na_value=np.nan)
hi, lo = v > 98, v <= 95
lab = np.r_[np.ones(hi.sum()), np.zeros(lo.sum())]
zp26 = hr.zib_predict_net(m['net'], ZIB[42], T(d26), seed=42)
ood = {}
for k, u, u_va in (('HOF-Net-R P2h U_global', p26['P2h'][2], p_va['P2h'][2]), ('HOF-Net-R P2h U_alea', p26['P2h'][1], p_va['P2h'][1]),
                   ('HOF-Net-R P4 U_global', zp26['u_global'], m['zib_u_va'])):
    ood[k] = {'OOD 구속 >98 vs ≤95 AUROC': float(roc_auc_score(lab, np.r_[u[hi], u[lo]])), '>98 / ≤95 평균비': float(u[hi].mean() / u[lo].mean()),
              '2026 / 2025 검증 평균비': float(u.mean() / u_va.mean())}
old_unc = pd.read_csv(os.path.join('outputs', 'hofnet_nopt', 'uncertainty_ood.csv'), index_col=0, encoding='utf-8-sig')
for k in ('A0-β0.01',):
    ood[f'기존 HOF-Net {k} U_latent'] = {'OOD 구속 >98 vs ≤95 AUROC': float(old_unc.loc['OOD 구속 >98 vs ≤95 AUROC (U_latent)', k]),
                                        '>98 / ≤95 평균비': float(old_unc.loc['OOD 구속 >98 / ≤95 U_latent 평균비', k]),
                                        '2026 / 2025 검증 평균비': float(old_unc.loc['2026 / 2025 검증 U_latent 평균비', k])}
ood = pd.DataFrame(ood).T
save(ood, 'uncertainty_ood.csv')
log('OOD\n' + ood.round(4).to_string())

# 128 개 과적합 점검 (부록 A.3 gradient audit)
torch.manual_seed(SEED)
small = tuple(t_[:128] for t_ in tr_t)
net_s = hr.HOFNetR(len(NUM), prep.cat_cards, dropout=0.0)
opt = torch.optim.Adam(net_s.parameters(), lr=3e-3)
ys = (small[3] - small[3].mean()) / small[3].std()
for _ in range(100 if SMOKE else 600):
    f, _ = net_s(*small[:3]); loss = torch.nn.functional.mse_loss(f, ys)
    opt.zero_grad(); loss.backward(); opt.step()
overfit_mse = float(loss)

# ===========================================================================
# 7. Go/No-Go (논문 Table 5, Gate 1~3)
# ===========================================================================
mean_by = res.groupby('model', sort=False).mean(numeric_only=True)
by_seed = lambda k, c: res[res['model'] == k].set_index('seed')[c]
const_rmse_va = float(mean_by.loc['상수 평균', 'RMSE'])
lgbm_crps = by_seed('LGBM v4 + 이분산 오차모델', 'CRPS')
gate = {
    '단위 점검': UNIT,
    '128개 과적합 (표준화 MSE, 0 에 가까워야 함)': overfit_mse,
    'Gate 1 : P1 검증 RMSE (시드 평균) / 상수 / LGBM v4': [float(mean_by.loc['HOF-Net-R P1', 'RMSE']), const_rmse_va, float(mean_by.loc['LGBM v4 + 상수 분산', 'RMSE'])],
    'Gate 1 : P1 상수 대비 개선 (모든 시드)': bool((by_seed('HOF-Net-R P1', 'RMSE') < const_rmse_va).all()),
    'Gate 1 : P1 vs 상수 bootstrap CI 상한 < 0': bool(boot.loc['HOF-Net-R P1 vs 상수', '95% CI 상한'] < 0),
    'Gate 2 : U_global 표본 증가에 따라 단조 감소': bool(np.all(np.diff(size_curve['U_global 평균 (검증)']) < 0)),
    'Gate 2 : VI 평균이 BLR 과 일치 (예측 평균 차이 최대, 시드 평균)': float(pd.DataFrame(vi_rows)['예측 평균 차이 최대 (VI vs BLR)'].mean()),
    'Gate 3 : P2h CRPS < LGBM+이분산 (모든 시드)': bool((by_seed('HOF-Net-R P2h', 'CRPS').to_numpy() < lgbm_crps.to_numpy()).all()),
    'Gate 3 : P4 ZIB CRPS < LGBM+이분산 (모든 시드)': bool((by_seed('HOF-Net-R P4 (ZIB)', 'CRPS').to_numpy() < lgbm_crps.to_numpy()).all()),
    'Gate 3 : 보정 오차 P2h / P4 / LGBM+이분산': [float(mean_by.loc[k, '보정 오차']) for k in ('HOF-Net-R P2h', 'HOF-Net-R P4 (ZIB)', 'LGBM v4 + 이분산 오차모델')],
}
summary = {'gate': gate, 'lgbm_v4_holdout_rmse': lgbm_es_rmse, 'n': {'train': len(tr_rows), 'holdout': len(es_rows), 'valid': len(va_rows)},
           'seeds': SEEDS, 'tau0': {s: R[s]['tau0'] for s in R}, 'epochs_stage1': {s: len(R[s]['hist']) for s in R},
           'time_sec': {s: {'stage1_2': R[s]['time_stage1_2'], 'zib': R[s]['time_zib']} for s in R}, 'smoke': SMOKE, 'total_sec': time.time() - T0}
json.dump(summary, open(os.path.join(OUT, 'summary.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=str)
log('Go/No-Go', json.dumps(gate, ensure_ascii=False, indent=1, default=str))
log('끝')
