"""
유사 투구 검색 인덱스 : 시즌별 web/public/data/{season}/similar.json

실행 : python export_similar.py [--seasons 2026 ...] [--check-out 경로]
  export_web_data.py 가 시즌 폴더를 비우므로 그 다음에 실행 (daily·deploy·shap 워크플로 : export_sim_starts.py 다음, push-web 전).
  ops.WEB_CODE 에 포함 -> 코드가 바뀌면 web_id 가 바뀌어 전 시즌 스냅샷 재생성.

검색 단위 : 투수×구종 (정규시즌, 사이트가 점수를 매기는 투구 MIN_N 구 이상)
벡터 두 종류 (검색은 브라우저 web/lib/similar.ts : 차원별 표준화 → 코사인 → 같은 투수 제외 → 상위 k)
- model : HOF-Net-R(시드 42) ZIB 헤드 두 번째 은닉층 64차원의 투구별 값 평균 (float16)
- input : 모델 입력 수치 13개(좌투 반전, HAVAA 포함) 평균 + 투구손(우 +1, 좌 −1) (float32)
메타 : 투수 id·이름·투구손·구종·투구 수·헛스윙률·평균 구위(HOF)
--check-out : 브라우저 검색 패리티용 기대값 (질의 50개의 이웃 10개, 두 공간) — 커밋하지 않는 로컬 파일
"""
import argparse, base64, hashlib, json, os

import joblib
import numpy as np
import pandas as pd
import torch

import export_web_data as ew
import hof_net_r as hr
import stuff_model as sm
import stuff_pipeline as sp

MODEL = 'hof_r'
MIN_N = 100
K = 10


@torch.no_grad()
def pitch_vectors(model, X, chunk=16384):
    """투구별 (ZIB 은닉 64, 예측 E[Y]) — HOFNetRStuffModel._f 와 같은 순전파 (ω 사후평균).
    chunk : CUDA 어텐션 커널은 배치가 크면 실행 설정 오류 (HOFNetRStuffModel._f 와 같은 16384)"""
    assert len(model.members) == 1, '단일 시드 모델만 지원'
    net, head = model.members[0]
    dev = model._dev()
    xn, miss, xc = model.prep(model.angle.model_frame(X))
    hid, pred = [], []
    for i in range(0, len(xn), chunk):
        a, b, c = hr.to_dev(dev, xn[i:i + chunk], miss[i:i + chunk], xc[i:i + chunk])
        h = net.encode(a, b, c)
        z = net.basis(h)
        m = head.mlp
        h2 = m[3](m[2](m[1](m[0](h))))                 # Linear → GELU → Linear → GELU
        lz, am, ak = m[4](h2).unbind(-1)
        zb = torch.cat([z, torch.ones(len(z), 1, device=z.device)], 1)
        pi, al, be = hr.zib_params(lz, am + zb @ head.m, ak)
        hid.append(h2.float().cpu())
        pred.append(((1 - pi.double()) * (al.double() / (al.double() + be.double()))).cpu())
    return torch.cat(hid).numpy(), torch.cat(pred).numpy()


def season_groups(season, model, scaler, path=None):
    """시즌 → (메타 DataFrame, model 벡터 (g,64), input 벡터 (g,14), 기준일). 투수×구종 MIN_N 구 이상"""
    raw = sp.load_season(path or ew.SEASONS[season], year=season)
    d = ew.stuff_frame(raw[raw['game_type'] == 'R'], model)
    d = d[~sp.is_unscored(d)].reset_index(drop=True)
    d['pt'] = d['pitch_type'].astype(str)
    n = d.groupby(['pitcher', 'pt']).size()
    keep = n[n >= MIN_N]
    d = d.set_index(['pitcher', 'pt']).loc[keep.index].reset_index()
    hid, pred = pitch_vectors(model, d[model.input_features])
    num = model.prep.num_cols
    Xm = model.angle.model_frame(d[model.input_features])
    inp = np.column_stack([Xm[num].to_numpy('float64', na_value=np.nan), np.where(d['p_throws'].astype(str).to_numpy() == 'L', -1.0, 1.0)])
    gid = d.groupby(['pitcher', 'pt'], sort=True).ngroup().to_numpy()
    G = len(keep)
    cnt = np.bincount(gid, minlength=G)
    vm = np.zeros((G, hid.shape[1])); np.add.at(vm, gid, hid); vm /= cnt[:, None]
    vi = pd.DataFrame(inp).groupby(gid).mean().to_numpy()          # 결측 제외 평균
    d['swing'], d['whiff'] = d['description'].isin(ew.SWING_DESC), d['description'].isin(sp.WHIFF_DESC)
    d['xc'] = d['estimated_woba_using_speedangle'].where(d['type'] == 'X')
    d['score'] = scaler.transform(pred)
    meta = d.groupby(['pitcher', 'pt'], sort=True).agg(name=('player_name', 'first'), hand=('p_throws', 'first'), n=('score', 'size'),
                                                       sw=('swing', 'sum'), wh=('whiff', 'sum'), stuff=('score', 'mean'),
                                                       xc=('xc', 'mean')).reset_index()
    meta['whiff'] = meta['wh'] / meta['sw'].where(meta['sw'] > 0)
    meta['name'] = meta['name'].map(ew.display_name)
    assert (meta['n'].to_numpy() == cnt).all()
    return meta, vm.astype('float32'), vi.astype('float32'), d['game_date'].max().strftime('%Y-%m-%d'), num + ['p_throws']


def standardize(V):
    """차원별 표준화 + 단위 벡터 (브라우저 similar.ts 와 같은 규칙 : 표준편차 0 이면 1, 결측은 0)"""
    V = V.astype('float64')
    mu, sd = np.nanmean(V, 0), np.nanstd(V, 0)
    sd = np.where(sd > 0, sd, 1.0)
    Z = np.nan_to_num((V - mu) / sd)
    return Z / np.maximum(np.linalg.norm(Z, axis=1, keepdims=True), 1e-12), mu, sd


def search(U, q, pitchers, exclude, k=K):
    """표준화·정규화된 U 에서 q(단위 벡터) 의 코사인 상위 k (exclude 투수 제외). 동점은 index 순"""
    s = U @ q
    s[pitchers == exclude] = -np.inf
    order = np.lexsort((np.arange(len(s)), -s))
    return order[:k], s[order[:k]]


def b64(a, dtype):
    return base64.b64encode(np.ascontiguousarray(a, dtype=dtype).tobytes()).decode('ascii')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--seasons', type=int, nargs='*')
    ap.add_argument('--out', default=ew.OUT_DIR)
    ap.add_argument('--check-out')
    args = ap.parse_args()
    mdir = ew.MODELS[MODEL]['dir']
    model = sm.load_model(mdir)
    scaler = joblib.load(os.path.join(mdir, 'stage4_stuff_scaler.joblib'))
    msha = hashlib.sha256(open(os.path.join(mdir, sm.MODEL_FILE), 'rb').read()).hexdigest()[:16]
    for season in args.seasons or ew.SEASONS:
        meta, vm, vi, as_of, icols = season_groups(season, model, scaler)
        r = lambda x, nd: None if pd.isna(x) else round(float(x), nd)
        out = {'season': season, 'asOf': as_of, 'model': MODEL, 'model_sha256': msha, 'minN': MIN_N,
               'inputCols': icols, 'dims': {'model': int(vm.shape[1]), 'input': int(vi.shape[1])},
               'items': [{'id': int(m.pitcher), 'name': m.name, 'hand': str(m.hand), 'pt': m.pt, 'n': int(m.n),
                          'whiff': r(m.whiff, 3), 'stuff': r(m.stuff, 1)} for m in meta.itertuples()],
               'vecModel': b64(vm, '<f2'), 'vecInput': b64(vi, '<f4')}
        path = os.path.join(args.out, str(season), 'similar.json')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
        print(f'[{season}] {path} : 기준일 {as_of}, 투수×구종 {len(meta):,}, {os.path.getsize(path) / 1e3:.0f}KB')
        if args.check_out and season == max(args.seasons or ew.SEASONS):
            # 브라우저와 같은 값(float16 복원)으로 기대 이웃 계산
            vm16 = np.frombuffer(base64.b64decode(out['vecModel']), '<f2').reshape(vm.shape).astype('float32')
            vi32 = np.frombuffer(base64.b64decode(out['vecInput']), '<f4').reshape(vi.shape)
            pit = meta['pitcher'].to_numpy()
            rng = np.random.default_rng(42)
            qs = rng.choice(len(meta), 50, replace=False)
            chk = {'season': season, 'queries': []}
            for space, V in (('model', vm16), ('input', vi32)):
                U, _, _ = standardize(V)
                for q in qs:
                    nb, sim = search(U, U[q], pit, pit[q])
                    chk['queries'].append({'space': space, 'q': int(q), 'nb': nb.tolist(), 'sim': [float(x) for x in sim]})
            json.dump(chk, open(args.check_out, 'w', encoding='utf-8'))
            print('패리티 기대값', args.check_out)


if __name__ == '__main__':
    main()
