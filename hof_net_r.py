"""
HOF-Net-R (HOF_Net_Failure_Analysis_Revision_v1.pdf, 4·6절 · 부록 B 기준 구현) — 3단계 구위 모델 후보 (실험용, 웹 미반영)

기존 HOF-Net(hof_net.py)의 투구별 잠재가중치 q(W|x) + local KL 대신
- Stage I  (P1) : 결정적 평균 f(x) = out(z(x)), z(x) = attention encoder 위 MLP 의 마지막 은닉층 (d_r 차원). 표준화 타깃 MSE, KL 없음
- Stage II (P2) : encoder 고정, 데이터셋 공유 잔차 가중치 ω 의 닫힌형식 베이지안 선형회귀 (식 21–24, Cholesky)
                  r = y − f(x) ~ N(z̃ᵀω, σ_a²(x)),  ω ~ N(0, τ0² I),  z̃ = [z, 1]
                  상수 σ_a² 판과 이분산 σ_a²(x) 판(MSE 고정 뒤 분산 헤드만 NLL 학습 = two-stage)
- Stage II (P3) : 같은 헤드를 변분 q(ω) = N(m, diag s²) 로 학습. 손실 = 배치평균 NLL + KL/N (식 20, 부록 B Listing 1)
- Stage III(P4) : 영과잉 Beta(ZIB) 우도 (식 25–29, Listing 2). π(x)·m_B·κ 헤드 + m_B logit 에 공유 ω (KL/N)
예측 분산 분해 (식 33) : Var = σ_a²(x) [U_alea] + z̃ᵀ S z̃ [U_global]
"""
import math

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from scipy import special, stats

from hof_net import Block, batches, device_of, to_dev

ZERO_CUT = 0.005    # 공통 bin 의 첫 칸 (y ≤ 0.005 ≈ 정확한 0 사건)
BIN_EDGES = np.array([-np.inf, ZERO_CUT, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.5, 0.6, np.inf])


# ---------------------------------------------------------------------------
# 부록 B 핵심 손실 함수 (논문 코드 그대로)
# ---------------------------------------------------------------------------
def global_kl_per_observation(posterior_mean, posterior_std, prior_std, train_size):
    """KL[q(global weights) || p(global weights)] / N  (식 40, Listing 1)"""
    if train_size <= 0 or prior_std <= 0.0:
        raise ValueError('train_size and prior_std must be positive')
    if posterior_mean.shape != posterior_std.shape:
        raise ValueError('posterior shapes do not match')
    if torch.any(posterior_std <= 0):
        raise ValueError('posterior_std must be positive')
    prior_var = prior_std * prior_std
    kl = 0.5 * ((posterior_std.square() + posterior_mean.square()) / prior_var - 1.0
                + 2.0 * (math.log(prior_std) - posterior_std.log())).sum()
    return kl / train_size    # Global KL paid ONCE over the dataset


def zero_inflated_beta_nll(target, logit_zero, positive_mean_logit, precision_raw, precision_floor=1e-3):
    """y ∈ [0, 1) 의 투구별 ZIB NLL (Listing 2). 정확한 0 은 원자, (0,1) 은 Beta 밀도. 타깃 clamp 없음"""
    if len({target.shape, logit_zero.shape, positive_mean_logit.shape, precision_raw.shape}) != 1:
        raise ValueError('All inputs must have identical shapes')
    if torch.any((target < 0) | (target >= 1)):
        raise ValueError('Targets must belong to [0, 1)')
    p_mean = torch.sigmoid(positive_mean_logit).clamp(1e-5, 1 - 1e-5)
    precision = F.softplus(precision_raw) + precision_floor
    alpha = (p_mean * precision).clamp_min(1e-6)
    beta_param = ((1 - p_mean) * precision).clamp_min(1e-6)
    is_zero = target == 0
    log_zero_mass = F.logsigmoid(logit_zero)
    log_continuous_mass = F.logsigmoid(-logit_zero)
    positive_target = torch.where(is_zero, torch.full_like(target, 0.5), target)
    beta_logpdf = torch.distributions.Beta(alpha, beta_param).log_prob(positive_target)
    return -torch.where(is_zero, log_zero_mass, log_continuous_mass + beta_logpdf)


def zib_params(logit_zero, positive_mean_logit, precision_raw, precision_floor=1e-3):
    """헤드 출력 -> (π, α, β) : zero_inflated_beta_nll 과 같은 매개화"""
    p_mean = torch.sigmoid(positive_mean_logit).clamp(1e-5, 1 - 1e-5)
    precision = F.softplus(precision_raw) + precision_floor
    return torch.sigmoid(logit_zero), (p_mean * precision).clamp_min(1e-6), ((1 - p_mean) * precision).clamp_min(1e-6)


# ---------------------------------------------------------------------------
# Stage I : 결정적 attention 평균 + 잔차 basis
# ---------------------------------------------------------------------------
class HOFNetR(nn.Module):
    def __init__(self, n_num, cat_cards, d=32, layers=2, heads=4, dropout=0.1, d_r=16, hidden=64):
        super().__init__()
        self.K, self.d_r = n_num + len(cat_cards), d_r
        self.w = nn.Parameter(torch.randn(n_num, d) * 0.3)
        self.b = nn.Parameter(torch.zeros(n_num, d))
        self.miss = nn.Parameter(torch.zeros(n_num, d))
        self.cat = nn.ModuleList([nn.Embedding(c + 1, d) for c in cat_cards])
        self.blocks = nn.ModuleList([Block(d, heads, dropout) for _ in range(layers)])
        self.basis = nn.Sequential(nn.Linear(self.K * d, hidden), nn.GELU(), nn.Dropout(dropout), nn.Linear(hidden, d_r), nn.GELU())
        self.out = nn.Linear(d_r, 1)

    def encode(self, xn, miss, xc):
        """attention encoder h(x) (flatten 토큰)"""
        z = torch.cat([xn.unsqueeze(-1) * self.w + self.b + miss.unsqueeze(-1) * self.miss]
                      + [emb(xc[:, j]).unsqueeze(1) for j, emb in enumerate(self.cat)], dim=1)
        for blk in self.blocks:
            z, _ = blk(z, need_weights=False)    # HOF-Net-R 은 attention 가중치를 쓰지 않는다
        return z.flatten(1)

    def forward(self, xn, miss, xc):
        """(f(x) 표준화 단위, z(x))"""
        z = self.basis(self.encode(xn, miss, xc))
        return self.out(z).squeeze(-1), z


@torch.no_grad()
def encode_all(net, tensors, y_mean, y_std, size=8192, flat=False):
    """f(x) 원 단위, z(x) (+ flatten 토큰)"""
    net.eval()
    dev = device_of(net)
    xn, miss, xc = tensors[:3]
    fs, zs, hs = [], [], []
    for b in batches(len(xn), size, False):
        h = net.encode(*to_dev(dev, xn[b], miss[b], xc[b]))
        z = net.basis(h)
        fs.append(net.out(z).squeeze(-1).cpu()); zs.append(z.cpu())
        if flat:
            hs.append(h.cpu())    # flatten 토큰은 CPU 에 (GPU 메모리 보호)
    f = torch.cat(fs).double().numpy() * y_std + y_mean
    return (f, torch.cat(zs).numpy()) + ((torch.cat(hs),) if flat else ())


def grad_norm(params):
    g = [p.grad.detach().norm() for p in params if p.grad is not None]
    return float(torch.norm(torch.stack(g))) if g else 0.0


def fit_mean(net, tr, es, y_mean, y_std, epochs=30, patience=4, batch=1024, lr=1e-3, seed=42, log=print):
    """Stage I : 표준화 타깃 MSE (KL 없음). 조기 종료 = 홀드아웃 RMSE. epoch 별 telemetry (6.4절) 반환"""
    torch.manual_seed(seed)
    gen = torch.Generator().manual_seed(seed)
    (xn, miss, xc, y), (exn, emiss, exc, ey) = tr, es
    dev = device_of(net)
    ys = (y - y_mean) / y_std
    opt = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=1e-4)
    sub = torch.randperm(len(y), generator=torch.Generator().manual_seed(seed))[:20000]
    ey_np, y_sub = ey.double().numpy(), y[sub].double().numpy()
    best, best_state, bad, hist = np.inf, None, 0, []
    for ep in range(epochs):
        net.train()
        tot, n, gn, nb, nan = 0.0, 0, 0.0, 0, 0
        for b in batches(len(y), batch, True, gen):
            f, _ = net(*to_dev(dev, xn[b], miss[b], xc[b]))
            loss = F.mse_loss(f, ys[b].to(dev))
            if not torch.isfinite(loss):
                nan += 1
                continue
            opt.zero_grad(); loss.backward()
            gn += grad_norm(net.parameters()); nb += 1
            nn.utils.clip_grad_norm_(net.parameters(), 5.0)
            opt.step()
            tot += float(loss) * len(b); n += len(b)
        f_es, _ = encode_all(net, (exn, emiss, exc), y_mean, y_std)
        f_tr, _ = encode_all(net, (xn[sub], miss[sub], xc[sub]), y_mean, y_std)
        rmse = float(np.sqrt(np.mean((ey_np - f_es) ** 2)))
        rec = {'epoch': ep + 1, 'train_mse_std': tot / max(n, 1), 'holdout_rmse': rmse,
               'train_r2': 1 - np.mean((y_sub - f_tr) ** 2) / np.var(y_sub), 'holdout_r2': 1 - np.mean((ey_np - f_es) ** 2) / np.var(ey_np),
               'var_pred_holdout': float(np.var(f_es)), 'var_y_holdout': float(np.var(ey_np)), 'grad_norm_mean': gn / max(nb, 1), 'nan_batches': nan}
        hist.append(rec)
        log(' '.join(f'{k} {v:.5f}' if isinstance(v, float) else f'{k} {v}' for k, v in rec.items()))
        if rmse < best - 1e-6:
            best, bad = rmse, 0
            best_state = {k: v.detach().clone() for k, v in net.state_dict().items()}
        else:
            bad += 1
            if bad >= patience:
                break
    net.load_state_dict(best_state)
    return hist


# ---------------------------------------------------------------------------
# Stage II : 분산 헤드 σ_a²(x) (two-stage) · 닫힌형식 BLR · 변분 global 헤드
# ---------------------------------------------------------------------------
class VarHead(nn.Module):
    def __init__(self, d_r, hidden=32):
        super().__init__()
        self.net = nn.Sequential(nn.Linear(d_r, hidden), nn.GELU(), nn.Linear(hidden, 1))

    def forward(self, z):
        return F.softplus(self.net(z)).squeeze(-1) + 1e-6


def gauss_nll_np(y, mean, var):
    return 0.5 * (np.log(2 * np.pi * var) + (y - mean) ** 2 / var)


def fit_var_head(z_tr, r_tr, z_es, r_es, epochs=20, patience=3, batch=2048, lr=1e-3, seed=42, log=print, device=None):
    """평균 고정 뒤 잔차 r 의 Gaussian NLL 로 σ_a²(x) 만 학습 (E3.1 two-stage schedule). 반환 헤드는 CPU"""
    torch.manual_seed(seed)
    gen = torch.Generator().manual_seed(seed)
    dev = torch.device(device or 'cpu')
    head = VarHead(z_tr.shape[1])
    nn.init.constant_(head.net[-1].bias, float(np.log(np.expm1(np.var(r_tr)))))
    head.to(dev)
    zt, rt, ze = to_dev(dev, torch.from_numpy(z_tr), torch.from_numpy(r_tr.astype(np.float32)), torch.from_numpy(z_es))
    opt = torch.optim.Adam(head.parameters(), lr=lr)
    best, best_state, bad = np.inf, None, 0
    for ep in range(epochs):
        head.train()
        for b in batches(len(rt), batch, True, gen):
            v = head(zt[b])
            loss = (0.5 * (torch.log(v) + rt[b] ** 2 / v)).mean()
            opt.zero_grad(); loss.backward(); opt.step()
        with torch.no_grad():
            v_es = head(ze).double().cpu().numpy()
        nll = float(gauss_nll_np(r_es, 0.0, v_es).mean())
        log(f'var head epoch {ep + 1} holdout_nll {nll:.5f} mean_var {v_es.mean():.5f}')
        if nll < best - 1e-6:
            best, bad, best_state = nll, 0, {k: v.clone() for k, v in head.state_dict().items()}
        else:
            bad += 1
            if bad >= patience:
                break
    head.load_state_dict(best_state)
    return head.cpu().eval()


def var_of(head, z, size=65536):
    dev = device_of(head)
    with torch.no_grad():
        return np.concatenate([head(torch.from_numpy(z[i:i + size]).to(dev)).double().cpu().numpy() for i in range(0, len(z), size)])


def add_bias(z):
    return np.column_stack([z.astype(np.float64), np.ones(len(z))])


class BLRHead:
    """닫힌형식 Bayesian linear residual head (식 21–24). w = 1/σ_a²(x_i) 가중 (상수 분산이면 모두 같음)
    S = (τ0⁻² I + Z̃ᵀ W Z̃)⁻¹,  m = S Z̃ᵀ W r.  역행렬 대신 Cholesky solve"""

    def __init__(self, tau0):
        self.tau0 = tau0

    def fit(self, z, r, var):
        Z = add_bias(z)
        w = 1.0 / np.asarray(var, dtype=np.float64)
        P = np.eye(Z.shape[1]) / self.tau0 ** 2 + (Z * w[:, None]).T @ Z
        L = np.linalg.cholesky(P)
        self.m = np.linalg.solve(L.T, np.linalg.solve(L, Z.T @ (w * r)))
        Linv = np.linalg.solve(L, np.eye(len(P)))
        self.S = Linv.T @ Linv
        return self

    def shift(self, z):
        return add_bias(z) @ self.m

    def u_global(self, z):
        Z = add_bias(z)
        return np.einsum('ij,jk,ik->i', Z, self.S, Z)


class VIHead(nn.Module):
    """변분 global 헤드 q(ω) = N(m, diag s²). 우도 기대값은 선형이므로 정확히 계산 (MC 불필요)"""

    def __init__(self, d):
        super().__init__()
        self.m = nn.Parameter(torch.zeros(d))
        self.s_raw = nn.Parameter(torch.full((d,), -3.0))

    @property
    def s(self):
        return F.softplus(self.s_raw) + 1e-8

    def nll(self, Z, r, var):
        e2 = (r - Z @ self.m) ** 2 + (Z ** 2) @ self.s ** 2
        return 0.5 * (torch.log(2 * math.pi * var) + e2 / var)


def fit_vi_head(z, r, var, tau0, epochs=15, batch=4096, lr=1e-2, seed=42, device=None):
    """식 20 : J_B = −(1/B) Σ E_q log p + KL/N. 반환 헤드는 CPU"""
    torch.manual_seed(seed)
    gen = torch.Generator().manual_seed(seed)
    dev = torch.device(device or 'cpu')
    Z, R, V = to_dev(dev, torch.from_numpy(add_bias(z)), torch.from_numpy(np.asarray(r, np.float64)), torch.from_numpy(np.asarray(var, np.float64)))
    head = VIHead(Z.shape[1]).double().to(dev)
    opt = torch.optim.Adam(head.parameters(), lr=lr)
    N, hist = len(R), []
    for ep in range(epochs):
        for b in batches(N, batch, True, gen):
            nll = head.nll(Z[b], R[b], V[b])
            kl_n = global_kl_per_observation(head.m, head.s, tau0, N)
            loss = nll.mean() + kl_n
            opt.zero_grad(); loss.backward(); opt.step()
        with torch.no_grad():
            hist.append({'epoch': ep + 1, 'nll_mean': float(head.nll(Z, R, V).mean()),
                         'kl_total': float(global_kl_per_observation(head.m, head.s, tau0, N) * N),
                         'kl_per_n': float(global_kl_per_observation(head.m, head.s, tau0, N))})
    return head.cpu(), hist


# ---------------------------------------------------------------------------
# Stage III : 영과잉 Beta 헤드 (고정 encoder 위)
# ---------------------------------------------------------------------------
class ZIBHead(nn.Module):
    def __init__(self, d_in, d_r, hidden=64):
        super().__init__()
        self.mlp = nn.Sequential(nn.Linear(d_in, hidden), nn.GELU(), nn.Linear(hidden, hidden), nn.GELU(), nn.Linear(hidden, 3))
        self.m = nn.Parameter(torch.zeros(d_r + 1))          # 공유 ω (m_B logit 의 잔차 가중치)
        self.s_raw = nn.Parameter(torch.full((d_r + 1,), -3.0))

    @property
    def s(self):
        return F.softplus(self.s_raw) + 1e-6

    def forward(self, h, z, sample=True):
        lz, am, ak = self.mlp(h).unbind(-1)
        zb = torch.cat([z, torch.ones(len(z), 1, device=z.device)], 1)
        omega = self.m + self.s * torch.randn_like(self.m) if sample else self.m
        return lz, am + zb @ omega, ak

    def omega_samples(self, M, gen):
        return self.m.detach() + self.s.detach() * torch.randn(M, len(self.m), generator=gen).to(self.m.device)


def fit_zib_head(h_tr, z_tr, y_tr, h_es, z_es, y_es, tau0=1.0, epochs=30, patience=4, batch=1024, lr=1e-3, seed=42, log=print, device=None):
    """손실 = 배치평균 ZIB NLL + KL(q(ω)||p(ω))/N. 조기 종료 = 홀드아웃 ZIB NLL (ω = 사후 평균).
    입력은 CPU 텐서 (배치마다 device 로 이동), 반환 헤드는 CPU"""
    torch.manual_seed(seed)
    gen = torch.Generator().manual_seed(seed)
    dev = torch.device(device or 'cpu')
    head = ZIBHead(h_tr.shape[1], z_tr.shape[1])
    pi0 = float((y_tr == 0).float().mean())
    with torch.no_grad():
        head.mlp[-1].bias.copy_(torch.tensor([math.log(pi0 / (1 - pi0)), float(torch.logit(y_tr[y_tr > 0].mean())), 1.0]))
    head.to(dev)
    opt = torch.optim.AdamW(head.parameters(), lr=lr, weight_decay=1e-4)
    N, best, best_state, bad, hist = len(y_tr), np.inf, None, 0, []
    for ep in range(epochs):
        head.train()
        tot, kl_last = 0.0, 0.0
        for b in batches(N, batch, True, gen):
            hb, zb, yb = to_dev(dev, h_tr[b], z_tr[b], y_tr[b])
            nll = zero_inflated_beta_nll(yb, *head(hb, zb, sample=True)).mean()
            kl_n = global_kl_per_observation(head.m, head.s, tau0, N)
            loss = nll + kl_n
            opt.zero_grad(); loss.backward()
            nn.utils.clip_grad_norm_(head.parameters(), 5.0)
            opt.step()
            tot += float(nll) * len(b); kl_last = float(kl_n)
        head.eval()
        with torch.no_grad():
            es_nll = float(torch.cat([zero_inflated_beta_nll(y_es[b].to(dev), *head(*to_dev(dev, h_es[b], z_es[b]), sample=False))
                                      for b in batches(len(y_es), 8192, False)]).mean())
        rec = {'epoch': ep + 1, 'train_zib_nll': tot / N, 'kl_total': kl_last * N, 'kl_per_n': kl_last, 'holdout_zib_nll': es_nll}
        hist.append(rec)
        log(' '.join(f'{k} {v:.5f}' if isinstance(v, float) else f'{k} {v}' for k, v in rec.items()))
        if es_nll < best - 1e-6:
            best, bad, best_state = es_nll, 0, {k: v.detach().clone() for k, v in head.state_dict().items()}
        else:
            bad += 1
            if bad >= patience:
                break
    head.load_state_dict(best_state)
    return head.cpu().eval(), hist


@torch.no_grad()
def zib_predict(head, h, z, M=16, seed=42, size=16384, y=None):
    """π, α, β (ω = 사후 평균) + 예측 평균 E[Y] = (1−π) m_B 의 ω 사후 평균·분산 (U_global). y 를 주면 ZIB NLL (ω = 사후 평균)"""
    gen = torch.Generator().manual_seed(seed)
    dev = device_of(head)
    W = head.omega_samples(M, gen)                          # (M, d_r+1)
    keys = ('pi', 'a', 'b', 'mean', 'u_global') + (('nll',) if y is not None else ())
    out = {k: [] for k in keys}
    for b in batches(len(h), size, False):
        hb, zb = to_dev(dev, h[b], z[b])
        lz, am, ak = head.mlp(hb).unbind(-1)
        zb = torch.cat([zb, torch.ones(len(b), 1, device=dev)], 1)
        pi, a, be = zib_params(lz, am + zb @ head.m, ak)
        ms = (1 - pi) * torch.sigmoid(am.unsqueeze(0) + W @ zb.T).clamp(1e-5, 1 - 1e-5)   # (M, B)
        for k, v in (('pi', pi), ('a', a), ('b', be), ('mean', ms.mean(0)), ('u_global', ms.var(0))):
            out[k].append(v)
        if y is not None:
            out['nll'].append(zero_inflated_beta_nll(y[b].to(dev), lz, am + zb @ head.m, ak))
    return {k: torch.cat(v).double().cpu().numpy() for k, v in out.items()}


@torch.no_grad()
def zib_predict_net(net, head, tensors, M=16, seed=42, size=8192, y=None):
    """encoder 부터 조각별로 (flatten 토큰을 전부 들고 있지 않음 : 시즌 전체 추론용)"""
    net.eval()
    dev = device_of(net)
    xn, miss, xc = tensors[:3]
    parts = []
    for b in batches(len(xn), size, False):
        h = net.encode(*to_dev(dev, xn[b], miss[b], xc[b]))
        parts.append(zib_predict(head, h, net.basis(h), M, seed, size, None if y is None else y[b]))
    return {k: np.concatenate([p[k] for p in parts]) for k in parts[0]}


# ---------------------------------------------------------------------------
# 지표 : CRPS · 커버리지 · 0점 Brier · 공통 bin log score (분포 유형이 달라도 같은 정의)
# ---------------------------------------------------------------------------
def gauss_crps(y, mean, sd):
    z = (y - mean) / sd
    return sd * (z * (2 * stats.norm.cdf(z) - 1) + 2 * stats.norm.pdf(z) - 1 / np.sqrt(np.pi))


def gauss_metrics(y, mean, var):
    sd = np.sqrt(var)
    r = {'RMSE': float(np.sqrt(np.mean((y - mean) ** 2))), 'MAE': float(np.mean(np.abs(y - mean))),
         'R2': float(1 - np.mean((y - mean) ** 2) / np.var(y)),
         'NLL (Gaussian)': float(gauss_nll_np(y, mean, var).mean()), 'CRPS': float(gauss_crps(y, mean, sd).mean())}
    ce = []
    for c in (0.5, 0.8, 0.9, 0.95):
        cov = float(np.mean(np.abs(y - mean) <= stats.norm.ppf(0.5 + c / 2) * sd))
        r[f'커버리지 {int(c * 100)}%'] = cov
        ce.append(abs(cov - c))
    r['보정 오차'] = float(np.mean(ce))
    r['90% 구간 평균 폭'] = float(np.mean(2 * stats.norm.ppf(0.95) * sd))
    cdf = stats.norm.cdf((BIN_EDGES[None, 1:-1] - mean[:, None]) / sd[:, None])
    r.update(_bin_scores(y, np.column_stack([np.zeros(len(y)), cdf, np.ones(len(y))])))
    return r


def zib_cdf(t, pi, a, b):
    """t ≥ 0 에서 F(t) = π + (1−π) I_t(α, β)"""
    return pi + (1 - pi) * special.betainc(a, b, np.clip(t, 0, 1))


def zib_ppf(p, pi, a, b):
    q = np.clip((p - pi) / (1 - pi), 0, 1)
    return np.where(p <= pi, 0.0, special.betaincinv(a, b, q))


def zib_metrics(y, pi, a, b, mean, grid=401, chunk=4096):
    """CRPS = ∫₀¹ (F(t) − 1{y ≤ t})² dt (y, 예측 모두 [0,1] 지지 -> 바깥 적분 0)"""
    t = np.linspace(0, 1, grid)
    crps = np.empty(len(y))
    for i in range(0, len(y), chunk):
        s = slice(i, i + chunk)
        F_ = zib_cdf(t[None, :], pi[s, None], a[s, None], b[s, None])
        crps[s] = np.trapz((F_ - (y[s, None] <= t[None, :])) ** 2, t, axis=1)
    r = {'RMSE': float(np.sqrt(np.mean((y - mean) ** 2))), 'MAE': float(np.mean(np.abs(y - mean))),
         'R2': float(1 - np.mean((y - mean) ** 2) / np.var(y)), 'NLL (Gaussian)': np.nan, 'CRPS': float(crps.mean())}
    ce = []
    for c in (0.5, 0.8, 0.9, 0.95):
        lo, hi = zib_ppf((1 - c) / 2, pi, a, b), zib_ppf((1 + c) / 2, pi, a, b)
        cov = float(np.mean((y >= lo) & (y <= hi)))
        r[f'커버리지 {int(c * 100)}%'] = cov
        ce.append(abs(cov - c))
        if c == 0.9:
            width = float(np.mean(hi - lo))
    r['보정 오차'] = float(np.mean(ce))
    r['90% 구간 평균 폭'] = width
    cdf = zib_cdf(BIN_EDGES[None, 1:-1], pi[:, None], a[:, None], b[:, None])
    r.update(_bin_scores(y, np.column_stack([np.zeros(len(y)), cdf, np.ones(len(y))])))
    return r


def _bin_scores(y, cdf):
    """cdf : 각 bin 경계의 누적확률 (n, len(BIN_EDGES)). 0점 Brier = P(y ≤ ZERO_CUT) 의 Brier"""
    p = np.clip(np.diff(cdf, axis=1), 1e-12, 1)
    k = np.searchsorted(BIN_EDGES, y, side='left') - 1
    k = np.clip(k, 0, p.shape[1] - 1)
    p0 = cdf[:, 1]
    return {'bin log score': float(np.mean(np.log(p[np.arange(len(y)), k]))),
            '0점 Brier': float(np.mean((p0 - (y <= ZERO_CUT)) ** 2)), '예측 P(0) 평균': float(p0.mean()), '실제 0 비율': float(np.mean(y <= ZERO_CUT))}



# ---------------------------------------------------------------------------
# 웹 인터페이스 어댑터 (stuff_model.py 약속 : predict / categories / explain / method)
# ---------------------------------------------------------------------------
def _shapley_weights(G):
    """φ = v @ W : v (…, 2^G) 는 coalition 별 가치 (비트 g = 그룹 g 포함), W (2^G, G)"""
    fact = [math.factorial(k) for k in range(G + 1)]
    W = np.zeros((2 ** G, G))
    for S in range(2 ** G):
        s = bin(S).count('1')
        for g in range(G):
            if S >> g & 1:
                W[S, g] += fact[s - 1] * fact[G - s] / fact[G]     # v(S) 가 S∖g → S 의 한계기여에 + 로 들어감
            else:
                W[S, g] -= fact[s] * fact[G - s - 1] / fact[G]     # v(S) 가 S → S∪g 의 한계기여에 − 로 들어감
    return W


def _permutation_weights(G, n_perm, seed=42):
    """순열 표본 Shapley 의 가중 행렬 (2^G, G). 순열마다 한계기여의 합 = v(전체) − v(∅) 이므로 평균도 정확히 가법적.
    순열은 앞 절반을 뽑고 나머지 절반은 그 역순(antithetic)으로 둔다. 모든 투구에 같은 순열 -> 결정적"""
    rng = np.random.default_rng(seed)
    perms = [rng.permutation(G) for _ in range((n_perm + 1) // 2)]
    perms = (perms + [p[::-1] for p in perms])[:n_perm]
    W = np.zeros((2 ** G, G))
    for p in perms:
        S = 0
        for g in p:
            W[S, g] -= 1.0 / len(perms)
            S |= 1 << int(g)
            W[S, g] += 1.0 / len(perms)
    return W


class HOFNetRStuffModel:
    """HOF-Net-R P4 (ZIB) 시드 앙상블의 웹 어댑터. 입력은 v4 와 같은 input_features (원값 vaa·plate_z·pitch_type 포함)

    predict : 시드별 ZIB 예측 평균 E[Y] = (1 − π)·sigmoid(m_B), 공유 ω 는 사후 평균 (결정적) -> 시드 평균
    explain : 요인 그룹(웹의 8개 그룹)을 player 로 둔 interventional group Shapley
              v(S) = mean_k f(x_S, r_k,¬S)  (배경 reference r_k 의 나머지 그룹 값을 채운 혼합 입력)
              -> 기여 합 = f(x) − mean_k f(r_k), base = mean_k f(r_k) 로 가법성이 정확히 성립
              exact=True  : 모든 coalition (2^그룹 수) — 정확한 Shapley
              exact=False : 고정 순열 n_perm 개(antithetic)의 순열 표본 Shapley — 같은 배경·같은 base, 계산량 약 1/8 (LGBM 의 Saabas 자리)
              배경은 둘 다 refs 앞 k_exact 개
              반환 (n, 입력 열 수) 에서 그룹 기여는 그 그룹의 첫 입력 열에 두고 나머지 열은 0 (export 는 그룹 합만 쓴다)
    """

    def __init__(self, members, prep, angle_model, groups, refs, k_exact=8, n_perm=4):
        self.members = [(net.cpu().eval(), head.cpu().eval()) for net, head in members]
        self.prep, self.angle = prep, angle_model
        self.features = prep.num_cols + prep.cat_cols
        self.input_features = angle_model.input_features
        to_model = {'vaa': 'vaa_aa', 'haa': 'haa_aa'}    # 그룹은 입력 열 이름 (export_web_data.EXPLAIN_GROUPS) -> 모델 피처 이름
        self.groups = [(name, [to_model.get(f, f) for f in fs if to_model.get(f, f) in self.features]) for name, fs in groups]
        self.groups = [(name, fs) for name, fs in self.groups if fs]
        self.refs = refs[self.features].reset_index(drop=True)
        self.k_exact, self.n_perm = k_exact, n_perm
        g_of = {f: gi for gi, (_, fs) in enumerate(self.groups) for f in fs}
        assert set(g_of) == set(self.features), '그룹에 없는 피처'
        self.g_num = np.array([g_of[f] for f in prep.num_cols])
        self.g_cat = np.array([g_of[f] for f in prep.cat_cols])

    # --- 내부 ---
    def _dev(self):
        dev = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
        if device_of(self.members[0][0]) != dev:
            for net, head in self.members:
                net.to(dev); head.to(dev)
        return dev

    @torch.no_grad()
    def _f(self, xn, miss, xc, chunk=16384):
        """표준화 텐서 (이미 장치 위) -> 시드 평균 ZIB 예측 (float64 텐서).
        CUDA 의 빠른 attention 커널은 배치 × 헤드가 크면 실행 설정 오류가 나므로 chunk 행씩 나눈다"""
        if len(xn) > chunk:
            return torch.cat([self._f(xn[i:i + chunk], miss[i:i + chunk], xc[i:i + chunk], chunk) for i in range(0, len(xn), chunk)])
        out = 0.0
        for net, head in self.members:
            h = net.encode(xn, miss, xc)
            z = net.basis(h)
            lz, am, ak = head.mlp(h).unbind(-1)
            zb = torch.cat([z, torch.ones(len(z), 1, device=z.device)], 1)
            pi, a, b = zib_params(lz, am + zb @ head.m, ak)
            out = out + (1 - pi.double()) * (a.double() / (a.double() + b.double()))
        return out / len(self.members)

    def _predict_t(self, t, size=65536):
        dev = self._dev()
        xn, miss, xc = t
        return np.concatenate([self._f(*to_dev(dev, xn[i:i + size], miss[i:i + size], xc[i:i + size])).cpu().numpy()
                               for i in range(0, len(xn), size)])

    # --- 인터페이스 ---
    def predict(self, X):
        return self._predict_t(self.prep(self.angle.model_frame(X)))

    @property
    def categories(self):
        return self.angle.categories

    def method(self, exact=True):
        return 'shapley' if exact else 'shapley-sampled'

    def add_derived(self, d):
        return self.angle.add_derived(d)

    def group_shapley(self, X, exact=True, rows=131072):
        """(n, 그룹 수) 그룹 Shapley 기여, base, 예측. 예측 단위 (타구질)"""
        dev = self._dev()
        xn, miss, xc = self.prep(self.angle.model_frame(X))
        K = self.k_exact
        rn, rmiss, rc = to_dev(dev, *self.prep(self.refs.iloc[:K]))
        G = len(self.groups)
        Wn = _shapley_weights(G) if exact else _permutation_weights(G, self.n_perm)
        used = np.flatnonzero(np.abs(Wn).sum(1) > 0)                                       # 계산할 coalition (전체 집합은 항상 포함)
        used = np.union1d(used, [2 ** G - 1])
        full = int(np.searchsorted(used, 2 ** G - 1))
        S = torch.as_tensor(used, device=dev)
        inS = ((S[:, None] >> torch.arange(G, device=dev)[None, :]) & 1).bool()          # (coalition 수, G)
        mn = inS[:, torch.as_tensor(self.g_num, device=dev)]                               # (coalition 수, 수치 피처)
        mc = inS[:, torch.as_tensor(self.g_cat, device=dev)]
        W = torch.as_tensor(Wn[used], device=dev)
        nS = len(used)
        per = max(1, rows // (nS * K))                                                     # 한 번에 처리할 투구 수
        phis, preds = [], []
        for i in range(0, len(xn), per):
            bn, bm, bc = to_dev(dev, xn[i:i + per], miss[i:i + per], xc[i:i + per])
            n = len(bn)
            sel = lambda x, r, m: torch.where(m[None, :, None, :], x[:, None, None, :], r[None, None, :, :]).reshape(-1, x.shape[1])
            v = self._f(sel(bn, rn, mn), sel(bm, rmiss, mn), sel(bc, rc, mc)).reshape(n, nS, K).mean(2)
            phis.append((v @ W).cpu().numpy()); preds.append(v[:, full].cpu().numpy())
        phi, pred = np.concatenate(phis), np.concatenate(preds)
        base = float(self._f(rn, rmiss, rc).mean())
        return phi, base, pred

    def explain(self, X, exact=True):
        phi, base, _ = self.group_shapley(X, exact)
        pred = self.predict(X)
        phi += ((pred - base - phi.sum(1)) / phi.shape[1])[:, None]     # 부동소수 잔차(~1e-8)를 고르게 배분 -> predict 와 정확히 일치
        to_input = {'vaa_aa': 'vaa', 'haa_aa': 'haa'}
        cols = list(X.columns)
        out = np.zeros((len(X), len(cols)))
        for gi, (_, fs) in enumerate(self.groups):
            out[:, cols.index(to_input.get(fs[0], fs[0]))] = phi[:, gi]
        return out, base
