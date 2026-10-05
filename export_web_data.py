"""
웹 페이지(web/)용 데이터 export

시즌별 정규시즌 투구에 3·4단계 모델(구위 모델 + 20~80 스케일러)을 적용해 투구별 구위 score 를 만들고,
투수별 JSON(컬럼형 배열) / 투수 목록 / 리그 기준값을 web/public/data/{season}/ 에 저장한다.

- 2025 : 모델 학습 시즌 (선택한 모델 버전의 stuff_scores_2025.parquet 과 동일한 값인지 검증)
- 2024, 2026 : 2025 학습 모델을 그대로 적용한 out-of-sample score
- MODEL_VERSION 으로 사용할 모델 선택 (v1 : models/, outputs/ / v2 : models/v2/, outputs/v2/)
- v2 : 볼 판정 + Savant Waste 존 투구(sp.is_waste_ball)는 score 없음(null). 행은 유지해 분포도에는 표시

실행 : python export_web_data.py
"""
import gzip
import json
import os

import joblib
import numpy as np
import pandas as pd

import stuff_pipeline as sp

MODEL_VERSION = 'v2'
MODELS = {
    'v1': {'dir': 'models', 'outputs': 'outputs', 'features': sp.STUFF_FEATURES, 'drop_waste': False},
    'v2': {'dir': os.path.join('models', 'v2'), 'outputs': os.path.join('outputs', 'v2'),
           'features': sp.STUFF_FEATURES_V2, 'drop_waste': True},
}
CFG = MODELS[MODEL_VERSION]

SEASONS = {2026: 'games_26.pkl', 2025: 'games_25_final.pkl', 2024: 'games_24.pkl'}
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


# ---------------------------------------------------------------------------
# 구위 score 산출
# ---------------------------------------------------------------------------
def score_season(df, model, scaler):
    """정규시즌 투구 -> 구위 피처 -> 3단계 예측 -> 20~80 score (구종 제외 대상은 행 제외)"""
    d = sp.add_stuff_features(df)
    for col, cats in zip(sp.STUFF_CAT_FEATURES, model.booster_.pandas_categorical):
        d[col] = pd.Categorical(d[col].astype(str), categories=cats)
    d = d[d['pitch_type'].notna()]    # 학습 시 없던 구종 제외
    pred = model.predict(d[CFG['features']])
    d['stuff_score'] = scaler.transform(pred)
    if CFG['drop_waste']:
        d['stuff_score'] = d['stuff_score'].where(~sp.is_waste_ball(d))    # 터무니없는 위치의 볼 : 점수 없음
    for col in sp.STUFF_CAT_FEATURES:
        d[col] = d[col].astype(str)
    return d


def check_against_parquet(d):
    """2025 score 가 파이프라인 노트북 산출물과 동일한지 확인"""
    path = os.path.join(CFG['outputs'], 'stuff_scores_2025.parquet')
    if not os.path.exists(path):
        print('  (parquet 없음 - 검증 생략)')
        return
    key = ['game_pk', 'at_bat_number', 'pitch_number', 'pitcher']
    ref = pd.read_parquet(path)[key + ['stuff_score']]
    cur = d[key + ['stuff_score']].astype({k: 'int64' for k in key})
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


def pitcher_payload(g, season_start, pitch_types, teams):
    g = g.sort_values(['game_date', 'game_pk', 'at_bat_number', 'pitch_number'])
    pt_idx = {p: i for i, p in enumerate(pitch_types)}
    tm_idx = {t: i for i, t in enumerate(teams)}
    first = g.iloc[0]
    return {
        'id': int(first['pitcher']),
        'name': display_name(first['player_name']),
        'throws': first['p_throws'],
        'teams': teams,
        'pitchTypes': pitch_types,
        'd0': season_start,
        'cols': {
            'day': _arr((g['game_date'] - pd.Timestamp(season_start)).dt.days, 0),
            'game': _arr(g['game_pk'].astype('int64').rank(method='dense') - 1, 0),
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


def export_season(season, path, model, scaler):
    print(f'[{season}] {path}')
    raw = sp.load_regular_season(path, year=season)
    d = score_season(raw, model, scaler)
    print(f'  정규시즌 {len(raw):,}구 -> {len(d):,}구 (점수 없음 {d["stuff_score"].isna().sum():,}), '
          f'투수 {d["pitcher"].nunique():,}명')
    if season == 2025:
        check_against_parquet(d)
    d = add_web_columns(raw, d)

    out = os.path.join(OUT_DIR, str(season))
    # 폴더 자체는 지우지 않고 내용만 비운다 (OneDrive 가 폴더를 잡고 있으면 rmdir 이 거부됨)
    os.makedirs(os.path.join(out, 'p'), exist_ok=True)
    for root, _, files in os.walk(out):
        for f in files:
            os.remove(os.path.join(root, f))

    season_start = d['game_date'].min().strftime('%Y-%m-%d')
    valid_start = sp.split_last_month(raw)[2] if season == 2025 else None
    pitchers = []
    for pid, g in d.groupby('pitcher'):
        team_counts = g['team'].value_counts()
        teams = team_counts.index.tolist()    # 투구수 많은 팀 순
        pitch_types = g['pitch_type'].value_counts().index.tolist()
        dump_gz(pitcher_payload(g, season_start, pitch_types, teams), os.path.join(out, 'p', f'{int(pid)}.json.gz'))
        pitchers.append({
            'id': int(pid),
            'name': display_name(g['player_name'].iloc[0]),
            'throws': g['p_throws'].iloc[0],
            'teams': teams,
            'n': int(len(g)),
            'stuff': round(float(g['stuff_score'].mean()), 2) if g['stuff_score'].notna().any() else None,
        })

    dump({
        'season': season,
        'outOfSample': season != 2025,
        'validStart': valid_start.strftime('%Y-%m-%d') if valid_start is not None else None,
        'seasonStart': season_start,
        'seasonEnd': d['game_date'].max().strftime('%Y-%m-%d'),
        'pitches': int(len(d)),
        'teams': {lg: {t: n for t, n in ts.items() if t in set(d['team'])} for lg, ts in TEAMS.items()},
        'pitchers': sorted(pitchers, key=lambda p: p['name']),
    }, os.path.join(out, 'index.json'))
    dump(league_payload(d, valid_start), os.path.join(out, 'league.json'))
    print(f'  저장 : {out} (투수 {len(pitchers):,}명)')


def main():
    np.random.seed(sp.SEED)
    print(f'모델 {MODEL_VERSION} : {CFG["dir"]}')
    model = joblib.load(os.path.join(CFG['dir'], 'stage3_stuff_lgbm.joblib'))
    scaler = joblib.load(os.path.join(CFG['dir'], 'stage4_stuff_scaler.joblib'))
    os.makedirs(OUT_DIR, exist_ok=True)
    for season, path in SEASONS.items():
        export_season(season, path, model, scaler)
    dump({'seasons': sorted(SEASONS, reverse=True), 'resultLabels': RESULTS, 'paEvents': PA_EVENTS,
          'pitchNames': PITCH_NAMES, 'trainSeason': 2025,
          'modelVersion': MODEL_VERSION},
         os.path.join(OUT_DIR, 'meta.json'))


if __name__ == '__main__':
    main()
