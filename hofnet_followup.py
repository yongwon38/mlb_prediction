"""
hofnet_experiment.py 후속 : (1) LGBM 이분산 기준선 보정 계수 수정 후 재계산, (2) A5·A5-βNLL 의 구위 산출 근거 비교 추가
학습은 다시 하지 않고 outputs/hofnet/hof_*.pt 를 읽는다. 표본·split·전처리는 본 실험 1절과 같은 코드.
"""
import re
src = open('hofnet_experiment.py', encoding='utf-8').read()
exec(src[:src.index('# ---------------------------------------------------------------------------\n# 2. HOF-Net')])

def load_net(k):
    ck = torch.load(os.path.join(OUT, f'hof_{k}.pt'), weights_only=False)
    net = hn.HOFNet(len(NUM), prep.cat_cards, **ck['kw']); net.load_state_dict(ck['state']); net.eval()
    return net

# (1) LGBM + 이분산 오차 모델 기준선
fit_rows = pd.concat([tr_rows, es_rows])
lg_fit, lg_va = v3.predict(fit_rows[v3.input_features]), v3.predict(va_rows[v3.input_features])
params = dict(n_estimators=400, learning_rate=0.05, num_leaves=63, min_child_samples=200, random_state=SEED, verbose=-1)
Xfit, Xva = v3.model_frame(fit_rows[v3.input_features]), v3.model_frame(va_rows[v3.input_features])
var_m = lgb.LGBMRegressor(**params).fit(Xfit, np.log((fit_rows['y3'].to_numpy() - lg_fit) ** 2 + 1e-6))
var_va = np.exp(var_m.predict(Xva) + 1.27)
sd = np.sqrt(var_va)
r = {'RMSE': np.sqrt(mean_squared_error(y_va, lg_va)), 'MAE': mean_absolute_error(y_va, lg_va), 'R2': r2_score(y_va, lg_va),
     'NLL': float(np.mean(0.5 * (np.log(2 * np.pi * var_va) + (y_va - lg_va) ** 2 / var_va))), 'CRPS': float(np.mean(hn.gauss_crps(y_va, lg_va, sd)))}
ce = []
for c in (0.5, 0.8, 0.9, 0.95):
    cov = float(np.mean(np.abs(y_va - lg_va) <= stats.norm.ppf(0.5 + c / 2) * sd)); r[f'커버리지 {int(c * 100)}%'] = cov; ce.append(abs(cov - c))
r['보정 오차 (평균 |커버리지 − 명목|)'] = float(np.mean(ce)); r['90% 구간 평균 폭'] = float(np.mean(2 * stats.norm.ppf(0.95) * sd))
pp = pd.read_csv(os.path.join(OUT, 'point_prob.csv'), index_col=0, encoding='utf-8-sig')
pp['LGBM v3 + 이분산 오차 모델'] = pd.Series(r)
pp.to_csv(os.path.join(OUT, 'point_prob.csv'), encoding='utf-8-sig')
log('이분산 기준선 (수정)\n' + pd.Series(r).round(4).to_string())

# (2) 구위 산출 근거 : LGBM TreeSHAP vs HOF-Net 각 버전 (본 실험과 같은 2026 표본 2만 구)
s26 = fr[2026].sample(20000, random_state=SEED)
X26 = s26[v3.input_features]
groups = [g for g, _ in ew.EXPLAIN_GROUPS]
class TreeShapV3:
    def __init__(self, m): self.m = m
    def explain(self, X, exact=False): return self.m.explain(X, exact=True)
    def method(self, exact=False): return 'shap'
def lgbm_scaler(): return joblib.load(os.path.join('models', 'v3', 'stage4_stuff_scaler.joblib'))
import joblib
d25 = fr[2025]; is_tr = (d25['game_date'] < valid_start).to_numpy()
def run(model, sc, pred_fn):
    pred = pred_fn(X26); score = sc.transform(pred)
    c, S0, method = ew.explain_contrib(model, sc, X26, pred, score, 2026, None)
    return c, S0, method, score
cL, S0L, _, scL = run(TreeShapV3(v3), lgbm_scaler(), v3.predict)
rows, ex = [], []
for k in ['A0-β0.01', 'A0-βNLL', 'A5', 'A5-βNLL']:
    net = load_net(k)
    hof = hn.HOFNetStuffModel(net, prep, v3)
    sc = sp.StuffScaler().fit(hof.predict(d25[v3.input_features])[is_tr & ~d25['waste'].to_numpy()])
    c, S0, method, score = run(hof, sc, hof.predict)
    err = float(np.abs(S0 + c.sum(1) - score).max()); err99 = float(np.quantile(np.abs(S0 + c.sum(1) - score), 0.99))
    share = np.abs(c).mean(0) / np.abs(c).mean(0).sum()
    rows.append({'버전': k, 'method': method, '기준 점수 S0': S0, '가법성 오차 최대 (점)': err, '가법성 오차 99% (점)': err99,
                 '최대 + 요인 일치율': float(np.mean(cL.argmax(1) == c.argmax(1))), '최대 − 요인 일치율': float(np.mean(cL.argmin(1) == c.argmin(1))),
                 '구위 상관 (LGBM)': float(np.corrcoef(score, scL)[0, 1]),
                 **{f'{g} 투구별 상관': float(np.corrcoef(cL[:, j], c[:, j])[0, 1]) for j, g in enumerate(groups)},
                 **{f'{g} 비중': float(share[j]) for j, g in enumerate(groups)}})
    log(k, rows[-1])
lshare = np.abs(cL).mean(0) / np.abs(cL).mean(0).sum()
rows.append({'버전': 'LGBM v3', 'method': 'shap', '기준 점수 S0': S0L, **{f'{g} 비중': float(lshare[j]) for j, g in enumerate(groups)}})
agree = pd.DataFrame(rows).set_index('버전').T
agree.to_csv(os.path.join(OUT, 'explain_agreement_variants.csv'), encoding='utf-8-sig')
log('근거 일치도 (버전별)\n' + agree.round(3).to_string())
log('끝')
