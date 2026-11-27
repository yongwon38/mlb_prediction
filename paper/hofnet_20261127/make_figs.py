"""논문 그림 : 저장된 결과 파일만 읽어 벡터 PDF 로 (재학습 없음)
실행 (프로젝트 루트) : python paper/hofnet_20261127/make_figs.py
출력 : paper/hofnet_20261127/figs/*.pdf
"""
import os, sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
import numpy as np
import pandas as pd

sys.stdout.reconfigure(encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
FIG = os.path.join(HERE, 'figs')
os.makedirs(FIG, exist_ok=True)
for f in ('malgun.ttf', 'malgunbd.ttf'):
    p = os.path.join(os.environ.get('WINDIR', 'C:/Windows'), 'Fonts', f)
    if os.path.exists(p):
        font_manager.fontManager.addfont(p)
plt.rcParams.update({
    'font.family': 'Malgun Gothic', 'font.size': 7.5, 'axes.titlesize': 8, 'axes.labelsize': 7.5, 'legend.fontsize': 6.8,
    'xtick.labelsize': 6.8, 'ytick.labelsize': 6.8, 'axes.unicode_minus': False, 'pdf.fonttype': 42,
    'axes.spines.top': False, 'axes.spines.right': False, 'axes.linewidth': 0.6, 'lines.linewidth': 1.1,
    'savefig.bbox': 'tight', 'savefig.pad_inches': 0.02,
})
COL, FULL = 3.45, 7.0
C = {'lgbm': '#1f4e79', 'r': '#c0392b', 'a0': '#7f7f7f', 'a5': '#d4a017', 'p1': '#2e8b57'}
rd = lambda *p: pd.read_csv(os.path.join('outputs', *p), encoding='utf-8-sig')


def save(fig, name):
    fig.savefig(os.path.join(FIG, name))
    plt.close(fig)
    print('저장', name)


# ---------------------------------------------------------------------------
# 그림 2 : (a) 합성 데이터 강신호 R² — 원형 붕괴 vs 결정적 평균, (b) 예측 십분위별 실제 y (2025 검증, 시드 42)
# ---------------------------------------------------------------------------
s = rd('hofnet_r', 'synth_summary.csv')
s = s[s['DGP'] == 'strong']
dec = rd('hofnet_r', 'deciles.csv').set_index(rd('hofnet_r', 'deciles.csv').columns[0])
fig, ax = plt.subplots(1, 2, figsize=(COL, 1.95))
spec = [('기존 A0 (β=1)', 'HOF-Net (원형)', C['a0'], 'o', '-'), ('기존 A5 (결정적)', 'HOF-Net 결정적', C['a5'], 's', '--'),
        ('HOF-Net-R P1', 'R-Det', C['r'], '^', '-')]
for key, lab, col, mk, ls in spec:
    g = s[s['model'] == key].sort_values('N')
    ax[0].errorbar(g['N'], g['R2 mean'], yerr=g['R2 std'], color=col, marker=mk, ms=3, ls=ls, label=lab, capsize=1.5, lw=1)
ax[0].set_xscale('log')
ax[0].set_xticks([2000, 10000, 50000], ['2천', '1만', '5만'])
ax[0].set_xlabel('학습 표본 수 N')
ax[0].set_ylabel('검증 $R^2$')
ax[0].set_ylim(-0.1, 1.05)
ax[0].set_title('(a) 합성 데이터 (강신호)', loc='left')
ax[0].legend(frameon=False, loc='center right', handlelength=1.6)
x = np.arange(1, 11)
for key, lab, col, mk, ls in [('LGBM v4', 'LightGBM v4', C['lgbm'], 'D', '-'), ('기존 HOF-Net A0', 'HOF-Net (원형)', C['a0'], 'o', '-'),
                              ('HOF-Net-R P4 (ZIB)', 'R-ZIB', C['r'], '^', '--')]:
    ax[1].plot(x, dec.loc[key].to_numpy(), color=col, marker=mk, ms=2.8, ls=ls, label=lab)
ax[1].set_xlabel('예측값 십분위')
ax[1].set_ylabel('실제 $y$ 평균')
ax[1].set_xticks([1, 5, 10])
ax[1].set_ylim(0.05, 0.16)
ax[1].set_title('(b) 예측 십분위 (2025 검증)', loc='left')
ax[1].legend(frameon=False, loc='upper left', handlelength=1.6, borderaxespad=0.1)
fig.tight_layout(w_pad=1.2)
save(fig, 'fig_collapse.pdf')

# ---------------------------------------------------------------------------
# 그림 3 : LightGBM v4 대비 Δρ(구위, whiff%) 와 투수 군집 부트스트랩 95% CI (시드 42)
# ---------------------------------------------------------------------------
diag = rd('hofnet_diag', 'results.csv').set_index('run')
rev = rd('hofnet_review', 'results.csv').set_index('run')
boot = rd('hofnet_r', 'bootstrap_rho_whiff.csv').set_index(rd('hofnet_r', 'bootstrap_rho_whiff.csv').columns[0])
rows = [
    ('HOF-Net 결정적 (원형)', *boot.loc['기존 HOF-Net A5'].to_numpy(), '원형'),
    ('R-BLRh', *boot.loc['HOF-Net-R P2h'].to_numpy(), 'R'),
    ('R-ZIB (본 모델)', *boot.loc['HOF-Net-R P4 (ZIB)'].to_numpy(), 'R'),
    ('R-ZIB, 베이지안 헤드 제거', *rev.loc['b4', ['Δρ whiff%', 'Δρ whiff% CI 하한', 'Δρ whiff% CI 상한']].to_numpy(), '대조'),
    ('MLP 인코더 + ZIB', *rev.loc['b2', ['Δρ whiff%', 'Δρ whiff% CI 하한', 'Δρ whiff% CI 상한']].to_numpy(), '대조'),
    ('R-ZIB + SWA', *diag.loc['h2_cos_swa P4', ['ρ − LGBM', 'ρ − LGBM 95% CI 하한', 'ρ − LGBM 95% CI 상한']].to_numpy(), '진단'),
    ('R-Det, LGBM 증류', *diag.loc['h6b_distill_all P1', ['ρ − LGBM', 'ρ − LGBM 95% CI 하한', 'ρ − LGBM 95% CI 상한']].to_numpy(), '진단'),
    ('LGBM 2부 모형 (ZIB)', *rev.loc['B1b two-part LGBM (ZIB)', ['Δρ whiff%', 'Δρ whiff% CI 하한', 'Δρ whiff% CI 상한']].to_numpy(), '대조'),
]
fig, ax = plt.subplots(figsize=(COL, 2.05))
mk = {'원형': ('o', C['a0']), 'R': ('^', C['r']), '대조': ('s', C['lgbm']), '진단': ('D', C['p1'])}
for i, (lab, d, lo, hi, kind) in enumerate(rows):
    y = len(rows) - 1 - i
    m, col = mk[kind]
    ax.plot([lo, hi], [y, y], color=col, lw=1.2)
    ax.plot(d, y, marker=m, color=col, ms=4, mfc='white' if kind != 'R' else col)
    ax.text(0.052, y, f'{d:+.3f}', va='center', ha='right', fontsize=6.3, color='#333')
ax.axvline(0, color='#444', lw=0.7, ls=':')
ax.set_yticks(range(len(rows)), [r[0] for r in rows][::-1])
ax.set_xlim(-0.095, 0.055)
ax.set_xlabel('Δρ(구위, whiff%) vs LightGBM v4  (95% CI)')
for sp in ('left',):
    ax.spines[sp].set_visible(False)
ax.tick_params(axis='y', length=0)
fig.tight_layout()
save(fig, 'fig_forest.pdf')

# ---------------------------------------------------------------------------
# 그림 4 : (a) 요인 그룹 기여 비중 LGBM(TreeSHAP) vs HOF-Net-R(그룹 Shapley), (b) 배경 수 K 에 따른 설명 안정성
# ---------------------------------------------------------------------------
ex = rd('model_choice', 'explain_agreement.csv').set_index(rd('model_choice', 'explain_agreement.csv').columns[0])
groups = ['구속', '수직 무브먼트', '수평 무브먼트', '진입각', '릴리스 위치', '익스텐션', '회전', '투구손']
lg = ex.loc[[f'{g} 비중' for g in groups]].iloc[:, 0].to_numpy()
hf = ex.loc[[f'{g} 비중' for g in groups]].iloc[:, 1].to_numpy()
stab = rd('model_choice', 'explain_stability.csv')
ks = stab[stab['비교'].str.contains('K=')].copy()
ks['K'] = ks['비교'].str.extract(r'K=(\d+) vs')[0].astype(int)
fig, ax = plt.subplots(1, 2, figsize=(FULL, 1.75), gridspec_kw={'width_ratios': [1.65, 1]})
xx = np.arange(len(groups))
w = 0.38
ax[0].bar(xx - w / 2, lg, w, color=C['lgbm'], label='LightGBM v4 (TreeSHAP)')
ax[0].bar(xx + w / 2, hf, w, color='white', edgecolor=C['r'], hatch='////', lw=0.8, label='HOF-Net-R (그룹 Shapley, K=8)')
ax[0].set_xticks(xx, groups)
ax[0].set_ylabel('|기여| 평균 비중')
ax[0].set_title('(a) 요인 그룹별 기여 비중 (2026, 2만 구)', loc='left')
ax[0].legend(frameon=False)
ax[1].plot(ks['K'], ks['그룹별 상관 평균'], marker='o', ms=3, color=C['r'], label='그룹 기여 상관 (평균)')
ax[1].plot(ks['K'], ks['그룹별 상관 최소'], marker='s', ms=3, ls='--', color=C['a0'], label='그룹 기여 상관 (최소 그룹)')
ax[1].plot(ks['K'], ks['최대 + 요인 일치율'], marker='^', ms=3, ls=':', color=C['lgbm'], label='최대 (+) 요인 일치율')
ax[1].axvline(8, color='#999', lw=0.6, ls=':')
ax[1].set_xscale('log', base=2)
ax[1].set_xticks([1, 4, 8, 16, 32], ['1', '4', '8', '16', '32'])
ax[1].set_xlabel('배경 참조 수 K (기준 : K=64)')
ax[1].set_ylim(0.35, 1.02)
ax[1].set_title('(b) 배경 수에 따른 설명 안정성', loc='left')
ax[1].legend(frameon=False, loc='lower right')
fig.tight_layout(w_pad=1.5)
save(fig, 'fig_explain.pdf')
