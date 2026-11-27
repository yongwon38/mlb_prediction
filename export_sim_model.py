"""
구위 시뮬레이터용 웹 모델 내보내기 : models/hof_r (HOF-Net-R 시드 42 단일) -> web/public/sim/hof_r.json

실행 : python export_sim_model.py [--check-n 20000]
  모델이 바뀔 때만 다시 실행해 git 에 커밋한다 (daily 에서 만들지 않음).

내용
- 구조 상수 (d, 헤드, 층, LayerNorm eps, ZIB precision floor)
- 전처리 : 수치 13개 표준화 평균·표준편차, 범주(p_throws) 목록 (코드 = 목록 위치 + 1, 모르는 값 = 0), 결측은 0 + 결측 표시
- HAVAA : vaa_aa = vaa − (a + b·plate_z), 구종별 계수 (없는 구종은 공통 계수)
- 가중치 : float32 리틀엔디언 하나로 이어 붙여 base64 (tensors 에 이름·shape·offset). torch 와 같은 float32 값
- 스케일러 : StuffScaler(-예측의 학습기간 ECDF -> 50 + 10·Φ⁻¹) 를 구위 20–80 등간격 4,001점에서의 -예측 값 표로 압축.
  웹은 -예측을 표에서 찾아 선형보간 (표 아래 = 20, 위 = 80)

예측 (웹이 구현할 식, 시드 1개)
  h = flatten(블록 2개(토큰)),  z = GELU(L2(GELU(L1(h))))  [basis]
  lz, am, ak = MLP(h),  m_B = am + [z, 1]·ω (ω = head.m, 사후 평균)
  p = clamp(sigmoid(m_B), 1e-5, 1 − 1e-5), prec = softplus(ak) + 1e-3, α = max(p·prec, 1e-6), β = max((1 − p)·prec, 1e-6)
  E[Y] = (1 − sigmoid(lz))·α/(α + β)   (낮을수록 좋은 구위)

검증 : JSON 만으로 만든 numpy float32 forward vs HOFNetRStuffModel.predict (2025 검증 구간 표본), 표 스케일러 vs StuffScaler.transform
웹 패리티 고정 세트 : web/scripts/fixtures/sim_parity.json (1,000구 torch CPU 기준값 + 앞 8구 층별 중간값 + erf 격자)
  -> web 에서 node scripts/sim_parity.mjs 로 lib/hofnet.ts 와 대조. 모델을 다시 내보내면 고정 세트도 함께 갱신된다
"""
import argparse, base64, hashlib, json, os, sys, time

import joblib
import numpy as np
import pandas as pd
from scipy import stats

import stuff_model as sm

sys.stdout.reconfigure(encoding='utf-8')
ap = argparse.ArgumentParser()
ap.add_argument('--model-dir', default=os.path.join('models', 'hof_r'))
ap.add_argument('--out', default=os.path.join('web', 'public', 'sim', 'hof_r.json'))
ap.add_argument('--grid', type=int, default=4001)
ap.add_argument('--check-n', type=int, default=20000)
ARGS = ap.parse_args()
LN_EPS, P_FLOOR = 1e-5, 1e-3

model = sm.load_model(ARGS.model_dir)
scaler = joblib.load(os.path.join(ARGS.model_dir, 'stage4_stuff_scaler.joblib'))
meta = json.load(open(os.path.join(ARGS.model_dir, 'features.json'), encoding='utf-8'))
assert len(model.members) == 1, f'시뮬레이터는 단일 시드 모델만 지원 (현재 시드 {meta["seeds"]}) -> build_hof_web_model.py --seeds 42'
net, head = model.members[0]
prep, angle = model.prep, model.angle
blk0 = net.blocks[0]
D, H, L = net.w.shape[1], blk0.attn.num_heads, len(net.blocks)
assert all(abs(b.ln1.eps - LN_EPS) < 1e-12 and abs(b.ln2.eps - LN_EPS) < 1e-12 for b in net.blocks)
assert isinstance(blk0.ff[1], type(net.basis[1])) and blk0.ff[1].approximate == 'none', 'GELU 는 erf 정확형이어야 함'

# --- 가중치 : 이름 -> float32 배열 (torch Linear 는 (out, in)) ---
T = {'tok.w': net.w, 'tok.b': net.b, 'tok.miss': net.miss}
T.update({f'cat.{j}': e.weight for j, e in enumerate(net.cat)})
for i, b in enumerate(net.blocks):
    T.update({f'blk{i}.ln1.g': b.ln1.weight, f'blk{i}.ln1.b': b.ln1.bias, f'blk{i}.ln2.g': b.ln2.weight, f'blk{i}.ln2.b': b.ln2.bias,
              f'blk{i}.attn.in.W': b.attn.in_proj_weight, f'blk{i}.attn.in.b': b.attn.in_proj_bias,
              f'blk{i}.attn.out.W': b.attn.out_proj.weight, f'blk{i}.attn.out.b': b.attn.out_proj.bias,
              f'blk{i}.ff1.W': b.ff[0].weight, f'blk{i}.ff1.b': b.ff[0].bias, f'blk{i}.ff2.W': b.ff[3].weight, f'blk{i}.ff2.b': b.ff[3].bias})
T.update({'basis1.W': net.basis[0].weight, 'basis1.b': net.basis[0].bias, 'basis2.W': net.basis[3].weight, 'basis2.b': net.basis[3].bias,
          'zib1.W': head.mlp[0].weight, 'zib1.b': head.mlp[0].bias, 'zib2.W': head.mlp[2].weight, 'zib2.b': head.mlp[2].bias,
          'zib3.W': head.mlp[4].weight, 'zib3.b': head.mlp[4].bias, 'zib.omega': head.m})
W = {k: v.detach().cpu().numpy().astype('<f4') for k, v in T.items()}
tensors, off, chunks = {}, 0, []
for k, a in W.items():
    tensors[k] = {'shape': list(a.shape), 'offset': off}
    chunks.append(a.ravel()); off += a.size
blob = np.concatenate(chunks).astype('<f4')

# --- 스케일러 표 : 구위 s_i 등간격 -> p_i = Φ((s_i − 50)/10) -> ECDF 역함수 (중간 순위 (k + 0.5)/n 를 선형보간) ---
ref = np.asarray(scaler.ref_, dtype=float)       # 정렬된 −예측
n = len(ref)
s_grid = np.linspace(20, 80, ARGS.grid)
k = np.clip(stats.norm.cdf((s_grid - 50) / 10) * n - 0.5, 0, n - 1)
neg_pred = np.interp(k, np.arange(n), ref)


def score_table(pred):
    return np.interp(-np.asarray(pred, float), neg_pred, s_grid, left=20.0, right=80.0)


model_file = os.path.join(ARGS.model_dir, sm.MODEL_FILE)
out = {
    'format': 'stuff-lab-sim/1',
    'model': 'hof_r', 'seeds': meta['seeds'],
    'model_sha256': hashlib.sha256(open(model_file, 'rb').read()).hexdigest()[:16],
    'created': time.strftime('%Y-%m-%d'),
    'arch': {'d': int(D), 'heads': int(H), 'layers': int(L), 'd_r': int(net.d_r), 'ln_eps': LN_EPS, 'precision_floor': P_FLOOR,
             'gelu': 'erf'},
    'input_features': list(angle.input_features),
    'num_cols': prep.num_cols, 'cat_cols': prep.cat_cols, 'cats': [[str(c) for c in cs] for cs in prep.cats],
    'mean': [float(prep.mean[c]) for c in prep.num_cols], 'std': [float(prep.std[c]) for c in prep.num_cols],
    'havaa': {'feature': 'vaa_aa', 'formula': 'vaa - (a + b * plate_z)', 'by': 'pitch_type',
              'coef': {kk[0]: [float(x) for x in v] for kk, v in angle.vaa_coef.items()},
              'default': [float(x) for x in angle.vaa_default]},
    'pitch_types': [str(c) for c in angle.categories[0]],
    'scaler': {'score_lo': 20.0, 'score_hi': 80.0, 'n': ARGS.grid, 'fit_n': int(n),
               'neg_pred': [float(f'{x:.10g}') for x in neg_pred]},
    'tensors': tensors, 'n_weights': int(blob.size),
    'weights_b64': base64.b64encode(blob.tobytes()).decode('ascii'),
}
neg_pred = np.array(out['scaler']['neg_pred'])    # 반올림한 표로 검증
os.makedirs(os.path.dirname(ARGS.out), exist_ok=True)
with open(ARGS.out, 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, separators=(',', ':'))


# ---------------------------------------------------------------------------
# 검증 : JSON 만 읽어 numpy float32 forward (웹 구현의 기준 사양)
# ---------------------------------------------------------------------------
def load_sim(path):
    j = json.load(open(path, encoding='utf-8'))
    flat = np.frombuffer(base64.b64decode(j['weights_b64']), dtype='<f4')
    w = {k_: flat[t['offset']:t['offset'] + int(np.prod(t['shape']))].reshape(t['shape']) for k_, t in j['tensors'].items()}
    return j, w


def ln(x, g, b, eps):
    mu = x.mean(-1, keepdims=True); var = ((x - mu) ** 2).mean(-1, keepdims=True)
    return ((x - mu) / np.sqrt(var + eps) * g + b).astype(np.float32)


def gelu(x):
    from scipy.special import erf
    return (0.5 * x * (1 + erf(x / np.sqrt(2)))).astype(np.float32)


def softplus(x):
    return np.where(x > 20, x, np.log1p(np.exp(np.minimum(x, 20)))).astype(np.float32)


def sigmoid(x):
    return (1 / (1 + np.exp(-x))).astype(np.float32)


def sim_predict(j, w, X):
    """X : input_features 원값 DataFrame -> E[Y] (float64)"""
    a = j['arch']; d, nh = a['d'], a['heads']; dh = d // nh
    pt = X['pitch_type'].astype(str).to_numpy()
    ab = np.array([j['havaa']['coef'].get(p_, j['havaa']['default']) for p_ in pt])
    cols = {c: X[c].to_numpy('float64', na_value=np.nan) for c in j['num_cols'] if c != 'vaa_aa'}
    cols['vaa_aa'] = X['vaa'].to_numpy('float64', na_value=np.nan) - (ab[:, 0] + ab[:, 1] * X['plate_z'].to_numpy('float64', na_value=np.nan))
    x = np.column_stack([(cols[c] - m_) / s_ for c, m_, s_ in zip(j['num_cols'], j['mean'], j['std'])])
    miss = np.isnan(x).astype(np.float32); xn = np.nan_to_num(x, nan=0.0).astype(np.float32)
    tok = xn[..., None] * w['tok.w'] + w['tok.b'] + miss[..., None] * w['tok.miss']
    cat_tok = []
    for jj, (c, cs) in enumerate(zip(j['cat_cols'], j['cats'])):
        code = np.array([cs.index(v) + 1 if v in cs else 0 for v in X[c].astype(str)])
        cat_tok.append(w[f'cat.{jj}'][code][:, None, :])
    z = np.concatenate([tok] + cat_tok, axis=1).astype(np.float32)        # (B, K, d)
    B, K, _ = z.shape
    for i in range(a['layers']):
        p_ = f'blk{i}.'
        h = ln(z, w[p_ + 'ln1.g'], w[p_ + 'ln1.b'], a['ln_eps'])
        qkv = h @ w[p_ + 'attn.in.W'].T + w[p_ + 'attn.in.b']
        q, k_, v = (qkv[..., s * d:(s + 1) * d].reshape(B, K, nh, dh).transpose(0, 2, 1, 3) for s in range(3))
        att = q @ k_.transpose(0, 1, 3, 2) / np.float32(np.sqrt(dh))
        att = np.exp(att - att.max(-1, keepdims=True)); att = att / att.sum(-1, keepdims=True)
        o = (att @ v).transpose(0, 2, 1, 3).reshape(B, K, d)
        z = (z + o @ w[p_ + 'attn.out.W'].T + w[p_ + 'attn.out.b']).astype(np.float32)
        f = gelu(ln(z, w[p_ + 'ln2.g'], w[p_ + 'ln2.b'], a['ln_eps']) @ w[p_ + 'ff1.W'].T + w[p_ + 'ff1.b'])
        z = (z + f @ w[p_ + 'ff2.W'].T + w[p_ + 'ff2.b']).astype(np.float32)
    hf = z.reshape(B, K * d)
    zb = gelu(gelu(hf @ w['basis1.W'].T + w['basis1.b']) @ w['basis2.W'].T + w['basis2.b'])
    o3 = gelu(gelu(hf @ w['zib1.W'].T + w['zib1.b']) @ w['zib2.W'].T + w['zib2.b']) @ w['zib3.W'].T + w['zib3.b']
    lz, am, ak = o3[:, 0], o3[:, 1], o3[:, 2]
    mB = am + np.concatenate([zb, np.ones((B, 1), np.float32)], 1) @ w['zib.omega']
    pm = np.clip(sigmoid(mB), 1e-5, 1 - 1e-5); prec = softplus(ak) + np.float32(a['precision_floor'])
    al, be = np.maximum(pm * prec, 1e-6), np.maximum((1 - pm) * prec, 1e-6)
    return (1 - sigmoid(lz).astype(np.float64)) * (al.astype(np.float64) / (al.astype(np.float64) + be.astype(np.float64)))


size = os.path.getsize(ARGS.out)
import gzip
gz = len(gzip.compress(open(ARGS.out, 'rb').read(), 9))
print(f'저장 {ARGS.out} : {size / 1e6:.3f}MB (gzip {gz / 1e6:.3f}MB), 가중치 {blob.size:,}개, 스케일러 표 {ARGS.grid}점')

CACHE = os.path.join('outputs', 'vaa_exp', 'cache')
d = pd.read_parquet(os.path.join(CACHE, 'frame_2025.parquet'), columns=sorted(set(angle.input_features) | {'game_date', 'waste'}))
valid_start = pd.Timestamp(pd.read_json(os.path.join(CACHE, 'meta.json'), typ='series')['valid_start'])
dv = d[(d['game_date'] >= valid_start) & ~d['waste']]
X = dv.sample(min(ARGS.check_n, len(dv)), random_state=42)[angle.input_features]
j, w = load_sim(ARGS.out)
p_torch = model.predict(X)
p_sim = np.concatenate([sim_predict(j, w, X.iloc[i:i + 4096]) for i in range(0, len(X), 4096)])
s_exact, s_tab = scaler.transform(p_torch), score_table(p_sim)
full = model.predict(dv[angle.input_features])
chk = {'표본': len(X), '결측 포함 행': int(model.prep(angle.model_frame(X))[1].numpy().any(1).sum()), '좌투 행': int((X['p_throws'] == 'L').sum()),
       '예측 |Δ| 최대 (numpy vs torch)': float(np.abs(p_sim - p_torch).max()),
       '구위 |Δ| 최대 (표·numpy vs StuffScaler·torch)': float(np.abs(s_tab - s_exact).max()),
       '스케일러 표만 |Δ| 최대 (검증 구간 전체)': float(np.abs(score_table(full) - scaler.transform(full)).max()),
       '스케일러 표만 검증 구간 행 수': int(len(full)), 'json MB': size / 1e6, 'gzip MB': gz / 1e6}
print(json.dumps(chk, ensure_ascii=False, indent=1))
assert chk['예측 |Δ| 최대 (numpy vs torch)'] < 1e-5 and chk['구위 |Δ| 최대 (표·numpy vs StuffScaler·torch)'] < 0.05 and gz <= 1e6, '검증 실패'
print('검증 통과')


# ---------------------------------------------------------------------------
# 웹 패리티 고정 세트 (web/scripts/sim_parity.mjs) : torch CPU float32 기준값
# ---------------------------------------------------------------------------
import torch
from scipy.special import erf as sp_erf

torch.cuda.is_available = lambda: False      # 기준값은 CPU torch
model._dev()
rng = np.random.default_rng(42)
miss_any = model.prep(angle.model_frame(dv[angle.input_features]))[1].numpy().any(1)
pick = [dv[dv['p_throws'] == h].sample(300, random_state=42).index for h in ('R', 'L')]
pick.append(dv.index[miss_any][:100])
pick += [g.sample(min(20, len(g)), random_state=42).index for _, g in dv.groupby(dv['pitch_type'].astype(str))]
idx = pd.Index(np.concatenate(pick)).unique()
F = dv.loc[idx, angle.input_features].copy()
F['pitch_type'], F['p_throws'] = F['pitch_type'].astype(object), F['p_throws'].astype(object)
syn = F.iloc[:24].copy().reset_index(drop=True)
edits = [('pitch_type', 'XX'), ('pitch_type', None), ('p_throws', None), ('p_throws', 'S'), ('vaa', np.nan), ('plate_z', np.nan),
         ('release_spin_rate', np.nan), ('arm_angle', np.nan), ('velo_diff', np.nan), ('release_speed', 104.0), ('release_speed', 70.0),
         ('pfx_z', -2.0), ('pfx_z', 2.2), ('pfx_x', -2.0), ('spin_axis', 0.0), ('spin_axis', 359.0), ('release_extension', 8.0),
         ('vaa', -12.0), ('plate_z', 5.0), ('ivb_diff', -30.0), ('hb_diff', 25.0), ('release_pos_z', 3.0), ('pitch_type', 'SC'), ('pitch_type', 'EP')]
for r, (c, v) in enumerate(edits):
    syn.at[r, c] = v
num_in = [c for c in angle.input_features if c not in ('pitch_type', 'p_throws')]
allna = F.iloc[[0]].copy().reset_index(drop=True)
allna.loc[0, num_in] = np.nan
F = pd.concat([F.reset_index(drop=True), syn, allna], ignore_index=True)
rest = dv.drop(idx).sample(1000 - len(F), random_state=42)[angle.input_features].astype({'pitch_type': object, 'p_throws': object})
F = pd.concat([F, rest], ignore_index=True)
F[num_in] = F[num_in].astype('float64')
p_ref = model.predict(F)


@torch.no_grad()
def torch_trace(Xs):
    xn, miss, xc = model.prep(angle.model_frame(Xs))
    e0 = torch.cat([xn.unsqueeze(-1) * net.w + net.b + miss.unsqueeze(-1) * net.miss]
                   + [emb(xc[:, j]).unsqueeze(1) for j, emb in enumerate(net.cat)], dim=1)
    z, blocks = e0, []
    for blk in net.blocks:
        z, _ = blk(z, need_weights=False)
        blocks.append(z)
    h = z.flatten(1)
    return {'tokens': e0, 'blocks': blocks, 'basis': net.basis(h), 'zib': head.mlp(h)}


def flat(t):
    return [float(v) for v in t.detach().numpy().astype(np.float32).ravel()]


tr = torch_trace(F.iloc[:8])

# 반응 곡선 20개 : 기준 행의 변수 하나를 같은 구종 1–99 분위 41점으로 (나머지 고정). HAVAA 곡선은 vaa = 목표 + (a + b·plate_z) 로 역산해 Python 에 넣음
N_PT = 41
mf = angle.model_frame(dv[angle.input_features]).assign(pitch_type=dv['pitch_type'].astype(str).to_numpy())
q_pt = mf.groupby('pitch_type')[prep.num_cols].quantile([0.01, 0.99])
q_all = mf[prep.num_cols].quantile([0.01, 0.99])


def q_range(pt, c):
    return (float(q_pt.loc[(pt, 0.01), c]), float(q_pt.loc[(pt, 0.99), c])) if (pt, 0.01) in q_pt.index else (float(q_all.loc[0.01, c]), float(q_all.loc[0.99, c]))


Fm = angle.model_frame(F)
plan = [(i, prep.num_cols[k % len(prep.num_cols)]) for k, i in enumerate([0, 300, 1, 301, 2, 302, 3, 303, 4, 304, 5, 305, 6, 306, 7, 307, 8, 308])]
for i in range(600, 700):    # 결측이 있는 행 : 결측 변수 자체의 곡선 2개
    nas = [c for c in prep.num_cols if pd.isna(Fm.iloc[i][c]) and c != 'vaa_aa']
    if nas and len(plan) < 20:
        plan.append((i, nas[0]))
curves = []
for i, c in plan:
    base = F.iloc[[i]]
    pt = str(base['pitch_type'].iloc[0])
    lo, hi = q_range(pt, c)
    xs = np.linspace(lo, hi, N_PT)
    R = pd.concat([base] * N_PT, ignore_index=True)
    if c == 'vaa_aa':
        a_, b_ = angle.vaa_coef.get((pt,), angle.vaa_default)
        assert not pd.isna(R['plate_z'].iloc[0])
        R['vaa'] = xs + (a_ + b_ * R['plate_z'].to_numpy())
    else:
        R[c] = xs
    pc = model.predict(R)
    curves.append({'row': int(i), 'feature': c, 'pitch_type': pt, 'lo': lo, 'hi': hi,
                   'pred': [float(x) for x in pc], 'score_exact': [float(x) for x in scaler.transform(pc)]})
assert len(curves) == 20 and set(prep.num_cols) <= {cv['feature'] for cv in curves}
ex = np.linspace(-7, 7, 2801)
jsonable = lambda v: None if v is None or (isinstance(v, float) and np.isnan(v)) else (v if isinstance(v, str) else float(v))
fixture = {'model_sha256': out['model_sha256'], 'note': 'export_sim_model.py 가 만든 torch CPU float32 기준값',
           'rows': [{c: jsonable(r[c]) for c in angle.input_features} for r in F.to_dict('records')],
           'pred': [float(x) for x in p_ref], 'score_exact': [float(x) for x in scaler.transform(p_ref)],
           'score_table': [float(x) for x in score_table(p_ref)],
           'trace_rows': 8, 'trace': {'tokens': flat(tr['tokens']), 'blocks': [flat(b) for b in tr['blocks']], 'basis': flat(tr['basis']),
                                      'zib': flat(tr['zib'])},
           'curves': curves,
           'erf': {'x': [float(x) for x in ex], 'y': [float(y) for y in sp_erf(ex)]}}
FIX = os.path.join('web', 'scripts', 'fixtures', 'sim_parity.json')
os.makedirs(os.path.dirname(FIX), exist_ok=True)
json.dump(fixture, open(FIX, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print(f'고정 세트 {FIX} : {len(F)}구 (좌투 {(F["p_throws"] == "L").sum()}, 결측 포함 {int(model.prep(angle.model_frame(F))[1].numpy().any(1).sum())}, '
      f'합성 {len(edits) + 1}), {os.path.getsize(FIX) / 1e6:.2f}MB')
