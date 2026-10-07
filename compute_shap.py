"""
정확한 SHAP(TreeSHAP) 기여도 계산 — 웹 '구위 산출 근거' 용 캐시

export_web_data.py 는 이 캐시(outputs/v2/shap/shap_{season}.npz)가 있으면 정확한 SHAP 을,
없으면 Saabas(경로 기반) 기여를 쓴다. 투구 213만 개 기준 약 9시간(16스레드)이 걸리므로
청크 단위로 저장하고, 중단되면 이어서 계산한다.

실행 : python compute_shap.py            (전체 시즌 : 정규시즌 + 시범·포스트시즌)
       python compute_shap.py 2026       (특정 시즌)
       python compute_shap.py --extra    (시범·포스트시즌만 -> shap_{season}_extra.npz)
       python compute_shap.py 2026 --incremental [--max-rows N]      (클라우드 daily : 새 투구·피처가 바뀐 투구만 계산)
       python compute_shap.py 2026 --incremental --shard 3 --n-shards 8   (클라우드 병렬 : 남은 투구의 3번째 1/8 -> 조각 파일)
       python compute_shap.py 2026 --incremental                      (조각 파일이 있으면 합쳐서 shap_2026.npz)
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


def feature_hash(X):
    """투구별 피처 값 해시 (피처가 같으면 SHAP 도 같다)"""
    return pd.util.hash_pandas_object(X, index=False).to_numpy()


def shard_path(tag, k, n):
    return os.path.join(ew.SHAP_DIR, f'shard_{tag}_{k:02d}of{n:02d}.npz')


def update(season, path, model, extra=False, shard=None, n_shards=1, max_rows=None):
    """증분 계산 : 캐시(shap_{tag}.npz + 있으면 조각 파일들)에서 키·피처 해시가 같은 투구는 재사용, 나머지만 계산

    진행 중인 시즌은 새 투구가 들어오면 그 투수의 주 패스트볼 평균이 바뀌어 시즌 전체 피처가 바뀐다 (하루 약 12~14만 구)
    - shard=k : 계산할 투구의 k 번째 1/n 만 계산해 조각 파일로 저장 (클라우드 병렬)
    - shard 없음 : 조각까지 합쳐 남은 투구를 계산하고 shap_{tag}.npz 저장 (조각 합치기 겸용)
    - max_rows : 계산할 투구가 이보다 많으면 저장하지 않고 건너뜀 (export 는 Saabas 사용)"""
    tag = f'{season}_extra' if extra else f'{season}'
    out = os.path.join(ew.SHAP_DIR, f'shap_{tag}.npz')
    X, keys = (extra_frame if extra else season_frame)(season, path, model)
    if not len(X):
        return 0
    fh = feature_hash(X)
    contrib = np.full((len(X), X.shape[1]), np.nan)
    todo = np.ones(len(X), bool)
    base = None
    # 조각 계산은 본 캐시만 기준으로 (모든 조각이 같은 계산 대상 목록을 나눠 갖도록)
    shards = [] if shard is not None else sorted(f for f in os.listdir(ew.SHAP_DIR) if f.startswith(f'shard_{tag}_'))
    for f in ([out] if os.path.exists(out) else []) + [os.path.join(ew.SHAP_DIR, f) for f in shards]:
        with np.load(f) as z:
            if 'fh' not in z or not len(z['keys']):
                continue
            old = pd.DataFrame(z['keys'], columns=ew.KEY).assign(fh=z['fh'], row=np.arange(len(z['keys'])))
            m = pd.DataFrame(keys, columns=ew.KEY).assign(fh=fh).merge(old, on=ew.KEY + ['fh'], how='left')
            hit = m['row'].notna().to_numpy() & todo
            contrib[hit] = z['contrib'][m.loc[hit, 'row'].astype(int).to_numpy()]
            todo &= ~hit
            base = float(z['base'])
    idx = np.flatnonzero(todo)
    if shard is not None:
        idx = idx[shard::n_shards]
    print(f'[{tag}] {len(X):,}구 중 재계산 {len(idx):,}구' + (f' (조각 {shard + 1}/{n_shards})' if shard is not None else ''))
    if max_rows is not None and len(idx) > max_rows:
        print(f'  {max_rows:,}구 초과 -> 건너뜀 (shap 워크플로에서 병렬 계산)')
        return None
    t0 = time.time()
    for a in range(0, len(idx), CHUNK):
        rows = idx[a:a + CHUNK]
        c = model.booster_.predict(X.iloc[rows], pred_contrib=True, num_threads=os.cpu_count())
        contrib[rows] = c[:, :-1]
        base = float(c[0, -1])
        print(f'  {a + len(rows):,}/{len(idx):,} ({(time.time() - t0) / 60:.1f}분 경과)', flush=True)
    if shard is not None:
        np.savez(shard_path(tag, shard, n_shards), contrib=contrib[idx], base=base if base is not None else np.nan,
                 keys=keys[idx], fh=fh[idx])
        return len(idx)
    np.savez(out, contrib=contrib, base=base, keys=keys, fh=fh)
    for f in shards:
        os.remove(os.path.join(ew.SHAP_DIR, f))
    print(f'[{tag}] 저장 : {out}')
    return len(idx)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('seasons', type=int, nargs='*')
    ap.add_argument('--extra', action='store_true', help='시범·포스트시즌만')
    ap.add_argument('--incremental', action='store_true', help='캐시 재사용, 새 투구·피처가 바뀐 투구만 계산 (클라우드)')
    ap.add_argument('--shard', type=int, help='(증분) 조각 번호 0 ~ n-1')
    ap.add_argument('--n-shards', type=int, default=1)
    ap.add_argument('--max-rows', type=int, help='(증분) 계산할 투구가 이보다 많으면 건너뜀')
    args = ap.parse_args()
    model = joblib.load(os.path.join(ew.CFG['dir'], 'stage3_stuff_lgbm.joblib'))
    os.makedirs(ew.SHAP_DIR, exist_ok=True)
    kw = dict(shard=args.shard, n_shards=args.n_shards, max_rows=args.max_rows)
    for season in args.seasons or list(ew.SEASONS):
        if args.incremental:
            update(season, ew.SEASONS[season], model, extra=True, **kw)
            if not args.extra:
                update(season, ew.SEASONS[season], model, **kw)
        else:
            compute(season, ew.SEASONS[season], model, extra=True)    # 시범·포스트시즌 (짧음) 먼저
            if not args.extra:
                compute(season, ew.SEASONS[season], model)


if __name__ == '__main__':
    main()
