"""
1단계 학습에서 '배럴인데 아웃' 타구 제외 실험 (시드 42 고정) — 운영 점수 산정에는 포함, 1단계 RF 학습에서만 제외

실행 : python barrel_out_experiment.py [--smoke]
  A : 기준선 (지금 파이프라인과 같은 1단계 RF · OOF · Gamma/Beta)
  B : 1단계 학습 행에서 barrel(launch_speed_angle == 6) & 아웃 제외. 빠진 행은 B 전체 학습 모델로 예측 (학습에 안 쓴 행이라 누수 없음)
  두 변형 모두 같은 코드로 2단계 보정 · 3단계 v4 LGBM 재학습 · 구위 지표 평가 -> B − A 와 투수 군집 bootstrap CI
출력 : outputs/barrel_out/ (stage1_metrics.csv · barrel_calib.csv · score_by_class.csv · results.csv · log.txt · 그림)
데이터 · split · 3단계 변수 : outputs/vaa_exp/cache (stuff_pipeline_261010_vaa3.ipynb), v4 학습 코드 = stuff_pipeline_261011_v4.ipynb
"""
import argparse, os, sys, time, warnings
os.environ.setdefault('LOKY_MAX_CPU_COUNT', str(os.cpu_count()))
import numpy as np
import pandas as pd
import joblib
import lightgbm as lgb
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from scipy import stats
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import log_loss, accuracy_score

import export_web_data as ew
import stuff_model as sm
import stuff_pipeline as sp

warnings.filterwarnings('ignore')
sys.stdout.reconfigure(encoding='utf-8')
ap = argparse.ArgumentParser()
ap.add_argument('--smoke', action='store_true')
SMOKE = ap.parse_args().smoke
SEED = 42
B = 50 if SMOKE else 1000
N_TREES = 30 if SMOKE else 300
OUT = os.path.join('outputs', 'barrel_out', 'smoke') if SMOKE else os.path.join('outputs', 'barrel_out')
os.makedirs(OUT, exist_ok=True)
CACHE = os.path.join('outputs', 'vaa_exp', 'cache')
T0 = time.time()
LOG = open(os.path.join(OUT, 'log.txt'), 'a', encoding='utf-8')


def log(*a):
    s = f'[{time.time() - T0:7.0f}s] ' + ' '.join(str(x) for x in a)
    print(s, flush=True); LOG.write(s + '\n'); LOG.flush()


def save(df, name, **kw):
    df.to_csv(os.path.join(OUT, name), encoding='utf-8-sig', **kw)


log('시작', 'smoke' if SMOKE else 'full')

# ---------------------------------------------------------------------------
# 1. 1단계 데이터 (stuff_pipeline_260929 / vaa3 캐시 생성과 같은 split)
# ---------------------------------------------------------------------------
BB_COLS = ['launch_speed', 'launch_angle', 'launch_speed_angle']
raw = {2025: sp.load_regular_season('games_25_final.pkl', year=2025), 2026: sp.load_regular_season('games_26.pkl', year=2026)}
bb = {y: raw[y][BB_COLS].copy() for y in raw}    # 투구 단위 타구 정보 (구위 목적 지표용)
df = raw[2025]
train_df, valid_df, valid_start = sp.split_last_month(df, months=1)
assert valid_start.normalize() == pd.Timestamp(pd.read_json(os.path.join(CACHE, 'meta.json'), typ='series')['valid_start']), valid_start
X1_tr, y1_tr = sp.build_hit_dataset(train_df)
X1_va, y1_va = sp.build_hit_dataset(valid_df)
barrel_tr = (train_df.loc[X1_tr.index, 'launch_speed_angle'] == 6).fillna(False).to_numpy(bool)
barrel_va = (valid_df.loc[X1_va.index, 'launch_speed_angle'] == 6).fillna(False).to_numpy(bool)
del raw, df, train_df, valid_df
if SMOKE:
    i = np.random.default_rng(SEED).random(len(X1_tr)) < 0.2
    X1_tr, y1_tr, barrel_tr = X1_tr[i], y1_tr[i], barrel_tr[i]
drop_tr = barrel_tr & (y1_tr.to_numpy() == 0)
log(f'1단계 학습 {len(X1_tr):,} / 검증 {len(X1_va):,} | 학습 배럴 {barrel_tr.sum():,} (아웃 {drop_tr.sum():,}, {drop_tr.sum() / barrel_tr.sum():.1%})',
    f'| 검증 배럴 {barrel_va.sum():,} (아웃 {(barrel_va & (y1_va.to_numpy() == 0)).sum():,})')
rf_par = joblib.load(os.path.join('models', 'stage1_hit_rf.joblib')).get_params()
new_rf = lambda: RandomForestClassifier(n_estimators=N_TREES, n_jobs=-1, random_state=SEED,
                                        max_depth=rf_par['max_depth'], min_samples_leaf=rf_par['min_samples_leaf'])

# ---------------------------------------------------------------------------
# 2. 1단계 변형 : OOF(학습) + 전체 모델(검증, 제외 행)
# ---------------------------------------------------------------------------
VARIANTS = {'A': '기준선', 'B': '배럴 아웃 제외'}
P_tr, P_va = {}, {}
for k in VARIANTS:
    keep = ~drop_tr if k == 'B' else np.ones(len(X1_tr), bool)
    Xk, yk = X1_tr[keep], y1_tr[keep]
    P = np.zeros((len(X1_tr), 4))
    P[keep] = cross_val_predict(new_rf(), Xk, yk, cv=StratifiedKFold(5, shuffle=True, random_state=SEED), method='predict_proba')
    full = new_rf().fit(Xk, yk)
    if (~keep).any():
        P[~keep] = full.predict_proba(X1_tr[~keep])
    P_tr[k], P_va[k] = P, full.predict_proba(X1_va)
    log(f'[{k}] 1단계 학습 {keep.sum():,}행 완료')

# 1단계 평가 : 전체 검증셋(운영 조건) + 배럴 아웃 뺀 검증셋(참고)
yv = y1_va.to_numpy()
va_sets = {'전체 검증': np.ones(len(yv), bool), '검증 − 배럴 아웃(참고)': ~(barrel_va & (yv == 0)),
           '검증 배럴만': barrel_va, '검증 비배럴': ~barrel_va}
rows = []
for k in VARIANTS:
    for name, m in va_sets.items():
        P, y = P_va[k][m], yv[m]
        oh = np.eye(4)[y]
        rows.append({'변형': k, '평가셋': name, 'n': int(m.sum()), 'logloss': log_loss(y, P, labels=[0, 1, 2, 3]),
                     'accuracy': accuracy_score(y, P.argmax(1)), 'Brier': float(((P - oh) ** 2).sum(1).mean()),
                     '예측 P(아웃) 평균': P[:, 0].mean(), '실제 아웃률': (y == 0).mean(),
                     '예측 E 평균': sp.expected_value(P).mean(), '실제 결과 평균': y.mean()})
st1 = pd.DataFrame(rows)
save(st1, 'stage1_metrics.csv', index=False)
log('1단계 지표\n' + st1.round(4).to_string(index=False))

# 배럴 영역 보정 : 타구속도 구간별 예측 P(아웃) vs 실제 (검증 배럴)
ev = X1_va['launch_speed'].to_numpy()
ev_bin = pd.cut(ev, [95, 100, 103, 106, 109, 125], right=False)
cal = pd.DataFrame({'ev': ev_bin, 'y_out': yv == 0, 'A': P_va['A'][:, 0], 'B': P_va['B'][:, 0], 'barrel': barrel_va})
cal = cal[cal['barrel']].groupby('ev', observed=True).agg(n=('y_out', 'size'), 실제_아웃률=('y_out', 'mean'), A_P아웃=('A', 'mean'), B_P아웃=('B', 'mean'))
save(cal, 'barrel_calib.csv')
log('검증 배럴 타구속도별 P(아웃)\n' + cal.round(3).to_string())

# ---------------------------------------------------------------------------
# 3. 2단계 : Gamma/Beta 를 각 변형의 OOF E(학습기간 인플레이 전체)로 적합 -> 타구질 점수
# ---------------------------------------------------------------------------
hit_score, calib = {}, {}
for k in VARIANTS:
    E_tr, E_va = sp.expected_value(P_tr[k]), sp.expected_value(P_va[k])
    calib[k] = sp.GammaBetaCalibrator().fit(E_tr)
    hit_score[k] = pd.concat([pd.Series(calib[k].transform(E_tr), index=X1_tr.index), pd.Series(calib[k].transform(E_va), index=X1_va.index)])
    log(f'[{k}] {calib[k]}')
lab = pd.concat([y1_tr, y1_va]).map(sp.HIT_LABELS)
brl = pd.Series(np.r_[barrel_tr, barrel_va], index=lab.index)
grp = lab.where(~brl, '배럴 ' + lab)
sbc = pd.DataFrame({k: hit_score[k].groupby(grp).mean() for k in VARIANTS}).assign(n=grp.value_counts())
sbc.loc['전체'] = [hit_score['A'].mean(), hit_score['B'].mean(), len(grp)]
save(sbc, 'score_by_class.csv')
r_ab = stats.spearmanr(hit_score['A'], hit_score['B']).statistic
log(f'타구질 점수 결과별 평균 (A·B 순위상관 {r_ab:.4f})\n' + sbc.round(4).to_string())

fig, ax = plt.subplots(1, 2, figsize=(12, 4.2))
for k, c in [('A', '#4C72B0'), ('B', '#DD8452')]:
    ax[0].hist(hit_score[k], bins=80, density=True, alpha=.55, color=c, label=f'{k} {VARIANTS[k]}')
ax[0].set(title='Hit quality score (0~1)', xlabel='score'); ax[0].legend()
x = cal.index.astype(str)
ax[1].plot(x, cal['실제_아웃률'], 'k-o', label='actual out rate')
ax[1].plot(x, cal['A_P아웃'], '-o', color='#4C72B0', label='A predicted P(out)')
ax[1].plot(x, cal['B_P아웃'], '-o', color='#DD8452', label='B predicted P(out)')
ax[1].set(title='Barrels (valid): P(out) by exit velocity', xlabel='launch_speed (mph)', ylim=(0, 1)); ax[1].legend()
plt.tight_layout(); plt.savefig(os.path.join(OUT, 'barrel_out.png'), dpi=110); plt.close()

# ---------------------------------------------------------------------------
# 4. 3단계 : v4 LGBM 을 각 y3 로 재학습 (stuff_pipeline_261011_v4.ipynb 와 같은 코드)
# ---------------------------------------------------------------------------
v4 = sm.load_model(os.path.join('models', 'v4'))
FEATS = list(v4.features)
cols = sorted(set(v4.input_features) | {'game_date', 'waste', 'pitcher', 'description', 'type', 'events', 'estimated_woba_using_speedangle'})
fr = {y: pd.read_parquet(os.path.join(CACHE, f'frame_{y}.parquet'), columns=cols + (['y3', 'split'] if y == 2025 else [])) for y in (2025, 2026)}
d25 = fr[2025]
is_tr = (d25['game_date'] < valid_start).to_numpy()
inplay = sp.inplay_mask(d25)
samp_mask = d25['y3'].notna()
for y in fr:
    fr[y] = fr[y].join(bb[y])
y3 = {}
for k in VARIANTS:
    yk = d25['y3'].copy()
    yk[samp_mask & inplay] = hit_score[k].reindex(d25.index[samp_mask & inplay]).to_numpy()
    y3[k] = yk
pd.DataFrame({f'y3_{k}': y3[k] for k in VARIANTS}).to_parquet(os.path.join(OUT, 'y3_ab.parquet'))    # barrel_out_hof_experiment.py 입력
if not SMOKE:
    ok = samp_mask & inplay
    diff = (y3['A'][ok] - d25.loc[ok, 'y3']).abs()
    log(f'A y3 재현 : 캐시 y3 와 |차이| 평균 {diff.mean():.5f}, 최대 {diff.max():.4f}, 상관 {np.corrcoef(y3["A"][ok], d25.loc[ok, "y3"])[0, 1]:.5f}')
fit_idx = d25.index[samp_mask & d25['split'].isin(['tr', 'es']).to_numpy()]
va_idx = d25.index[samp_mask & (d25['split'] == 'va').to_numpy()]
if SMOKE:
    fit_idx = pd.Index(np.random.default_rng(SEED).choice(fit_idx, 40000, replace=False))
waste = {y: fr[y]['waste'].fillna(True).to_numpy(bool) for y in fr}
scored_tr = is_tr & ~waste[2025] & ~sp.is_no_tracking(d25).to_numpy()
model_x = {y: v4.model_frame(fr[y][v4.input_features])[FEATS] for y in fr}

pred, res = {}, {}
for k in VARIANTS:
    yk = y3[k].dropna()
    fi = fit_idx[fit_idx.isin(yk.index)]
    lgbm = lgb.LGBMRegressor(**v4.lgbm.get_params()).fit(model_x[2025].loc[fi], yk.loc[fi])
    pred[k] = {y: lgbm.predict(model_x[y]) for y in fr}
    sc = sp.StuffScaler().fit(pred[k][2025][scored_tr])
    for y in fr:
        fr[y][f's_{k}'] = pd.Series(sc.transform(pred[k][y]).astype('float32'), index=fr[y].index).where(~waste[y])
    vi = va_idx[va_idx.isin(yk.index)]
    pv = pd.Series(pred[k][2025], index=d25.index).loc[vi]
    res[k] = {'홀드아웃 RMSE (자기 y3)': float(np.sqrt(np.mean((yk.loc[vi] - pv) ** 2))), '학습 행': len(fi)}
    log(f'[{k}] 3단계 학습 {len(fi):,}행')

# ---------------------------------------------------------------------------
# 5. 구위 지표 (hofnet_experiment.py validity 정의) + 하드힛 억제 지표 + 투수 군집 bootstrap
# ---------------------------------------------------------------------------
def pt_table(d, min_n=100):
    """투수×구종 집계 : 스윙 대비 헛스윙, 인플레이 대비 배럴·하드힛, xwOBAcon"""
    ip = sp.inplay_mask(d) & d['launch_speed'].notna()
    x = d.assign(pitch_type=d['pitch_type'].astype(str), sw=d['description'].isin(ew.SWING_DESC), wh=d['description'].isin(sp.WHIFF_DESC),
                 ip=ip, brl=ip & (d['launch_speed_angle'] == 6).fillna(False), hh=ip & (d['launch_speed'] >= 95),
                 xc=d['estimated_woba_using_speedangle'].where(d['type'] == 'X'))
    g = x.groupby(['pitcher', 'pitch_type']).agg(n=('sw', 'size'), sw=('sw', 'sum'), wh=('wh', 'sum'), ip=('ip', 'sum'),
                                                  brl=('brl', 'sum'), hh=('hh', 'sum'), xc=('xc', 'mean'),
                                                  **{f's_{k}': (f's_{k}', 'mean') for k in VARIANTS})
    g = g[g['n'] >= min_n]
    return g.assign(whiff=g['wh'] / g['sw'], barrel=g['brl'] / g['ip'], hardhit=g['hh'] / g['ip'])


TARGETS = {'whiff': ('whiff%', 1), 'xc': ('xwOBAcon', -1), 'barrel': ('배럴%/인플레이', -1), 'hardhit': ('하드힛%/인플레이', -1)}
pv25 = pt_table(fr[2025][~is_tr])
pt26 = pt_table(fr[2026])
_pits = pv25.index.get_level_values('pitcher').to_numpy()
_upits = np.unique(_pits)
_rows_of = {p_: np.where(_pits == p_)[0] for p_ in _upits}
_rng = np.random.default_rng(SEED)
BOOT = [np.concatenate([_rows_of[p_] for p_ in _rng.choice(_upits, len(_upits))]) for _ in range(B)]


def rho(a, b):
    return stats.spearmanr(a, b, nan_policy='omit').statistic


rows = []
for t, (name, sign) in TARGETS.items():
    tv = pv25[t].to_numpy()
    r = {'지표': f'검증 투수×구종 ρ(구위, {name})'}
    boots = {}
    for k in VARIANTS:
        s = pv25[f's_{k}'].to_numpy()
        r[k] = rho(s, tv)
        boots[k] = np.array([rho(s[i], tv[i]) for i in BOOT])
    d_ = boots['B'] - boots['A']
    r.update({'B − A': r['B'] - r['A'], 'CI 하한': float(np.quantile(d_, 0.025)), 'CI 상한': float(np.quantile(d_, 0.975)), '좋은 방향': '+' if sign > 0 else '−'})
    rows.append(r)
# 예측력 : 2025 전체 시즌 구위 -> 2026 결과
pm25 = pt_table(fr[2025])
both = pm25[[f's_{k}' for k in VARIANTS]].join(pt26[list(TARGETS)], how='inner')
for t, (name, sign) in TARGETS.items():
    rows.append({'지표': f'예측력 ρ(구위 2025, {name} 2026)', **{k: rho(both[f's_{k}'], both[t]) for k in VARIANTS}, '좋은 방향': '+' if sign > 0 else '−'})
    rows[-1]['B − A'] = rows[-1]['B'] - rows[-1]['A']
rows.append({'지표': '3단계 홀드아웃 RMSE (각자 y3)', 'A': res['A']['홀드아웃 RMSE (자기 y3)'], 'B': res['B']['홀드아웃 RMSE (자기 y3)']})
rows.append({'지표': 'A·B 투구 구위 점수 상관 (2025)', 'A': 1.0, 'B': float(np.corrcoef(fr[2025]['s_A'].fillna(50), fr[2025]['s_B'].fillna(50))[0, 1])})
out = pd.DataFrame(rows)
save(out, 'results.csv', index=False)
log(f'구위 지표 (투수×구종 {len(pv25)}개, bootstrap {B}회)\n' + out.round(4).to_string(index=False))
log('끝', f'{time.time() - T0:.0f}s')
