"""
클라우드 운영 명령 (GitHub Actions 에서 실행, 로컬에서도 동일하게 동작)

    python ops.py update [--days 3]          현재 시즌 최근 N일 Statcast 갱신 -> data_status.json
    python ops.py bootstrap 2025 [--pkl games_25_final.pkl]   시즌 전체 적재 (pkl 없으면 Savant 에서 수집)
    python ops.py pull-web [--skip 2026]     웹 데이터 스냅샷 -> web/public/data (없는 시즌은 missing 으로 출력)
    python ops.py push-web 2026 ...          web/public/data/{season} -> 스냅샷 업로드
    python ops.py pull-shap [2026] / push-shap 2025 ...   SHAP 캐시 (outputs/{ver}/shap) 내려받기 / 올리기
    python ops.py shap-todo                  적재된 시즌 중 현재 모델 SHAP 캐시가 없는 시즌 (JSON 목록)

결과값은 GITHUB_OUTPUT 이 있으면 거기에 key=value 로도 쓴다.
"""
import argparse
import datetime as dt
import json
import os
import tarfile

import data_store as ds

STATUS_FILE = 'data_status.json'
WEB_CODE = ['export_web_data.py', 'stuff_pipeline.py', 'stuff_model.py']    # 웹 산출물에 영향을 주는 코드


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


def model_id():
    """3단계 모델 파일 해시 (SHAP 캐시 경로). 파일이 하나면 그 파일 해시 그대로"""
    import stuff_model as sm
    files = sm.model_files(_ew().CFG['dir'])
    if len(files) == 1:
        return ds.file_id(files[0])
    return ds.hashlib.sha256(''.join(ds.file_id(f) for f in files).encode()).hexdigest()[:12]


def web_id():
    """모델(3·4단계) + export 코드가 같으면 같은 id -> 바뀌면 지난 시즌 스냅샷이 자동으로 missing 이 되어 재생성된다"""
    import stuff_model as sm
    ew = _ew()
    files = sm.model_files(ew.CFG['dir']) + [os.path.join(ew.CFG['dir'], 'stage4_stuff_scaler.joblib')] + WEB_CODE
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
    ew.write_meta()
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
    prefix = f'shap/{model_id()}/'
    os.makedirs(ew.SHAP_DIR, exist_ok=True)
    got = []
    for r in ds.store().list(prefix):
        tag = r[len(prefix):].removeprefix('shap_').removesuffix('.npz').removesuffix('_extra')
        if not args.seasons or int(tag) in args.seasons:
            ds.shutil.copyfile(ds.store().download(r), os.path.join(ew.SHAP_DIR, r[len(prefix):]))
            got.append(r)
    print(f'SHAP 캐시 {len(got)}개 -> {ew.SHAP_DIR}')


def cmd_push_shap(args):
    ew = _ew()
    mid = model_id()
    files = []
    for season in args.seasons:
        for tag in (f'{season}', f'{season}_extra'):
            p = os.path.join(ew.SHAP_DIR, f'shap_{tag}.npz')
            if os.path.exists(p):
                files.append((p, f'shap/{mid}/shap_{tag}.npz'))
    if not files:
        print('올릴 SHAP 캐시 없음')
        return
    ds.store().upload(files, f'shap {mid} : {" ".join(map(str, args.seasons))}')


def cmd_shap_todo(args):
    ew = _ew()
    have = set(ds.store().list(f'shap/{model_id()}/'))
    data = {f.split('/')[1] for f in ds.store().list('statcast/')}    # 적재된 시즌만
    todo = [s for s in ew.SEASONS if str(s) in data and f'shap/{model_id()}/shap_{s}.npz' not in have]
    _out(seasons=json.dumps(todo))


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
    for name in ('push-web', 'push-shap'):
        sub.add_parser(name).add_argument('seasons', type=int, nargs='+')
    sub.add_parser('pull-shap').add_argument('seasons', type=int, nargs='*')
    sub.add_parser('shap-todo')
    args = ap.parse_args()
    globals()['cmd_' + args.cmd.replace('-', '_')](args)


if __name__ == '__main__':
    main()
