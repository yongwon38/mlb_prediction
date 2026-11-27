"""본문 수치 대조 : main.tex 의 소수(小數)마다 numbers.md 에 같은 자릿수로 반올림해 일치하는 값이 있는지 확인
일치하지 않는 수치만 출력 (사람이 직접 확인할 목록). 실행 (프로젝트 루트) : python paper/hofnet_20261127/check_numbers.py
"""
import os, re, sys

sys.stdout.reconfigure(encoding='utf-8')
HERE = os.path.dirname(os.path.abspath(__file__))
tex = open(os.path.join(HERE, 'main.tex'), encoding='utf-8').read()
tex = tex[tex.index('\\begin{document}'):tex.index('\\bibliographystyle')]
src = open(os.path.join(HERE, 'numbers.md'), encoding='utf-8').read()
num = r'[-−]?\d+(?:,\d{3})*(?:\.\d+)?(?:e[-+]?\d+)?'
vals = []
for m in re.finditer(num, src):
    try:
        vals.append(float(m.group().replace('−', '-').replace(',', '')))
    except ValueError:
        pass
vals += [v * 100 for v in vals]             # 비율 → %
vals = set(vals)
unmatched = []
for m in re.finditer(r'(?<![\w.])(\$-\$|−|-)?(\d+\.\d+)(?:\\times10\^\{(-?\d+)\})?', tex):
    sign = -1 if m.group(1) else 1
    s = m.group(2)
    nd = len(s.split('.')[1])
    x = float(s) * (10 ** int(m.group(3)) if m.group(3) else 1)
    if m.group(3):
        nd = nd - int(m.group(3))
    ok = any(abs(round(abs(v), nd) - x) < 10 ** (-nd) * 0.51 for v in vals)
    if not ok:
        ctx = tex[max(0, m.start() - 40):m.end() + 20].replace('\n', ' ')
        unmatched.append((m.group(0), ctx))
print(f'본문 소수 {len(re.findall(r"\d+\.\d+", tex))}개 중 출처 불일치 후보 {len(unmatched)}개')
for x, c in unmatched:
    print(f'  {x:>12}  …{c}…')
