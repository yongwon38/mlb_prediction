"""
HOF-Net-R 성능 열세 원인 진단 (시드 42 고정) — LGBM v4 대비 구위 지표 ρ(whiff) 가 낮은 이유를 가설별로 확인

실행 : python hofnet_diag_experiment.py [--runs base,h1,...] [--smoke]
  base : 기준선 (hofnet_r_experiment.py 와 같은 Stage I + ZIB 헤드) — 저장된 시드 42 결과 재현 확인
  h1   : 데이터 양 — 학습 비율 10/25/50% × (HOF, LGBM v4 같은 하이퍼파라미터). 100% = base / 운영 v4
  h2   : 조기 종료·학습 부족 — ① 조기 종료 없이 30 epoch (epoch 마다 ρ) ② cosine 학습률 + 마지막 10 epoch 가중치 평균(SWA)
  h3   : 구종(pitch_type) 임베딩 입력 (진단용, 운영 v4 원칙상 웹 반영 안 함)
  h4   : 인코더를 ZIB NLL 로 end-to-end 학습 (기존 : MSE 인코더 고정 + ZIB 헤드)
  h5   : 구조·용량 — 일반 MLP / 큰 HOF (d=64, layers=3)
  h6   : distillation — LGBM v4 예측값을 타깃으로 학습 (a : 같은 학습 표본, b : 학습기간 비-waste 전체 투구)
출력 : outputs/hofnet_diag/ (runs/*.json = 실험별 결과, 있으면 건너뜀 · results.csv · epochs.csv · pt_bias.csv)
데이터 · split · 변수 · 구위 지표 정의 : hofnet_r_experiment.py 1절, hofnet_experiment.py 4절과 같다
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

import export_web_data as ew
import hof_net as hn
import hof_net_r as hr
import stuff_model as sm
import stuff_pipeline as sp

warnings.filterwarnings('ignore')
sys.stdout.reconfigure(encoding='utf-8')
ALL_RUNS = ['base', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']
ap = argparse.ArgumentParser()
ap.add_argument('--runs', default=','.join(ALL_RUNS))
ap.add_argument('--smoke', action='store_true')
ARGS = ap.parse_args()
SMOKE = ARGS.smoke
SEED = 42
EPOCHS = 2 if SMOKE else 30
B = 50 if SMOKE else 1000
DEV = torch.device('cuda' if torch.cuda.is_available() else 'cpu')
OUT = os.path.join('outputs', 'hofnet_diag', 'smoke') if SMOKE else os.path.join('outputs', 'hofnet_diag')
os.makedirs(os.path.join(OUT, 'runs'), exist_ok=True)
CACHE = os.path.join('outputs', 'vaa_exp', 'cache')
T0 = time.time()
LOG = open(os.path.join(OUT, 'diag_log.txt'), 'a', encoding='utf-8')


def log(*a):
    s = f'[{time.time() - T0:7.0f}s] ' + ' '.join(str(x) for x in a)
    print(s, flush=True); LOG.write(s + '\n'); LOG.flush()


def save(df, name, **kw):
    df.to_csv(os.path.join(OUT, name), encoding='utf-8-sig', **kw)


log('시작', vars(ARGS), 'device', DEV)

# ---------------------------------------------------------------------------
# 1. 데이터 (hofnet_r_experiment.py 1절과 같은 캐시 · split · 변수)
# ---------------------------------------------------------------------------
v4 = sm.load_model(os.path.join('models', 'v4'))
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
valid_start = pd.Timestamp(pd.read_json(os.path.join(CACHE, 'meta.json'), typ='series')['valid_start'])
d25 = fr[2025]
samp = d25[d25['y3'].notna()]
tr_rows, es_rows, va_rows = samp[samp['split'] == 'tr'], samp[samp['split'] == 'es'], samp[samp['split'] == 'va']
if SMOKE:
    tr_rows, es_rows, va_rows = tr_rows.sample(20000, random_state=SEED), es_rows.sample(4000, random_state=SEED), va_rows.sample(6000, random_state=SEED)
    keep = set(tr_rows.index) | set(es_rows.index) | set(va_rows.index)
    fr = {y: (d.loc[d.index.isin(keep) | (d['game_date'] >= valid_start).to_numpy() | (np.random.default_rng(SEED).random(len(d)) < 0.05)] if y == 2025 else d.sample(60000, random_state=SEED))
          for y, d in fr.items()}
    d25 = fr[2025]
is_tr = (d25['game_date'] < valid_start).to_numpy()
waste = {y: fr[y]['waste'].fillna(True).to_numpy(bool) for y in fr}    # 결측 = 점수 제외 (where(~waste) 와 같은 처리)
log('표본 train', len(tr_rows), 'holdout', len(es_rows), 'valid', len(va_rows), '| 시즌', {y: len(d) for y, d in fr.items()})

prep = hn.Prep(tr_rows, NUM, CAT)
CAT_PT = CAT + ['pitch_type']
prep_pt = hn.Prep(tr_rows, NUM, CAT_PT)    # H3 : 구종 임베딩 추가
y_tr, y_es, y_va = (torch.tensor(d['y3'].to_numpy(np.float32)) for d in (tr_rows, es_rows, va_rows))
va_pos = d25.index.get_indexer(va_rows.index)
assert (va_pos >= 0).all()
_tens = {}


def tensors(p, key, df):
    """(xn, miss, xc) 캐시 : p = Prep, key = 이름"""
    k = (id(p), key)
    if k not in _tens:
        _tens[k] = p(df)
    return _tens[k]


def split_t(p, y=None):
    """학습·홀드아웃 텐서 (타깃 y 를 바꿀 수 있다 : distillation)"""
    ytr, yes = (y_tr, y_es) if y is None else y
    return (*tensors(p, 'tr', tr_rows), ytr), (*tensors(p, 'es', es_rows), yes)


season_t = lambda p, y: tensors(p, f'season{y}', fr[y])

# ---------------------------------------------------------------------------
# 2. 구위 지표 (hofnet_experiment.py 4절 정의) + 투수 군집 bootstrap
# ---------------------------------------------------------------------------
_src = open('hofnet_experiment.py', encoding='utf-8').read()
exec(_src[_src.index('def within_corr'):_src.index('scalers, stuff_cols, rows = {}, {}, {}')])
dv = d25[~is_tr].assign(swing=lambda d: d['description'].isin(ew.SWING_DESC), whiff=lambda d: d['description'].isin(sp.WHIFF_DESC))
gkey = ['pitcher', 'pitch_type']
grp_tab = dv.groupby(gkey, observed=True).agg(n=('swing', 'size'), sw=('swing', 'sum'), wh=('whiff', 'sum'))
grp_tab = grp_tab[grp_tab['n'] >= 100]
grp_tab['wr'] = grp_tab['wh'] / grp_tab['sw']
_pits = grp_tab.index.get_level_values('pitcher').to_numpy()
_upits = np.unique(_pits)
_rows_of = {p_: np.where(_pits == p_)[0] for p_ in _upits}
_rng = np.random.default_rng(SEED)
BOOT = [np.concatenate([_rows_of[p_] for p_ in _rng.choice(_upits, len(_upits))]) for _ in range(B)]    # 모든 실험이 같은 재표본
WR = grp_tab['wr'].to_numpy()


def boot_rho(s):
    return np.array([stats.spearmanr(s[i], WR[i]).statistic for i in BOOT])


REF = {}    # LGBM v4 기준값 : pt 평균 2026, bootstrap ρ
PT_LIST = ['FF', 'SI', 'FC', 'SL', 'ST', 'CU', 'KC', 'CH', 'FS']


def evaluate(name, pred, extra=None, ref=False):
    """pred = {연도: 투구별 원 예측(타구질, 낮을수록 좋음)} -> 구위 점수(StuffScaler, 2025 학습기간 비-waste) 기준 지표"""
    sc = sp.StuffScaler().fit(pred[2025][is_tr & ~waste[2025]])
    for y in fr:
        fr[y]['s_cur'] = pd.Series(sc.transform(pred[y]).astype('float32'), index=fr[y].index).where(~fr[y]['waste'])
    pv = pred[2025][va_pos]
    yv = y_va.double().numpy()
    r = {'run': name, '홀드아웃 RMSE (검증)': float(np.sqrt(np.mean((yv - pv) ** 2))), '홀드아웃 R² (검증)': float(1 - np.mean((yv - pv) ** 2) / np.var(yv))}
    r.update({f'검증 {a}': v for a, v in validity(fr[2025][~is_tr], 's_cur').items()})
    mm = pd.concat([pt_means(fr[2025], 's_cur'), pt_means(fr[2026], 's_cur')], axis=1, join='inner')
    r['안정성 r(2025→2026)'] = mm.corr().iloc[0, 1]
    ww = pd.concat([pt_means(fr[2025], 's_cur'), pt_whiff(fr[2026])], axis=1, join='inner')
    r['예측력 ρ(구위 2025, whiff% 2026)'] = stats.spearmanr(ww.iloc[:, 0], ww.iloc[:, 1]).statistic
    s_grp = dv.assign(s=fr[2025].loc[dv.index, 's_cur']).groupby(gkey, observed=True)['s'].mean().reindex(grp_tab.index).to_numpy()
    rb = boot_rho(s_grp)
    r['ρ 95% CI 하한'], r['ρ 95% CI 상한'] = float(np.quantile(rb, 0.025)), float(np.quantile(rb, 0.975))
    pt26 = pt_means(fr[2026], 's_cur')
    if ref:
        REF.update(pt26=pt26, rb=rb)
    else:
        d_ = rb - REF['rb']
        r['ρ − LGBM'] = r['검증 투수×구종 ρ(구위, whiff%)'] - REF['rho']
        r['ρ − LGBM 95% CI 하한'], r['ρ − LGBM 95% CI 상한'] = float(np.quantile(d_, 0.025)), float(np.quantile(d_, 0.975))
        both = pd.concat([pt26, REF['pt26']], axis=1, join='inner')
        r['LGBM 과 투수×구종 상관 (2026)'] = float(both.corr().iloc[0, 1])
        diff = (both.iloc[:, 0] - both.iloc[:, 1]).groupby(level=1).mean()
        r.update({f'구종 치우침 {pt}': float(diff.get(pt, np.nan)) for pt in PT_LIST})
        r['구종 치우침 |평균|'] = float(np.nanmean([abs(r[f'구종 치우침 {pt}']) for pt in PT_LIST]))
    if ref:
        REF['rho'] = r['검증 투수×구종 ρ(구위, whiff%)']
    r.update(extra or {})
    log(f'[{name}] ρ(whiff) {r["검증 투수×구종 ρ(구위, whiff%)"]:.4f} [{r["ρ 95% CI 하한"]:.3f}, {r["ρ 95% CI 상한"]:.3f}]',
        f'RMSE {r["홀드아웃 RMSE (검증)"]:.5f}', f'예측력 {r["예측력 ρ(구위 2025, whiff% 2026)"]:.4f}',
        '' if ref else f'Δ {r["ρ − LGBM"]:+.4f} [{r["ρ − LGBM 95% CI 하한"]:+.3f}, {r["ρ − LGBM 95% CI 상한"]:+.3f}]')
    return r


def rho_2025(pred25):
    """epoch 별 빠른 ρ : 2025 만"""
    sc = sp.StuffScaler().fit(pred25[is_tr & ~waste[2025]])
    s = pd.Series(sc.transform(pred25).astype('float32'), index=d25.index).where(~d25['waste'])
    return validity(d25[~is_tr].assign(s_cur=s[~is_tr]), 's_cur')['투수×구종 ρ(구위, whiff%)']


# ---------------------------------------------------------------------------
# 3. 모델 · 학습
# ---------------------------------------------------------------------------
class MLP(nn.Module):
    """H5 : 같은 입력의 일반 MLP. HOFNetR 과 같은 인터페이스 (encode → basis → out)"""

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


def fit_mean_ext(net, tr, es, y_mean, y_std, epochs, patience=4, early_stop=True, cosine=False, swa_last=0, on_epoch=None, batch=1024, lr=1e-3, seed=SEED):
    """hr.fit_mean 과 같은 학습 루프 + 선택 : 조기 종료 끄기, cosine 학습률, 마지막 k epoch 가중치 평균(SWA), epoch 콜백"""
    torch.manual_seed(seed)
    gen = torch.Generator().manual_seed(seed)
    (xn, miss, xc, y), (exn, emiss, exc, ey) = tr, es
    dev = hn.device_of(net)
    ys = (y - y_mean) / y_std
    opt = torch.optim.AdamW(net.parameters(), lr=lr, weight_decay=1e-4)
    sched = torch.optim.lr_scheduler.CosineAnnealingLR(opt, T_max=epochs) if cosine else None
    ey_np = ey.double().numpy()
    best, best_state, bad, hist, swa, n_swa = np.inf, None, 0, [], None, 0
    for ep in range(epochs):
        net.train()
        tot, n = 0.0, 0
        for b in hn.batches(len(y), batch, True, gen):
            f, _ = net(*hn.to_dev(dev, xn[b], miss[b], xc[b]))
            loss = F.mse_loss(f, ys[b].to(dev))
            opt.zero_grad(); loss.backward()
            nn.utils.clip_grad_norm_(net.parameters(), 5.0)
            opt.step()
            tot += float(loss) * len(b); n += len(b)
        if sched:
            sched.step()
        if swa_last and ep >= epochs - swa_last:
            sd = {k: v.detach().clone().float() for k, v in net.state_dict().items()}
            swa = sd if swa is None else {k: swa[k] + (sd[k] - swa[k]) / (n_swa + 1) for k in sd}
            n_swa += 1
        f_es, _ = hr.encode_all(net, (exn, emiss, exc), y_mean, y_std)
        rmse = float(np.sqrt(np.mean((ey_np - f_es) ** 2)))
        rec = {'epoch': ep + 1, 'train_mse_std': tot / max(n, 1), 'holdout_rmse': rmse}
        if on_epoch:
            rec.update(on_epoch(net))
        hist.append(rec)
        log('   ', ' '.join(f'{k} {v:.5f}' if isinstance(v, float) else f'{k} {v}' for k, v in rec.items()))
        if rmse < best - 1e-6:
            best, bad = rmse, 0
            best_state = {k: v.detach().clone() for k, v in net.state_dict().items()}
        elif early_stop:
            bad += 1
            if bad >= patience:
                break
    if swa is not None:
        net.load_state_dict({k: v.to(best_state[k].dtype) for k, v in swa.items()})    # 평균 가중치 (BatchNorm 없음 → 재보정 불필요)
    elif early_stop:
        net.load_state_dict(best_state)
    return hist


def fit_zib_e2e(net, tr, es, tau0=1.0, epochs=EPOCHS, patience=4, batch=1024, lr=1e-3, seed=SEED):
    """H4 : 인코더 + ZIB 헤드를 ZIB NLL(+KL/N) 로 함께 학습. 조기 종료 = 홀드아웃 ZIB NLL (ω = 사후 평균)"""
    torch.manual_seed(seed)
    gen = torch.Generator().manual_seed(seed)
    (xn, miss, xc, y), (exn, emiss, exc, ey) = tr, es
    dev = hn.device_of(net)
    with torch.no_grad():
        h0 = net.encode(*hn.to_dev(dev, xn[:2], miss[:2], xc[:2]))
    head = hr.ZIBHead(h0.shape[1], net.basis(h0).shape[1])
    pi0 = float((y == 0).float().mean())
    with torch.no_grad():
        head.mlp[-1].bias.copy_(torch.tensor([np.log(pi0 / (1 - pi0)), float(torch.logit(y[y > 0].mean())), 1.0]))
    head.to(dev)
    params = list(net.parameters()) + list(head.parameters())
    opt = torch.optim.AdamW(params, lr=lr, weight_decay=1e-4)
    N, best, best_state, bad, hist = len(y), np.inf, None, 0, []
    for ep in range(epochs):
        net.train(); head.train()
        tot = 0.0
        for b in hn.batches(N, batch, True, gen):
            bx = hn.to_dev(dev, xn[b], miss[b], xc[b])
            h = net.encode(*bx)
            nll = hr.zero_inflated_beta_nll(y[b].to(dev), *head(h, net.basis(h), sample=True)).mean()
            loss = nll + hr.global_kl_per_observation(head.m, head.s, tau0, N)
            opt.zero_grad(); loss.backward()
            nn.utils.clip_grad_norm_(params, 5.0)
            opt.step()
            tot += float(nll) * len(b)
        net.eval(); head.eval()
        with torch.no_grad():
            es_nll = []
            for b in hn.batches(len(ey), 8192, False):
                h = net.encode(*hn.to_dev(dev, exn[b], emiss[b], exc[b]))
                es_nll.append(hr.zero_inflated_beta_nll(ey[b].to(dev), *head(h, net.basis(h), sample=False)))
            es_nll = float(torch.cat(es_nll).mean())
        hist.append({'epoch': ep + 1, 'train_zib_nll': tot / N, 'holdout_zib_nll': es_nll})
        log('    e2e', hist[-1])
        if es_nll < best - 1e-6:
            best, bad = es_nll, 0
            best_state = ({k: v.detach().clone() for k, v in net.state_dict().items()}, {k: v.detach().clone() for k, v in head.state_dict().items()})
        else:
            bad += 1
            if bad >= patience:
                break
    net.load_state_dict(best_state[0]); head.load_state_dict(best_state[1])
    return head.eval(), hist


def new_net(kind, p):
    torch.manual_seed(SEED)
    if kind == 'mlp':
        return MLP(len(NUM), p.cat_cards).to(DEV)
    if kind == 'big':
        return hr.HOFNetR(len(NUM), p.cat_cards, d=64, layers=3).to(DEV)
    return hr.HOFNetR(len(NUM), p.cat_cards).to(DEV)


def p1_season(net, p, y_mean, y_std):
    return {y: hr.encode_all(net, season_t(p, y), y_mean, y_std)[0] for y in fr}


def p4(net, p, tr, es, y_mean, y_std):
    """기존 P4 : 인코더 고정 + ZIB 헤드 (hofnet_r_experiment 3절과 같은 호출). 반환 : 시즌별 E[Y] (M=4, seed 42)"""
    _, z_tr, h_tr = hr.encode_all(net, tr, y_mean, y_std, flat=True)
    _, z_es, h_es = hr.encode_all(net, es, y_mean, y_std, flat=True)
    zh, _ = hr.fit_zib_head(h_tr, torch.from_numpy(z_tr), y_tr, h_es, torch.from_numpy(z_es), y_es, epochs=EPOCHS, seed=SEED,
                            log=lambda s: None, device=DEV)
    zh.to(DEV)
    del h_tr, h_es
    return {y: hr.zib_predict_net(net, zh, season_t(p, y), M=4, seed=SEED)['mean'] for y in fr}


RESULTS = []


def done(name):
    f = os.path.join(OUT, 'runs', f'{name}.json')
    if os.path.exists(f):
        RESULTS.extend(json.load(open(f, encoding='utf-8')))
        log(f'[{name}] 저장본 사용')
        return True
    return False


def keep(name, rows, hist=None):
    json.dump(rows, open(os.path.join(OUT, 'runs', f'{name}.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, default=float)
    if hist is not None:
        pd.DataFrame(hist).assign(run=name).to_csv(os.path.join(OUT, 'runs', f'{name}_epochs.csv'), index=False, encoding='utf-8-sig')
    RESULTS.extend(rows)


def run_hof(name, desc, kind='hof', p=prep, tr=None, es=None, fit_kw=None, with_p4=True, y_target=None):
    """Stage I 학습 → P1 평가 (+ P4). y_target = (학습 타깃, 홀드아웃 타깃) 로 distillation"""
    if done(name):
        return
    tr_, es_ = (tr, es) if tr is not None else split_t(p, y_target)
    y_mean, y_std = float(tr_[3].mean()), float(tr_[3].std())
    net = new_net(kind, p)
    t = time.time()
    log(f'=== {name} : {desc} (학습 {len(tr_[3]):,}구, 파라미터 {sum(q.numel() for q in net.parameters()):,})')
    if fit_kw is None:
        hist = hr.fit_mean(net, tr_, es_, y_mean, y_std, epochs=EPOCHS, seed=SEED, log=lambda s: log('   ', s))
    else:
        hist = fit_mean_ext(net, tr_, es_, y_mean, y_std, epochs=EPOCHS, **fit_kw)
    t1 = time.time() - t
    info = {'설명': desc, '모델': kind, '학습 투구': len(tr_[3]), 'epoch 수': len(hist), '학습 시간(초)': t1,
            '최적 epoch (홀드아웃 RMSE)': int(np.argmin([h['holdout_rmse'] for h in hist]) + 1), '파라미터 수': sum(q.numel() for q in net.parameters())}
    pred = p1_season(net, p, y_mean, y_std)
    if y_target is not None:
        lg_va = LGBM_PRED[2025][va_pos]
        info['LGBM 예측 재현 R² (검증)'] = float(1 - np.mean((lg_va - pred[2025][va_pos]) ** 2) / np.var(lg_va))
    rows = [evaluate(f'{name} P1', pred, {**info, '헤드': 'P1 (MSE 평균)'})]
    if with_p4:
        tr_y, es_y = split_t(p)    # ZIB 헤드는 실제 타깃(y3)으로
        rows.append(evaluate(f'{name} P4', p4(net, p, tr_y, es_y, y_mean, y_std), {**info, '헤드': 'P4 (ZIB)'}))
    keep(name, rows, hist)
    del net
    torch.cuda.empty_cache()


# ---------------------------------------------------------------------------
# 4. 실험
# ---------------------------------------------------------------------------
RUNS = ARGS.runs.split(',')
LGBM_PRED = {y: v4.predict(fr[y][v4.input_features]) for y in fr}
RESULTS.append(evaluate('LGBM v4 (운영)', LGBM_PRED, {'설명': '운영 LGBM v4 (시드 42)', '모델': 'lgbm', '학습 투구': len(tr_rows) + len(es_rows)}, ref=True))
lgb_params = v4.lgbm.get_params()

if 'base' in RUNS:
    run_hof('base', '기준선 : 현재 HOF-Net-R 설정 (MSE 인코더, 홀드아웃 RMSE 조기 종료)')

if 'h1' in RUNS:
    for frac in (0.1, 0.25, 0.5):
        idx = torch.from_numpy(np.random.default_rng(SEED).permutation(len(tr_rows))[:int(frac * len(tr_rows))])
        tr_full, es_full = split_t(prep)
        sub = tuple(t[idx] for t in tr_full)
        run_hof(f'h1_hof_{int(frac * 100)}', f'학습 데이터 {frac:.0%} (HOF)', tr=sub, es=es_full, with_p4=False)
        name = f'h1_lgbm_{int(frac * 100)}'
        if not done(name):
            rows_ = pd.concat([tr_rows.iloc[idx.numpy()], es_rows])    # 운영 v4 와 같이 학습 + 홀드아웃으로 학습
            t = time.time()
            mdl = sm.AngleAdjustedStuffModel(lgb.LGBMRegressor(**{**lgb_params, 'random_state': SEED}).fit(
                v4.model_frame(rows_[v4.input_features])[FEATS], rows_['y3']), FEATS, v4.vaa_coef, vaa_default=getattr(v4, 'vaa_default', None))
            pred = {y: mdl.predict(fr[y][v4.input_features]) for y in fr}
            keep(name, [evaluate(name, pred, {'설명': f'학습 데이터 {frac:.0%} (LGBM)', '모델': 'lgbm', '학습 투구': len(rows_), '학습 시간(초)': time.time() - t})])

if 'h2' in RUNS:
    track = lambda net: {'rho_whiff': rho_2025(hr.encode_all(net, season_t(prep, 2025), *NORM)[0])}
    NORM = (float(y_tr.mean()), float(y_tr.std()))
    run_hof('h2_noes', '조기 종료 없이 30 epoch (epoch 마다 ρ 기록, 최저 홀드아웃 RMSE 시점 복원)',
            fit_kw=dict(early_stop=True, patience=EPOCHS + 1, on_epoch=track))
    run_hof('h2_cos_swa', 'cosine 학습률 30 epoch + 마지막 10 epoch 가중치 평균 (SWA)',
            fit_kw=dict(early_stop=False, cosine=True, swa_last=2 if SMOKE else 10, on_epoch=track))

if 'h3' in RUNS:
    run_hof('h3_pitch_type', '구종(pitch_type) 임베딩 입력', p=prep_pt)

if 'h4' in RUNS and not done('h4_zib_e2e'):
    tr_, es_ = split_t(prep)
    net = new_net('hof', prep)
    log('=== h4_zib_e2e : 인코더 + ZIB 헤드 end-to-end')
    t = time.time()
    head, hist = fit_zib_e2e(net, tr_, es_)
    pred = {y: hr.zib_predict_net(net, head, season_t(prep, y), M=4, seed=SEED)['mean'] for y in fr}
    keep('h4_zib_e2e', [evaluate('h4_zib_e2e P4', pred, {'설명': '인코더를 ZIB NLL 로 end-to-end 학습', '모델': 'hof', '헤드': 'P4 (ZIB e2e)',
                                                          '학습 투구': len(tr_rows), 'epoch 수': len(hist), '학습 시간(초)': time.time() - t})], hist)
    del net, head

if 'h5' in RUNS:
    run_hof('h5_mlp', '일반 MLP (같은 입력, 은닉 256×2)', kind='mlp')
    run_hof('h5_big', '큰 HOF-Net-R (d=64, layers=3)', kind='big')

if 'h6' in RUNS:
    soft = lambda df: torch.tensor(v4.predict(df[v4.input_features]).astype(np.float32))
    soft_es = soft(es_rows)
    run_hof('h6a_distill', 'distillation : LGBM 예측을 타깃으로 (같은 학습 표본)', y_target=(soft(tr_rows), soft_es))
    big_rows = d25[is_tr & ~waste[2025] & ~d25.index.isin(es_rows.index)]
    tr_big = (*prep(big_rows[FEATS]), soft(big_rows))
    run_hof('h6b_distill_all', f'distillation : 학습기간 비-waste 전체 투구 {len(big_rows):,}구', tr=tr_big, es=(*tensors(prep, 'es', es_rows), soft_es),
            y_target=(tr_big[3], soft_es))

# ---------------------------------------------------------------------------
# 5. 정리
# ---------------------------------------------------------------------------
res = pd.DataFrame(RESULTS).drop_duplicates('run', keep='last').set_index('run')
save(res, 'results.csv')
eps = [pd.read_csv(os.path.join(OUT, 'runs', f), encoding='utf-8-sig') for f in sorted(os.listdir(os.path.join(OUT, 'runs'))) if f.endswith('_epochs.csv')]
if eps:
    save(pd.concat(eps, ignore_index=True), 'epochs.csv', index=False)
show = ['검증 투수×구종 ρ(구위, whiff%)', 'ρ 95% CI 하한', 'ρ 95% CI 상한', 'ρ − LGBM', 'ρ − LGBM 95% CI 하한', 'ρ − LGBM 95% CI 상한',
        '홀드아웃 RMSE (검증)', '예측력 ρ(구위 2025, whiff% 2026)', 'LGBM 과 투수×구종 상관 (2026)', '구종 치우침 |평균|', 'epoch 수']
log('결과\n' + res[[c for c in show if c in res]].round(4).to_string())
save(res[[c for c in res if c.startswith('구종 치우침')]], 'pt_bias.csv')
log('끝', f'{(time.time() - T0) / 60:.1f}분')
