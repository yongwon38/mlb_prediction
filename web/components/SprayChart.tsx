"use client";
import { useMemo, useRef, useState } from "react";
import type { Pitch } from "@/lib/types";
import { type BattedStats, type ResultShape, battedStats, hitClass, resultShape } from "@/lib/analysis";
import { hitColor, useDarkMode } from "@/lib/colors";
import { Tooltip } from "@/components/StrikeZone";
import { ResultLegend, ResultMarker } from "@/components/ResultMarker";
import { f1, f3, pct } from "@/components/Panels";

// 필드 좌표 (ft) : 홈 = (0,0), +x = 1루 쪽, +y = 외야. 화면은 포수 시점과 같은 좌우 방향 (왼쪽 = 3루/좌익)
const X_DOM: [number, number] = [-265, 265];
const Y_DOM: [number, number] = [-25, 470];
const W = 440;
const PX = W / (X_DOM[1] - X_DOM[0]);
const H = Math.round((Y_DOM[1] - Y_DOM[0]) * PX);
const sx = (x: number) => (x - X_DOM[0]) * PX;
const sy = (y: number) => (Y_DOM[1] - y) * PX;

/** 외야 펜스 근사 : 양 파울폴 330ft, 중앙 400ft */
const fenceR = (deg: number) => 330 + 70 * Math.cos((deg * Math.PI) / 90);
const polar = (r: number, deg: number) => [r * Math.sin((deg * Math.PI) / 180), r * Math.cos((deg * Math.PI) / 180)];
const arcPath = (rOf: (d: number) => number) =>
  Array.from({ length: 91 }, (_, i) => {
    const d = -45 + i;
    const [x, y] = polar(rOf(d), d);
    return `${i ? "L" : "M"}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`;
  }).join(" ");
const FENCE = arcPath(fenceR);
const RINGS = [150, 250, 350];
const BASE = 90 / Math.SQRT2;

interface Props {
  ps: Pitch[]; // 선택 구간 투구 (전역 필터 적용 후)
  ghost: Pitch[]; // 선택하지 않은 구간 (흐리게)
  all: Pitch[]; // 비교 기준 (전역 필터 적용 후 전체)
  selecting: boolean;
  pitchNames: Record<string, string>;
}

const SPRAY_SHAPES: ResultShape[] = ["square", "triangle", "diamond", "star"];
const SHAPE_CLASS: Record<ResultShape, number> = { dot: 0, square: 0, triangle: 1, diamond: 2, star: 3 };

const inPlay = (p: Pitch) => p.r >= 4 && p.r <= 8;
const located = (p: Pitch) => inPlay(p) && p.hx !== null && p.hy !== null;

export default function SprayChart({ ps, ghost, all, selecting, pitchNames }: Props) {
  const dark = useDarkMode();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Pitch | null>(null);

  // 아웃 -> 1루타 -> 장타 -> 홈런 순으로 그려 안타가 위에 오도록
  const pts = useMemo(
    () =>
      ps
        .filter(located)
        .sort((a, b) => hitClass(a.r) - hitClass(b.r))
        .map((p) => ({ p, cls: hitClass(p.r), x: sx(p.hx as number), y: sy(p.hy as number) })),
    [ps],
  );
  const ghostPts = useMemo(() => ghost.filter(located).map((p) => ({ p, x: sx(p.hx as number), y: sy(p.hy as number) })), [ghost]);
  const missing = useMemo(() => ps.filter((p) => inPlay(p) && !located(p)).length, [ps]);
  const selStats = useMemo(() => battedStats(ps.filter(inPlay)), [ps]);
  const allStats = useMemo(() => battedStats(all.filter(inPlay)), [all]);

  const layer = useMemo(
    () => (
      <g>
        {ghostPts.map(({ p, x, y }) => (
          <circle key={p.i} cx={x} cy={y} r={2} fill="var(--muted)" fillOpacity={0.18} />
        ))}
        {pts.map(({ p, cls, x, y }) => (
          <ResultMarker key={p.i} shape={resultShape(p.r)} x={x} y={y} fill={hitColor(cls, dark)} opacity={cls === 0 ? 0.8 : 0.9} ring="var(--surface)" />
        ))}
      </g>
    ),
    [pts, ghostPts, dark],
  );

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = ((e.clientX - rect.left) / rect.width) * W;
    const my = ((e.clientY - rect.top) / rect.height) * H;
    let best: (typeof pts)[number] | null = null;
    let bd = 14 * 14;
    for (const q of pts) {
      const d = (q.x - mx) ** 2 + (q.y - my) ** 2;
      if (d <= bd) {
        bd = d;
        best = q;
      }
    }
    setHover(best?.p ?? null);
  };

  const [lx, ly] = polar(330, -45);
  const [rx, ry] = polar(330, 45);
  const hp = hover ? { x: sx(hover.hx as number), y: sy(hover.hy as number) } : null;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto touch-none select-none"
        role="img"
        aria-label={`인플레이 타구 분포 ${pts.length}개`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onPointerDown={onMove}
      >
        <rect x={0} y={0} width={W} height={H} fill="var(--surface)" />
        {/* 페어 지역 */}
        <path d={`M${sx(0)},${sy(0)} L${sx(lx)},${sy(ly)} ${FENCE.replace(/^M/, "L")} Z`} fill="var(--surface-2)" />
        {RINGS.map((r) => {
          const [tx, ty] = polar(r, 0);
          return (
            <g key={r}>
              <path d={arcPath(() => r)} fill="none" stroke="var(--grid)" strokeDasharray="3 4" />
              <text x={sx(tx) + 4} y={sy(ty) + 11} fontSize={10} fill="var(--muted)" className="tnum">
                {r}ft
              </text>
            </g>
          );
        })}
        <path d={FENCE} fill="none" stroke="var(--axis)" strokeWidth={1.5} />
        <line x1={sx(0)} y1={sy(0)} x2={sx(lx)} y2={sy(ly)} stroke="var(--axis)" />
        <line x1={sx(0)} y1={sy(0)} x2={sx(rx)} y2={sy(ry)} stroke="var(--axis)" />
        <path
          d={`M${sx(0)},${sy(0)} L${sx(BASE)},${sy(BASE)} L${sx(0)},${sy(2 * BASE)} L${sx(-BASE)},${sy(BASE)} Z`}
          fill="none"
          stroke="var(--axis)"
          strokeOpacity={0.7}
        />
        <text x={8} y={H - 8} fontSize={11} fill="var(--muted)">
          ← 3루쪽 (좌익)
        </text>
        <text x={W - 8} y={H - 8} fontSize={11} fill="var(--muted)" textAnchor="end">
          (우익) 1루쪽 →
        </text>
        {layer}
        {hover && hp && <circle cx={hp.x} cy={hp.y} r={10} fill="none" stroke="var(--ink)" strokeWidth={1.5} pointerEvents="none" />}
      </svg>

      {hover && hp && <Tooltip p={hover} left={(hp.x / W) * 100} top={(hp.y / H) * 100} pitchNames={pitchNames} />}

      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-ink-2" aria-label="타구 결과 범례">
        <ResultLegend shapes={SPRAY_SHAPES} color={(sh) => hitColor(SHAPE_CLASS[sh], dark)} />
        <span className="ml-auto tnum text-muted">
          타구 {pts.length.toLocaleString()}개{missing ? ` (좌표 없음 ${missing})` : ""}
        </span>
      </div>

      <BattedTable sel={selStats} all={allStats} selecting={selecting} />
    </div>
  );
}

function BattedTable({ sel, all, selecting }: { sel: BattedStats; all: BattedStats; selecting: boolean }) {
  const rows: [string, (s: BattedStats) => string][] = [
    ["타구 수", (s) => s.n.toLocaleString()],
    ["평균 타구속도", (s) => (s.ev === null ? "-" : `${f1(s.ev)} mph`)],
    ["하드히트% (95+)", (s) => pct(s.hardHit)],
    ["인플레이 안타율", (s) => f3(s.ba)],
    ["당겨침 / 센터 / 밀어침", (s) => `${pct(s.dir.pull, 0)} / ${pct(s.dir.center, 0)} / ${pct(s.dir.oppo, 0)}`],
    ["땅볼 / 라인드라이브 / 뜬공 / 팝업", (s) => `${pct(s.la.gb, 0)} / ${pct(s.la.ld, 0)} / ${pct(s.la.fb, 0)} / ${pct(s.la.pu, 0)}`],
  ];
  return (
    <table className="mt-3 w-full text-xs tnum">
      <thead>
        <tr className="text-muted border-b border-grid">
          <th className="text-left font-normal py-1.5">인플레이 타구</th>
          {selecting && <th className="text-right font-normal py-1.5 px-1.5">선택 구간</th>}
          <th className="text-right font-normal py-1.5 pl-1.5">{selecting ? "전체" : "값"}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map(([label, fmt]) => (
          <tr key={label} className="border-b border-grid last:border-0">
            <td className="py-1.5 text-ink-2">{label}</td>
            {selecting && <td className="py-1.5 px-1.5 text-right font-semibold text-ink">{fmt(sel)}</td>}
            <td className={`py-1.5 pl-1.5 text-right ${selecting ? "text-ink-2" : "font-semibold text-ink"}`}>{fmt(all)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
