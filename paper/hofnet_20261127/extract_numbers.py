"""논문 본문 수치의 출처 대조표 : 저장된 결과 파일만 읽어 numbers.md 로 정리 (재학습 없음)
실행 (프로젝트 루트) : python paper/hofnet_20261127/extract_numbers.py
"""
import json, os, sys

import pandas as pd

sys.stdout.reconfigure(encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
R = lambda *p: os.path.join('outputs', *p)
out = ['# 본문 수치 → 출처 대조표 (extract_numbers.py 자동 생성)', '']


def table(title, path, df, nd=4):
    out.extend([f'## {title}', f'출처 : `{path}`', '', df.round(nd).to_markdown(), ''])


rd = lambda p, **k: pd.read_csv(p, encoding='utf-8-sig', **k)

# 1. 점·분포 예측 (5 시드 평균)
p = R('hofnet_r', 'point_prob.csv')
d = rd(p, index_col=0)
cols = ['RMSE mean', 'RMSE std', 'R2 mean', 'CRPS mean', 'NLL (Gaussian) mean', '보정 오차 mean', '0점 Brier mean', 'bin log score mean',
        '커버리지 50% mean', '커버리지 80% mean', '커버리지 90% mean', '커버리지 95% mean', '실제 0 비율 mean', '예측 P(0) 평균 mean', 'U_global 비중 mean']
table('점·분포 예측 (2025 검증, 5 시드 평균)', p, d[[c for c in cols if c in d.columns]], 5)

# 2. 구위 지표
p = R('hofnet_r', 'stuff_metrics.csv')
table('구위 지표 (5 시드 평균 ± 표준편차)', p, rd(p, index_col=0).T, 4)
p = R('hofnet_r', 'stuff_metrics_by_seed.csv')
d = rd(p, index_col=0)
table('구위 지표 시드별 (ρ whiff, xwOBAcon)', p, d[d.columns[:3]], 6)
for f in ('bootstrap_rho_whiff.csv', 'bootstrap_rmse.csv'):
    p = R('hofnet_r', f)
    table(f'투수 군집 부트스트랩 (시드 42) : {f}', p, rd(p, index_col=0), 5)

# 3. 합성 데이터, 원형 붕괴
p = R('hofnet_r', 'synth_summary.csv')
table('합성 데이터 E1', p, rd(p).pivot_table(index=['DGP', 'N'], columns='model', values='R2 mean'), 4)
p = R('hofnet_r', 'synth_gate0.json')
out.extend([f'## Gate 0', f'출처 : `{p}`', '', '```', json.dumps(json.load(open(p, encoding='utf-8')), ensure_ascii=False, indent=1), '```', ''])
p = R('hofnet_nopt', 'collapse_check.csv')
table('원형 HOF-Net 붕괴 점검 (v4 입력 14개)', p, rd(p, index_col=0), 5)

# 4. 불확실성
for f in ('uncertainty_size_curve.csv', 'uncertainty_ood.csv', 'vi_vs_blr.csv'):
    p = R('hofnet_r', f)
    table(f'불확실성 : {f}', p, rd(p, index_col=0), 6)

# 5. ZIB 효과 분리, 격차 진단
p = R('hofnet_review', 'results.csv')
d = rd(p, index_col=0)
table('ZIB 효과 분리·대조 실험 (시드 42)', p, d[['RMSE', 'CRPS', '0점 Brier', 'bin log score', 'ρ whiff%', 'Δρ whiff%', 'Δρ whiff% CI 하한', 'Δρ whiff% CI 상한']], 4)
p = R('hofnet_diag', 'results.csv')
d = rd(p, index_col=0)
table('격차 진단 (시드 42)', p, d[['검증 투수×구종 ρ(구위, whiff%)', 'ρ − LGBM', 'ρ − LGBM 95% CI 하한', 'ρ − LGBM 95% CI 상한', '학습 투구', '파라미터 수']], 4)

# 6. 운영 모델 선택·설명
for f in ('perf_stuff_metrics.csv', 'explain_agreement.csv', 'explain_stability.csv', 'explain_monotonic.csv'):
    p = R('model_choice', f)
    table(f'운영 모델 : {f}', p, rd(p, index_col=0), 4)
p = R('model_choice', 'agree_scores.json')
out.extend([f'## 앙상블 vs LGBM 2026 점수 일치', f'출처 : `{p}`', '', '```', json.dumps(json.load(open(p, encoding='utf-8')), ensure_ascii=False, indent=1), '```', ''])

# 7. 학습 요약
p = R('hofnet_r', 'summary.json')
s = json.load(open(p, encoding='utf-8'))
out.extend([f'## 학습 요약', f'출처 : `{p}`', '', '```', json.dumps(s, ensure_ascii=False, indent=1)[:4000], '```', ''])

# 8. 운영 적용 (2026-11-27 세션 결과, outputs/ 에 저장되지 않음 → 업무일지 출처)
out.extend(['## 운영 적용 (출처 : 업무일지/업무일지_20261127.md §2·§4·§10)', '',
            '- 시드 42 단일 vs 앙상블 (2025 검증) : ρ whiff 0.7002 → 0.6985, Δ −0.0017 [−0.019, +0.017]; RMSE 0.16818 → 0.16826',
            '- 2026 기존 웹 점수와 일치 : 투수×구종 r 0.979, 상위 50 겹침 39',
            '- 브라우저 추론 : E[Y] 최대 |Δ| 8.8e-8 (1,000구), 구위 0.0036점, 반응 곡선 20개 0.0043점, 실제 투구 20구 0.0009점, 1구 0.45 ms · 41구 17 ms (Node)',
            '- 반응 곡선 예 (업무일지_20261127 §5) : 좌투 FF 릴리스 높이 4.5 → 7.0 ft 에서 구위 47.8 → 80.0', '',
            '## 설명 계산 비용 (출처 : 업무일지/업무일지_20261016.md 78행, cost.csv 미저장)', '',
            '- CPU 4스레드 1만 구 : LGBM TreeSHAP 4.5 초 / HOF 순열 근사 111 초 / HOF 정확 999 초 (GPU 약 100 초), 순열 근사 vs 정확 그룹 상관 0.988', '',
            '## 원값이 위 표에서 반올림돼 보이는 수치 (원 파일 값)', '',
            '- collapse_check A0 검증 예측 표준편차 9.1216e-05, uncertainty_size_curve U_global(100%) 2.51e-06, explain_agreement 가법성 오차 3.2532e-09', ''])

open(os.path.join(HERE, 'numbers.md'), 'w', encoding='utf-8').write('\n'.join(out))
print('numbers.md', len(out), '줄')
