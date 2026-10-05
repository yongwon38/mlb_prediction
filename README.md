# mlb_prediction

## 구위(Stuff) 지표 — 투구 물리량만으로 구위를 평가

[tjStuff+](https://medium.com/@thomasjamesnestico/modelling-tjstuff-v3-0-10b48294c7fb)처럼 **타석 정보(타자·카운트·로케이션) 없이 투구 데이터만으로 구위 자체의 위력**을 20~80 스케일로 산출한다. 데이터는 `pybaseball`(Statcast), 2025 정규시즌.

| 단계 | 내용 | 방법 |
|---|---|---|
| 1 | 타구방향·타구속도·발사각·공격각도 → 타구결과 (0 아웃 / 1 1루타 / 2 2·3루타 / 3 홈런) | RandomForest 다중분류 |
| 2 | 예측확률 기대값(0~3) → **타구질 score (0~1)** | Gamma 적합 → Beta 변환 |
| 3 | 투구 정보(+ VAA·HAA) → 타구질 score (헛스윙 = 0, 루킹삼진 제외) | LGBM |
| 4 | 3단계 예측 → **구위 score (20~80, 중앙값 50, 대칭)**. 존에서 크게 벗어난 볼(Savant Waste)은 점수 제외 | ECDF → 정규분위수 |

- 학습 : 정규시즌 ~ 2025-08-28 / 검증 : 정규시즌 마지막 1개월 (2025-08-29 ~ 09-28)

### v2 결과 (현재 웹 모델, `stuff_pipeline_261005.ipynb`)
v1 과 동일 split·동일 표본(검증기간 인플레이 + 헛스윙)·waste 볼 제외 조건에서 비교

| 지표 | v1 | v2 |
|---|---|---|
| 검증 RMSE / R² | 0.1630 / 0.082 | **0.1622 / 0.091** |
| 검증 투수×구종 ρ(구위, whiff%) | 0.674 | **0.738** |
| 검증 투수×구종 ρ(구위, xwOBAcon) | −0.264 | **−0.286** |
| 연도 간 안정성 r (2025→2026, 투수×구종) | 0.838 | **0.862** |
| 다음 시즌 whiff% 예측 ρ (2025→2026) | 0.649 | **0.695** |
| 2026 구간 Whiff 격차 (60+ − <40) | 0.527 | **0.550** |

- 기존 점수에서 waste 볼은 평균 62.9 로 나머지 투구(48.5)보다 높았음 (로케이션을 보지 않는 모델이라 빠진 공도 물리량만으로 평가) → v2 부터 점수 제외

### 베이스라인(v1) 결과 (검증셋)
- 1단계 RandomForest : logloss 0.449 (사전확률 0.916), accuracy 0.817
- 3단계 LGBM : RMSE 0.1609 (평균 baseline 0.1675), R² 0.077
- 4단계 : 투수×구종(100구+) 구위 score vs whiff% Spearman 0.71, 투수 단위(300구+) 0.59

### 웹 분석 페이지 (`web/`)
투수를 이름 또는 리그→구단→선수 드롭다운으로 찾아(시즌 2025/2024 선택), 포수 시점 스트라이크 존에 투구별 구위를 색 농도로 표시하고 전력분석 패널을 함께 보여준다.
- 패널 : 요약(구위 퍼센타일·Whiff%·CSW%·피안타율·xwOBA), 스카우팅 노트(규칙 기반), 구종 아스널, 구종별 구위 분포(리그 대비), 코스별 히트맵, 구위 구간별 결과(리그 대비), 카운트별 피치 믹스, 월별/경기 내 투구수별 구위 추이, 좌우 스플릿
- 필터 : 구종, 결과, 타자 손, 카운트 상황, 구위 범위, 팀(이적 투수), 검증기간만
- 시즌 : 2026 / 2025 / 2024. 2024·2026 은 2025 학습 모델을 그대로 적용한 out-of-sample 점수

```bash
python export_web_data.py          # web/public/data 생성 (games_24/25_final/26.pkl, models/ 필요. 없는 pkl 은 pybaseball 로 자동 다운로드)
cd web && npm install && npm run dev
npx vercel --prod --archive=tgz    # web/ 에서 배포 (투수별 파일이 많아 아카이브 업로드 필수)
```

### 실행
```bash
pip install pandas numpy scipy scikit-learn lightgbm shap matplotlib pyarrow pybaseball jupyter
jupyter nbconvert --to notebook --execute --inplace stuff_pipeline_260929.ipynb   # v1
jupyter nbconvert --to notebook --execute --inplace stuff_pipeline_261005.ipynb   # v2 (v1 모델과 비교 포함)
```
데이터(`games_25_final.pkl`)는 레포에 포함하지 않는다. 파일이 없으면 `stuff_pipeline.load_regular_season()`이 pybaseball로 2025 시즌을 받아 같은 이름으로 캐시한다.

### 구조
```
CLAUDE.md                     프로젝트 규칙 (파이프라인 정의, 데이터 규칙, 업무일지 규칙)
stuff_pipeline.py             단계별 공통 함수
stuff_pipeline_YYMMDD.ipynb   파이프라인 실행 노트북
outputs/                      그림, 지표 CSV, 검증기간 리더보드
업무일지/                      일일 업무일지
```
