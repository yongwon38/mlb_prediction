"""
운영 모델(v4) 모니터링·재학습 게이트 공통 함수 (monitor.py / retrain_gate.py / build_monitor_ref.py)

- 점수 : export_web_data 와 같은 경로 (stuff_frame -> predict -> 20~80 스케일, 점수 제외 투구는 NaN). SHAP 은 계산하지 않는다
- 타구질 y3 : 1단계 RF(stage1_hit_rf) + v4 학습 때 쓴 2단계 보정기 (build_monitor_ref.py 가 재현해 monitoring/stage12/ 에 저장)
- 성능 지표 : 투수×구종(n >= 100) Spearman ρ(구위, whiff%) · ρ(구위, xwOBAcon), 3단계 RMSE (hofnet_review_experiment.py 와 같은 정의)
- 불확실성 : 투수 군집 bootstrap (B = 1000, seed 42)
- 드리프트 : PSI (2025 학습 분포 10분위 기준, 범주형은 비율)
이 모듈은 web_id 해시 대상(export_web_data·stuff_pipeline·stuff_model)을 import 만 하고 수정하지 않는다.
"""
import json
import os

import joblib
import numpy as np
import pandas as pd
from scipy import stats

import export_web_data as ew
import stuff_model as sm
import stuff_pipeline as sp

SEED = sp.SEED
MODEL_DIR = os.path.join('models', 'v4')
# monitoring/ : models/ 밖에 둔다 (models/** push 는 shap·deploy 워크플로를 트리거)
STAGE12_DIR = os.path.join('monitoring', 'stage12')        # git 미추적 (RF 27MB) -> HF models/stage12/
STAGE12_FILES = {'rf': 'stage1_hit_rf.joblib', 'calib': 'stage2_calib.joblib'}
REF_PATH = os.path.join('monitoring', 'v4_ref.json')       # git 추적 : 기준 분포·기준 성능
MIN_N = 100            # 투수×구종 최소 투구 수 (누적·검증)
MIN_N_WEEK = 30        # 주간 참고값
B = 1000               # bootstrap 반복
PSI_WARN = 0.2
PSI_WATCH = 0.1
HOF_MONITOR_FILE = 'monitor/monitor.json'   # HF 저장 경로 (web_data/{web_id}/ 밖 -> 모델이 바뀌어도 이력 유지)
HOF_GATE_FILE = 'monitor/gate.json'


# ---------------------------------------------------------------------------
# 모델·아티팩트
# ---------------------------------------------------------------------------
def load_v4():
    model = sm.load_model(MODEL_DIR)
    scaler = joblib.load(os.path.join(MODEL_DIR, 'stage4_stuff_scaler.joblib'))
    return model, scaler


def load_stage12():
    """1단계 RF + 2단계 보정기. 로컬에 없으면 온라인 저장소(HF models/stage12/)에서 받는다"""
    out = {}
    for k, f in STAGE12_FILES.items():
        path = os.path.join(STAGE12_DIR, f)
        if not os.path.exists(path):
            import data_store
            path = data_store.store().download(f'models/stage12/{f}')
        out[k] = joblib.load(path)
    return out['rf'], out['calib']


def load_ref():
    with open(REF_PATH, encoding='utf-8') as f:
        return json.load(f)


# ---------------------------------------------------------------------------
# 점수·타구질
# ---------------------------------------------------------------------------
def score_frame(raw, model, scaler):
    """정규시즌 투구 -> 피처 + pred(3단계 예측) + stuff(20~80, 점수 제외 투구 NaN). export_web_data.score_season 과 같은 값"""
    d = ew.stuff_frame(raw, model)
    d['pred'] = model.predict(d[ew.CFG['features']])
    d['stuff'] = pd.Series(scaler.transform(d['pred'].to_numpy()), index=d.index).where(~sp.is_unscored(d))
    return d


def hit_score(d, rf, calib):
    """인플레이 타구 -> 타구질 score (0~1). index = d 의 index"""
    X, _ = sp.build_hit_dataset(d)
    if len(X) == 0:
        return pd.Series(dtype=float)
    return pd.Series(calib.transform(sp.expected_value(rf.predict_proba(X))), index=X.index)


def add_y3(d, rf, calib):
    """3단계 학습 표본(인플레이 + 헛스윙, 루킹삼진 제외)의 y3 열 추가 (v2 이후 정의). 표본 밖은 NaN"""
    _, y3 = sp.build_stuff_dataset(d, hit_score(d, rf, calib), features=['pitcher'], include_looking_k=False)
    d['y3'] = y3.reindex(d.index)
    return d


def model_features(d, model):
    """LGBM 이 실제로 보는 14개 피처 (보정 진입각 vaa_aa 포함)"""
    return model.model_frame(d[model.input_features])


# ---------------------------------------------------------------------------
# 성능 지표
# ---------------------------------------------------------------------------
def group_table(d, score_col='stuff', min_n=MIN_N):
    """투수×구종 : 투구 수, 평균 구위, whiff%(헛스윙/스윙), xwOBAcon (hofnet_review_experiment.group_table 과 같은 정의)"""
    x = d.assign(pt=d['pitch_type'].astype(str), sw=d['description'].isin(ew.SWING_DESC),
                 wh=d['description'].isin(sp.WHIFF_DESC),
                 xc=d['estimated_woba_using_speedangle'].where(d['type'] == 'X'))
    g = x.groupby(['pitcher', 'pt'], observed=True).agg(n=('sw', 'size'), s=(score_col, 'mean'), sw=('sw', 'sum'),
                                                         wh=('wh', 'sum'), xc=('xc', 'mean'))
    g = g[g['n'] >= min_n]
    return g.assign(whiff=g['wh'] / g['sw'].replace(0, np.nan))


def rho(a, b):
    ok = np.isfinite(a) & np.isfinite(b)
    if ok.sum() < 10:
        return float('nan')
    return float(stats.spearmanr(a[ok], b[ok]).statistic)


def boot_index(pitchers, b=B, seed=SEED):
    """투수 군집 bootstrap : 투수를 복원추출하고 그 투수의 행을 모두 포함한 행 번호 배열 b 개"""
    pitchers = np.asarray(pitchers)
    up = np.unique(pitchers)
    rows = {p: np.where(pitchers == p)[0] for p in up}
    rng = np.random.default_rng(seed)
    return [np.concatenate([rows[p] for p in rng.choice(up, len(up))]) for _ in range(b)]


def group_metrics(g, boot=None):
    """ρ(구위, whiff%) · ρ(구위, xwOBAcon) + (boot 이 있으면) 95% CI"""
    s, wh, xc = g['s'].to_numpy(), g['whiff'].to_numpy(), g['xc'].to_numpy()
    out = {'groups': int(len(g)), 'rhoWhiff': rho(s, wh), 'rhoXwoba': rho(s, xc)}
    if boot is not None and len(g) >= 10:
        rw = np.array([rho(s[i], wh[i]) for i in boot])
        rx = np.array([rho(s[i], xc[i]) for i in boot])
        out['rhoWhiffCI'] = [float(np.nanquantile(rw, .025)), float(np.nanquantile(rw, .975))]
        out['rhoXwobaCI'] = [float(np.nanquantile(rx, .025)), float(np.nanquantile(rx, .975))]
    return out


def rmse(d, pred_col='pred'):
    m = d['y3'].notna() & d[pred_col].notna()
    if m.sum() == 0:
        return float('nan'), 0
    return float(np.sqrt(np.mean((d.loc[m, pred_col] - d.loc[m, 'y3']) ** 2))), int(m.sum())


# ---------------------------------------------------------------------------
# 드리프트
# ---------------------------------------------------------------------------
def psi_ref(X):
    """기준 분포 : 수치형 = 10분위 경계 + 구간 비율, 범주형 = 범주 비율"""
    ref = {}
    for c in X.columns:
        x = X[c]
        if isinstance(x.dtype, pd.CategoricalDtype) or x.dtype == object:
            fr = x.astype(str).value_counts(normalize=True)
            ref[c] = {'type': 'cat', 'frac': {k: float(v) for k, v in fr.items()}}
        else:
            v = x.to_numpy(float)
            v = v[np.isfinite(v)]
            edges = np.unique(np.quantile(v, np.linspace(0, 1, 11)[1:-1]))
            cnt = np.bincount(np.searchsorted(edges, v, side='right'), minlength=len(edges) + 1)
            ref[c] = {'type': 'num', 'edges': edges.tolist(), 'frac': (cnt / cnt.sum()).tolist()}
    return ref


def psi(ref_c, x, eps=1e-4):
    """Population Stability Index = Σ (q - p) ln(q / p)"""
    if ref_c['type'] == 'cat':
        keys = list(ref_c['frac'])
        q = x.astype(str).value_counts(normalize=True).reindex(keys).fillna(0).to_numpy()
        p = np.array([ref_c['frac'][k] for k in keys])
    else:
        v = x.to_numpy(float)
        v = v[np.isfinite(v)]
        if len(v) == 0:
            return float('nan')
        edges = np.asarray(ref_c['edges'])
        cnt = np.bincount(np.searchsorted(edges, v, side='right'), minlength=len(edges) + 1)
        q, p = cnt / cnt.sum(), np.asarray(ref_c['frac'])
    q, p = np.clip(q, eps, None), np.clip(p, eps, None)
    return float(np.sum((q - p) * np.log(q / p)))


def dump_json(obj, path):
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, indent=1, allow_nan=False, default=_clean)


def _clean(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if not np.isfinite(o) else float(o)
    raise TypeError(type(o))


def finite(x, nd=4):
    """JSON 용 : NaN/inf -> None, 반올림 (정수는 그대로)"""
    if x is None:
        return None
    if isinstance(x, (int, np.integer)) and not isinstance(x, bool):
        return int(x)
    x = float(x)
    return round(x, nd) if np.isfinite(x) else None
