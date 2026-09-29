# mlb_prediction

## 구위(Stuff) 지표 — 투구 물리량만으로 구위를 평가

[tjStuff+](https://medium.com/@thomasjamesnestico/modelling-tjstuff-v3-0-10b48294c7fb)처럼 **타석 정보(타자·카운트·로케이션) 없이 투구 데이터만으로 구위 자체의 위력**을 20~80 스케일로 산출한다. 데이터는 `pybaseball`(Statcast), 2025 정규시즌.

| 단계 | 내용 | 방법 |
|---|---|---|
| 1 | 타구방향·타구속도·발사각·공격각도 → 타구결과 (0 아웃 / 1 1루타 / 2 2·3루타 / 3 홈런) | RandomForest 다중분류 |
| 2 | 예측확률 기대값(0~3) → **타구질 score (0~1)** | Gamma 적합 → Beta 변환 |
| 3 | 투구 정보 → 타구질 score (헛스윙·루킹삼진 = 0) | LGBM 베이스라인 |
| 4 | 3단계 예측 → **구위 score (20~80, 중앙값 50, 대칭)** | ECDF → 정규분위수 |

- 학습 : 정규시즌 ~ 2025-08-28 / 검증 : 정규시즌 마지막 1개월 (2025-08-29 ~ 09-28)

### 베이스라인 결과 (검증셋)
- 1단계 RandomForest : logloss 0.449 (사전확률 0.916), accuracy 0.817
- 3단계 LGBM : RMSE 0.1609 (평균 baseline 0.1675), R² 0.077
- 4단계 : 투수×구종(100구+) 구위 score vs whiff% Spearman 0.71, 투수 단위(300구+) 0.59

### 실행
```bash
pip install pandas numpy scipy scikit-learn lightgbm shap matplotlib pyarrow pybaseball jupyter
jupyter nbconvert --to notebook --execute --inplace stuff_pipeline_260929.ipynb
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
