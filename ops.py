"""
클라우드 운영 명령 (GitHub Actions 에서 실행, 로컬에서도 동일하게 동작)

    python ops.py update [--days 3]          현재 시즌 최근 N일 Statcast 갱신 -> data_status.json
    python ops.py bootstrap 2025 [--pkl games_25_final.pkl]   시즌 전체 적재 (pkl 없으면 Savant 에서 수집)
    python ops.py pull-web [--skip 2026]     웹 데이터 스냅샷 -> web/public/data (없는 시즌은 missing 으로 출력)
    python ops.py push-web 2026 ...          web/public/data/{season} -> 스냅샷 업로드
    python ops.py pull-shap [2026] / push-shap 2025 ...   SHAP 캐시 (outputs/{ver}/shap) 내려받기 / 올리기
    python ops.py shap-todo                  적재된 시즌 중 현재 모델 SHAP 캐시가 없는 시즌 (JSON 목록)
    --model hof_r                            (pull-shap · push-shap · shap-todo) 대체 모델의 기여 캐시 (기본 : 웹 주 모델)

결과값은 GITHUB_OUTPUT 이 있으면 거기에 key=value 로도 쓴다.
"""
import argparse
import datetime as dt
import json
import os
import tarfile

import data_store as ds

STATUS_FILE = 'data_status.json'
WEB_CODE = ['export_web_data.py', 'stuff_pipeline.py', 'stuff_model.py', 'hof_net.py', 'hof_net_r.py']    # 웹 산출물에 영향을 주는 코드


def _out(**kv):
    for k, v in kv.items():
        print(f'{k}={v}')
    gh = os.getenv('GITHUB_OUTPUT')
    if gh:
        with open(gh, 'a', encoding='utf-8') as f:
            for k, v in kv.items():
                f.write(f'{k}={v}\n')


def _ew():
    import export_web_data as ew
    return ew


def model_id(ver=None):
    """3단계 모델 파일 해시 (SHAP 캐시 경로). 파일이 하나면 그 파일 해시 그대로"""
    import stuff_model as sm
    ew = _ew()
    files = sm.model_files(ew.MODELS[ver or ew.MODEL_VERSION]['dir'])
    if len(files) == 1:
        return ds.file_id(files[0])
    return ds.hashlib.sha256(''.join(ds.file_id(f) for f in files).encode()).hexdigest()[:12]


def web_id():
    """모델(3·4단계) + export 코드가 같으면 같은 id -> 바뀌면 지난 시즌 스냅샷이 자동으로 missing 이 되어 재생성된다"""
    import stuff_model as sm
    ew = _ew()
    dirs = [ew.CFG['dir']] + [ew.MODELS[ew.ALT_MODELS[k]]['dir'] for k in ew.available_alts()]    # 대체 모델(HOF)도 포함
    files = [f for d in dirs for f in sm.model_files(d) + [os.path.join(d, 'stage4_stuff_scaler.joblib')]] + WEB_CODE
    h = ''.join(ds.file_id(f) for f in files)
    return ds.hashlib.sha256(h.encode()).hexdigest()[:12]


# ---------------------------------------------------------------------------
def cmd_update(args):
    season = ds.current_season()
    res = ds.update_recent(season, days=args.days)
    print(json.dumps(res, ensure_ascii=False))
    old = {}
    if os.path.exists(STATUS_FILE):
        with open(STATUS_FILE, encoding='utf-8') as f:
            old = json.load(f)
    # 데이터가 바뀐 날 + 그 외에는 주 1회만 내용이 바뀜 -> 커밋이 생겨 GitHub 의 60일 비활성 cron 정지를 막는다
    status = {**old, 'season': season, 'checkedWeek': ds.today().strftime('%G-W%V')}
    if res.get('dataThrough'):
        status['dataThrough'] = res['dataThrough']
    if res['changed']:
        status.update(pitches=res['pitches'], updatedAt=dt.datetime.now(ds.KST).strftime('%Y-%m-%d %H:%M KST'))
    with open(STATUS_FILE, 'w', encoding='utf-8') as f:
        json.dump(status, f, ensure_ascii=False, indent=2)
        f.write('\n')
    _out(changed=str(res['changed']).lower(), season=season)


def cmd_bootstrap(args):
    ds.bootstrap_season(args.season, pkl=args.pkl)


def cmd_pull_web(args):
    ew = _ew()
    wid = web_id()
    os.makedirs(ew.OUT_DIR, exist_ok=True)
    have = set(ds.store().list(f'web_data/{wid}/'))
    missing = []
    for season in ew.SEASONS:
        r = f'web_data/{wid}/{season}.tar.gz'
        if season in args.skip:
            continue
        if r not in have:
            missing.append(season)
            continue
        with tarfile.open(ds.store().download(r)) as t:
            t.extractall(ew.OUT_DIR, filter='data')
        print(f'  스냅샷 {season} 풀기 완료')
    ew.write_meta(ew.available_alts())
    print(f'web_id {wid}, 스냅샷 없음 : {missing}')
    _out(missing=' '.join(map(str, missing)), web_id=wid)


def cmd_push_web(args):
    ew = _ew()
    wid = web_id()
    tmp = os.path.join(ds.CACHE_DIR, 'web_data', wid)
    os.makedirs(tmp, exist_ok=True)
    files = []
    for season in args.seasons:
        local = os.path.join(tmp, f'{season}.tar.gz')
        with tarfile.open(local, 'w:gz') as t:
            t.add(os.path.join(ew.OUT_DIR, str(season)), arcname=str(season))
        files.append((local, f'web_data/{wid}/{season}.tar.gz'))
    ds.store().upload(files, f'web data {wid} : {" ".join(map(str, args.seasons))}')


def cmd_pull_shap(args):
    """현재 모델의 SHAP 캐시 (시즌을 주면 그 시즌만)"""
    ew = _ew()
    prefix = f'shap/{model_id(args.model)}/'
    out = ew.shap_dir(args.model or ew.MODEL_VERSION)
    os.makedirs(out, exist_ok=True)
    got = []
    for r in ds.store().list(prefix):
        tag = r[len(prefix):].removeprefix('shap_').removesuffix('.npz').removesuffix('_extra')
        if not args.seasons or int(tag) in args.seasons:
            ds.shutil.copyfile(ds.store().download(r), os.path.join(out, r[len(prefix):]))
            got.append(r)
    print(f'SHAP 캐시 {len(got)}개 -> {out}')


def cmd_push_shap(args):
    ew = _ew()
    mid = model_id(args.model)
    files = []
    for season in args.seasons:
        for tag in (f'{season}', f'{season}_extra'):
            p = os.path.join(ew.shap_dir(args.model or ew.MODEL_VERSION), f'shap_{tag}.npz')
            if os.path.exists(p):
                files.append((p, f'shap/{mid}/shap_{tag}.npz'))
    if not files:
        print('올릴 SHAP 캐시 없음')
        return
    ds.store().upload(files, f'shap {mid} : {" ".join(map(str, args.seasons))}')


def cmd_shap_todo(args):
    ew = _ew()
    mid = model_id(args.model)
    have = set(ds.store().list(f'shap/{mid}/'))
    data = {f.split('/')[1] for f in ds.store().list('statcast/')}    # 적재된 시즌만
    todo = [s for s in ew.SEASONS if str(s) in data and f'shap/{mid}/shap_{s}.npz' not in have]
    _out(seasons=json.dumps(todo))


def cmd_shap_plan(args):
    """shap 워크플로 계획 : 모델 × 시즌 × 조각 작업 목록 (JSON)
    - 시즌을 주면 그 시즌, 아니면 모델별 캐시 없는 시즌 + 대체 모델은 현재 시즌(매일 근사로 채운 투구를 정확값으로)"""
    ew = _ew()
    models = json.loads(args.models) if args.models else [ew.MODEL_VERSION] + [ew.ALT_MODELS[k] for k in ew.available_alts()]
    data = {f.split('/')[1] for f in ds.store().list('statcast/')}
    plan = {}
    for m in models:
        if args.seasons:
            plan[m] = json.loads(args.seasons)
            continue
        mid = model_id(m)
        have = set(ds.store().list(f'shap/{mid}/'))
        todo = [s for s in ew.SEASONS if str(s) in data and f'shap/{mid}/shap_{s}.npz' not in have]
        cur = ds.current_season()
        if m != ew.MODEL_VERSION and str(cur) in data and cur not in todo:
            todo.append(cur)
        plan[m] = todo
    jobs = [{'model': m, 'season': s, 'shard': k} for m, ss in plan.items() for s in ss for k in range(args.shards)]
    seasons = sorted({s for ss in plan.values() for s in ss})
    _out(seasons=json.dumps(seasons), plan=json.dumps({m: ss for m, ss in plan.items() if ss}), jobs=json.dumps(jobs))


def cmd_models(args):
    """웹에 쓰는 모델 버전 목록 (주 모델 + 파일이 있는 대체 모델, JSON) — 워크플로의 모델 루프용"""
    ew = _ew()
    _out(models=json.dumps([ew.MODEL_VERSION] + [ew.ALT_MODELS[k] for k in ew.available_alts()]))


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    p = sub.add_parser('update')
    p.add_argument('--days', type=int, default=3)
    p = sub.add_parser('bootstrap')
    p.add_argument('season', type=int)
    p.add_argument('--pkl')
    p = sub.add_parser('pull-web')
    p.add_argument('--skip', type=int, nargs='*', default=[])
    sub.add_parser('push-web').add_argument('seasons', type=int, nargs='+')
    p = sub.add_parser('push-shap')
    p.add_argument('seasons', type=int, nargs='+')
    p.add_argument('--model')
    p = sub.add_parser('pull-shap')
    p.add_argument('seasons', type=int, nargs='*')
    p.add_argument('--model')
    sub.add_parser('shap-todo').add_argument('--model')
    p = sub.add_parser('shap-plan')
    p.add_argument('--seasons', default='')
    p.add_argument('--models', default='')
    p.add_argument('--shards', type=int, default=8)
    sub.add_parser('models')
    args = ap.parse_args()
    globals()['cmd_' + args.cmd.replace('-', '_')](args)


if __name__ == '__main__':
    main()
