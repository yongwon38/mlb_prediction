"""
웹 페이지(web/)용 데이터 export

시즌별 정규시즌 투구에 3·4단계 모델(구위 모델 + 20~80 스케일러)을 적용해 투구별 구위 score 를 만들고,
투수별 JSON(컬럼형 배열) / 투수 목록 / 리그 기준값을 web/public/data/{season}/ 에 저장한다.

- 2025 : 모델 학습 시즌 (선택한 모델 버전의 stuff_scores_2025.parquet 과 동일한 값인지 검증)
- 2024, 2026 : 2025 학습 모델을 그대로 적용한 out-of-sample score
- MODEL_VERSION 으로 사용할 모델 선택 (v1 : models/, outputs/ / v2 : models/v2/, outputs/v2/)
- v2 : 볼 판정 + Savant Waste 존 투구(sp.is_waste_ball)와 사구(sp.is_unscored)는 score 없음(null). 행은 유지해 분포도에는 표시

실행 : python export_web_data.py                       (전체 시즌)
       python export_web_data.py --seasons 2026         (특정 시즌만, meta.json 은 항상 전체 시즌 목록)
"""
import argparse
import gzip
import json
import os
import urllib.request

import joblib
import numpy as np
import pandas as pd

import data_store
import stuff_pipeline as sp

MODEL_VERSION = 'v2'
MODELS = {
    'v1': {'dir': 'models', 'outputs': 'outputs', 'features': sp.STUFF_FEATURES, 'drop_waste': False},
    'v2': {'dir': os.path.join('models', 'v2'), 'outputs': os.path.join('outputs', 'v2'),
           'features': sp.STUFF_FEATURES_V2, 'drop_waste': True},
}
CFG = MODELS[MODEL_VERSION]

# 2024 ~ 현재 시즌 (3월 1일에 새 시즌 자동 추가). 로컬 pkl 이 없으면 온라인 저장소(data_store)에서 읽는다
SEASONS = {y: 'games_25_final.pkl' if y == 2025 else f'games_{y % 100}.pkl'
           for y in range(max(data_store.current_season(), 2026), 2023, -1)}
OUT_DIR = os.path.join('web', 'public', 'data')
MIN_PITCHER_PITCHES = 300     # 리그 퍼센타일 기준 표본 (투수 전체)
MIN_PITCHTYPE_PITCHES = 50    # 리그 퍼센타일 기준 표본 (투수×구종)
STUFF_BINS = [20, 40, 45, 50, 55, 60, 80.01]
STUFF_BIN_LABELS = ['<40', '40-45', '45-50', '50-55', '55-60', '60+']

TEAMS = {
    'AL': {'BAL': 'Baltimore Orioles', 'BOS': 'Boston Red Sox', 'NYY': 'New York Yankees',
           'TB': 'Tampa Bay Rays', 'TOR': 'Toronto Blue Jays', 'CWS': 'Chicago White Sox',
           'CLE': 'Cleveland Guardians', 'DET': 'Detroit Tigers', 'KC': 'Kansas City Royals',
           'MIN': 'Minnesota Twins', 'HOU': 'Houston Astros', 'LAA': 'Los Angeles Angels',
           'OAK': 'Oakland Athletics', 'ATH': 'Athletics', 'SEA': 'Seattle Mariners',
           'TEX': 'Texas Rangers'},
    'NL': {'ATL': 'Atlanta Braves', 'MIA': 'Miami Marlins', 'NYM': 'New York Mets',
           'PHI': 'Philadelphia Phillies', 'WSH': 'Washington Nationals', 'CHC': 'Chicago Cubs',
           'CIN': 'Cincinnati Reds', 'MIL': 'Milwaukee Brewers', 'PIT': 'Pittsburgh Pirates',
           'STL': 'St. Louis Cardinals', 'AZ': 'Arizona Diamondbacks', 'COL': 'Colorado Rockies',
           'LAD': 'Los Angeles Dodgers', 'SD': 'San Diego Padres', 'SF': 'San Francisco Giants'},
}
TEAM_LEAGUE = {t: lg for lg, ts in TEAMS.items() for t in ts}

PITCH_NAMES = {
    'FF': '4-Seam Fastball', 'SI': 'Sinker', 'FC': 'Cutter', 'SL': 'Slider', 'ST': 'Sweeper',
    'SV': 'Slurve', 'CU': 'Curveball', 'KC': 'Knuckle Curve', 'CH': 'Changeup', 'FS': 'Splitter',
    'FO': 'Forkball', 'SC': 'Screwball', 'KN': 'Knuckleball', 'EP': 'Eephus',
}

# 투구 결과 (화면 표시용) : 0 볼 / 1 루킹 스트라이크 / 2 헛스윙 / 3 파울 / 4 인플레이 아웃 / 5 1루타 / 6 2루타 / 7 3루타 / 8 홈런 / 9 사구
RESULTS = ['Ball', 'Called Strike', 'Swinging Strike', 'Foul', 'Out', 'Single', 'Double', 'Triple', 'Home Run', 'HBP']
DESC_TO_RESULT = {
    'ball': 0, 'blocked_ball': 0, 'automatic_ball': 0, 'pitchout': 0,
    'called_strike': 1, 'automatic_strike': 1,
    'swinging_strike': 2, 'swinging_strike_blocked': 2, 'missed_bunt': 2,
    'foul': 3, 'foul_tip': 3, 'foul_bunt': 3, 'bunt_foul_tip': 3,
    'hit_by_pitch': 9,
}
HIT_TO_RESULT = {'single': 5, 'double': 6, 'triple': 7, 'home_run': 8}

# 타석 종료 이벤트 : 0 없음 / 1 아웃(타수) / 2 삼진 / 3 1B / 4 2B / 5 3B / 6 HR / 7 볼넷 / 8 사구 / 9 타수 아님(희생타 등)
PA_EVENTS = ['', 'Out', 'Strikeout', 'Single', 'Double', 'Triple', 'Home Run', 'Walk', 'HBP', 'Sacrifice/Other']
EVENT_TO_PA = {'strikeout': 2, 'strikeout_double_play': 2, 'single': 3, 'double': 4, 'triple': 5,
               'home_run': 6, 'walk': 7, 'intent_walk': 7, 'hit_by_pitch': 8,
               'sac_fly': 9, 'sac_bunt': 9, 'sac_fly_double_play': 9, 'catcher_interf': 9, 'truncated_pa': 9}

SWING_DESC = ['swinging_strike', 'swinging_strike_blocked', 'foul', 'foul_tip', 'hit_into_play',
              'foul_bunt', 'missed_bunt', 'bunt_foul_tip']

# 경기 유형 : 0 정규시즌 / 1 포스트시즌 / 2 시범경기. 모델 학습·리그 기준값은 정규시즌만
GAME_TYPE_CODE = {'R': 0, 'F': 1, 'D': 1, 'L': 1, 'W': 1, 'S': 2}
GAME_TYPE_LABELS = ['정규시즌', '포스트시즌', '시범경기']
ROUND_LABELS = {'R': '정규시즌', 'S': '시범경기', 'F': '와일드카드', 'D': '디비전시리즈', 'L': '챔피언십시리즈', 'W': '월드시리즈'}
# 경기 중요도 = 타석 |WPA| 합 x 경기 유형 가중치
IMPORTANCE_WEIGHT = {'R': 1.0, 'S': 0.5, 'F': 1.5, 'D': 1.5, 'L': 1.5, 'W': 2.0}
# 리그 요약(메인 페이지) 리더보드 최소 투구 수 (유형별)
SUMMARY_MIN_PITCHES = {0: 300, 1: 40, 2: 100}
HIGHLIGHT_MIN_GAME_PITCHES = 15    # 투수 경기 구위 하이라이트 최소 투구
HIGHLIGHT_MIN_LEAGUE_GAME_PITCHES = 40    # 리그 전체 구위 하이라이트 경기 최소 투구
# 타석 종료 이벤트별 아웃 수 (경기 IP 추정용)
OUTS_BY_EVENT = {'field_out': 1, 'strikeout': 1, 'force_out': 1, 'sac_fly': 1, 'sac_bunt': 1, 'fielders_choice_out': 1,
                 'grounded_into_double_play': 2, 'double_play': 2, 'strikeout_double_play': 2, 'sac_fly_double_play': 2,
                 'sac_bunt_double_play': 2, 'triple_play': 3, 'other_out': 1}
STATSAPI = 'https://statsapi.mlb.com/api/v1'
CACHE_DIR = 'web_cache'    # 선수 이름 캐시 (커밋하지 않음)


# ---------------------------------------------------------------------------
# 구위 산출 근거 : SHAP 기여도 -> 구위 점수 단위 (요인 그룹별 합)
# ---------------------------------------------------------------------------
# 서로 얽힌 변수는 SHAP 이 기여를 임의로 나눠 가지므로 그룹으로 묶어 보여 준다
EXPLAIN_GROUPS = [
    ('구속', ['release_speed', 'velo_diff', 'vy0', 'ay']),
    ('수직 무브먼트', ['pfx_z', 'ivb_diff', 'az']),
    ('수평 무브먼트', ['pfx_x', 'hb_diff', 'ax']),
    ('진입각·궤적', ['vaa', 'haa', 'vx0', 'vz0']),
    ('릴리스 위치', ['release_pos_x', 'release_pos_z', 'arm_angle']),
    ('익스텐션', ['release_extension']),
    ('회전', ['release_spin_rate', 'spin_axis']),
    ('구종·투구손', ['pitch_type', 'p_throws']),
]
EXPLAIN_COLS = [f'e{j}' for j in range(len(EXPLAIN_GROUPS))]
# 근거 문장용 원값 (모델 입력 기준 : 좌투는 좌우 반전 = 우투 기준, 무브먼트는 inch)
EXPLAIN_FEATS = {'v': ('release_speed', 1), 'ivb': ('pfx_z', 1), 'hb': ('pfx_x', 1), 'spin': ('release_spin_rate', 0),
                 'axis': ('spin_axis', 0), 'vaa': ('vaa', 1), 'haa': ('haa', 1), 'ext': ('release_extension', 1),
                 'rz': ('release_pos_z', 1), 'arm': ('arm_angle', 0)}


SHAP_DIR = os.path.join(CFG['outputs'], 'shap')    # compute_shap.py 가 만드는 정확한 SHAP 캐시
KEY = ['game_pk', 'at_bat_number', 'pitch_number', 'pitcher']


def saabas_contrib(booster, X):
    """Saabas(경로 기반) 기여 : 트리마다 루트 -> 리프 경로에서 분기 변수에 노드값 변화를 귀속.
    리프별 기여 벡터를 미리 만들어 두고 pred_leaf 로 조회 -> 수 분 안에 전체 시즌 계산. bias + 합 = 예측 (정확)"""
    F = X.shape[1]
    trees = booster.dump_model()['tree_info']
    table = np.zeros((len(trees), max(t['num_leaves'] for t in trees), F))
    bias = 0.0
    for ti, tr in enumerate(trees):
        root = tr['tree_structure']
        if 'leaf_value' in root:
            bias += root['leaf_value']
            continue
        bias += root['internal_value']
        stack = [(root, np.zeros(F))]
        while stack:
            node, acc = stack.pop()
            for ch in (node['left_child'], node['right_child']):
                val = ch['leaf_value'] if 'leaf_index' in ch else ch['internal_value']
                a = acc.copy()
                a[node['split_feature']] += val - node['internal_value']
                if 'leaf_index' in ch:
                    table[ti, ch['leaf_index']] = a
                else:
                    stack.append((ch, a))
    leaves = booster.predict(X, pred_leaf=True)
    contrib = np.zeros((len(X), F))
    for ti in range(len(trees)):
        contrib += table[ti, leaves[:, ti]]
    return contrib, bias


def load_shap_cache(season, keys):
    """compute_shap.py 의 정확한 SHAP 캐시 (모든 투구가 있을 때만 사용). 반환 (contrib, base) 또는 None

    shap_{season}.npz = 정규시즌, shap_{season}_extra.npz = 시범경기·포스트시즌 (있으면 합친다)"""
    zs = [np.load(p) for p in (os.path.join(SHAP_DIR, f'shap_{season}{s}.npz') for s in ('', '_extra')) if os.path.exists(p)]
    if not zs:
        return None
    ref = pd.DataFrame(np.concatenate([z['keys'] for z in zs]), columns=KEY)
    ref['row'] = np.arange(len(ref))
    m = keys.astype('int64').merge(ref, on=KEY, how='left')
    if m['row'].isna().any():
        print(f'  SHAP 캐시 불완전 ({m["row"].isna().sum():,}구 없음) -> Saabas 사용')
        return None
    contrib = np.concatenate([z['contrib'] for z in zs])
    return contrib[m['row'].astype(int).to_numpy()], float(zs[0]['base'])


def explain_contrib(model, scaler, X, pred, score, season, keys):
    """투구별 요인 그룹 기여 (구위 점수 단위). 반환 : (n, 그룹 수) 배열, 기준 점수 S0, 방법('shap'|'saabas')

    기여 phi_ij 는 예측(타구질, 낮을수록 좋음) 단위 -> k_i = (s_i - S0) / (pred_i - base) 로 비례 배분해
    S0 + sum_j c_ij = s_i 가 정확히 성립하게 한다. pred 가 base 와 거의 같으면 스케일러 수치 미분을 쓴다
    """
    feats = list(X.columns)
    cached = load_shap_cache(season, keys)
    if cached is not None and np.abs(cached[1] + cached[0].sum(axis=1) - pred).max() >= 1e-6:
        print('  SHAP 캐시가 현재 모델·데이터와 맞지 않음 -> Saabas 사용')
        cached = None
    if cached is not None:
        contrib, base = cached
        method = 'shap'
    else:
        contrib, base = saabas_contrib(model.booster_, X)
        method = 'saabas'
    assert np.abs(base + contrib.sum(axis=1) - pred).max() < 1e-6, '기여 합 != 예측'
    S0 = float(scaler.transform([base])[0])
    diff = pred - base
    h = 2e-3
    deriv = (scaler.transform(pred + h) - scaler.transform(pred - h)) / (2 * h)
    near = np.abs(diff) < 1e-4
    k = np.where(near, deriv, (score - S0) / np.where(near, 1.0, diff))
    c = np.column_stack([contrib[:, [feats.index(f) for f in fs]].sum(axis=1) for _, fs in EXPLAIN_GROUPS]) * k[:, None]
    err = np.abs(S0 + c.sum(axis=1) - score)[~near]
    assert err.max() < 1e-6, f'기여도 가법성 오차 {err.max()}'
    return c, S0, method


# ---------------------------------------------------------------------------
# 구위 score 산출
# ---------------------------------------------------------------------------
def stuff_frame(raw, model):
    """전체 경기 유형 투구 -> 구위 피처 (모델 범주 정렬, 학습 시 없던 구종 제외)

    정규시즌 행은 정규시즌만으로 add_stuff_features (= 학습·parquet 과 동일 값).
    시범·포스트시즌 행의 '주 패스트볼 대비 차이'는 그 투수의 정규시즌 주 패스트볼 기준 (정규시즌 기록이 없으면 자체 기준)"""
    is_r = raw['game_type'] == 'R'
    parts = [sp.add_stuff_features(raw[is_r])]
    if (~is_r).any():
        x = sp.add_stuff_features(raw[~is_r])
        ref = parts[0].groupby('pitcher')[['fb_velo', 'fb_hb', 'fb_ivb']].first()
        has = x['pitcher'].isin(ref.index)
        for c in ref.columns:
            x.loc[has, c] = x.loc[has, 'pitcher'].map(ref[c])
        x['velo_diff'] = x['release_speed'] - x['fb_velo']
        x['hb_diff'] = x['pfx_x'] - x['fb_hb']
        x['ivb_diff'] = x['pfx_z'] - x['fb_ivb']
        parts.append(x)
    d = pd.concat(parts)
    for col, cats in zip(sp.STUFF_CAT_FEATURES, model.booster_.pandas_categorical):
        d[col] = pd.Categorical(d[col].astype(str), categories=cats)
    return d[d['pitch_type'].notna()]    # 학습 시 없던 구종 제외


def score_season(df, model, scaler, season):
    """전체 경기 유형 투구 -> 구위 피처 -> 3단계 예측 -> 20~80 score + 요인 기여 (구종 제외 대상은 행 제외). 반환 (d, 기준 점수 S0, 기여 방법)"""
    d = stuff_frame(df, model)
    pred = model.predict(d[CFG['features']])
    d['stuff_score'] = scaler.transform(pred)
    c, S0, method = explain_contrib(model, scaler, d[CFG['features']], pred, d['stuff_score'].to_numpy(), season, d[KEY])
    d[EXPLAIN_COLS] = c
    if CFG['drop_waste']:
        scored = ~sp.is_unscored(d)
        d['stuff_score'] = d['stuff_score'].where(scored)    # 터무니없는 위치의 볼 + 사구 : 점수 없음
        print(f"  점수 제외 : waste 볼 {sp.is_waste_ball(d).sum():,} + 사구 {(d['description'] == 'hit_by_pitch').sum():,}")
        d.loc[~scored, EXPLAIN_COLS] = np.nan
    for col in sp.STUFF_CAT_FEATURES:
        d[col] = d[col].astype(str)
    return d, S0, method


def check_against_parquet(d):
    """2025 score 가 파이프라인 노트북 산출물과 동일한지 확인"""
    path = os.path.join(CFG['outputs'], 'stuff_scores_2025.parquet')
    if not os.path.exists(path):
        print('  (parquet 없음 - 검증 생략)')
        return
    key = ['game_pk', 'at_bat_number', 'pitch_number', 'pitcher']
    ref = pd.read_parquet(path)[key + ['description', 'stuff_score']]
    if CFG['drop_waste']:    # 기준 parquet 은 waste 볼만 NaN -> 사구 제외 규칙을 같게 맞춘 뒤 대조
        ref.loc[ref['description'] == 'hit_by_pitch', 'stuff_score'] = np.nan
    ref = ref.drop(columns='description')
    cur = d.loc[d['game_type'] == 'R', key + ['stuff_score']].astype({k: 'int64' for k in key})
    m = cur.merge(ref.astype({k: 'int64' for k in key}), on=key, suffixes=('', '_ref'))
    nan_ok = (m['stuff_score'].isna() == m['stuff_score_ref'].isna()).all()
    diff = (m['stuff_score'] - m['stuff_score_ref']).abs()
    print(f'  parquet 대조 : 매칭 {len(m):,} / 현재 {len(cur):,} / 기준 {len(ref):,}, 최대 오차 {diff.max():.2e}, '
          f'점수 없음 {m["stuff_score"].isna().sum():,}구 (위치 일치 {nan_ok})')
    assert len(m) == len(ref) and nan_ok and diff.max() < 1e-6, 'parquet 과 구위 score 불일치'


# ---------------------------------------------------------------------------
# 투구별 파생 변수
# ---------------------------------------------------------------------------
def add_web_columns(raw, d):
    """raw : 정규시즌 원본 (경기 내 투구 순번 계산용), d : score 가 붙은 투구"""
    order = raw.sort_values(['game_pk', 'at_bat_number', 'pitch_number'])
    pitch_no = order.groupby(['pitcher', 'game_pk']).cumcount() + 1
    d = d.join(pitch_no.rename('game_pitch_no'))

    d['team'] = np.where(d['inning_topbot'] == 'Top', d['home_team'], d['away_team'])
    unknown = set(d['team']) - set(TEAM_LEAGUE)
    assert not unknown, f'리그 매핑 없는 팀 : {unknown}'

    res = d['description'].map(DESC_TO_RESULT)
    inplay = d['description'] == 'hit_into_play'
    res[inplay] = d.loc[inplay, 'events'].map(HIT_TO_RESULT).fillna(4)
    assert res.notna().all(), f"결과 매핑 없음 : {d.loc[res.isna(), 'description'].unique()}"
    d['result'] = res.astype(int)

    pa = d['events'].map(EVENT_TO_PA)
    d['pa_event'] = np.where(d['events'].notna(), pa.fillna(1), 0).astype(int)

    d['is_swing'] = d['description'].isin(SWING_DESC).astype(int)
    d['is_whiff'] = d['description'].isin(sp.WHIFF_DESC).astype(int)

    # 타자 존 높이로 정규화 (표준 존 1.5 ~ 3.5 ft)
    d['plate_z_norm'] = sp.norm_plate_z(d)

    # 피 xwOBA : 인플레이 = 추정 wOBA, 그 외 타석 종료 = 실제 wOBA (woba_denom 기준)
    xw = np.where(inplay, d['estimated_woba_using_speedangle'], d['woba_value'])
    d['xwoba'] = pd.Series(xw, index=d.index).where(d['woba_denom'] == 1)

    # 원래 부호의 무브먼트 (add_stuff_features 는 좌투 반전 + inch 변환을 하므로 원본에서 다시 가져온다)
    d['hb_in'] = raw.loc[d.index, 'pfx_x'] * 12
    d['ivb_in'] = raw.loc[d.index, 'pfx_z'] * 12

    # 타구 좌표 (ft) : Savant hc_x/hc_y -> 홈플레이트 = (0, 0), +x = 1루 쪽, +y = 외야 방향. 인플레이만
    d['hit_x'] = (2.5 * (d['hc_x'] - 125.42)).where(inplay)
    d['hit_y'] = (2.5 * (198.27 - d['hc_y'])).where(inplay)

    # 경기 유형·상황 (투수 관점) : 홈팀 투수 = 초 공격 수비
    d['gt'] = d['game_type'].map(GAME_TYPE_CODE)
    assert d['gt'].notna().all(), f"경기 유형 매핑 없음 : {d.loc[d['gt'].isna(), 'game_type'].unique()}"
    sign = np.where(d['inning_topbot'] == 'Top', 1.0, -1.0)
    d['wpa_p'] = d['delta_home_win_exp'].fillna(0) * sign
    d['re_p'] = -d['delta_run_exp']
    d['opp'] = np.where(d['inning_topbot'] == 'Top', d['away_team'], d['home_team'])
    d['is_home'] = (d['inning_topbot'] == 'Top').astype(int)
    d['score_diff'] = d['fld_score'] - d['bat_score']
    d['runners'] = d['on_1b'].notna().astype(int) + 2 * d['on_2b'].notna().astype(int) + 4 * d['on_3b'].notna().astype(int)
    d['runs_on'] = (d['post_bat_score'] - d['bat_score']).clip(lower=0)
    fin = raw.groupby('game_pk')[['post_home_score', 'post_away_score']].max()
    d['final_home'] = d['game_pk'].map(fin['post_home_score'])
    d['final_away'] = d['game_pk'].map(fin['post_away_score'])
    # 선발 : 그 경기에서 해당 팀 수비의 첫 투구를 던진 투수
    first = raw.sort_values(['game_pk', 'at_bat_number', 'pitch_number']).drop_duplicates(['game_pk', 'inning_topbot'])
    starters = set(zip(first['game_pk'], first['pitcher']))
    d['is_start'] = [int((g, p) in starters) for g, p in zip(d['game_pk'], d['pitcher'])]
    return d


# ---------------------------------------------------------------------------
# JSON 작성
# ---------------------------------------------------------------------------
def _arr(s, nd=None):
    """Series -> JSON 리스트 (결측은 null, nd 자리 반올림)"""
    v = s.to_numpy(dtype=float)
    if nd is not None:
        v = np.round(v, nd)
    out = v.tolist()
    return [None if x != x else (int(x) if nd == 0 else x) for x in out]


def display_name(player_name):
    last, _, first = str(player_name).partition(', ')
    return f'{first} {last}'.strip()


SORT_KEY = ['game_date', 'game_pk', 'at_bat_number', 'pitch_number']


def _num(x, nd=None):
    """스칼라 -> JSON 값 (결측 null)"""
    if x is None or x != x:
        return None
    return int(round(x)) if nd == 0 else (round(float(x), nd) if nd is not None else float(x))


def game_pa_tables(g):
    """투수 1명의 투구(SORT_KEY 정렬) -> (경기 인덱스, 타석 인덱스, 경기 표, 타석 표). 표는 DataFrame, 투구 위치 기준 i0"""
    g = g.reset_index(drop=True)
    gi = pd.Series(pd.factorize(g['game_pk'])[0])
    pai = pd.Series(pd.factorize(g['game_pk'].astype('int64') * 1000 + g['at_bat_number'].astype('int64'))[0])
    pos = pd.Series(np.arange(len(g)))

    by = g.groupby(pai, sort=True)
    last = by.tail(1).set_index(pai[by.tail(1).index])
    pas = pd.DataFrame({
        'g': gi.groupby(pai).first(),
        'ab': by['at_bat_number'].first(),
        'inn': by['inning'].first(),
        'o': by['outs_when_up'].first(),
        'on': by['runners'].first(),
        'sc': by['score_diff'].first(),
        'bat': by['batter'].first().astype('int64'),
        'lhb': (by['stand'].first() == 'L').astype(int),
        'ev': last['pa_event'],
        'event': last['events'],
        'des': last['des'].where(last['events'].notna()),
        'wpa': by['wpa_p'].sum(),
        're': by['re_p'].sum(min_count=1),
        'runs': by['runs_on'].sum(),
        'n': by.size(),
        'i0': pos.groupby(pai).first(),
        's': by['stuff_score'].mean(),
        'smax': by['stuff_score'].max(),
    })
    pas['outs'] = pas['event'].map(OUTS_BY_EVENT).fillna(0).astype(int)

    byg = g.groupby(gi, sort=True)
    pg = pas.groupby('g')
    first = byg.head(1).set_index(gi[byg.head(1).index])
    home = first['is_home'] == 1
    rd = first['game_type']
    scored = g['stuff_score'].notna()
    games = pd.DataFrame({
        'pk': first['game_pk'].astype('int64'),
        'date': first['game_date'].dt.strftime('%Y-%m-%d'),
        'gt': first['gt'].astype(int),
        'rd': rd,
        'team': first['team'],
        'opp': first['opp'],
        'home': home.astype(int),
        'rs': np.where(home, first['final_home'], first['final_away']),
        'ra': np.where(home, first['final_away'], first['final_home']),
        'st': first['is_start'],
        'n': byg.size(),
        'outs': pg['outs'].sum(),
        'h': pg['ev'].apply(lambda e: int(e.between(3, 6).sum())),
        'bb': pg['ev'].apply(lambda e: int((e == 7).sum())),
        'k': pg['ev'].apply(lambda e: int((e == 2).sum())),
        'hr': pg['ev'].apply(lambda e: int((e == 6).sum())),
        'r': pg['runs'].sum(),
        's': byg['stuff_score'].mean(),
        's60': (g['stuff_score'] >= 60).groupby(gi).sum() / scored.groupby(gi).sum().replace(0, np.nan),
        'wpa': pg['wpa'].sum(),
        'imp': pg['wpa'].apply(lambda w: w.abs().sum()) * rd.map(IMPORTANCE_WEIGHT).to_numpy(),
        'i0': pos.groupby(gi).first(),
        'pa0': pas.reset_index().groupby('g')['index'].first(),
        'npa': pg.size(),
    })
    return gi, pai, games, pas


def records_json(df, nd):
    """DataFrame -> JSON 레코드 (숫자는 nd 자리, 기본 정수 / 결측 null / 문자 그대로)"""
    out = []
    for row in df.to_dict('records'):
        out.append({k: (_num(v, nd.get(k, 0)) if isinstance(v, (int, float, np.integer, np.floating)) else
                        (v if isinstance(v, str) else None)) for k, v in row.items()})
    return out


GAME_ND = {'s': 1, 's60': 3, 'wpa': 3, 'imp': 3}
PA_ND = {'wpa': 3, 're': 3, 's': 1, 'smax': 1}


def games_json(games):
    return records_json(games, GAME_ND)


def pas_json(pas, bat_idx):
    out = []
    for r in pas.itertuples(index=False):
        out.append({'g': int(r.g), 'ab': int(r.ab), 'inn': int(r.inn), 'o': _num(r.o, 0), 'on': int(r.on), 'sc': _num(r.sc, 0),
                    'bat': bat_idx[int(r.bat)], 'lhb': int(r.lhb), 'ev': int(r.ev), 'des': r.des if isinstance(r.des, str) else None,
                    'wpa': _num(r.wpa, 3), 're': _num(r.re, 3), 'runs': int(r.runs), 'n': int(r.n), 'i0': int(r.i0),
                    's': _num(r.s, 1), 'smax': _num(r.smax, 1)})
    return out


def pitcher_payload(g, season_start, pitch_types, teams, names):
    """투수 파일 : 투구 컬럼 + 경기 표 + 타석 표 + 타자 이름. 반환 (payload, 경기 표, 타석 표)"""
    g = g.sort_values(SORT_KEY).reset_index(drop=True)
    gi, pai, games, pas = game_pa_tables(g)
    bat_ids = list(dict.fromkeys(pas['bat'].tolist()))
    bat_idx = {b: i for i, b in enumerate(bat_ids)}
    pt_idx = {p: i for i, p in enumerate(pitch_types)}
    tm_idx = {t: i for i, t in enumerate(teams)}
    first = g.iloc[0]
    payload = {
        'id': int(first['pitcher']),
        'name': display_name(first['player_name']),
        'throws': first['p_throws'],
        'teams': teams,
        'pitchTypes': pitch_types,
        'd0': season_start,
        'batters': [[int(b), names.get(int(b), str(b))] for b in bat_ids],
        'games': games_json(games),
        'pas': pas_json(pas, bat_idx),
        'cols': {
            'day': _arr((g['game_date'] - pd.Timestamp(season_start)).dt.days, 0),
            'game': gi.tolist(),
            'gt': g['gt'].astype(int).tolist(),
            'pai': pai.tolist(),
            'pn': _arr(g['pitch_number'], 0),
            'wpa': _arr(g['wpa_p'], 4),
            're': _arr(g['re_p'], 3),
            'gp': _arr(g['game_pitch_no'], 0),
            'inn': _arr(g['inning'], 0),
            'tm': [tm_idx[t] for t in g['team']],
            'pt': [pt_idx[p] for p in g['pitch_type']],
            's': _arr(g['stuff_score'], 1),
            'x': _arr(g['plate_x'], 2),
            'z': _arr(g['plate_z_norm'], 2),
            'zone': _arr(g['zone'], 0),
            'r': g['result'].tolist(),
            'pa': g['pa_event'].tolist(),
            'st': (g['stand'] == 'L').astype(int).tolist(),
            'b': _arr(g['balls'], 0),
            'k': _arr(g['strikes'], 0),
            'sw': g['is_swing'].tolist(),
            'wh': g['is_whiff'].tolist(),
            'v': _arr(g['release_speed'], 1),
            'hb': _arr(g['hb_in'], 1),
            'ivb': _arr(g['ivb_in'], 1),
            'spin': _arr(g['release_spin_rate'], 0),
            'ev': _arr(g['launch_speed'], 1),
            'la': _arr(g['launch_angle'], 0),
            'xba': _arr(g['estimated_ba_using_speedangle'], 3),
            'xw': _arr(g['xwoba'], 3),
            'hx': _arr(g['hit_x'], 1),
            'hy': _arr(g['hit_y'], 1),
        },
    }
    return payload, games, pas


def explain_payload(g):
    """설명 페이지 전용 투수 파일 (투수 파일과 같은 투구 순서). 기여는 0.1점 단위 정수"""
    g = g.sort_values(SORT_KEY)
    cols = {f'c{j}': _arr(g[col] * 10, 0) for j, col in enumerate(EXPLAIN_COLS)}
    cols.update({k: _arr(g[src], nd) for k, (src, nd) in EXPLAIN_FEATS.items()})
    return {'id': int(g['pitcher'].iloc[0]), 'n': int(len(g)), 'cols': cols}


def explain_league(d, S0):
    """리그 기준 : 구종별 평균 원값과 평균 그룹 기여 (점수 있는 투구만)"""
    d = d[d['stuff_score'].notna()]
    pts = {}
    for pt, g in d.groupby('pitch_type'):
        pts[pt] = {'n': int(len(g)),
                   'feat': {k: round(float(g[src].mean()), 2) for k, (src, _) in EXPLAIN_FEATS.items()},
                   'contrib': [round(float(v), 2) for v in g[EXPLAIN_COLS].mean()]}
    return {'base': round(S0, 3), 'groups': [n for n, _ in EXPLAIN_GROUPS],
            'groupFeatures': [fs for _, fs in EXPLAIN_GROUPS],
            'overall': [round(float(v), 2) for v in d[EXPLAIN_COLS].mean()], 'pitchTypes': pts}


def outcome_rates(g):
    """구간/그룹별 리그 기준 지표"""
    ab = g['pa_event'].between(1, 6)
    hits = g['pa_event'].between(3, 6)
    tb = g['pa_event'].map({3: 1, 4: 2, 5: 3, 6: 4}).fillna(0)
    swings = g['is_swing'].sum()
    con = g['xwoba'].where(g['description'] == 'hit_into_play')
    return {
        'n': int(len(g)),
        'ba': float(hits.sum() / ab.sum()) if ab.sum() else None,
        'slg': float(tb.sum() / ab.sum()) if ab.sum() else None,
        'whiff': float(g['is_whiff'].sum() / swings) if swings else None,
        'csw': float(((g['result'] == 1) | (g['is_whiff'] == 1)).mean()),
        'xwobacon': float(con.mean()) if con.notna().any() else None,
        'xwoba': float(g['xwoba'].mean()) if g['xwoba'].notna().any() else None,
    }


def league_payload(d, valid_start=None):
    d = d[d['stuff_score'].notna()]    # 리그 기준값은 점수가 있는 투구만
    pct = np.arange(1, 100)
    pitcher_avg = d.groupby('pitcher')['stuff_score'].agg(['mean', 'size'])
    pitcher_avg = pitcher_avg[pitcher_avg['size'] >= MIN_PITCHER_PITCHES]['mean']

    pitch_types = {}
    for pt, g in d.groupby('pitch_type'):
        per_pitcher = g.groupby('pitcher')['stuff_score'].agg(['mean', 'size'])
        per_pitcher = per_pitcher[per_pitcher['size'] >= MIN_PITCHTYPE_PITCHES]['mean']
        pitch_types[pt] = {
            'name': PITCH_NAMES.get(pt, pt),
            'pitchQuantiles': np.round(np.percentile(g['stuff_score'], [5, 25, 50, 75, 95]), 2).tolist(),
            'pitcherPercentiles': (np.round(np.percentile(per_pitcher, pct), 2).tolist()
                                   if len(per_pitcher) >= 10 else None),
            'velo': round(float(g['release_speed'].mean()), 1),
            **{k: (round(v, 4) if v is not None else None) for k, v in outcome_rates(g).items()},
        }

    bins = pd.cut(d['stuff_score'], STUFF_BINS, labels=STUFF_BIN_LABELS, right=False)
    buckets = [{'label': lab, **outcome_rates(d[bins == lab])} for lab in STUFF_BIN_LABELS]

    return {
        'pitcherPercentiles': np.round(np.percentile(pitcher_avg, pct), 2).tolist(),
        'minPitcherPitches': MIN_PITCHER_PITCHES,
        'minPitchTypePitches': MIN_PITCHTYPE_PITCHES,
        'overall': outcome_rates(d),
        'pitchTypes': pitch_types,
        'stuffBins': STUFF_BINS[:-1],
        'buckets': buckets,
        # 학습 시즌은 학습기간이 in-sample 이므로 검증기간(out-of-sample) 기준값을 따로 둔다
        'bucketsValid': ([{'label': lab, **outcome_rates(d[(bins == lab) & (d['game_date'] >= valid_start)])}
                          for lab in STUFF_BIN_LABELS] if valid_start is not None else None),
    }


def dump(obj, path):
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(obj, f, ensure_ascii=False, separators=(',', ':'))


def dump_gz(obj, path):
    """투수별 파일은 gzip 으로 저장 (배포 용량 121MB -> 약 28MB, 브라우저에서 DecompressionStream 으로 해제)"""
    raw = json.dumps(obj, ensure_ascii=False, separators=(',', ':')).encode('utf-8')
    with open(path, 'wb') as f:
        f.write(gzip.compress(raw, compresslevel=9, mtime=0))


# ---------------------------------------------------------------------------
# 외부 데이터 : 선수 이름, MLB 공식 시즌 기록 (MLB Stats API)
# ---------------------------------------------------------------------------
def _get_json(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'stuff-lab-export'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def player_names(ids):
    """MLBAM id -> 'First Last'. web_cache/people.json 에 캐시, 없는 id 만 Stats API 로 일괄 조회"""
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, 'people.json')
    cache = {}
    if os.path.exists(path):
        with open(path, encoding='utf-8') as f:
            cache = {int(k): v for k, v in json.load(f).items()}
    missing = sorted({int(i) for i in ids} - set(cache))
    try:
        for k in range(0, len(missing), 300):
            chunk = missing[k:k + 300]
            data = _get_json(f"{STATSAPI}/people?personIds={','.join(map(str, chunk))}")
            for p in data.get('people', []):
                cache[int(p['id'])] = p.get('fullName', str(p['id']))
    except Exception as e:    # 네트워크 실패 : 이름 대신 id 표시
        print(f'  선수 이름 조회 실패 ({e}) -> id 로 표시')
    with open(path, 'w', encoding='utf-8') as f:
        json.dump(cache, f, ensure_ascii=False)
    return cache


STAT_FIELDS = {'G': 'gamesPlayed', 'GS': 'gamesStarted', 'W': 'wins', 'L': 'losses', 'SV': 'saves', 'HLD': 'holds',
               'BS': 'blownSaves', 'outs': 'outs', 'R': 'runs', 'ER': 'earnedRuns', 'H': 'hits', 'HR': 'homeRuns',
               'BB': 'baseOnBalls', 'IBB': 'intentionalWalks', 'HBP': 'hitBatsmen', 'K': 'strikeOuts', 'BF': 'battersFaced',
               'AB': 'atBats', 'NP': 'numberOfPitches'}
STAT_GAME_TYPES = {'R': ['R'], 'P': ['F', 'D', 'L', 'W'], 'S': ['S']}


def official_stats(season, start, end, ids):
    """MLB Stats API byDateRange : 데이터 기준일(end)까지 유형별 공식 투수 기록 (카운팅 스탯만 저장, 비율은 웹에서 계산)

    반환 {'asOf', 'fip': {유형: FIP 상수}, 'players': {id: {유형: {...}}}} 또는 None(네트워크 실패)"""
    ids = set(ids)
    players, fip = {}, {}
    try:
        for key, gtypes in STAT_GAME_TYPES.items():
            tot = {}
            for gt in gtypes:
                url = (f'{STATSAPI}/stats?stats=byDateRange&group=pitching&sportId=1&season={season}&gameType={gt}'
                       f'&startDate={start}&endDate={end}&playerPool=ALL&limit=5000')
                best = {}
                for sp_ in _get_json(url)['stats'][0]['splits']:
                    pid = int(sp_['player']['id'])
                    row = {k: int(sp_['stat'].get(v, 0) or 0) for k, v in STAT_FIELDS.items()}
                    if pid not in best or row['outs'] > best[pid]['outs']:    # 팀별 분할 + 합계가 섞이면 합계(최대) 사용
                        best[pid] = row
                for pid, row in best.items():
                    acc = tot.setdefault(pid, dict.fromkeys(STAT_FIELDS, 0))
                    for k in STAT_FIELDS:
                        acc[k] += row[k]
            if not tot:
                continue
            lg = {k: sum(r[k] for r in tot.values()) for k in STAT_FIELDS}
            ip = lg['outs'] / 3
            if ip > 0:
                fip[key] = round(9 * lg['ER'] / ip - (13 * lg['HR'] + 3 * (lg['BB'] + lg['HBP']) - 2 * lg['K']) / ip, 3)
            for pid, row in tot.items():
                if pid in ids:
                    players.setdefault(pid, {})[key] = row
            print(f'  공식 기록 {key} : {len(tot):,}명 (FIP 상수 {fip.get(key)})')
    except Exception as e:
        print(f'  공식 기록 조회 실패 ({e}) -> stats.json 생략')
        return None
    return {'asOf': end, 'fip': fip, 'players': players}


def summary_payload(d, pitchers, games, pas):
    """메인 페이지용 시즌 요약 : 유형별 리그 지표·구간별 결과, 구위 리더, 승부처 경기/타석, 구위 하이라이트 경기"""
    d = d[d['stuff_score'].notna()]
    bins = pd.cut(d['stuff_score'], STUFF_BINS, labels=STUFF_BIN_LABELS, right=False)
    by_gt = {}
    for gt in range(len(GAME_TYPE_LABELS)):
        m = d['gt'] == gt
        if not m.any():
            continue
        x = d[m]
        pm = x.groupby('pitcher')['stuff_score'].agg(['mean', 'size'])
        leaders = pm[pm['size'] >= SUMMARY_MIN_PITCHES[gt]].sort_values('mean', ascending=False).head(10)
        info = {p['id']: p for p in pitchers}
        g_ = games[games['gt'] == gt]
        p_ = pas[pas['gt'] == gt]
        by_gt[gt] = {
            'pitches': int(m.sum()),
            'pitchers': int(x['pitcher'].nunique()),
            'games': int(x['game_pk'].nunique()),
            'stuff': round(float(x['stuff_score'].mean()), 2),
            'rates': {k: (round(v, 4) if v is not None else None) for k, v in outcome_rates(x).items()},
            'buckets': [{'label': lab, **{k: (round(v, 4) if v is not None else None)
                                          for k, v in outcome_rates(x[bins[m] == lab]).items()}} for lab in STUFF_BIN_LABELS],
            'minPitches': SUMMARY_MIN_PITCHES[gt],
            'leaders': [{'id': int(pid), 'name': info[pid]['name'], 'teams': info[pid]['teams'], 'n': int(r['size']),
                         'stuff': round(float(r['mean']), 2)} for pid, r in leaders.iterrows()],
            'impGames': games_json(g_.sort_values('imp', ascending=False).head(10)),
            'stuffGames': games_json(g_[g_['n'] >= HIGHLIGHT_MIN_LEAGUE_GAME_PITCHES].sort_values('s', ascending=False).head(10)),
            'impPas': records_json(p_.reindex(p_['wpa'].abs().sort_values(ascending=False).index).head(10), PA_ND),
        }
    return by_gt


def export_season(season, path, model, scaler):
    print(f'[{season}] {path}')
    raw = sp.load_season(path, year=season)
    d, S0, method = score_season(raw, model, scaler, season)
    print(f'  전체 {len(raw):,}구 -> {len(d):,}구 (점수 없음 {d["stuff_score"].isna().sum():,}), '
          f'투수 {d["pitcher"].nunique():,}명, 유형별 ' +
          ', '.join(f'{k} {v:,}' for k, v in d['game_type'].value_counts().items()))
    if season == 2025:
        check_against_parquet(d)
    d = add_web_columns(raw, d)
    reg = d[d['gt'] == 0]    # 리그 기준값·검증기간은 정규시즌 기준

    out = os.path.join(OUT_DIR, str(season))
    # 폴더 자체는 지우지 않고 내용만 비운다 (OneDrive 가 폴더를 잡고 있으면 rmdir 이 거부됨)
    os.makedirs(os.path.join(out, 'p'), exist_ok=True)
    os.makedirs(os.path.join(out, 'e'), exist_ok=True)
    for root, _, files in os.walk(out):
        for f in files:
            os.remove(os.path.join(root, f))

    names = player_names(d['batter'].dropna().unique())
    season_start = d['game_date'].min().strftime('%Y-%m-%d')
    valid_start = sp.split_last_month(raw[raw['game_type'] == 'R'])[2] if season == 2025 else None
    pitchers, all_games, all_pas = [], [], []
    for pid, g in d.groupby('pitcher'):
        team_counts = g['team'].value_counts()
        teams = team_counts.index.tolist()    # 투구수 많은 팀 순
        pitch_types = g['pitch_type'].value_counts().index.tolist()
        name = display_name(g['player_name'].iloc[0])
        payload, games, pas = pitcher_payload(g, season_start, pitch_types, teams, names)
        dump_gz(payload, os.path.join(out, 'p', f'{int(pid)}.json.gz'))
        dump_gz(explain_payload(g), os.path.join(out, 'e', f'{int(pid)}.json.gz'))
        by_gt = []
        for gt in range(len(GAME_TYPE_LABELS)):
            s_ = g.loc[g['gt'] == gt, 'stuff_score']
            by_gt.append([int(len(s_)), round(float(s_.mean()), 2) if s_.notna().any() else None] if len(s_) else None)
        pitchers.append({
            'id': int(pid),
            'name': name,
            'throws': g['p_throws'].iloc[0],
            'teams': teams,
            'n': by_gt[0][0] if by_gt[0] else 0,          # 정규시즌 투구 수 / 평균 구위 (기존 의미 유지)
            'stuff': by_gt[0][1] if by_gt[0] else None,
            'byGt': by_gt,                                 # [정규, 포스트, 시범] 별 [투구 수, 평균 구위] 또는 null
        })
        games = games.assign(pid=int(pid), name=name, gi=np.arange(len(games)))
        pas = pas.assign(pid=int(pid), name=name, pai=np.arange(len(pas)), gt=pas['g'].map(games['gt']),
                         date=pas['g'].map(games['date']), opp=pas['g'].map(games['opp']), team=pas['g'].map(games['team']),
                         batName=pas['bat'].map(lambda b: names.get(int(b), str(b))))
        all_games.append(games)
        all_pas.append(pas.drop(columns=['event']))
    all_games = pd.concat(all_games, ignore_index=True)
    all_pas = pd.concat(all_pas, ignore_index=True)

    gt_counts = d['gt'].value_counts()
    dump({
        'season': season,
        'outOfSample': season != 2025,
        'validStart': valid_start.strftime('%Y-%m-%d') if valid_start is not None else None,
        'seasonStart': season_start,
        'seasonEnd': d['game_date'].max().strftime('%Y-%m-%d'),
        'regularStart': reg['game_date'].min().strftime('%Y-%m-%d'),
        'regularEnd': reg['game_date'].max().strftime('%Y-%m-%d'),
        'pitches': int(len(reg)),
        'gameTypes': [int(gt_counts.get(gt, 0)) for gt in range(len(GAME_TYPE_LABELS))],
        'teams': {lg: {t: n for t, n in ts.items() if t in set(d['team'])} for lg, ts in TEAMS.items()},
        'pitchers': sorted(pitchers, key=lambda p: p['name']),
    }, os.path.join(out, 'index.json'))
    lg = league_payload(reg, valid_start)
    lg['explain'] = explain_league(reg, S0)
    lg['explain']['method'] = method
    dump(lg, os.path.join(out, 'league.json'))
    dump({'byGt': summary_payload(d, pitchers, all_games, all_pas)}, os.path.join(out, 'summary.json'))
    stats = official_stats(season, f'{season}-02-01', d['game_date'].max().strftime('%Y-%m-%d'), [p['id'] for p in pitchers])
    if stats is not None:
        dump(stats, os.path.join(out, 'stats.json'))
    ex = lg['explain']
    print(f"  설명 ({method}) : 기준 S0 {ex['base']:.2f}, 리그 평균 기여 " +
          ', '.join(f'{n} {v:+.2f}' for n, v in zip(ex['groups'], ex['overall'])))
    for pt in ['FF', 'SI', 'CH', 'FS', 'SL', 'CU', 'EP']:
        if pt in ex['pitchTypes']:
            print(f'    {pt} : ' + ', '.join(f'{n} {v:+.1f}' for n, v in zip(ex['groups'], ex['pitchTypes'][pt]['contrib'])))
    size = {k: sum(os.path.getsize(os.path.join(out, k, f)) for f in os.listdir(os.path.join(out, k))) for k in ('p', 'e')}
    print(f"  투수 파일 {size['p'] / 1e6:.1f}MB, 설명 파일 {size['e'] / 1e6:.1f}MB")
    print(f'  저장 : {out} (투수 {len(pitchers):,}명, 경기 {len(all_games):,}, 타석 {len(all_pas):,})')


def main():
    global OUT_DIR
    ap = argparse.ArgumentParser()
    ap.add_argument('--seasons', type=int, nargs='*', help='내보낼 시즌 (기본 : 전체)')
    ap.add_argument('--out', default=OUT_DIR, help='출력 폴더 (기본 : web/public/data)')
    args = ap.parse_args()
    OUT_DIR = args.out
    np.random.seed(sp.SEED)
    print(f'모델 {MODEL_VERSION} : {CFG["dir"]}')
    model = joblib.load(os.path.join(CFG['dir'], 'stage3_stuff_lgbm.joblib'))
    scaler = joblib.load(os.path.join(CFG['dir'], 'stage4_stuff_scaler.joblib'))
    os.makedirs(OUT_DIR, exist_ok=True)
    for season in args.seasons or SEASONS:
        export_season(season, SEASONS[season], model, scaler)
    write_meta()


def write_meta():
    """web/public/data/meta.json (전체 시즌 목록, 표시 상수)"""
    dump({'seasons': sorted(SEASONS, reverse=True), 'resultLabels': RESULTS, 'paEvents': PA_EVENTS,
          'pitchNames': PITCH_NAMES, 'trainSeason': 2025, 'gameTypes': GAME_TYPE_LABELS, 'rounds': ROUND_LABELS,
          'importanceWeight': IMPORTANCE_WEIGHT,
          'modelVersion': MODEL_VERSION},
         os.path.join(OUT_DIR, 'meta.json'))


if __name__ == '__main__':
    main()
