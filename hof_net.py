"""
HOF-Net (HOF_Net_Draft_v0_1.pdf, 부록 A 기준 구현) — 3단계 구위 모델 후보 (실험용, 웹 미반영)

구조
- 토큰화 : 수치 e_k = x_k·w_k + b_k (+ 결측 임베딩), 범주 = 임베딩. d = 32
- Self-attention : Transformer 2층 · 4헤드 · dropout 0.1, 마지막 층 헤드 평균 A(x)
- 사후분포 q(W|x) = N(μ(x), D R D) : R = corr(BBᵀ + εI), B = (A + Aᵀ)/2, D = diag(softplus(v(x)) + ε)
- 사전분포 p(W|x) = N(0, diag τ²) : τ_k = τ_min + softplus(a·λ_k + b_k), a = softplus(ã) > 0, λ_k = 대칭 attention 평균
- 예측기 (초기형) : m(x, W) = b + Σ_k W_k·h_k(x), h_k = 피처 k 자기 토큰만 보는 MLP (문맥 없음)
- 우도 : N(y | m, σ²(x)), σ² = softplus(·) + ε
- 학습 : 조건부 ELBO (β), EM 방식 교대 최적화 (A단계 θ·φ / B단계 ψ : KL + λ_prior·Ω)

m 이 W 에 선형이므로 예측 분포는 정확히 N(b + hᵀμ, σ² + hᵀΣh) : 평균·분산·NLL 을 MC 없이 계산 (MC 는 수렴 점검용)
- U_alea = σ², U_latent = hᵀΣh (초안 7절)
- 구위 산출 근거 : 기여 c_k = μ_k·h_k, 기준값 b → b + Σ c_k = 예측 평균 (정확한 덧셈 분해)
"""
import math

import numpy as np
import pandas as pd
import torch
import torch.nn as nn
import torch.nn.functional as F

EPS_R, EPS_S, TAU_MIN = 1e-3, 1e-5, 1e-4    # EPS_R : 초안 기본 1e-5, 안정성을 위해 1e-3 (16.3절 adaptive jitter 허용)


class Block(nn.Module):
    def __init__(self, d, heads, dropout):
        super().__init__()
        self.ln1, self.ln2 = nn.LayerNorm(d), nn.LayerNorm(d)
        self.attn = nn.MultiheadAttention(d, heads, dropout=0.0, batch_first=True)    # A(x) 를 공분산에 쓰므로 attention 자체엔 dropout 없음
        self.ff = nn.Sequential(nn.Linear(d, 2 * d), nn.GELU(), nn.Dropout(dropout), nn.Linear(2 * d, d))
        self.drop = nn.Dropout(dropout)

    def forward(self, x):
        h = self.ln1(x)
        a, w = self.attn(h, h, h, need_weights=True, average_attn_weights=True)    # w : (B, K, K) 헤드 평균
        x = x + self.drop(a)
        x = x + self.drop(self.ff(self.ln2(x)))
        return x, w


class HOFNet(nn.Module):
    def __init__(self, n_num, cat_cards, d=32, layers=2, heads=4, dropout=0.1, cov='full', latent=True):
        super().__init__()
        self.n_num, self.K, self.cov, self.latent = n_num, n_num + len(cat_cards), cov, latent
        self.w = nn.Parameter(torch.randn(n_num, d) * 0.3)
        self.b = nn.Parameter(torch.zeros(n_num, d))
        self.miss = nn.Parameter(torch.zeros(n_num, d))
        self.cat = nn.ModuleList([nn.Embedding(c + 1, d) for c in cat_cards])
        self.blocks = nn.ModuleList([Block(d, heads, dropout) for _ in range(layers)])
        K = self.K
        self.mu_head = nn.Linear(K * d, K)
        self.s_head = nn.Linear(K * d, K)
        nn.init.constant_(self.s_head.bias, -3.0)    # 초기 사후 표준편차 ≈ 0.05
        self.var_head = nn.Sequential(nn.Linear(K * d, 64), nn.GELU(), nn.Linear(64, 1))
        self.h = nn.Sequential(nn.Linear(d, 32), nn.GELU(), nn.Linear(32, 1))    # 피처별 h_k (자기 토큰만)
        self.bias = nn.Parameter(torch.zeros(1))
        # ψ : 조건부 사전분포
        self.prior_a = nn.Parameter(torch.zeros(1))
        self.prior_b = nn.Parameter(torch.full((K,), math.log(math.e - 1)))    # softplus = 1 → τ ≈ 1

    def theta_phi(self):
        return [p for n, p in self.named_parameters() if not n.startswith('prior_')]

    def psi(self):
        return [self.prior_a, self.prior_b]

    def tokens(self, xn, miss, xc):
        e = xn.unsqueeze(-1) * self.w + self.b + miss.unsqueeze(-1) * self.miss
        return torch.cat([e] + [emb(xc[:, j]).unsqueeze(1) for j, emb in enumerate(self.cat)], dim=1)

    def forward(self, xn, miss, xc):
        e0 = self.tokens(xn, miss, xc)
        z = e0
        for blk in self.blocks:
            z, A = blk(z)
        flat = z.flatten(1)
        mu = self.mu_head(flat)
        s = F.softplus(self.s_head(flat)) + EPS_S
        h = self.h(e0).squeeze(-1)                       # (B, K) 문맥 없는 피처 항
        var = F.softplus(self.var_head(flat)).squeeze(-1) + 1e-4
        if self.cov == 'full':
            Bm = (A + A.transpose(1, 2)) / 2
            G = Bm @ Bm.transpose(1, 2) + EPS_R * torch.eye(self.K, device=A.device)
            dg = torch.sqrt(torch.diagonal(G, dim1=1, dim2=2))
            R = G / (dg.unsqueeze(2) * dg.unsqueeze(1))
        else:
            R = torch.eye(self.K, device=A.device).expand(A.shape[0], -1, -1)
        lam = ((A + A.transpose(1, 2)) / 2).mean(dim=2)  # λ_k (4.9절)
        tau = TAU_MIN + F.softplus(F.softplus(self.prior_a) * lam * self.K + self.prior_b)
        return {'mu': mu, 's': s, 'R': R, 'h': h, 'var': var, 'tau': tau, 'lam': lam, 'A': A}

    def predictive(self, o):
        """정확한 예측 분포 N(mean, var_alea + var_latent)"""
        mean = self.bias + (o['mu'] * o['h']).sum(1)
        if not self.latent:
            return mean, o['var'], torch.zeros_like(mean)
        hs = o['h'] * o['s']                               # hᵀ D R D h
        u_lat = (hs.unsqueeze(1) @ o['R'] @ hs.unsqueeze(2)).squeeze(-1).squeeze(-1).clamp_min(0)
        return mean, o['var'], u_lat

    def kl(self, o):
        """KL( N(μ, DRD) || N(0, diag τ²) ) 닫힌 꼴 (4.11절)"""
        mu, s, R, tau = o['mu'], o['s'], o['R'], o['tau']
        tr = (s ** 2 / tau ** 2).sum(1)
        quad = (mu ** 2 / tau ** 2).sum(1)
        if self.cov == 'full':
            L = torch.linalg.cholesky(R + 1e-6 * torch.eye(self.K, device=R.device))
            logdet_R = 2 * torch.log(torch.diagonal(L, dim1=1, dim2=2)).sum(1)
        else:
            logdet_R = torch.zeros_like(tr)
        logdet_q = 2 * torch.log(s).sum(1) + logdet_R
        logdet_p = 2 * torch.log(tau).sum(1)
        return 0.5 * (tr + quad - self.K + logdet_p - logdet_q)

    def sample_mean(self, o, M):
        """MC 표본 W^(m) = μ + chol(Σ) ε 로 예측 평균·분산 (수렴 점검용)"""
        Sig = o['s'].unsqueeze(2) * o['R'] * o['s'].unsqueeze(1)
        L = torch.linalg.cholesky(Sig + 1e-8 * torch.eye(self.K, device=Sig.device))
        eps = torch.randn(M, *o['mu'].shape, device=o['mu'].device)
        W = o['mu'] + (L.unsqueeze(0) @ eps.unsqueeze(-1)).squeeze(-1)
        m = self.bias + (W * o['h']).sum(-1)              # (M, B)
        return m.mean(0), m.var(0) + o['var']


def gauss_nll(y, mean, var):
    return 0.5 * (torch.log(2 * math.pi * var) + (y - mean) ** 2 / var)


def gauss_crps(y, mean, sd):
    """정규 예측 분포의 CRPS (닫힌 꼴)"""
    from scipy.stats import norm
    z = (y - mean) / sd
    return sd * (z * (2 * norm.cdf(z) - 1) + 2 * norm.pdf(z) - 1 / np.sqrt(np.pi))


# ---------------------------------------------------------------------------
# 전처리 · 학습 · 추론
# ---------------------------------------------------------------------------
class Prep:
    """수치형 표준화(학습기간 평균·표준편차) + 결측 표시, 범주형 코드"""

    def __init__(self, df, num_cols, cat_cols):
        self.num_cols, self.cat_cols = list(num_cols), list(cat_cols)
        x = df[self.num_cols].astype('float64')
        self.mean, self.std = x.mean(), x.std().replace(0, 1)
        self.cats = [list(df[c].astype('category').cat.categories) for c in self.cat_cols]

    def __call__(self, df):
        x = ((df[self.num_cols].astype('float64') - self.mean) / self.std)
        miss = x.isna().to_numpy(np.float32)
        xn = x.fillna(0).to_numpy(np.float32)
        xc = np.column_stack([pd.Categorical(df[c].astype(str), categories=[str(v) for v in cats]).codes + 1
                              for c, cats in zip(self.cat_cols, self.cats)]).astype(np.int64)
        return torch.from_numpy(xn), torch.from_numpy(miss), torch.from_numpy(xc)

    @property
    def cat_cards(self):
        return [len(c) for c in self.cats]


def batches(n, size, shuffle, gen=None):
    idx = torch.randperm(n, generator=gen) if shuffle else torch.arange(n)
    for i in range(0, n, size):
        yield idx[i:i + size]


@torch.no_grad()
def predict(net, tensors, size=8192):
    net.eval()
    xn, miss, xc = tensors
    out = {k: [] for k in ('mean', 'var', 'u_lat', 'contrib', 'lam')}
    for b in batches(len(xn), size, False):
        o = net(xn[b], miss[b], xc[b])
        mean, var, u = net.predictive(o)
        out['mean'].append(mean); out['var'].append(var); out['u_lat'].append(u)
        out['contrib'].append(o['mu'] * o['h']); out['lam'].append(o['lam'])
    return {k: torch.cat(v).double().numpy() for k, v in out.items()} | {'base': float(net.bias.item())}


def fit(net, tr, es, beta=1.0, lam_prior=1e-3, epochs=30, patience=4, batch=1024, lr=1e-3, lr_psi=1e-4,
        b_frac=0.25, seed=42, nll_beta=0.0, log=print):
    """EM 방식 교대 최적화 (5절 Algorithm 1). 조기 종료 = 홀드아웃 예측 NLL. 반환 : 학습 기록 DataFrame
    nll_beta > 0 : β-NLL (Seitzer et al. 2022) — 투구별 NLL 에 σ²^nll_beta (기울기 차단) 가중.
                   일반 Gaussian NLL 은 분산만 맞추고 평균 학습을 멈추는 문제가 있어 그 보완책"""
    torch.manual_seed(seed)
    gen = torch.Generator().manual_seed(seed)
    (xn, miss, xc, y), (exn, emiss, exc, ey) = tr, es
    opt_a = torch.optim.AdamW(net.theta_phi(), lr=lr, weight_decay=1e-4)
    opt_b = torch.optim.AdamW(net.psi(), lr=lr_psi)
    best, best_state, bad, hist = np.inf, None, 0, []
    for ep in range(epochs):
        net.train()
        tot = {'nll': 0.0, 'kl': 0.0, 'n': 0, 'nan': 0, 'chol': 0}
        for b in batches(len(y), batch, True, gen):              # A단계 : θ·φ (ψ 고정)
            o = net(xn[b], miss[b], xc[b])
            if net.latent:
                Sig = o['s'].unsqueeze(2) * o['R'] * o['s'].unsqueeze(1)
                L, info = torch.linalg.cholesky_ex(Sig + 1e-8 * torch.eye(net.K))
                tot['chol'] += int((info != 0).sum())
                eps = torch.randn(4, *o['mu'].shape)
                W = o['mu'] + (L.unsqueeze(0) @ eps.unsqueeze(-1)).squeeze(-1)   # 재매개화 표본 4개
                m = net.bias + (W * o['h']).sum(-1)
                ll = -gauss_nll(y[b], m, o['var']).mean(0)
                kl = net.kl(o)
                wt = (lambda w: w / w.mean())(o['var'].detach() ** nll_beta) if nll_beta else 1.0   # 배치 평균 1 로 정규화 (KL 과의 비중 유지)
                loss = (-ll * wt + beta * kl).mean()
            else:
                mean, var, _ = net.predictive(o)
                ll, kl = -gauss_nll(y[b], mean, var), torch.zeros(len(b))
                wt = (lambda w: w / w.mean())(var.detach() ** nll_beta) if nll_beta else 1.0
                loss = (-ll * wt).mean()
            if not torch.isfinite(loss):
                tot['nan'] += 1
                continue
            opt_a.zero_grad(); loss.backward()
            nn.utils.clip_grad_norm_(net.theta_phi(), 5.0)
            opt_a.step()
            tot['nll'] += float(-ll.sum()); tot['kl'] += float(kl.sum()); tot['n'] += len(b)
        if net.latent:                                           # B단계 : ψ (θ·φ 고정)
            for i, b in enumerate(batches(len(y), batch, True, gen)):
                if i >= b_frac * len(y) / batch:
                    break
                with torch.no_grad():
                    o = net(xn[b], miss[b], xc[b])
                lam = o['lam']
                tau = TAU_MIN + F.softplus(F.softplus(net.prior_a) * lam * net.K + net.prior_b)
                o = {**{k: v.detach() for k, v in o.items()}, 'tau': tau}
                omega = (torch.log(tau) - 0.0) ** 2              # log τ0 = 0 (τ0 = 1)
                loss_b = net.kl(o).mean() + lam_prior * omega.mean()
                opt_b.zero_grad(); loss_b.backward(); opt_b.step()
        p = predict(net, (exn, emiss, exc))
        es_nll = float(gauss_nll(ey.double(), torch.from_numpy(p['mean']), torch.from_numpy(p['var'] + p['u_lat'])).mean())
        es_rmse = float(np.sqrt(np.mean((ey.numpy() - p['mean']) ** 2)))
        with torch.no_grad():
            tau_max = float(net(exn[:4096], emiss[:4096], exc[:4096])['tau'].max())
        rec = {'epoch': ep + 1, 'train_nll': tot['nll'] / max(tot['n'], 1), 'train_kl': tot['kl'] / max(tot['n'], 1),
               'holdout_nll': es_nll, 'holdout_rmse': es_rmse, 'nan_batches': tot['nan'], 'chol_fail': tot['chol'], 'tau_max': tau_max}
        hist.append(rec)
        log(' '.join(f'{k} {v:.5f}' if isinstance(v, float) else f'{k} {v}' for k, v in rec.items()))
        if es_nll < best - 1e-5:
            best, bad = es_nll, 0
            best_state = {k: v.detach().clone() for k, v in net.state_dict().items()}
        else:
            bad += 1
            if bad >= patience:
                break
    net.load_state_dict(best_state)
    return pd.DataFrame(hist)


# ---------------------------------------------------------------------------
# 웹 인터페이스 어댑터 (stuff_model.py 와 같은 약속 : predict / categories / explain / method)
# ---------------------------------------------------------------------------
class HOFNetStuffModel:
    """v3 와 같은 입력(원값 vaa·plate_z 포함)을 받아 HAVAA 를 계산한 뒤 HOF-Net 으로 예측.
    explain = 덧셈 분해 (μ_k·h_k, 기준값 b) — 정확값이므로 exact 와 무관하게 같은 결과"""

    def __init__(self, net, prep, v3_model):
        self.net, self.prep, self.v3 = net, prep, v3_model
        self.features = prep.num_cols + prep.cat_cols
        self.input_features = v3_model.input_features

    def _parts(self, X):
        Xm = self.v3.model_frame(X)
        return predict(self.net, self.prep(Xm))

    def predict(self, X):
        p = self._parts(X)
        return p['base'] + p['contrib'].sum(1)

    def predictive(self, X):
        p = self._parts(X)
        return p['base'] + p['contrib'].sum(1), p['var'], p['u_lat']

    @property
    def categories(self):
        return self.v3.categories

    def explain(self, X, exact=True):
        p = self._parts(X)
        to_input = {'vaa_aa': 'vaa'}
        cols = list(X.columns)
        out = np.zeros((len(X), len(cols)))
        for j, f in enumerate(self.features):
            out[:, cols.index(to_input.get(f, f))] += p['contrib'][:, j]
        return out, p['base']

    def method(self, exact=True):
        return 'hof-additive'
