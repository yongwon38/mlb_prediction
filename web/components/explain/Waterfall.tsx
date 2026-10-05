"use client";
import { divergingPole, useDarkMode } from "@/lib/colors";
import { fmtSigned } from "@/lib/explain";

/** 개별 투구 워터폴 : 기준 S0 -> 요인별 ± -> 최종 구위 (가로 = 구위 점수) */
export default function Waterfall({ groups, c, base, final }: { groups: string[]; c: number[]; base: number; final: number }) {
  const dark = useDarkMode();
  const steps: { label: string; from: number; to: number; kind: "base" | "step" | "final" }[] = [{ label: "기준", from: base, to: base, kind: "base" }];
  let acc = base;
  groups.forEach((g, j) => {
    steps.push({ label: g, from: acc, to: acc + c[j], kind: "step" });
    acc += c[j];
  });
  steps.push({ label: "최종 구위", from: final, to: final, kind: "final" });

  const vals = steps.flatMap((s) => [s.from, s.to]);
  const lo = Math.max(20, Math.floor(Math.min(...vals, 45) / 5) * 5);
  const hi = Math.min(80, Math.ceil(Math.max(...vals, 55) / 5) * 5);
  const W = 560, L = 112, R = 56, RH = 24, T = 6;
  const H = T + steps.length * RH + 22;
  const x = (v: number) => L + ((Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo)) * (W - L - R);
  const ticks = Array.from({ length: Math.round((hi - lo) / 5) + 1 }, (_, i) => lo + i * 5);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={`구위 ${final.toFixed(1)} 산출 과정`}>
      {ticks.map((t) => (
        <g key={t}>
          <line x1={x(t)} x2={x(t)} y1={T} y2={H - 20} stroke={t === 50 ? "var(--axis)" : "var(--grid)"} />
          <text x={x(t)} y={H - 6} fontSize={10} fill="var(--muted)" textAnchor="middle" className="tnum">
            {t}
          </text>
        </g>
      ))}
      {steps.map((s, i) => {
        const y = T + i * RH;
        const cy = y + RH / 2;
        const isStep = s.kind === "step";
        const d = s.to - s.from;
        const x0 = x(Math.min(s.from, s.to)), x1 = x(Math.max(s.from, s.to));
        return (
          <g key={s.label}>
            <text x={L - 8} y={cy + 4} fontSize={12} fill={isStep ? "var(--ink-2)" : "var(--ink)"} fontWeight={isStep ? 400 : 600} textAnchor="end">
              {s.label}
            </text>
            {isStep ? (
              <>
                <rect x={x0} y={y + 5} width={Math.max(1.5, x1 - x0)} height={RH - 10} rx={3} fill={divergingPole(d >= 0, dark)} />
                {i < steps.length - 1 && <line x1={x(s.to)} x2={x(s.to)} y1={y + RH - 5} y2={y + RH + 5} stroke="var(--muted)" strokeDasharray="2 2" />}
                <text x={x1 + 5} y={cy + 4} fontSize={11} fill="var(--ink)" className="tnum">
                  {fmtSigned(d, 1)}
                </text>
              </>
            ) : (
              <>
                <circle cx={x(s.to)} cy={cy} r={5} fill="var(--ink)" />
                <text x={x(s.to) + 9} y={cy + 4} fontSize={12} fill="var(--ink)" fontWeight={600} className="tnum">
                  {s.to.toFixed(1)}
                </text>
              </>
            )}
          </g>
        );
      })}
    </svg>
  );
}
