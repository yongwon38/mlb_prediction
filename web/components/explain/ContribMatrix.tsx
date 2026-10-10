"use client";
import { divergingColor, useDarkMode } from "@/lib/colors";
import { fmtSigned } from "@/lib/explain";
import { useT } from "@/lib/i18n";

export interface MatrixRow {
  key: string;
  label: React.ReactNode;
  n: number;
  score: number | null;
  c: number[] | null;
  ref?: number[] | null; // 비교 기준 (리그 동일 구종 평균 기여)
}

/** 행 = 구종 또는 구위 구간, 열 = 요인. 셀 = 평균 기여(점), 색은 diverging + 숫자 항상 표시 */
export default function ContribMatrix({ groups, rows, base, active, onRow, dom = 4 }: { groups: string[]; rows: MatrixRow[]; base: number; active?: string | null; onRow?: (k: string) => void; dom?: number }) {
  const dark = useDarkMode();
  const tt = useT();
  const t = tt.explain;
  return (
    <div className="overflow-x-auto -mx-1">
      <table className="w-full text-xs tnum border-separate" style={{ borderSpacing: 2 }}>
        <thead>
          <tr className="text-muted">
            <th className="text-left font-normal px-1.5 py-1">{t.matrixHead[0]}</th>
            <th className="text-right font-normal px-1.5 py-1">{t.matrixHead[1]}</th>
            <th className="text-right font-normal px-1.5 py-1">{t.matrixHead[2]}</th>
            {groups.map((g) => (
              <th key={g} className="font-normal px-0.5 py-1 text-center min-w-[44px] leading-tight">
                {g}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.key}
              onClick={onRow ? () => onRow(r.key) : undefined}
              className={`${onRow ? "cursor-pointer" : ""} ${active === r.key ? "outline outline-2 outline-[var(--ink)] rounded" : ""}`}
              aria-selected={active === r.key}
            >
              <td className="px-1.5 py-1.5 text-ink whitespace-nowrap">{r.label}</td>
              <td className="px-1.5 py-1.5 text-right text-ink-2">{r.n.toLocaleString()}</td>
              <td className="px-1.5 py-1.5 text-right font-semibold text-ink" title={r.score !== null ? t.scoreTitle(base.toFixed(1), fmtSigned(r.score - base, 1)) : undefined}>
                {r.score === null ? "-" : r.score.toFixed(1)}
              </td>
              {groups.map((g, j) => {
                if (!r.c) return <td key={g} className="text-center text-muted">-</td>;
                const v = r.c[j];
                const { fill, ink } = divergingColor(v, dom, dark);
                const ref = r.ref?.[j];
                return (
                  <td
                    key={g}
                    className="text-center rounded py-1.5 font-medium"
                    style={{ background: fill, color: ink }}
                    title={ref !== undefined ? t.cellTitle(g, fmtSigned(v, 1), fmtSigned(ref, 1), fmtSigned(v - ref, 1)) : t.cellTitleNoRef(g, fmtSigned(v, 1))}
                  >
                    {fmtSigned(v, 1)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
