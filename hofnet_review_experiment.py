"""
교수님 검토(HOF_Net_R_Research_Improvement_Review_20261115.pdf) 개선안 실험 (시드 42 고정, 운영 반영 없음)

실행 : python hofnet_review_experiment.py [--runs b0,b3,...] [--smoke]
  b0  : LGBM v4 + Gaussian (상수 분산 / 이분산 오차모델)                       — 기준선
  b1a : LGBM v4 평균 유지 + ZIB (π = LGBM 분류기, m_B = μ/(1−π), κ 구간별 MLE)   — 우도 변경만의 효과
  b1b : two-part LGBM (분류기 π + 양수 행 cross-entropy 회귀 m_B + κ)            — LGBM 로 만든 ZIB
  b3  : HOF-Net-R P4 (Bayesian ZIB 헤드)                                         — 현재 접근
  b4  : HOF-Net-R + ZIB, Bayesian 제거 (ω 결정적, KL 없음)
  b2 / b5 : Residual MLP + ZIB (Bayesian / 제거)                                — attention 필요성
  rk  : 그룹 순위 손실 λr ∈ {0.01, 0.05, 0.1, 0.2} (Beta–Binomial 신뢰도 가중) + P4 헤드
  b6  : two-part HOF (π 인코더 BCE + 양수 인코더 MSE, κ 구간별 MLE)
  tc  : LGBM teacher 정규화 λt ∈ {0.3, 1.0} (투수 GroupKFold OOF teacher) + P4 헤드
출력 : outputs/hofnet_review/ (runs/*.json = 실행별 결과, 있으면 건너뜀 · results.csv · log.txt)
데이터 · split · 변수 : hofnet_diag_experiment.py 1절 / 구위 지표 : barrel_out_experiment.py 5절과 같다
"""
import argparse, json, os, sys, time, warnings
os.environ.setdefault('LOKY_MAX_CPU_COUNT', str(os.cpu_count()))
import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.nn.functional as F
import lightgbm as lgb
from scipy import stats
from sklearn.model_selection import GroupKFold

import export_web_data as ew
import hof_net as hn
import hof_net_r as hr
import stuff_model as sm
import stuff_pipeline as sp

warnings.filterwarnings('ignore')
sys.stdout.reconfigure(encoding='utf-8')
ALL_RUNS = ['b0', 'b1a', 'b1b', 'b3', 'b4', 'b2', 'b5', 'rk', 'b6', 'tc']
ap = argparse.ArgumentParser()
ap.add_argument('--runs', default=','.join(ALL_RUNS))
ap.add_argument('--smoke', action='store_true')
ARGS = ap.parse_args()
SMOKE = ARGS.smoke
SEED = 42
EPOCHS = 2 if SMOKE else 30
B = 50 if SMOKE else 1000
DELTA = 0.005    # 비열등성 허용 범위 (교수님 §8.2 의 후보값)
DEV = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
OUT = os.path.join('outputs', 'hofnet_review', 'smoke') if SMOKE else os.path.join('outputs', 'hofnet_review')
os.makedirs(os.path.join(OUT, 'runs'), exist_ok=True)
CACHE = os.path.join('outputs', 'vaa_exp', 'cache')
T0 = time.time()
LOG = open(os.path.join(OUT, 'log.txt'), 'a', encoding='utf-8')


def log(*a):
    s = f'[{time.time() - T0:7.0f}s] ' + ' '.join(str(x) for x in a)
    print(s, flush=True); LOG.write(s + '\n'); LOG.flush()


log('시작', vars(ARGS), 'device', DEV)

# ---------------------------------------------------------------------------
# 1. 데이터 (hofnet_diag_experiment.py 1절과 같은 캐시 · split · 변수) + 타구 정보
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
samp = d25[d25['y3'].notna()]
tr_rows, es_rows, va_rows = samp[samp['split'] == 'tr'], samp[samp['split'] == 'es'], samp[samp['split'] == 'va']
if SMOKE:
    tr_rows, es_rows = tr_rows.sample(20000, random_state=SEED), es_rows.sample(4000, random_state=SEED)
is_tr = (d25['game_date'] < valid_start).to_numpy()
waste = {y: fr[y]['waste'].fillna(True).to_numpy(bool) for y in fr}
va_pos = d25.index.get_indexer(va_rows.index)
y_va = va_rows['y3'].to_numpy()
log('표본 train', len(tr_rows), 'holdout', len(es_rows), 'valid', len(va_rows), '| 시즌', {y: len(d) for y, d in fr.items()})

prep = hn.Prep(tr_rows, NUM, CAT)
T_tr, T_es, T_va = prep(tr_rows), prep(es_rows), prep(va_rows)
T_season = {y: prep(fr[y]) for y in fr}
tt = lambda a: torch.tensor(np.asarray(a, dtype=np.float32))
y_tr_t, y_es_t = tt(tr_rows['y3']), tt(es_rows['y3'])
MF = {y: v4.model_frame(fr[y][v4.input_features])[FEATS] for y in fr}
mf_rows = lambda rows: MF[2025].loc[rows.index]
lgb_params = v4.lgbm.get_params()

# ---------------------------------------------------------------------------
# 2. 평가 (barrel_out_experiment.py 5절 지표 + LGBM 대비 투수 군집 bootstrap + 비열등성)
# ---------------------------------------------------------------------------
TARGETS = {'whiff': 'whiff%', 'xc': 'xwOBAcon', 'barrel': '배럴%', 'hardhit': '하드힛%'}


def group_table(d, min_n=100):
    ip = sp.inplay_mask(d) & d['launch_speed'].notna()
    x = d.assign(pitch_type=d['pitch_type'].astype(str), sw=d['description'].isin(ew.SWING_DESC), wh=d['description'].isin(sp.WHIFF_DESC),
                 ip=ip, brl=ip & (d['launch_speed_angle'] == 6).fillna(False), hh=ip & (d['launch_speed'] >= 95),
                 xc=d['estimated_woba_using_speedangle'].where(d['type'] == 'X'))
    g = x.groupby(['pitcher', 'pitch_type']).agg(n=('sw', 'size'), sw=('sw', 'sum'), wh=('wh', 'sum'), ip=('ip', 'sum'),
                                                  brl=('brl', 'sum'), hh=('hh', 'sum'), xc=('xc', 'mean'))
    g = g[g['n'] >= min_n]
    return g.assign(whiff=g['wh'] / g['sw'], barrel=g['brl'] / g['ip'], hardhit=g['hh'] / g['ip'])


dv = d25[~is_tr]
GV = group_table(dv)                                  # 검증 그룹 (고정)
G25, G26 = group_table(d25), group_table(fr[2026])    # 예측력 : 2025 전체 구위 → 2026 결과
GP = G25.index.intersection(G26.index)
key_v = pd.MultiIndex.from_arrays([dv['pitcher'].to_numpy(), dv['pitch_type'].astype(str).to_numpy()])
key_25 = pd.MultiIndex.from_arrays([d25['pitcher'].to_numpy(), d25['pitch_type'].astype(str).to_numpy()])
_pits = GV.index.get_level_values('pitcher').to_numpy()
_up = np.unique(_pits)
_rows_of = {p_: np.where(_pits == p_)[0] for p_ in _up}
_rng = np.random.default_rng(SEED)
BOOT = [np.concatenate([_rows_of[p_] for p_ in _rng.choice(_up, len(_up))]) for _ in range(B)]
rho = lambda a, b: stats.spearmanr(a, b, nan_policy='omit').statistic
REF = {}


def zib_nll_np(y, pi, a, b):
    pi = np.clip(pi, 1e-6, 1 - 1e-6)
    pos = y > 0
    out = -np.log(pi)
    out[pos] = -np.log(1 - pi[pos]) - stats.beta.logpdf(y[pos], a[pos], b[pos])
    return out


def evaluate(name, mean, dist=None, info=None, ref=False):
    """mean = {연도: 투구별 예측 평균 E[Y] (타구질, 낮을수록 좋은 구위)} / dist = 검증 행의 분포 ('zib', π, α, β) 또는 ('gauss', 분산)"""
    sc = sp.StuffScaler().fit(mean[2025][is_tr & ~waste[2025]])
    s = {y: pd.Series(sc.transform(mean[y]), index=fr[y].index).where(~waste[y]) for y in fr}
    sv = pd.Series(s[2025][~is_tr].to_numpy(), index=key_v).groupby(level=[0, 1]).mean().reindex(GV.index).to_numpy()
    s25 = pd.Series(s[2025].to_numpy(), index=key_25).groupby(level=[0, 1]).mean()
    pm = mean[2025][va_pos]
    r = {'run': name, 'RMSE': float(np.sqrt(np.mean((y_va - pm) ** 2))), 'MAE': float(np.mean(np.abs(y_va - pm)))}
    if dist is not None:
        if dist[0] == 'zib':
            _, pi, a, b = dist
            m = hr.zib_metrics(y_va, pi, a, b, (1 - pi) * a / (a + b))
            m['ZIB NLL'] = float(zib_nll_np(y_va, pi, a, b).mean())
        else:
            m = hr.gauss_metrics(y_va, pm, dist[1])
        r.update({k: m[k] for k in ('CRPS', '0점 Brier', '보정 오차', 'bin log score') if k in m})
        if 'ZIB NLL' in m:
            r['ZIB NLL'] = m['ZIB NLL']
    for t, lab in TARGETS.items():
        r[f'ρ {lab}'] = rho(sv, GV[t].to_numpy())
    for t, lab in TARGETS.items():
        r[f'예측력 ρ {lab} 2026'] = rho(s25.reindex(GP).to_numpy(), G26.loc[GP, t].to_numpy())
    rb = {t: np.array([rho(sv[i], GV[t].to_numpy()[i]) for i in BOOT]) for t in ('whiff', 'xc')}
    if ref:
        REF.update(rb=rb, rho=r['ρ whiff%'], mean=mean[2025])
    else:
        for t, lab in (('whiff', 'whiff%'), ('xc', 'xwOBAcon')):
            d_ = rb[t] - REF['rb'][t]
            r[f'Δρ {lab}'] = r[f'ρ {lab}'] - (REF['rho'] if t == 'whiff' else REF['rho_xc'])
            r[f'Δρ {lab} CI 하한'], r[f'Δρ {lab} CI 상한'] = float(np.quantile(d_, 0.025)), float(np.quantile(d_, 0.975))
        r['비열등 (Δρ whiff 5% 분위 > −δ)'] = bool(np.quantile(rb['whiff'] - REF['rb']['whiff'], 0.05) > -DELTA)
        r['LGBM 과 투구 예측 상관 (2025)'] = float(np.corrcoef(mean[2025], REF['mean'])[0, 1])
    if ref:
        REF['rho_xc'] = r['ρ xwOBAcon']
    r.update(info or {})
    log(f'[{name}] RMSE {r["RMSE"]:.5f}', f'CRPS {r.get("CRPS", np.nan):.4f}', f'ρ whiff {r["ρ whiff%"]:.4f}', f'ρ xwOBAcon {r["ρ xwOBAcon"]:.4f}',
        f'ρ 배럴 {r["ρ 배럴%"]:.4f}', f'예측력 {r["예측력 ρ whiff% 2026"]:.4f}',
        '' if ref else f'Δρ {r["Δρ whiff%"]:+.4f} [{r["Δρ whiff% CI 하한"]:+.3f}, {r["Δρ whiff% CI 상한"]:+.3f}]')
    return r


RESULTS = []


def done(name):
    f = os.path.join(OUT, 'runs', f'{name}.json')
    if os.path.exists(f):
        RESULTS.extend(json.load(open(f, encoding='utf-8')))
        log(f'[{name}] 저장본 사용')
        return True
    return False


def keep(name, rows):
    json.dump(rows, open(os.path.join(OUT, 'runs', f'{name}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=float)
    RESULTS.extend(rows)


def cpu_time_10k(fn):
    t = time.time(); fn(); return time.time() - t


# ---------------------------------------------------------------------------
# 3. 모델 부품
# ---------------------------------------------------------------------------
class MLP(nn.Module):
    """Residual MLP backbone (hofnet_diag_experiment.MLP 와 같은 구조) : encode → basis → out"""

    def __init__(self, n_num, cat_cards, d_emb=8, hidden=256, d_r=16, dropout=0.1):
        super().__init__()
        self.cat = nn.ModuleList([nn.Embedding(c + 1, d_emb) for c in cat_cards])
        d_in = 2 * n_num + d_emb * len(cat_cards)
        self.enc = nn.Sequential(nn.Linear(d_in, hidden), nn.GELU(), nn.Dropout(dropout), nn.Linear(hidden, hidden), nn.GELU(), nn.Dropout(dropout))
        self.basis = nn.Sequential(nn.Linear(hidden, d_r), nn.GELU())
        self.out = nn.Linear(d_r, 1)

    def encode(self, xn, miss, xc):
        return self.enc(torch.cat([xn, miss] + [emb(xc[:, j]) for j, emb in enumerate(self.cat)], dim=1))

    def forward(self, xn, miss, xc):
        z = self.basis(self.encode(xn, miss, xc))
        return self.out(z).squeeze(-1), z


def new_net(kind):
    torch.manual_seed(SEED)
    return (MLP(len(NUM), prep.cat_cards) if kind == 'mlp' else hr.HOFNetR(len(NUM), prep.cat_cards)).to(DEV)


# ---- 그룹 순위 손실 재료 : 2025 학습기간 투수×구종 (투구 ≥ 100), 라벨 = 학습기간 whiff% 만 ----
gtr = d25[is_tr & ~waste[2025]]
gtr = gtr.assign(pt=gtr['pitch_type'].astype(str), sw=gtr['description'].isin(ew.SWING_DESC), wh=gtr['description'].isin(sp.WHIFF_DESC))
gstat = gtr.groupby(['pitcher', 'pt']).agg(n=('sw', 'size'), sw=('sw', 'sum'), wh=('wh', 'sum'))
gstat = gstat[(gstat['n'] >= 100) & (gstat['sw'] >= 20)]
assert (gtr['game_date'] < valid_start).all()    # 검증기간 성적은 순위 라벨에 쓰지 않는다
p_hat = (gstat['wh'] / gstat['sw']).to_numpy()
mu_p, var_p = p_hat.mean(), p_hat.var()
_c = mu_p * (1 - mu_p) / var_p - 1                # Beta 사전 적률 추정
PRIOR_A, PRIOR_B = mu_p * _c, (1 - mu_p) * _c
_draw = np.random.default_rng(SEED).beta(PRIOR_A + gstat['wh'].to_numpy()[:, None], PRIOR_B + (gstat['sw'] - gstat['wh']).to_numpy()[:, None],
                                         size=(len(gstat), 200))    # 그룹별 사후 표본 200개
G_DRAW = torch.tensor(_draw, dtype=torch.float32)
G_P = torch.tensor(p_hat, dtype=torch.float32)
gkey = pd.MultiIndex.from_arrays([gtr['pitcher'].to_numpy(), gtr['pt'].to_numpy()])
gcode = pd.Series(np.arange(len(gstat)), index=gstat.index).reindex(gkey).to_numpy()
ok = ~np.isnan(gcode)
G_ROWS = gtr[ok]
G_IDX = [np.where(gcode[ok] == g)[0] for g in range(len(gstat))]
T_G = prep(G_ROWS)
log(f'순위 그룹 {len(gstat)}개 (학습기간 투구 {len(G_ROWS):,}구), Beta 사전 a={PRIOR_A:.1f} b={PRIOR_B:.1f}')


def rank_loss(net, rng, n_g=64, n_p=64, T=0.1):
    """식 (2) : 그룹 평균 구위 S̄ = −f (표준화) 의 pairwise logistic, 가중치 w = |2P(p_g > p_h) − 1| (Beta–Binomial 사후)"""
    gs = rng.choice(len(G_IDX), n_g, replace=False)
    rows = np.concatenate([rng.choice(G_IDX[g], n_p, replace=True) for g in gs])
    f, _ = net(*hn.to_dev(DEV, T_G[0][rows], T_G[1][rows], T_G[2][rows]))
    S = -f.view(n_g, n_p).mean(1)
    gt = torch.from_numpy(gs)
    conf = (G_DRAW[gt][:, None, :] > G_DRAW[gt][None, :, :]).float().mean(-1).to(DEV)
    w = (2 * conf - 1).abs()
    t = torch.sign(G_P[gt][:, None] - G_P[gt][None, :]).to(DEV)
    iu = torch.triu_indices(n_g, n_g, 1, device=DEV)
    l = F.softplus(-t * (S[:, None] - S[None, :]) / T)[iu[0], iu[1]]
    ww = w[iu[0], iu[1]]
    return (ww * l).sum() / ww.sum().clamp_min(1e-6)


def fit_stage1(net, tr, es, y_mean, y_std, lam_r=0.0, teacher=None, lam_t=0.0, epochs=EPOCHS, patience=4, batch=1024, lr=1e-3, rank_every=4):
    """hr.fit_mean 과 같은 루프 (표준화 MSE, 홀드아웃 y3 RMSE 조기 종료) + 선택 : 그룹 순위 손실 / teacher MSE"""
    torch.manual_seed(SEED)
    gen = torch.Generator().manual_seed(SEED)
    rng = np.random.default_rng(SEED)
    (xn, miss, xc, y), (exn, emiss, exc, ey) = tr, es
    ys = (y - y_mean) / y_std
    ts = None if teacher is None else (teacher - y_mean) / y_std
    opt = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=1e-4)
    ey_np = ey.double().numpy()
    best, best_state, bad, hist = np.inf, None, 0, []
    for ep in range(epochs):
        net.train()
        tot, n, rk_tot, rk_n = 0.0, 0, 0.0, 0
        for i, b in enumerate(hn.batches(len(y), batch, True, gen)):
            f, _ = net(*hn.to_dev(DEV, xn[b], miss[b], xc[b]))
            loss = F.mse_loss(f, ys[b].to(DEV))
            if ts is not None:
                loss = loss + lam_t * F.mse_loss(f, ts[b].to(DEV))
            if lam_r > 0 and i % rank_every == 0:
                rl = rank_loss(net, rng)
                loss = loss + lam_r * rl
                rk_tot += float(rl); rk_n += 1
            opt.zero_grad(); loss.backward()
            nn.utils.clip_grad_norm_(net.parameters(), 5.0)
            opt.step()
            tot += float(loss) * len(b); n += len(b)
        f_es, _ = hr.encode_all(net, (exn, emiss, exc), y_mean, y_std)
        rmse = float(np.sqrt(np.mean((ey_np - f_es) ** 2)))
        hist.append({'epoch': ep + 1, 'train_loss': tot / n, 'rank_loss': rk_tot / max(rk_n, 1), 'holdout_rmse': rmse})
        if rmse < best - 1e-6:
            best, bad, best_state = rmse, 0, {k: v.detach().clone() for k, v in net.state_dict().items()}
        else:
            bad += 1
            if bad >= patience:
                break
    net.load_state_dict(best_state)
    return hist


def fit_zib(net, y_mean, y_std, bayes=True, tau0=1.0, epochs=EPOCHS, patience=4, batch=1024, lr=1e-3):
    """hr.fit_zib_head 와 같은 헤드·손실. bayes=False 면 ω 결정적(s ≈ 0 고정)·KL 없음"""
    _, z_tr, h_tr = hr.encode_all(net, T_tr, y_mean, y_std, flat=True)
    _, z_es, h_es = hr.encode_all(net, T_es, y_mean, y_std, flat=True)
    z_tr, z_es = torch.from_numpy(z_tr), torch.from_numpy(z_es)
    torch.manual_seed(SEED)
    gen = torch.Generator().manual_seed(SEED)
    head = hr.ZIBHead(h_tr.shape[1], z_tr.shape[1])
    pi0 = float((y_tr_t == 0).float().mean())
    with torch.no_grad():
        head.mlp[-1].bias.copy_(torch.tensor([np.log(pi0 / (1 - pi0)), float(torch.logit(y_tr_t[y_tr_t > 0].mean())), 1.0]))
        if not bayes:
            head.s_raw.fill_(-30.0)
    head.s_raw.requires_grad_(bayes)
    head.to(DEV)
    opt = torch.optim.AdamW([p for p in head.parameters() if p.requires_grad], lr=lr, weight_decay=1e-4)
    N, best, best_state, bad = len(y_tr_t), np.inf, None, 0
    for ep in range(epochs):
        head.train()
        for b in hn.batches(N, batch, True, gen):
            hb, zb, yb = hn.to_dev(DEV, h_tr[b], z_tr[b], y_tr_t[b])
            loss = hr.zero_inflated_beta_nll(yb, *head(hb, zb, sample=bayes)).mean()
            if bayes:
                loss = loss + hr.global_kl_per_observation(head.m, head.s, tau0, N)
            opt.zero_grad(); loss.backward()
            nn.utils.clip_grad_norm_(head.parameters(), 5.0)
            opt.step()
        head.eval()
        with torch.no_grad():
            es_nll = float(torch.cat([hr.zero_inflated_beta_nll(y_es_t[b].to(DEV), *head(*hn.to_dev(DEV, h_es[b], z_es[b]), sample=False))
                                      for b in hn.batches(len(y_es_t), 8192, False)]).mean())
        if es_nll < best - 1e-6:
            best, bad, best_state = es_nll, 0, {k: v.detach().clone() for k, v in head.state_dict().items()}
        else:
            bad += 1
            if bad >= patience:
                break
    head.load_state_dict(best_state)
    del h_tr, h_es
    return head.eval()


def kappa_bins(m_es, y_es, m_apply, n_bins=10):
    """양수 행의 Beta 정밀도 κ 를 m_B 분위 구간별 격자 MLE (es 로 적합) → 적용 행의 κ"""
    pos = y_es > 0
    m, yv = np.clip(m_es[pos], 1e-4, 1 - 1e-4), y_es[pos]
    edges = np.unique(np.quantile(m, np.linspace(0, 1, n_bins + 1)))
    grid = np.exp(np.linspace(np.log(0.5), np.log(300), 120))
    kb = []
    for i in range(len(edges) - 1):
        s = (m >= edges[i]) & (m <= edges[i + 1])
        ll = [stats.beta.logpdf(yv[s], m[s] * k, (1 - m[s]) * k).sum() for k in grid]
        kb.append(grid[int(np.argmax(ll))])
    idx = np.clip(np.searchsorted(edges, m_apply, side='right') - 1, 0, len(kb) - 1)
    return np.asarray(kb)[idx]


def zib_from_parts(pi, m, kappa):
    m = np.clip(m, 1e-4, 1 - 1e-4)
    return ('zib', np.clip(pi, 1e-6, 1 - 1e-6), m * kappa, (1 - m) * kappa)


def run_nn(name, desc, kind='hof', bayes=True, lam_r=0.0, teacher=None, lam_t=0.0):
    """Stage I (선택 손실) → ZIB 헤드 → 평가"""
    if done(name):
        return
    y_mean, y_std = float(y_tr_t.mean()), float(y_tr_t.std())
    net = new_net(kind)
    t = time.time()
    log(f'=== {name} : {desc}')
    hist = fit_stage1(net, (*T_tr, y_tr_t), (*T_es, y_es_t), y_mean, y_std, lam_r=lam_r, teacher=teacher, lam_t=lam_t)
    head = fit_zib(net, y_mean, y_std, bayes=bayes)
    t_train = time.time() - t
    zp = hr.zib_predict_net(net, head, T_va, M=4, seed=SEED)
    mean = {y: hr.zib_predict_net(net, head, T_season[y], M=4, seed=SEED)['mean'] for y in fr}
    net_c, head_c = net.cpu(), head.cpu()
    torch.set_num_threads(4)
    x10 = tuple(t_[:10000] for t_ in T_va)
    t_cpu = cpu_time_10k(lambda: hr.zib_predict_net(net_c, head_c, x10, M=4, seed=SEED))
    torch.set_num_threads(os.cpu_count())
    info = {'설명': desc, '학습 시간(초)': t_train, 'CPU 1만 구 추론(초)': t_cpu, 'epoch 수': len(hist),
            '최종 순위 손실': hist[-1]['rank_loss'] if lam_r else np.nan, 'U_global 평균': float(zp['u_global'].mean())}
    keep(name, [evaluate(name, mean, ('zib', zp['pi'], zp['a'], zp['b']), info)])
    del net, head, net_c, head_c
    torch.cuda.empty_cache()


# ---------------------------------------------------------------------------
# 4. 실험
# ---------------------------------------------------------------------------
RUNS = ARGS.runs.split(',')
fit_rows = pd.concat([tr_rows, es_rows])

# B0 기준선 (항상 먼저 : 모든 Δρ 의 기준)
lg_mean = {y: v4.predict(fr[y][v4.input_features]) for y in fr}
var_params = dict(n_estimators=400, learning_rate=0.05, num_leaves=63, min_child_samples=200, random_state=SEED, verbose=-1)
lg_fit = v4.predict(fit_rows[v4.input_features])
var_m = lgb.LGBMRegressor(**var_params).fit(mf_rows(fit_rows), np.log((fit_rows['y3'].to_numpy() - lg_fit) ** 2 + 1e-6))
x10_lgb = fr[2025][v4.input_features].iloc[:10000]
t_lgb = cpu_time_10k(lambda: v4.predict(x10_lgb))
b0 = evaluate('B0 LGBM v4 + 이분산 Gaussian', lg_mean, ('gauss', np.exp(var_m.predict(mf_rows(va_rows)) + 1.27)),
              {'설명': 'LGBM v4 운영 모델, 분포 = 이분산 오차모델', 'CPU 1만 구 추론(초)': t_lgb}, ref=True)
b0c = dict(b0, run='B0 LGBM v4 + 상수 분산 Gaussian', **{k: v for k, v in evaluate(
    'B0 LGBM v4 + 상수 분산 Gaussian', lg_mean, ('gauss', np.full(len(va_rows), np.var(fit_rows['y3'].to_numpy() - lg_fit)))).items()
    if k in ('CRPS', '0점 Brier', '보정 오차', 'bin log score')})
RESULTS.extend([b0, b0c])

# LGBM 부품 : 학습셋(tr)만으로 적합한 모델 → es 로 κ 를 정한다 (es 를 본 적 없는 예측)
is_zero = lambda rows: (rows['y3'].to_numpy() == 0).astype(int)
cls_par = {k: v for k, v in lgb_params.items() if k not in ('objective', 'metric')}
if any(r in RUNS for r in ('b1a', 'b1b')):
    clf = lgb.LGBMClassifier(**cls_par).fit(mf_rows(tr_rows), is_zero(tr_rows))
    pi_of = lambda X: clf.predict_proba(X)[:, 1]
    lgb_tr = lgb.LGBMRegressor(**lgb_params).fit(mf_rows(tr_rows), tr_rows['y3'])

if 'b1a' in RUNS and not done('b1a'):
    pi_es, pi_va = pi_of(mf_rows(es_rows)), pi_of(mf_rows(va_rows))
    m_es = np.clip(lgb_tr.predict(mf_rows(es_rows)) / (1 - pi_es), 1e-4, 1 - 1e-4)
    mu_va = lg_mean[2025][va_pos]
    m_va = np.clip(mu_va / (1 - pi_va), 1e-4, 1 - 1e-4)
    kap = kappa_bins(m_es, es_rows['y3'].to_numpy(), m_va)
    dist = zib_from_parts(pi_va, m_va, kap)
    r = evaluate('B1a LGBM v4 평균 + ZIB', lg_mean, dist, {'설명': '점 예측·순위는 LGBM v4 그대로, 분포만 ZIB (π 분류기, m_B = μ/(1−π), κ 구간 MLE)'})
    assert abs(r['ρ whiff%'] - REF['rho']) < 1e-12    # 순위가 LGBM 과 같아야 한다
    keep('b1a', [r])

if 'b1b' in RUNS and not done('b1b'):
    pos = tr_rows['y3'].to_numpy() > 0
    reg = lgb.LGBMRegressor(**{**lgb_params, 'objective': 'cross_entropy'}).fit(mf_rows(tr_rows)[pos], tr_rows['y3'].to_numpy()[pos])
    m_es = np.clip(reg.predict(mf_rows(es_rows)), 1e-4, 1 - 1e-4)
    pi_va, m_va = pi_of(mf_rows(va_rows)), np.clip(reg.predict(mf_rows(va_rows)), 1e-4, 1 - 1e-4)
    kap = kappa_bins(m_es, es_rows['y3'].to_numpy(), m_va)
    mean = {y: (1 - pi_of(MF[y])) * np.clip(reg.predict(MF[y]), 1e-4, 1 - 1e-4) for y in fr}
    t_cpu = cpu_time_10k(lambda: (pi_of(MF[2025].iloc[:10000]), reg.predict(MF[2025].iloc[:10000])))
    keep('b1b', [evaluate('B1b two-part LGBM (ZIB)', mean, zib_from_parts(pi_va, m_va, kap),
                          {'설명': 'LGBM 분류기 π + 양수 행 cross-entropy 회귀 m_B, 평균 (1−π)m_B', 'CPU 1만 구 추론(초)': t_cpu})])

if 'b3' in RUNS:
    run_nn('b3', 'B3 HOF-Net-R P4 (Bayesian ZIB 헤드) — 현재 접근', 'hof', bayes=True)
if 'b4' in RUNS:
    run_nn('b4', 'B4 HOF-Net-R + ZIB, Bayesian 제거', 'hof', bayes=False)
if 'b2' in RUNS:
    run_nn('b2', 'B2 Residual MLP + Bayesian ZIB 헤드', 'mlp', bayes=True)
if 'b5' in RUNS:
    run_nn('b5', 'B5 Residual MLP + ZIB, Bayesian 제거', 'mlp', bayes=False)

if 'rk' in RUNS:
    for lam in (0.01, 0.05, 0.1, 0.2):
        run_nn(f'rk_{lam}', f'그룹 순위 손실 λr = {lam} (HOF-Net-R + Bayesian ZIB)', 'hof', bayes=True, lam_r=lam)

if 'b6' in RUNS and not done('b6'):
    log('=== b6 : two-part HOF')
    t = time.time()
    y_mean, y_std = float(y_tr_t.mean()), float(y_tr_t.std())
    # π 인코더 : BCE(y = 0), 조기 종료 = 홀드아웃 logloss
    net0 = new_net('hof')
    z_tr, z_es = (y_tr_t == 0).float(), (y_es_t == 0).float()
    gen = torch.Generator().manual_seed(SEED)
    opt = torch.optim.AdamW(net0.parameters(), lr=1e-3, weight_decay=1e-4)
    best, bad, best_state = np.inf, 0, None
    for ep in range(EPOCHS):
        net0.train()
        for b in hn.batches(len(z_tr), 1024, True, gen):
            f, _ = net0(*hn.to_dev(DEV, T_tr[0][b], T_tr[1][b], T_tr[2][b]))
            loss = F.binary_cross_entropy_with_logits(f, z_tr[b].to(DEV))
            opt.zero_grad(); loss.backward(); nn.utils.clip_grad_norm_(net0.parameters(), 5.0); opt.step()
        lg_es, _ = hr.encode_all(net0, T_es, 0.0, 1.0)
        ll = float(F.binary_cross_entropy_with_logits(torch.from_numpy(lg_es).float(), z_es))
        if ll < best - 1e-6:
            best, bad, best_state = ll, 0, {k: v.detach().clone() for k, v in net0.state_dict().items()}
        else:
            bad += 1
            if bad >= 4:
                break
    net0.load_state_dict(best_state)
    # 양수 인코더 : 양수 행 MSE
    ptr, pes = (y_tr_t > 0).numpy(), (y_es_t > 0).numpy()
    sub = lambda T, m: tuple(t_[torch.from_numpy(m)] for t_ in T)
    yp_tr, yp_es = y_tr_t[torch.from_numpy(ptr)], y_es_t[torch.from_numpy(pes)]
    pm_, ps_ = float(yp_tr.mean()), float(yp_tr.std())
    netp = new_net('hof')
    fit_stage1(netp, (*sub(T_tr, ptr), yp_tr), (*sub(T_es, pes), yp_es), pm_, ps_)
    pi_ = lambda T: 1 / (1 + np.exp(-hr.encode_all(net0, T, 0.0, 1.0)[0]))
    mb_ = lambda T: np.clip(hr.encode_all(netp, T, pm_, ps_)[0], 1e-4, 1 - 1e-4)
    kap = kappa_bins(mb_(T_es), y_es_t.numpy(), mb_(T_va))
    mean = {y: (1 - pi_(T_season[y])) * mb_(T_season[y]) for y in fr}
    keep('b6', [evaluate('B6 two-part HOF (π·양수 인코더 분리)', mean, zib_from_parts(pi_(T_va), mb_(T_va), kap),
                         {'설명': 'π 인코더 BCE + 양수 인코더 MSE (각각 HOF-Net-R), κ 구간 MLE', '학습 시간(초)': time.time() - t})])
    del net0, netp
    torch.cuda.empty_cache()

if 'tc' in RUNS:
    # teacher = LGBM 학습기간 OOF (투수 GroupKFold 5겹). es 행은 tr 전체로 학습한 LGBM 으로 예측 (모두 es 를 보지 않음)
    oof = np.zeros(len(tr_rows))
    for k, (a, b) in enumerate(GroupKFold(5).split(tr_rows, groups=tr_rows['pitcher'])):
        m_ = lgb.LGBMRegressor(**lgb_params).fit(mf_rows(tr_rows).iloc[a], tr_rows['y3'].iloc[a])
        oof[b] = m_.predict(mf_rows(tr_rows).iloc[b])
    log(f'teacher OOF : y3 와 상관 {np.corrcoef(oof, tr_rows["y3"])[0, 1]:.4f}')
    for lam in (0.3, 1.0):
        run_nn(f'tc_{lam}', f'LGBM teacher 정규화 λt = {lam} (HOF-Net-R + Bayesian ZIB)', 'hof', bayes=True, teacher=tt(oof), lam_t=lam)

res = pd.DataFrame(RESULTS)
res.to_csv(os.path.join(OUT, 'results.csv'), index=False, encoding='utf-8-sig')
show = ['run', 'RMSE', 'CRPS', 'ZIB NLL', '0점 Brier', '보정 오차', 'ρ whiff%', 'Δρ whiff%', 'Δρ whiff% CI 하한', 'Δρ whiff% CI 상한',
        '비열등 (Δρ whiff 5% 분위 > −δ)', 'ρ xwOBAcon', 'ρ 배럴%', 'ρ 하드힛%', '예측력 ρ whiff% 2026', '예측력 ρ xwOBAcon 2026',
        'LGBM 과 투구 예측 상관 (2025)', '학습 시간(초)', 'CPU 1만 구 추론(초)']
log('결과\n' + res[[c for c in show if c in res.columns]].round(4).to_string(index=False))
log('끝', f'{time.time() - T0:.0f}s')
