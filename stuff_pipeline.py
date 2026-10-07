"""
구위(Stuff) 지표 파이프라인 모듈

1단계 : 타구 정보(타구방향, 타구속도, 발사각, 공격각도) -> 타구결과 다중분류 (RandomForest)
2단계 : 예측확률 기대값(0~3) -> Gamma 적합 -> Beta 변환 -> 타구질 score (0~1)
3단계 : 투구 정보 -> 타구질 score 회귀 (베이스라인 LGBM, 추후 커스텀 모델로 교체 예정)
4단계 : 3단계 예측값 -> 20~80 스케일 구위 score (중앙값 50, 대칭)

모든 경로는 프로젝트 루트 기준 상대경로를 사용한다. (CLAUDE.md 참조)
"""
import os
import numpy as np
import pandas as pd
from scipy import stats

SEED = 42

# ---------------------------------------------------------------------------
# 0. 데이터 로드 / 분할
# ---------------------------------------------------------------------------
def _read_raw(path, year):
    """로컬 pkl -> 없거나 MLB_DATA=store 이면 온라인 저장소(data_store, HF) -> 둘 다 없으면 pybaseball 로 받아 pkl 캐시"""
    if os.path.exists(path) and os.getenv('MLB_DATA') != 'store':
        return pd.read_pickle(path)
    import data_store
    df = data_store.load_raw(year)
    if df is not None:
        return df
    import pybaseball as pyb
    pyb.cache.enable()
    df = pyb.statcast(start_dt=f'{year}-03-01', end_dt=f'{year}-11-30')
    df.to_pickle(path)
    return df


def load_regular_season(path='games_25_final.pkl', year=2025):
    """정규시즌(game_type == 'R') 투구 데이터 로드. 파일이 없으면 온라인 저장소 / pybaseball 에서 받는다."""
    df = _read_raw(path, year)
    df = df[df['game_type'] == 'R'].copy()
    df['game_date'] = pd.to_datetime(df['game_date'])
    return df.reset_index(drop=True)


def load_season(path='games_25_final.pkl', year=2025):
    """시범경기·정규시즌·포스트시즌 전체 투구 (웹 표시용). 모델 학습·검증은 load_regular_season 만 사용한다."""
    df = _read_raw(path, year)
    df['game_date'] = pd.to_datetime(df['game_date'])
    return df.reset_index(drop=True)


def split_last_month(df, months=1):
    """정규시즌 마지막 N개월 = 검증셋, 그 이전 = 학습셋"""
    valid_start = df['game_date'].max() - pd.DateOffset(months=months) + pd.Timedelta(days=1)
    is_valid = df['game_date'] >= valid_start
    return df[~is_valid].copy(), df[is_valid].copy(), valid_start


# ---------------------------------------------------------------------------
# 1. 타구결과 모델
# ---------------------------------------------------------------------------
HIT_FEATURES = ['spray_angle', 'launch_speed', 'launch_angle', 'attack_angle']
HIT_LABELS = {0: 'Out', 1: 'Single', 2: 'Double/Triple', 3: 'HomeRun'}

# 타격 결과로 볼 수 없는 이벤트 (학습 제외)
EXCLUDE_EVENTS = ['truncated_pa', 'catcher_interf']
EVENT_TO_CLASS = {'single': 1, 'double': 2, 'triple': 2, 'home_run': 3}    # 나머지 인플레이 이벤트는 모두 아웃(0)


def spray_angle(hc_x, hc_y):
    """타구방향 (deg) : 0 = 센터, 음수 = 3루 방향, 양수 = 1루 방향"""
    return np.degrees(np.arctan((hc_x - 125.42) / (198.27 - hc_y)))


def inplay_mask(df):
    """타격이 이뤄진 인플레이 타구 (파울 제외, 파울플라이아웃은 type == 'X' 로 포함됨)"""
    return (df['type'] == 'X') & df['events'].notna() & ~df['events'].isin(EXCLUDE_EVENTS)


def build_hit_dataset(df):
    """1단계 학습 데이터 (X, y). index 는 원본 df 의 index 를 유지한다."""
    d = df[inplay_mask(df)].copy()
    d['spray_angle'] = spray_angle(d['hc_x'], d['hc_y'])
    d = d[d['launch_speed'].notna() & d['launch_angle'].notna()]
    y = d['events'].map(EVENT_TO_CLASS).fillna(0).astype(int)
    return d[HIT_FEATURES], y


def expected_value(proba):
    """예측확률 -> 기대 타구결과값 E = 0*P0 + 1*P1 + 2*P2 + 3*P3 (0~3)"""
    return proba @ np.arange(proba.shape[1])


# ---------------------------------------------------------------------------
# 2. 타구질 score : Gamma -> Beta 변환
# ---------------------------------------------------------------------------
class GammaBetaCalibrator:
    """E(0~3) 에 Gamma 분포를 적합하고, CDF 를 거쳐 Beta 분포(0~1) 로 변환한다.

    score = BetaPPF( GammaCDF(E) ; a, b )
    Beta 의 (a, b) 는 E/3 의 평균·분산으로 적률법 추정 -> 원래 분포 형태를 유지하며 0~1 로 매핑
    """
    eps = 1e-6

    def fit(self, E):
        E = np.clip(np.asarray(E, dtype=float), self.eps, 3 - self.eps)
        self.gamma_a, _, self.gamma_scale = stats.gamma.fit(E, floc=0)
        m = E / 3
        mu, var = m.mean(), m.var()
        common = mu * (1 - mu) / var - 1
        self.beta_a, self.beta_b = mu * common, (1 - mu) * common
        return self

    def transform(self, E):
        E = np.clip(np.asarray(E, dtype=float), self.eps, 3 - self.eps)
        u = stats.gamma.cdf(E, self.gamma_a, scale=self.gamma_scale)
        u = np.clip(u, self.eps, 1 - self.eps)
        return stats.beta.ppf(u, self.beta_a, self.beta_b)

    def __repr__(self):
        return (f'GammaBetaCalibrator(gamma_a={self.gamma_a:.3f}, gamma_scale={self.gamma_scale:.3f}, '
                f'beta_a={self.beta_a:.3f}, beta_b={self.beta_b:.3f})')


# ---------------------------------------------------------------------------
# 3. 구위 모델 : 투구 정보 -> 타구질 score
# ---------------------------------------------------------------------------
FASTBALLS = ['FF', 'SI', 'FC']
EXCLUDE_PITCH_TYPES = ['FA', 'CS', 'PO', 'UN']    # 구종 정보 불명확 / 이퓨스·피치아웃 등
WHIFF_DESC = ['swinging_strike', 'swinging_strike_blocked']

STUFF_NUM_FEATURES = [
    'release_speed', 'pfx_x', 'pfx_z', 'release_pos_x', 'release_pos_z', 'release_extension',
    'release_spin_rate', 'spin_axis', 'arm_angle',
    'vx0', 'vy0', 'vz0', 'ax', 'ay', 'az',
    'velo_diff', 'hb_diff', 'ivb_diff',
]
STUFF_CAT_FEATURES = ['pitch_type', 'p_throws']
STUFF_FEATURES = STUFF_NUM_FEATURES + STUFF_CAT_FEATURES
# v2 : 홈플레이트 도달 시점 수직/수평 진입각 추가 (원값, 높이 보정 없음)
STUFF_FEATURES_V2 = STUFF_NUM_FEATURES + ['vaa', 'haa'] + STUFF_CAT_FEATURES

PLATE_Y = 17 / 12    # 홈플레이트 앞면 (ft)
RELEASE_Y = 50.0     # Statcast 초기 속도/가속도 기준 위치 (ft)


def approach_angles(vx0, vy0, vz0, ax, ay, az):
    """홈플레이트 앞면 도달 시점의 수직(VAA)/수평(HAA) 진입각 (deg)

    vy_f = -sqrt(vy0^2 - 2*ay*(50 - 17/12)), t = (vy_f - vy0) / ay
    VAA = -atan(vz_f / vy_f) : 음수 = 내려오며 진입 (패스트볼 약 -5, 커브 약 -9)
    HAA = -atan(vx_f / vy_f) : 양수 = 포수 시점 오른쪽(3루 쪽)으로 진입
    """
    vy_f = -np.sqrt(vy0 ** 2 - 2 * ay * (RELEASE_Y - PLATE_Y))
    t = (vy_f - vy0) / ay
    vz_f = vz0 + az * t
    vx_f = vx0 + ax * t
    return -np.degrees(np.arctan(vz_f / vy_f)), -np.degrees(np.arctan(vx_f / vy_f))


def add_stuff_features(df):
    """투구 물리량 피처 생성 (로케이션 제외, tjStuff+ 방식)

    - 좌투는 수평 성분 부호를 반전해 우투 기준으로 정규화
    - 투수별 주 패스트볼(FF/SI/FC 중 최다 구종, 없으면 최다 구종) 대비 구속/수평/수직 무브먼트 차이
    """
    d = df[df['pitch_type'].notna() & ~df['pitch_type'].isin(EXCLUDE_PITCH_TYPES)].copy()
    lefty = d['p_throws'] == 'L'
    for c in ['pfx_x', 'release_pos_x', 'vx0', 'ax']:
        d.loc[lefty, c] = -d.loc[lefty, c]
    d.loc[lefty, 'spin_axis'] = 360 - d.loc[lefty, 'spin_axis']
    # 좌투 반전 후 계산 -> HAA 도 우투 기준
    d['vaa'], d['haa'] = approach_angles(d['vx0'], d['vy0'], d['vz0'], d['ax'], d['ay'], d['az'])
    d['pfx_x'] = d['pfx_x'] * 12    # ft -> inch
    d['pfx_z'] = d['pfx_z'] * 12

    # 투수별 주 패스트볼 (투구 물리량만 사용하므로 결과 누수 없음)
    counts = d.groupby(['pitcher', 'pitch_type']).size().rename('n').reset_index()
    counts['is_fb'] = counts['pitch_type'].isin(FASTBALLS)
    counts = counts.sort_values(['pitcher', 'is_fb', 'n'], ascending=[True, False, False])
    primary = counts.drop_duplicates('pitcher')[['pitcher', 'pitch_type']]
    fb = (d.merge(primary, on=['pitcher', 'pitch_type'])
           .groupby('pitcher')[['release_speed', 'pfx_x', 'pfx_z']].mean()
           .rename(columns={'release_speed': 'fb_velo', 'pfx_x': 'fb_hb', 'pfx_z': 'fb_ivb'}))
    d = d.join(fb, on='pitcher')
    d['velo_diff'] = d['release_speed'] - d['fb_velo']
    d['hb_diff'] = d['pfx_x'] - d['fb_hb']
    d['ivb_diff'] = d['pfx_z'] - d['fb_ivb']

    for c in STUFF_CAT_FEATURES:
        d[c] = d[c].astype('category')
    return d


def stuff_sample_mask(df, include_looking_k=True):
    """3단계 학습 표본 : 인플레이 타구 + 헛스윙 (+ 루킹 삼진, v1 기본값)"""
    mask = inplay_mask(df) | df['description'].isin(WHIFF_DESC)
    if include_looking_k:
        mask |= (df['description'] == 'called_strike') & (df['events'] == 'strikeout')
    return mask


def build_stuff_dataset(df_feat, hit_score, features=STUFF_FEATURES, include_looking_k=True):
    """3단계 학습 데이터. 인플레이 타구는 타구질 score, 헛스윙(/루킹삼진)은 0.

    hit_score : 1·2단계 산출 타구질 score (index = 원본 df index)
    v1 = 기본 인자, v2 = features=STUFF_FEATURES_V2, include_looking_k=False
    """
    d = df_feat[stuff_sample_mask(df_feat, include_looking_k)].copy()
    y = pd.Series(0.0, index=d.index)
    inplay = inplay_mask(d)
    y[inplay] = hit_score.reindex(d.index[inplay])
    keep = y.notna()    # 타구 정보 결측으로 score 가 없는 인플레이 타구 제외
    return d.loc[keep, features], y[keep]


# ---------------------------------------------------------------------------
# 화면 표시용 : 존에서 크게 벗어난 볼 (점수 산정 제외)
# ---------------------------------------------------------------------------
BALL_DESC = ['ball', 'blocked_ball']
WASTE_X = 20 / 12                                   # Savant Waste : 존 중심에서 좌우 20인치 바깥
WASTE_Z_LO, WASTE_Z_HI = 1.5 - 10 / 12, 3.5 + 10 / 12    # 정규화 존(1.5~3.5ft) 위아래 10인치 바깥


def norm_plate_z(df):
    """타자 존 높이로 plate_z 정규화 (표준 존 1.5 ~ 3.5 ft). 존 정보가 이상하면 원값"""
    h = df['sz_top'] - df['sz_bot']
    zn = 1.5 + (df['plate_z'] - df['sz_bot']) / h * 2.0
    return zn.where(h > 0.5, df['plate_z'])


def is_waste_ball(df):
    """볼 판정이면서 Savant Waste 존(터무니없는 위치)에 들어온 투구"""
    zn = norm_plate_z(df)
    waste = (df['plate_x'].abs() > WASTE_X) | (zn < WASTE_Z_LO) | (zn > WASTE_Z_HI)
    return df['description'].isin(BALL_DESC) & waste


def is_unscored(df):
    """화면에서 구위 점수를 매기지 않는 투구 : waste 볼 + 사구 (사구도 터무니없는 위치의 공)"""
    return is_waste_ball(df) | (df['description'] == 'hit_by_pitch')


def fit_stuff_model(X_tr, y_tr, X_es, y_es, n_iter=12, seed=SEED, verbose=True):
    """베이스라인 LGBM 회귀 모델 (추후 이 함수만 커스텀 모델로 교체)

    X_es, y_es : 학습셋 내부의 early-stopping / 튜닝용 홀드아웃 (검증셋 아님)
    반환 : predict(X) 를 갖는 모델
    """
    import lightgbm as lgb

    rng = np.random.default_rng(seed)
    space = {
        'num_leaves': [15, 31, 63, 127],
        'min_child_samples': [50, 100, 200, 400],
        'learning_rate': [0.02, 0.05],
        'colsample_bytree': [0.6, 0.8, 1.0],
        'subsample': [0.7, 0.9],
        'reg_lambda': [0.0, 1.0, 5.0],
    }
    results = []
    for i in range(n_iter):
        params = {k: v[rng.integers(len(v))] for k, v in space.items()}
        m = lgb.LGBMRegressor(n_estimators=3000, subsample_freq=1, random_state=seed, verbose=-1, **params)
        m.fit(X_tr, y_tr, eval_set=[(X_es, y_es)], eval_metric='l2',
              callbacks=[lgb.early_stopping(100, verbose=False)])
        rmse = np.sqrt(m.best_score_['valid_0']['l2'])
        results.append((rmse, m.best_iteration_, params))
        if verbose:
            print(f'[{i + 1:02d}] rmse={rmse:.5f} iter={m.best_iteration_} {params}')

    rmse, best_iter, params = min(results, key=lambda r: r[0])
    if verbose:
        print(f'best rmse={rmse:.5f} iter={best_iter} {params}')
    # 홀드아웃까지 포함해 재학습 (데이터 증가분만큼 반복수 소폭 증가)
    final = lgb.LGBMRegressor(n_estimators=int(best_iter * 1.1), subsample_freq=1,
                              random_state=seed, verbose=-1, **params)
    final.fit(pd.concat([X_tr, X_es]), pd.concat([y_tr, y_es]))
    final.tuning_results_ = pd.DataFrame(
        [{'rmse': r, 'best_iter': it, **p} for r, it, p in results]).sort_values('rmse')
    return final


# ---------------------------------------------------------------------------
# 4. 최종 구위 score : 20~80 스케일
# ---------------------------------------------------------------------------
class StuffScaler:
    """예측 타구질(낮을수록 좋은 구위) -> 20~80 구위 score

    raw = -예측 타구질 의 학습셋 경험분포(ECDF) -> 표준정규 분위수 z -> 50 + 10z, [20, 80] clip
    => 학습셋 기준 중앙값 50, 50 을 중심으로 대칭
    """

    def fit(self, pred):
        self.ref_ = np.sort(-np.asarray(pred, dtype=float))
        return self

    def transform(self, pred):
        raw = -np.asarray(pred, dtype=float)
        n = len(self.ref_)
        lo = np.searchsorted(self.ref_, raw, side='left')
        hi = np.searchsorted(self.ref_, raw, side='right')
        p = np.clip((lo + hi) / 2 / n, 0.5 / n, 1 - 0.5 / n)
        return np.clip(50 + 10 * stats.norm.ppf(p), 20, 80)
