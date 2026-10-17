"""
HOF-Net-R P4 (ZIB) 시드 앙상블 -> 웹 모델 (models/hof_r/)

실행 : python build_hof_web_model.py [--seeds 42 43 44 45 46] [--k-exact 8] [--n-perm 4]
입력 : outputs/hofnet_r/hofnet_r_seed{s}.pt (hofnet_r_experiment.py), models/v4 (HAVAA 계수), outputs/vaa_exp/cache/frame_2025.parquet
출력 : models/hof_r/stage3_stuff_lgbm.joblib (hof_net_r.HOFNetRStuffModel, 파일명은 stuff_model 인터페이스 약속),
       stage4_stuff_scaler.joblib (2025 학습기간 정규시즌 비-waste 예측으로 적합), features.json
"""
import argparse, json, os

import joblib
import numpy as np
import pandas as pd
import torch

import export_web_data as ew
import hof_net as hn
import hof_net_r as hr
import stuff_model as sm
import stuff_pipeline as sp

ap = argparse.ArgumentParser()
ap.add_argument('--seeds', type=int, nargs='+', default=[42, 43, 44, 45, 46])
ap.add_argument('--k-exact', type=int, default=8)
ap.add_argument('--n-perm', type=int, default=4)
ap.add_argument('--n-refs', type=int, default=64)
ARGS = ap.parse_args()
OUT = os.path.join('models', 'hof_r')
CACHE = os.path.join('outputs', 'vaa_exp', 'cache')
SEED = 42

v4 = sm.load_model(os.path.join('models', 'v4'))
members, prep = [], None
for s in ARGS.seeds:
    ck = torch.load(os.path.join('outputs', 'hofnet_r', f'hofnet_r_seed{s}.pt'), map_location='cpu', weights_only=False)
    p = hn.Prep.from_state(ck['num'], ck['cat'], ck['mean'], ck['std'], ck['cats'])
    if prep is None:
        prep = p
    assert p.num_cols == prep.num_cols and p.cats == prep.cats and np.allclose(p.mean, prep.mean), f'seed {s} 전처리 불일치'
    net = hr.HOFNetR(len(p.num_cols), p.cat_cards); net.load_state_dict(ck['net'])
    head = hr.ZIBHead(net.K * net.w.shape[1], net.d_r); head.load_state_dict(ck['zib'])
    members.append((net, head))
assert set(prep.num_cols + prep.cat_cols) == set(v4.features), 'v4 변수와 불일치'

d = pd.read_parquet(os.path.join(CACHE, 'frame_2025.parquet'), columns=sorted(set(v4.input_features) | {'game_date', 'waste'}))
valid_start = pd.Timestamp(pd.read_json(os.path.join(CACHE, 'meta.json'), typ='series')['valid_start'])
fit_rows = d[(d['game_date'] < valid_start) & ~d['waste']]
Xm = v4.model_frame(fit_rows[v4.input_features])
complete = Xm[prep.num_cols].notna().all(axis=1).to_numpy()

# HAVAA 보정만 쓰는 가벼운 복사본 (LGBM 없이 계수·범주만) : 모델 파일에 sklearn 객체가 들어가지 않게 (클라우드 sklearn 버전과 무관)
angle = sm.AngleAdjustedStuffModel(None, v4.features, v4.vaa_coef, vaa_default=getattr(v4, 'vaa_default', None),
                                   category_list=[list(c) for c in v4.categories])
assert np.allclose(angle.model_frame(fit_rows.iloc[:5000][v4.input_features])['vaa_aa'], Xm.iloc[:5000]['vaa_aa'], equal_nan=True)
model = hr.HOFNetRStuffModel(members, prep, angle, ew.EXPLAIN_GROUPS, Xm.iloc[:1], k_exact=ARGS.k_exact, n_perm=ARGS.n_perm)
pred = model.predict(fit_rows[v4.input_features])
scaler = sp.StuffScaler().fit(pred)
# 배경 reference : 앞 k_exact 개는 예측 분포를 k_exact 등분한 층마다 1구 (기준 점수 base = 배경 평균 예측이 리그 평균 근처, 분산도 작음),
# 나머지는 무작위 (K 안정성 점검용). 모두 결측 없는 학습기간 비-waste 정규시즌 투구
rng = np.random.default_rng(SEED)
order = np.argsort(pred)
order = order[complete[order]]
strata = np.array_split(order, ARGS.k_exact)
pick = [int(rng.choice(st)) for st in strata]
rest = rng.choice(np.setdiff1d(np.flatnonzero(complete), pick), ARGS.n_refs - len(pick), replace=False)
model.refs = Xm.iloc[np.r_[pick, rest]][model.features].reset_index(drop=True)
base = float(model._f(*hr.to_dev(model._dev(), *prep(model.refs.iloc[:ARGS.k_exact]))).mean())
print('배경 기준값', base, '-> 점수', float(scaler.transform([base])[0]), '/ 학습기간 평균 예측', float(pred.mean()), '-> 점수', float(scaler.transform([pred.mean()])[0]))
for net, head in model.members:    # 저장은 CPU
    net.cpu(); head.cpu()
os.makedirs(OUT, exist_ok=True)
joblib.dump(model, os.path.join(OUT, sm.MODEL_FILE))
joblib.dump(scaler, os.path.join(OUT, 'stage4_stuff_scaler.joblib'))
json.dump({'features': model.features, 'input_features': model.input_features, 'seeds': ARGS.seeds, 'k_exact': ARGS.k_exact, 'n_perm': ARGS.n_perm,
           'groups': [g for g, _ in model.groups], 'scaler_fit_n': int(len(pred))},
          open(os.path.join(OUT, 'features.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
print('저장', OUT, '시드', ARGS.seeds, '스케일러 표본', len(pred), '그룹', [g for g, _ in model.groups])
