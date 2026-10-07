# CLAUDE.md — MLB 구위(Stuff) 지표 프로젝트

이 파일은 어느 컴퓨터에서 작업하든 동일한 틀로 작업하기 위한 프로젝트 규칙이다. 작업 시작 전 반드시 읽고 따른다.

## 1. 프로젝트 목적
- tjStuff+ 처럼 **타석 정보(타자·카운트·상황·로케이션) 없이 투구 물리량만으로 "구위 자체의 위력"을 평가**하는 지표를 만든다.
  - 참조 : tjStuff+ v3.0 — https://medium.com/@thomasjamesnestico/modelling-tjstuff-v3-0-10b48294c7fb
- 데이터 출처 : `pybaseball` (Statcast). 로컬 캐시 `games_25_final.pkl`(2025 전체 시즌), `games_24.pkl`(2024), `games_26.pkl`(2026, 웹 out-of-sample 점수용).
  - `games_25.pkl` 은 2025-06-30 까지만 있으므로 전체 시즌 분석에는 `games_25_final.pkl` 을 사용한다.

## 2. 파이프라인 정의 (변경 시 사용자와 협의)

### 1단계 — 타구결과 예측 모델 (다중분류)
- 설명변수 : 타구방향(spray angle, `hc_x`/`hc_y` 로 계산), 타구속도(`launch_speed`), 발사각(`launch_angle`), 공격각도(`attack_angle`)
- 목적변수 : 0 = 아웃 / 1 = 1루타 / 2 = 2루타·3루타 / 3 = 홈런
  - 실책(`field_error`), 희생타, 야수선택, 병살 등 나머지 인플레이 결과는 아웃(0)
- 모델 : 설명변수가 적으므로 RandomForest / DecisionTree 등 단순하고 설명력 좋은 모델
- 학습 표본 : 인플레이 타구(`type == 'X'`)만. 파울 타구와 타격이 없는 투구는 제외, **파울플라이아웃은 포함**(Statcast 에서 `hit_into_play` 로 기록됨). `truncated_pa`, `catcher_interf` 제외
- 3단계 y 로 쓰일 학습셋 예측은 과적합 방지를 위해 Out-of-Fold 예측을 사용

### 2단계 — 타구질 score (0~1)
- 예측확률의 기대값 `E = P1 + 2·P2 + 3·P3` (0~3 실수)
- E 가 따르는 **Gamma 분포를 추정**하고 이를 **Beta 분포로 변환**해 0~1 로 매핑 : `score = BetaPPF(GammaCDF(E))`
  - Beta 모수는 E/3 의 적률법 추정. 변환 모수는 학습셋에서만 추정

### 3단계 — 구위 모델 (투구 → 타구질 score)
- 설명변수 : 해당 타구 결과에 대응되는 투구 데이터 (**로케이션 `plate_x`/`plate_z`, 카운트, 타자 정보 제외**)
  - 구속, 무브먼트(`pfx_x`/`pfx_z`), 릴리스 포인트, 익스텐션, 회전수·회전축, 팔각도, 초기 속도/가속도, 구종, 투구손, 주 패스트볼 대비 구속·무브먼트 차이
  - 좌투는 수평 성분 부호를 반전해 우투 기준으로 정규화
  - **v2(현재 웹 모델)** : 위 변수 + **VAA·HAA**(홈플레이트 도달 진입각, `sp.approach_angles`, 원값). VAA 는 plate_z 와 상관 0.75 로 높이 정보가 일부 섞임
- 학습 표본 : 1단계와 동일(파울·미타격 제외) + **헛스윙 투구는 포함하며 y = 0**
  - v1 은 루킹 삼진도 y = 0 으로 포함했으나 **v2 부터 루킹 삼진은 제외** (`build_stuff_dataset(..., include_looking_k=False)`)
- 모델 : **베이스라인은 LGBM**. 사용자가 추후 3단계 모델을 직접 만들어 교체할 예정이다.
  - 교체 지점은 `stuff_pipeline.fit_stuff_model(X_tr, y_tr, X_es, y_es) -> model(.predict)` 하나로 유지한다.
  - 새 모델과 비교할 때는 반드시 동일 split, 동일 표본, 동일 지표(RMSE/MAE/R², 분위별 실제값, 검증기간 whiff% 상관)를 사용한다.
  - 튜닝은 학습셋 내부 홀드아웃(학습셋 마지막 2주)으로만 수행하고 검증셋은 최종 평가에만 사용한다.

### 4단계 — 최종 구위 score (20~80)
- 3단계 예측값(낮을수록 좋은 구위)을 부호 반전 → 학습기간 투구의 ECDF → 표준정규 분위수 z → `50 + 10z`, [20, 80] clip
- 중앙값 50, 50 을 기준으로 대칭
- **Waste 볼 점수 제외 (v2)** : 볼 판정(`ball`/`blocked_ball`)이면서 Savant Waste 존(|plate_x| > 20in, 또는 정규화 존 1.5~3.5ft 위아래 10in 바깥)인 투구는 점수 NaN (`sp.is_waste_ball`). 스케일러도 waste 볼 제외 투구로 적합. 웹 분포도에는 표시하되 점수·집계에서 제외

### 모델 버전
| 버전 | 노트북 | 모델 / 산출물 | 비고 |
|---|---|---|---|
| v1 | `stuff_pipeline_260929.ipynb` | `models/`, `outputs/` | 베이스라인 |
| v2 | `stuff_pipeline_261005.ipynb` | `models/v2/`, `outputs/v2/` | VAA·HAA, 루킹삼진 제외, waste 볼 제외. **웹 사용 중** (`export_web_data.MODEL_VERSION`) |
- 새 버전은 기존 산출물을 덮어쓰지 않고 `models/vN/`, `outputs/vN/` 에 저장

## 3. 데이터 규칙
- **모델 학습·검증·리그 기준값은 정규시즌만** (`game_type == 'R'`, `load_regular_season`). 포스트시즌(F/D/L/W)·시범경기(S) 제외
  - 웹 표시는 전체 경기 유형(`load_season`) : 같은 모델로 점수를 매기고 `gt`(0 정규 / 1 포스트 / 2 시범)로 구분. 비정규 투구의 '주 패스트볼 대비 차이'는 그 투수의 정규시즌 주 패스트볼 기준
- **검증셋 = 정규시즌 마지막 1개월, 학습셋 = 그 이전** (2025 : 검증 2025-08-29 ~ 09-28)
- 구종 결측, `FA`/`CS`/`PO`/`UN` 구종은 3단계에서 제외

## 4. 코드/폴더 규칙
```
stuff_pipeline.py              단계별 공통 함수 (로드·분할·피처·캘리브레이션·모델)
stuff_pipeline_YYMMDD.ipynb    파이프라인 실행 노트북 (날짜 접미사 YYMMDD)
models/                        학습된 모델 (joblib)
outputs/                       예측 결과, 지표, 그림
업무일지/업무일지_YYYYMMDD.md    일일 업무일지
export_web_data.py             웹용 데이터 export (시즌별 구위 score -> web/public/data/{season}/ : index·league·summary·stats(MLB 공식 기록).json, p/ e/ 투수별 .json.gz(경기·타석 표 포함))
compute_shap.py                정확한 SHAP 캐시 계산 (outputs/v2/shap/, 약 12시간 : 정규 shap_{season}.npz + 시범·포스트 shap_{season}_extra.npz). 없으면 export 가 Saabas 기여 사용
web/                           Next.js 분석 페이지 (static export, Vercel 배포) : / 홈, /pitcher, /games, /explain(/pitch-types, /bands, /pitch)
data_store.py                  온라인 데이터 저장소 (HF Datasets : statcast 월별 parquet, SHAP 캐시, 웹 데이터 스냅샷)
ops.py                         클라우드 운영 명령 (update / bootstrap / pull-web / push-web / pull-shap / push-shap / shap-todo)
.github/workflows/             daily(매일 갱신·배포) / deploy(push 시 배포) / shap(끝난 시즌 SHAP) / bootstrap(처음 적재)
data_status.json               데이터 기준일 (daily 가 커밋)
```
- 웹 데이터 갱신 : **`git push` 하면 자동** (7절). `web/public/data/` 는 커밋하지 않는다
- 데이터 로드 순서 : 로컬 pkl -> 없거나 `MLB_DATA=store` 면 HF 데이터셋 -> 둘 다 없으면 pybaseball (`stuff_pipeline._read_raw`)
- **절대경로 금지** — 프로젝트 루트 기준 상대경로만 사용 (OneDrive 동기화, 다른 PC 대응)
- 난수 seed = 42 고정
- 기존 파일(`modelling*.ipynb`, `preprocess_hits.py` 등 이전 작업물)은 사용자 요청 없이 수정하지 않는다.
- 노트북 실행 확인 : `jupyter nbconvert --to notebook --execute --inplace <노트북>`
- 환경 : Python 3.12, pandas, numpy, scipy, scikit-learn(≥1.4, RF 결측 네이티브 지원), lightgbm, shap, matplotlib, pyarrow, pybaseball

## 5. Git 규칙
- 원격 레포 : https://github.com/yongwon38/mlb_prediction (공개 레포, 브랜치 `main`)
- 다른 PC 에서는 `git clone` 후 작업하고, 작업 시작 전 `git pull` 로 최신화한다.
- `.gitignore` 는 **화이트리스트 방식**이다. 데이터(`*.pkl`), `.env`, `outputs/*.parquet`, 개인 PDF·기존 작업물은 절대 커밋하지 않는다.
  - 모델은 **현재 웹 모델 폴더(`models/v2/*.joblib`)만 커밋**한다 (클라우드 배치가 git 의 모델로 점수를 매김). 웹 모델 버전을 바꾸면 `.gitignore` 의 `models/v2` 줄도 함께 바꾼다
  - 새로 추적할 파일(새 노트북, 모듈 등)은 `.gitignore` 에 `!/파일명` 을 추가해 허용한다.
  - 커밋 전 `git status` 로 스테이징 목록을 반드시 확인한다.
- 노트북 커밋 전 로컬 절대경로가 찍힌 stderr 출력이 있으면 제거한다 (공개 레포).
- 하루 작업이 끝나면 업무일지 작성 → 커밋 → push.

## 6. 업무일지 규칙 (필수)
- **매일 작업이 완료되면 그날의 작업 내용을 `업무일지/업무일지_작업일자.md` 파일로 저장한다.** (작업일자 형식 : `YYYYMMDD`, 예 : `업무일지_20260929.md`)
- 같은 날 여러 번 작업하면 같은 파일에 섹션을 추가한다.
- 포함 내용 :
  1. 작업 요약
  2. 생성/수정한 파일
  3. 주요 결과 (지표 수치, 그림 경로)
  4. 결정 사항과 그 이유 (파이프라인 해석, 가정)
  5. 이슈 / 미해결 사항
  6. 다음 작업 계획
- 새 세션을 시작하면 가장 최근 업무일지를 먼저 읽고 이어서 작업한다.

## 7. 클라우드 운영 (무료, 로컬 PC 없이 동작)
- 구성 : GitHub Actions(공개 레포 무료) + Hugging Face 데이터셋 `elcax1/mlb-statcast`(공개) + Vercel Hobby(`stuff-lab`)
- **daily** (매일 15:00 KST) : 현재 시즌 최근 3일 Statcast 재수집 -> 경기 단위 교체 -> 바뀌었으면 현재 시즌 export -> 배포 -> `data_status.json` 커밋
- **deploy** (main push) : HF 의 웹 데이터 스냅샷(`web_data/{web_id}/`)으로 빌드·배포. `web_id` = 3·4단계 모델 + `export_web_data.py` + `stuff_pipeline.py` 해시 -> 모델·export 코드가 바뀌면 스냅샷이 없으므로 전 시즌 자동 재생성
- **shap** (models push / 매월 / 수동) : 끝난 시즌(12월 이후)만 8조각 병렬 SHAP -> 해당 시즌 재생성. 진행 중 시즌은 투수별 주 패스트볼 평균이 매일 바뀌어 캐시가 맞지 않으므로 Saabas
- Secrets : `HF_TOKEN`, `VERCEL_TOKEN`, `VERCEL_ORG_ID`, `VERCEL_PROJECT_ID` (`web/.vercel/project.json`)
- 로컬에서 HF 데이터로 작업 : `MLB_DATA=store`, 캐시 위치 `MLB_CACHE`(기본 `data_cache/`), 테스트 저장소 `MLB_STORE=<폴더>`
- `requirements.txt` 버전은 모델을 학습한 로컬 환경과 같게 유지한다 (joblib 호환)
