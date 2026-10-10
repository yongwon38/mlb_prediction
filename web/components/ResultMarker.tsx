"use client";
import { type ResultShape } from "@/lib/analysis";
import { useT } from "@/lib/i18n";

/** 투구 분포도·타구 분포도 공용 결과 기호 : ● 비타격 / ■ 아웃 / ▲ 1루타 / ◆ 2·3루타 / ★ 홈런 */
export function ResultMarker({
  shape,
  x,
  y,
  r = 3.8,
  fill,
  opacity = 1,
  ring = "none",
}: {
  shape: ResultShape;
  x: number;
  y: number;
  r?: number;
  fill: string;
  opacity?: number;
  ring?: string;
}) {
  const c = { fill, fillOpacity: opacity, stroke: ring, strokeWidth: 0.75 };
  switch (shape) {
    case "square":
      return <rect x={x - r * 0.9} y={y - r * 0.9} width={r * 1.8} height={r * 1.8} rx={1} {...c} />;
    case "triangle":
      return <path d={`M${x},${y - r * 1.25} L${x + r * 1.15},${y + r * 0.85} L${x - r * 1.15},${y + r * 0.85} Z`} {...c} />;
    case "diamond":
      return <path d={`M${x},${y - r * 1.3} L${x + r * 1.15},${y} L${x},${y + r * 1.3} L${x - r * 1.15},${y} Z`} {...c} />;
    case "star": {
      const R = r * 1.45, ri = R * 0.45;
      const d = Array.from({ length: 10 }, (_, i) => {
        const a = (Math.PI / 5) * i - Math.PI / 2;
        const rr = i % 2 ? ri : R;
        return `${i ? "L" : "M"}${(x + rr * Math.cos(a)).toFixed(2)},${(y + rr * Math.sin(a)).toFixed(2)}`;
      }).join(" ");
      return <path d={`${d} Z`} {...c} />;
    }
    default:
      return <circle cx={x} cy={y} r={r} {...c} />;
  }
}

/** 결과 기호 범례. color 를 주면 결과별 색, 없으면 회색 기호 */
export function ResultLegend({ shapes, color }: { shapes: ResultShape[]; color?: (s: ResultShape) => string }) {
  const labels = useT().shapes;
  return (
    <>
      {shapes.map((s) => (
        <span key={s} className="flex items-center gap-1">
          <svg width={12} height={12} aria-hidden>
            <ResultMarker shape={s} x={6} y={6.3} r={3.6} fill={color ? color(s) : "var(--muted)"} />
          </svg>
          {labels[s]}
        </span>
      ))}
    </>
  );
}
