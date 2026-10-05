"use client";
import { divergingPole, useDarkMode } from "@/lib/colors";
import { fmtSigned } from "@/lib/explain";

/** 요인별 기여 막대 (0 기준 좌우). + = 구위를 올림(빨강) / − = 깎음(파랑). ref 가 있으면 비교 기준(리그 동일 구종 평균)을 눈금으로 표시 */
export default function ContribBars({ groups, values, compare: refVals, dom }: { groups: string[]; values: number[]; compare?: number[] | null; dom?: number }) {
  const dark = useDarkMode();
  const D = dom ?? Math.max(2, Math.ceil(Math.max(...values.map(Math.abs), ...(refVals ?? []).map(Math.abs)) + 0.5));
  const W = 560, L = 112, R = 52, RH = 26, T = 6;
  const H = T + groups.length * RH + 22;
  const x = (v: number) => L + ((Math.max(-D, Math.min(D, v)) + D) / (2 * D)) * (W - L - R);
  const ticks = [-D, -D / 2, 0, D / 2, D];
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="요인별 구위 기여 (점)">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={T} y2={H - 20} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} />
          <text x={x(t)} y={H - 6} fontSize={10} fill="var(--muted)" textAnchor="middle" className="tnum">
            {fmtSigned(t, Number.isInteger(t) ? 0 : 1)}
          </text>
        </g>
      ))}
      {groups.map((g, i) => {
        const v = values[i];
        const y = T + i * RH;
        const x0 = x(0), x1 = x(v);
        const w = Math.max(1, Math.abs(x1 - x0));
        const pos = v >= 0;
        return (
          <g key={g}>
            <text x={L - 8} y={y + RH / 2 + 4} fontSize={12} fill="var(--ink-2)" textAnchor="end">
              {g}
            </text>
            <rect x={Math.min(x0, x1)} y={y + 5} width={w} height={RH - 10} rx={3} fill={divergingPole(pos, dark)} />
            {refVals && (
              <line x1={x(refVals[i])} x2={x(refVals[i])} y1={y + 2} y2={y + RH - 2} stroke="var(--ink)" strokeWidth={1.5} strokeDasharray="2 2">
                <title>{`리그 동일 구종 평균 ${fmtSigned(refVals[i], 1)}점`}</title>
              </line>
            )}
            <text x={pos ? Math.max(x1, x0) + 5 : Math.min(x1, x0) - 5} y={y + RH / 2 + 4} fontSize={11} fill="var(--ink)" textAnchor={pos ? "start" : "end"} className="tnum font-medium">
              {fmtSigned(v, 1)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
