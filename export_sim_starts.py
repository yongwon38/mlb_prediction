"""
구위 시뮬레이터 시작점 : 시즌별 web/public/data/{season}/sim_starts.json

실행 : python export_sim_starts.py [--seasons 2026 ...]
  export_web_data.py 가 시즌 폴더를 비우므로 반드시 그 다음에 실행 (daily·deploy 워크플로가 export 다음, push-web 전에 실행 -> HF 웹 스냅샷에 포함).
  ops.WEB_CODE 에 포함 -> 이 코드가 바뀌면 web_id 가 바뀌어 전 시즌 스냅샷이 다시 만들어진다.

대상 투구 : 정규시즌, 사이트에서 점수를 매기는 투구 (waste 볼·사구·트래킹 없음 제외), 모델 입력 공간 (좌투는 우투 기준 반전, 무브먼트 inch)
내용
- cols : 값 순서 = 모델 수치 입력 13개 (vaa_aa = HAVAA 포함) + 원값 vaa, plate_z
- league[구종] : n, med(중앙값), lo(1% 분위), hi(99% 분위) — 리그 시작점과 슬라이더·반응 곡선 범위
- pitchers[투수] : 이름, 투구손, 주 패스트볼 (구속, 수평, 수직 무브먼트), 구종별(정규시즌 MIN_N 구 이상) n·입력 평균 x
"""
import argparse, json, os

import numpy as np

import export_web_data as ew
import stuff_model as sm
import stuff_pipeline as sp

MODEL = 'hof_r'
MIN_N = 100           # 투수×구종 시작점 최소 투구 (홈 구종별 Top 5 와 같은 정규시즌 기준)
MIN_LEAGUE_N = 50     # 리그 구종 시작점 최소 투구
ND = 3


def r(x):
    return None if x is None or not np.isfinite(x) else round(float(x), ND)


def season_starts(season, path, model):
    raw = sp.load_season(path, year=season)
    d = ew.stuff_frame(raw[raw['game_type'] == 'R'], model)
    d = d[~sp.is_unscored(d)]
    X = model.angle.model_frame(d[model.input_features])
    num = model.prep.num_cols
    cols = num + ['vaa', 'plate_z']
    V = X[num].astype('float64').assign(vaa=d['vaa'].astype('float64').to_numpy(), plate_z=d['plate_z'].astype('float64').to_numpy())
    V['pitch_type'] = d['pitch_type'].astype(str).to_numpy()
    V['pitcher'] = d['pitcher'].to_numpy()

    league = {}
    for pt, g in V.groupby('pitch_type'):
        if len(g) < MIN_LEAGUE_N:
            continue
        q = g[cols].quantile([0.01, 0.5, 0.99])
        league[pt] = {'n': int(len(g)), 'med': [r(q.loc[0.5, c]) for c in cols], 'lo': [r(q.loc[0.01, c]) for c in cols],
                      'hi': [r(q.loc[0.99, c]) for c in cols]}

    fb = d.groupby('pitcher')[['fb_velo', 'fb_hb', 'fb_ivb']].first()
    info = d.groupby('pitcher').agg(name=('player_name', 'first'), hand=('p_throws', 'first'))
    means = V.groupby(['pitcher', 'pitch_type'])[cols].mean()
    counts = V.groupby(['pitcher', 'pitch_type']).size()
    pitchers = {}
    for (pid, pt), n in counts[counts >= MIN_N].sort_values(ascending=False).items():
        p = pitchers.setdefault(str(int(pid)), {'name': ew.display_name(info.loc[pid, 'name']), 'hand': str(info.loc[pid, 'hand']),
                                                'fb': [r(fb.loc[pid, c]) for c in fb.columns], 'types': {}})
        p['types'][pt] = {'n': int(n), 'x': [r(v) for v in means.loc[(pid, pt)]]}
    return {'season': season, 'asOf': d['game_date'].max().strftime('%Y-%m-%d'), 'model': MODEL, 'cols': cols,
            'minN': MIN_N, 'league': league, 'pitchers': pitchers}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seasons', type=int, nargs='*', help='시즌 (기본 : 전체)')
    ap.add_argument('--out', default=ew.OUT_DIR)
    args = ap.parse_args()
    model = sm.load_model(ew.MODELS[MODEL]['dir'])
    for season in args.seasons or ew.SEASONS:
        out = season_starts(season, ew.SEASONS[season], model)
        path = os.path.join(args.out, str(season), 'sim_starts.json')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
        n_types = sum(len(p['types']) for p in out['pitchers'].values())
        print(f'[{season}] {path} : 기준일 {out["asOf"]}, 리그 구종 {len(out["league"])}, 투수 {len(out["pitchers"]):,}명 · 투수×구종 {n_types:,}, '
              f'{os.path.getsize(path) / 1e3:.0f}KB')


if __name__ == '__main__':
    main()
