"""
온라인 데이터 저장소 — Hugging Face Datasets (공개, 무료)

레이아웃 (데이터셋 레포 HF_DATASET) :
    statcast/{season}/{season}-{MM}.parquet    pybaseball.statcast 원본 (시범·정규·포스트시즌 전체, 월별)
    shap/{model_id}/shap_{season}[_extra].npz   compute_shap.py 캐시 (model_id = stage3 모델 파일 해시)
    web_data/{model_id}/{season}.tar.gz         export_web_data.py 시즌 산출물 스냅샷

- 저장소 선택 : 환경변수 MLB_STORE 가 없으면 HF, 폴더 경로면 그 폴더 (로컬 테스트용)
- 쓰기에는 HF_TOKEN(write) 이 필요하다. 읽기는 공개 레포라 토큰 없이 가능
- 로컬 캐시 : data_cache/ (커밋하지 않음)
"""
import datetime as dt
import hashlib
import os
import shutil
import time

import pandas as pd

HF_DATASET = os.getenv('HF_DATASET', 'elcax1/mlb-statcast')
CACHE_DIR = os.getenv('MLB_CACHE', 'data_cache')    # OneDrive 동기화를 피하려면 MLB_CACHE 로 다른 위치 지정
SEASON_START, SEASON_END = '03-01', '11-30'    # stuff_pipeline.load_regular_season 과 같은 수집 구간
KEY = ['game_pk', 'at_bat_number', 'pitch_number']
KST = dt.timezone(dt.timedelta(hours=9))


def today():
    return dt.datetime.now(KST).date()


def current_season(d=None):
    """3월 1일부터 새 시즌 (그 전에는 직전 시즌)"""
    d = d or today()
    return d.year if d >= dt.date(d.year, 3, 1) else d.year - 1


def season_finished(season, d=None):
    """12월 이후면 시즌 종료 (월드시리즈는 11월 초까지)"""
    return (d or today()) >= dt.date(season, 12, 1)


def file_id(path, n=12):
    """파일 내용 해시 (모델 버전 식별용)"""
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for b in iter(lambda: f.read(1 << 20), b''):
            h.update(b)
    return h.hexdigest()[:n]


# ---------------------------------------------------------------------------
# 저장소 백엔드
# ---------------------------------------------------------------------------
class HFStore:
    def __init__(self, repo_id=HF_DATASET):
        from huggingface_hub import HfApi
        self.repo_id = repo_id
        self.api = HfApi()

    def list(self, prefix):
        from huggingface_hub.utils import RepositoryNotFoundError
        try:
            files = self.api.list_repo_files(self.repo_id, repo_type='dataset')
        except RepositoryNotFoundError:
            return []
        return sorted(f for f in files if f.startswith(prefix))

    def download(self, path):
        from huggingface_hub import hf_hub_download
        return hf_hub_download(self.repo_id, path, repo_type='dataset', local_dir=CACHE_DIR)

    def upload(self, files, message):
        """files : [(로컬 경로, 레포 경로)] -> 커밋 1개"""
        from huggingface_hub import CommitOperationAdd
        self.api.create_repo(self.repo_id, repo_type='dataset', exist_ok=True)
        ops = [CommitOperationAdd(path_in_repo=r, path_or_fileobj=l) for l, r in files]
        self.api.create_commit(self.repo_id, ops, commit_message=message, repo_type='dataset')


class DirStore:
    """로컬 폴더를 저장소처럼 사용 (테스트용, MLB_STORE=<폴더>)"""
    def __init__(self, root):
        self.root = root

    def list(self, prefix):
        out = []
        for d, _, fs in os.walk(self.root):
            for f in fs:
                r = os.path.relpath(os.path.join(d, f), self.root).replace(os.sep, '/')
                if r.startswith(prefix):
                    out.append(r)
        return sorted(out)

    def download(self, path):
        dst = os.path.join(CACHE_DIR, path)
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copyfile(os.path.join(self.root, path), dst)
        return dst

    def upload(self, files, message):
        for l, r in files:
            dst = os.path.join(self.root, r)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.abspath(l) != os.path.abspath(dst):
                shutil.copyfile(l, dst)
        print(f'  [store] {message} ({len(files)} files)')


_store = None


def store():
    global _store
    if _store is None:
        root = os.getenv('MLB_STORE')
        _store = DirStore(root) if root else HFStore()
    return _store


# ---------------------------------------------------------------------------
# 투구 데이터 (statcast)
# ---------------------------------------------------------------------------
def _month_path(season, ym):
    return f'statcast/{season}/{ym}.parquet'


def _order(df):
    """pybaseball 과 같은 순서 (최근 경기·타석·투구 먼저)"""
    df = df.copy()
    df['game_date'] = pd.to_datetime(df['game_date'])
    return df.sort_values(['game_date', 'game_pk', 'at_bat_number', 'pitch_number'], ascending=False, kind='stable')


def load_raw(season):
    """저장소의 시즌 전체 투구 (없으면 None)"""
    files = [f for f in store().list(f'statcast/{season}/') if f.endswith('.parquet')]
    if not files:
        return None
    print(f'  [store] {season} 투구 데이터 {len(files)}개 월 파일 다운로드')
    df = pd.concat([pd.read_parquet(store().download(f)) for f in files], ignore_index=True)
    return _order(df).reset_index(drop=True)


def _write_months(season, df, message):
    """월별 parquet 으로 저장·업로드. 반환 : 업로드한 월 목록"""
    df = _order(df)
    out_dir = os.path.join(CACHE_DIR, 'statcast', str(season))
    os.makedirs(out_dir, exist_ok=True)
    files = []
    for ym, g in df.groupby(df['game_date'].dt.strftime('%Y-%m'), sort=True):
        local = os.path.join(out_dir, f'{ym}.parquet')
        g.reset_index(drop=True).to_parquet(local, compression='zstd', index=False)
        files.append((local, _month_path(season, ym)))
    if files:
        store().upload(files, message)
    return [r for _, r in files]


def fetch_statcast(start, end, retries=3):
    """Baseball Savant -> DataFrame (실패 시 재시도, 빈 기간이면 빈 DataFrame)"""
    import pybaseball as pyb
    for i in range(retries):
        try:
            df = pyb.statcast(start_dt=str(start), end_dt=str(end), verbose=False)
            return df if df is not None else pd.DataFrame()
        except Exception as e:
            if i == retries - 1:
                raise
            print(f'  statcast 조회 실패 ({e}) -> {60 * (i + 1)}초 후 재시도')
            time.sleep(60 * (i + 1))


def bootstrap_season(season, pkl=None):
    """시즌 전체 적재. pkl 이 있으면 그 파일(학습에 쓴 원본 그대로), 없으면 Savant 에서 월 단위로 수집"""
    if pkl:
        df = pd.read_pickle(pkl)
    else:
        parts = []
        start = dt.date.fromisoformat(f'{season}-{SEASON_START}')
        end = min(dt.date.fromisoformat(f'{season}-{SEASON_END}'), today() - dt.timedelta(days=1))
        while start <= end:
            m_end = min((start.replace(day=28) + dt.timedelta(days=4)).replace(day=1) - dt.timedelta(days=1), end)
            print(f'  [{season}] {start} ~ {m_end}')
            parts.append(fetch_statcast(start, m_end))
            start = m_end + dt.timedelta(days=1)
        df = pd.concat([p for p in parts if len(p)], ignore_index=True)
    df = df.drop_duplicates(KEY, keep='first')
    months = _write_months(season, df, f'bootstrap {season} ({len(df):,} pitches)')
    print(f'  [{season}] {len(df):,}구 -> {len(months)}개 월 파일')
    return len(df)


def update_recent(season, days=3, end=None):
    """최근 days 일을 다시 받아 경기(game_pk) 단위로 교체 (Statcast 정정 반영). 반환 dict(변경 여부, 기준일 등)"""
    end = end or min(today() - dt.timedelta(days=1), dt.date.fromisoformat(f'{season}-{SEASON_END}'))
    start = max(end - dt.timedelta(days=days - 1), dt.date.fromisoformat(f'{season}-{SEASON_START}'))
    if start > end:
        return {'changed': False, 'reason': 'off-season'}
    new = fetch_statcast(start, end)
    print(f'  statcast {start} ~ {end} : {len(new):,}구')
    old = load_raw(season)
    if not len(new):
        last = old['game_date'].max().strftime('%Y-%m-%d') if old is not None else None
        return {'changed': False, 'reason': 'no games', 'dataThrough': last}
    new = _order(new).drop_duplicates(KEY, keep='first')
    months = set(new['game_date'].dt.strftime('%Y-%m'))
    if old is None:
        merged, touched = new, new
    else:
        keep = old[~old['game_pk'].isin(set(new['game_pk']))]
        touched_old = old[old['game_date'].dt.strftime('%Y-%m').isin(months)]
        merged = pd.concat([keep, new], ignore_index=True)
        touched = merged[merged['game_date'].dt.strftime('%Y-%m').isin(months)]
        if _same(touched_old, touched):
            return {'changed': False, 'reason': 'no change', 'dataThrough': old['game_date'].max().strftime('%Y-%m-%d')}
    n_old = 0 if old is None else len(old)
    _write_months(season, touched, f'update {season} {start}~{end}')
    return {'changed': True, 'season': season, 'pitches': int(len(merged)), 'added': int(len(merged) - n_old),
            'dataThrough': merged['game_date'].max().strftime('%Y-%m-%d'), 'months': sorted(months)}


def _same(a, b):
    if len(a) != len(b):
        return False
    a, b = _order(a).reset_index(drop=True), _order(b).reset_index(drop=True)
    return a.equals(b[a.columns]) if set(a.columns) == set(b.columns) else False


# ---------------------------------------------------------------------------
# 파일 묶음 (SHAP 캐시, 웹 데이터 스냅샷)
# ---------------------------------------------------------------------------
def pull_prefix(prefix, dst_dir):
    """저장소 prefix 아래 파일을 dst_dir 로 복사 (상대 경로 유지). 반환 : 받은 레포 경로 목록"""
    got = []
    for r in store().list(prefix):
        dst = os.path.join(dst_dir, os.path.relpath(r, prefix))
        os.makedirs(os.path.dirname(dst) or '.', exist_ok=True)
        shutil.copyfile(store().download(r), dst)
        got.append(r)
    return got
