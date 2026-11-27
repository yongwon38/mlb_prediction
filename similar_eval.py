"""
유사 투구 검색 평가 (유사 투구 검색 실행 계획 0단계) : model(ZIB 은닉) vs input(원 입력) 공간
실행 : python similar_eval.py   → outputs/similar/eval.json, eval_cases.csv

1. 투수×구종(2025 정규, 100구+) 이웃 10개 (같은 투수 제외) : 구종 순도, ρ(자기 whiff, 이웃 평균 whiff), ρ(자기 xwOBAcon, 이웃 평균)
   차이 (model − input) 의 투수 군집 부트스트랩 1,000회 95% CI (이웃은 전체 표본에서 한 번 계산, 집계만 재표본)
2. 연도 안정성 : 2025·2026 모두 있는 투수×구종 안에서 이웃 10개 중복률
3. 가상 투구 질의 점검 : '평균 입력 한 구의 임베딩' 질의 vs '투구 임베딩 평균' 질의의 이웃 중복률·코사인
4. 사례 : 구종별(FF ST FS CH CU) 300구 이상 중 헛스윙률 1위의 model 이웃 10개와 입력 차이 상위 3개
"""
import json, os, sys

import joblib
import numpy as np
import pandas as pd
import torch
from scipy import stats

import export_similar as es
import export_web_data as ew
import hof_net_r as hr
import stuff_model as sm

sys.stdout.reconfigure(encoding='utf-8')
OUT = os.path.join('outputs', 'similar')
os.makedirs(OUT, exist_ok=True)
SEED, B = 42, 1000
mdir = ew.MODELS[es.MODEL]['dir']
model = sm.load_model(mdir)
scaler = joblib.load(os.path.join(mdir, 'stage4_stuff_scaler.joblib'))


@torch.no_grad()
def embed_frame(Xm):
    """모델 입력 공간(num_cols + p_throws) 행 → ZIB 은닉 64 (가상 투구 질의와 같은 경로)"""
    net, head = model.members[0]
    dev = model._dev()
    a, b, c = hr.to_dev(dev, *model.prep(Xm))
    m = head.mlp
    return m[3](m[2](m[1](m[0](net.encode(a, b, c))))).float().cpu().numpy()


def neighbors(V, pit):
    U, _, _ = es.standardize(V)
    return np.stack([es.search(U, U[i], pit, pit[i])[0] for i in range(len(U))]), U


def per_group(meta, nb):
    pt = meta['pt'].to_numpy()
    return {'purity': (pt[nb] == pt[:, None]).mean(1), 'nb_whiff': meta['whiff'].to_numpy()[nb].mean(1),
            'nb_xc': np.nanmean(meta['xc'].to_numpy()[nb], 1)}


res, meta = {}, {}
vecs = {}
for y in (2025, 2026):
    m_, vm, vi, as_of, icols = es.season_groups(y, model, scaler)
    meta[y], vecs[y] = m_, {'model': vm, 'input': vi}
    print(y, len(m_), '투수×구종', flush=True)

# 1. 품질 + 부트스트랩
M = meta[2025]
pit = M['pitcher'].to_numpy()
G = {s: per_group(M, neighbors(vecs[2025][s], pit)[0]) for s in ('model', 'input')}
own_w, own_x = M['whiff'].to_numpy(), M['xc'].to_numpy()
rho = lambda a, b, idx: stats.spearmanr(a[idx], b[idx], nan_policy='omit').statistic
allidx = np.arange(len(M))
point = {s: {'구종 순도@10': float(G[s]['purity'].mean()), 'ρ whiff': float(rho(own_w, G[s]['nb_whiff'], allidx)),
             'ρ xwOBAcon': float(rho(own_x, G[s]['nb_xc'], allidx))} for s in G}
rng = np.random.default_rng(SEED)
upit = np.unique(pit)
rows_of = {p: np.flatnonzero(pit == p) for p in upit}
diffs = {k: [] for k in ('구종 순도@10', 'ρ whiff', 'ρ xwOBAcon')}
for _ in range(B):
    idx = np.concatenate([rows_of[p] for p in rng.choice(upit, len(upit))])
    diffs['구종 순도@10'].append(G['model']['purity'][idx].mean() - G['input']['purity'][idx].mean())
    diffs['ρ whiff'].append(rho(own_w, G['model']['nb_whiff'], idx) - rho(own_w, G['input']['nb_whiff'], idx))
    diffs['ρ xwOBAcon'].append(rho(own_x, G['model']['nb_xc'], idx) - rho(own_x, G['input']['nb_xc'], idx))
res['2025 품질'] = point
res['2025 차이 (model − input) [95% CI]'] = {k: [point['model'][k] - point['input'][k], *map(float, np.quantile(v, [.025, .975]))] for k, v in diffs.items()}
res['투수×구종 수'] = {str(y): len(meta[y]) for y in meta}

# 2. 연도 안정성
k5 = list(zip(M['pitcher'], M['pt'])); k6 = list(zip(meta[2026]['pitcher'], meta[2026]['pt']))
pos6 = {k: i for i, k in enumerate(k6)}
common = [k for k in k5 if k in pos6]
i5 = [k5.index(k) for k in common]; i6 = [pos6[k] for k in common]
cp = np.array([k[0] for k in common])
stab = {}
for s in ('model', 'input'):
    a = neighbors(vecs[2025][s][i5], cp)[0]; b = neighbors(vecs[2026][s][i6], cp)[0]
    stab[s] = float(np.mean([len(set(x) & set(y)) / es.K for x, y in zip(a, b)]))
res['연도 안정성 (2025→2026 이웃 중복률)'] = stab
res['공통 투수×구종'] = len(common)

# 3. 가상 투구 질의 점검 : 그룹 평균 입력 한 구의 임베딩으로 검색 vs 그룹 평균 임베딩으로 검색
vi = vecs[2025]['input']
Xm = pd.DataFrame(vi[:, :-1], columns=model.prep.num_cols)
Xm['p_throws'] = np.where(vi[:, -1] < 0, 'L', 'R')
emb = embed_frame(Xm)
U, mu, sd = es.standardize(vecs[2025]['model'])
Q = np.nan_to_num((emb - mu) / sd); Q /= np.linalg.norm(Q, axis=1, keepdims=True)
ov, cs = [], []
for i in range(len(U)):
    a = es.search(U, U[i], pit, pit[i])[0]; b = es.search(U, Q[i], pit, pit[i])[0]
    ov.append(len(set(a) & set(b)) / es.K); cs.append(float(U[i] @ Q[i]))
res['가상 투구 질의 (평균 입력 임베딩 vs 임베딩 평균)'] = {'이웃 중복률 평균': float(np.mean(ov)), '이웃 중복률 중앙값': float(np.median(ov)),
                                                 '코사인 평균': float(np.mean(cs)), '코사인 5% 분위': float(np.quantile(cs, .05))}

# 4. 사례
Ui, _, sdi = es.standardize(vi)
cases = []
for p in ('FF', 'ST', 'FS', 'CH', 'CU'):
    cand = M[(M['pt'] == p) & (M['n'] >= 300)]
    q = int(cand['whiff'].idxmax())
    nb, sim = es.search(U, U[q], pit, pit[q])
    for r_, (j, s_) in enumerate(zip(nb, sim), 1):
        dz = (vi[j] - vi[q]) / sdi
        top = np.argsort(-np.abs(np.nan_to_num(dz)))[:3]
        cases.append({'질의': f"{M.at[q, 'name']} {p}", '순위': r_, '이웃': f"{M.at[j, 'name']} {M.at[j, 'pt']}", '유사도': round(float(s_), 3),
                      '이웃 구위': round(float(M.at[j, 'stuff']), 1), '이웃 whiff': round(float(M.at[j, 'whiff']), 3), '질의 whiff': round(float(M.at[q, 'whiff']), 3),
                      '입력 차이 상위 3': ', '.join(f'{icols[t]} {vi[j, t] - vi[q, t]:+.2f}' for t in top)})
pd.DataFrame(cases).to_csv(os.path.join(OUT, 'eval_cases.csv'), index=False, encoding='utf-8-sig')
json.dump(res, open(os.path.join(OUT, 'eval.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print(json.dumps(res, ensure_ascii=False, indent=1))
print(pd.DataFrame(cases).groupby('질의').head(4).to_string(index=False))
