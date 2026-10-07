"""
정확한 SHAP(TreeSHAP) 기여도 계산 — 웹 '구위 산출 근거' 용 캐시

export_web_data.py 는 이 캐시(outputs/v2/shap/shap_{season}.npz)가 있으면 정확한 SHAP 을,
없으면 Saabas(경로 기반) 기여를 쓴다. 투구 213만 개 기준 약 9시간(16스레드)이 걸리므로
청크 단위로 저장하고, 중단되면 이어서 계산한다.

실행 : python compute_shap.py            (전체 시즌 : 정규시즌 + 시범·포스트시즌)
       python compute_shap.py 2026       (특정 시즌)
       python compute_shap.py --extra    (시범·포스트시즌만 -> shap_{season}_extra.npz)
       python compute_shap.py 2025 --shard 3 --n-shards 6    (클라우드 병렬 : 정규시즌 투구의 3번째 1/6 조각 -> parts 파일)
       python compute_shap.py 2025 --merge --n-shards 6      (조각 합치기 -> shap_2025.npz, 시범·포스트시즌은 shard 0 이 계산)
끝나면 : python export_web_data.py -> web/ 에서 재배포
"""
import argparse
import os
import time

import joblib
import numpy as np
import pandas as pd

import stuff_pipeline as sp
import export_web_data as ew

CHUNK = 20000


def season_frame(season, path, model):
    """export_web_data.score_season 과 같은 행·같은 피처 (구종 범주 정렬 포함)"""
    raw = sp.load_regular_season(path, year=season)
    d = sp.add_stuff_features(raw)
    for col, cats in zip(sp.STUFF_CAT_FEATURES, model.booster_.pandas_categorical):
        d[col] = pd.Categorical(d[col].astype(str), categories=cats)
    d = d[d['pitch_type'].notna()]
    return d[ew.CFG['features']], d[ew.KEY].astype('int64').to_numpy()


def extra_frame(season, path, model):
    """시범·포스트시즌 행 : export_web_data.stuff_frame 과 같은 피처 (정규시즌 청크 순서와 분리)"""
    raw = sp.load_season(path, year=season)
    d = ew.stuff_frame(raw, model)
    d = d[d['game_type'] != 'R']
    return d[ew.CFG['features']], d[ew.KEY].astype('int64').to_numpy()


def compute(season, path, model, extra=False):
    tag = f'{season}_extra' if extra else f'{season}'
    out = os.path.join(ew.SHAP_DIR, f'shap_{tag}.npz')
    if os.path.exists(out):
        print(f'[{tag}] 이미 있음 : {out}')
        return
    part_dir = os.path.join(ew.SHAP_DIR, f'parts_{tag}')
    os.makedirs(part_dir, exist_ok=True)
    X, keys = (extra_frame if extra else season_frame)(season, path, model)
    n_chunks = (len(X) + CHUNK - 1) // CHUNK
    print(f'[{tag}] {len(X):,}구, {n_chunks} 청크')
    t0 = time.time()
    for k in range(n_chunks):
        part = os.path.join(part_dir, f'{k:04d}.npy')
        if os.path.exists(part):
            continue
        c = model.booster_.predict(X.iloc[k * CHUNK:(k + 1) * CHUNK], pred_contrib=True, num_threads=os.cpu_count())
        np.save(part, c.astype(np.float64))
        done = k + 1
        el = time.time() - t0
        print(f'  {done}/{n_chunks} ({el / 60:.1f}분 경과)', flush=True)
    c = np.concatenate([np.load(os.path.join(part_dir, f'{k:04d}.npy')) for k in range(n_chunks)])
    base = float(c[0, -1])
    np.savez(out, contrib=c[:, :-1], base=base, keys=keys)
    print(f'[{tag}] 저장 : {out}')
    for f in os.listdir(part_dir):
        os.remove(os.path.join(part_dir, f))
    os.rmdir(part_dir)


def shard_path(season, k, n):
    return os.path.join(ew.SHAP_DIR, f'shard_{season}_{k:02d}of{n:02d}.npz')


def compute_shard(season, path, model, k, n):
    """정규시즌 투구를 n 조각으로 나눠 k 번째만 계산 (GitHub Actions 작업당 6시간 제한 대응)"""
    X, keys = season_frame(season, path, model)
    lo, hi = len(X) * k // n, len(X) * (k + 1) // n
    print(f'[{season}] 조각 {k + 1}/{n} : {hi - lo:,}구 / 전체 {len(X):,}구')
    t0 = time.time()
    parts = []
    for a in range(lo, hi, CHUNK):
        b = min(a + CHUNK, hi)
        parts.append(model.booster_.predict(X.iloc[a:b], pred_contrib=True, num_threads=os.cpu_count()))
        print(f'  {b - lo:,}/{hi - lo:,} ({(time.time() - t0) / 60:.1f}분 경과)', flush=True)
    c = np.concatenate(parts) if parts else np.zeros((0, X.shape[1] + 1))
    np.savez(shard_path(season, k, n), contrib=c[:, :-1], base=float(c[0, -1]) if len(c) else np.nan, keys=keys[lo:hi])


def merge_shards(season, n):
    zs = [np.load(shard_path(season, k, n)) for k in range(n)]
    base = next(float(z['base']) for z in zs if len(z['keys']))
    out = os.path.join(ew.SHAP_DIR, f'shap_{season}.npz')
    np.savez(out, contrib=np.concatenate([z['contrib'] for z in zs]), base=base,
             keys=np.concatenate([z['keys'] for z in zs]))
    print(f'[{season}] 저장 : {out}')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('seasons', type=int, nargs='*')
    ap.add_argument('--extra', action='store_true', help='시범·포스트시즌만')
    ap.add_argument('--shard', type=int, help='조각 번호 (0부터)')
    ap.add_argument('--n-shards', type=int, default=1)
    ap.add_argument('--merge', action='store_true', help='조각 합치기')
    args = ap.parse_args()
    model = joblib.load(os.path.join(ew.CFG['dir'], 'stage3_stuff_lgbm.joblib'))
    os.makedirs(ew.SHAP_DIR, exist_ok=True)
    for season in args.seasons or list(ew.SEASONS):
        if args.merge:
            merge_shards(season, args.n_shards)
        elif args.shard is not None:
            if args.shard == 0:
                compute(season, ew.SEASONS[season], model, extra=True)
            compute_shard(season, ew.SEASONS[season], model, args.shard, args.n_shards)
        else:
            compute(season, ew.SEASONS[season], model, extra=True)    # 시범·포스트시즌 (짧음) 먼저
            if not args.extra:
                compute(season, ew.SEASONS[season], model)


if __name__ == '__main__':
    main()
