"use client";
import { useMemo, useRef, useState } from "react";
import type { Pitch } from "@/lib/types";
import { PA_LABELS, RESULT_LABELS, ZONE_BOT, ZONE_HALF_WIDTH, ZONE_TOP, resultShape } from "@/lib/analysis";
import { STUFF_DOMAIN, stuffColor, stuffOpacity, useDarkMode } from "@/lib/colors";
import { ResultLegend, ResultMarker } from "@/components/ResultMarker";

const W = 440;
const H = 500;
const X_DOM: [number, number] = [-2.2, 2.2];
const PX = W / (X_DOM[1] - X_DOM[0]); // ft -> px (가로·세로 동일 스케일)
const Z_TOP = H / PX;
const sx = (x: number) => (x - X_DOM[0]) * PX;
const sz = (z: number) => (Z_TOP - z - 0.15) * PX;

interface Props {
  pitches: Pitch[];
  ghost?: Pitch[]; // 구위 구간 선택 시 나머지 공 (회색 배경, hover 제외)
  pitchNames: Record<string, string>;
  onPick?: (p: Pitch) => void; // 마우스로 점을 클릭하면 호출 (산출 근거 페이지로 이동)
}

export default function StrikeZone({ pitches, ghost = [], pitchNames, onPick }: Props) {
  const dark = useDarkMode();
  const svgRef = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<Pitch | null>(null);

  // 구위 낮은 공을 먼저 그려 진한(구위 높은) 공이 위에 오도록
  const pts = useMemo(
    () =>
      pitches
        .filter((p) => p.x !== null && p.z !== null)
        .sort((a, b) => (a.s ?? -1) - (b.s ?? -1)) // 점수 없는 공(null)은 맨 아래
        .map((p) => ({ p, x: sx(p.x as number), y: sz(p.z as number) })),
    [pitches],
  );

  const ghostPts = useMemo(
    () => ghost.filter((p) => p.x !== null && p.z !== null).map((p) => ({ p, x: sx(p.x as number), y: sz(p.z as number) })),
    [ghost],
  );

  // 마커 레이어는 데이터가 바뀔 때만 다시 그린다 (hover 시 재렌더 방지)
  const layer = useMemo(
    () => (
      <g>
        {ghostPts.map(({ p, x, y }) => (
          <circle key={`g${p.i}`} cx={x} cy={y} r={2} fill="var(--muted)" fillOpacity={0.22} />
        ))}
        {pts.map(({ p, x, y }) => (
          p.s === null ? (
            <ResultMarker key={p.i} shape={resultShape(p.r)} x={x} y={y} fill="none" opacity={0} ring="var(--muted)" />
          ) : (
            <ResultMarker key={p.i} shape={resultShape(p.r)} x={x} y={y} fill={stuffColor(p.s, dark)} opacity={stuffOpacity(p.s)} ring="var(--surface)" />
          )
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
    let bd = 14 * 14; // 근접 포인트 탐색 반경 (px)
    for (const q of pts) {
      const d = (q.x - mx) ** 2 + (q.y - my) ** 2;
      if (d <= bd) {
        bd = d;
        best = q;
      }
    }
    setHover(best?.p ?? null);
  };

  const zl = sx(-ZONE_HALF_WIDTH), zr = sx(ZONE_HALF_WIDTH), zt = sz(ZONE_TOP), zb = sz(ZONE_BOT);
  const cw = (zr - zl) / 3, ch = (zb - zt) / 3;
  const hp = hover ? { x: sx(hover.x as number), y: sz(hover.z as number) } : null;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        className="w-full h-auto touch-none select-none"
        role="img"
        aria-label={`포수 시점 투구 위치 ${pts.length}구, 빨갈수록 구위 높음`}
        onPointerMove={onMove}
        onPointerLeave={() => setHover(null)}
        onPointerDown={onMove}
        onClick={(e) => {
          // 터치는 탭 = 툴팁만, 마우스 클릭 = 산출 근거로 이동
          if (onPick && hover && hover.s !== null && (e.nativeEvent as PointerEvent).pointerType !== "touch") onPick(hover);
        }}
        style={onPick && hover && hover.s !== null ? { cursor: "pointer" } : undefined}
      >
        <rect x={0} y={0} width={W} height={H} fill="var(--surface)" />
        {/* 존 바깥 영역 음영 기준 + 3×3 격자 */}
        {[1, 2].map((i) => (
          <g key={i} stroke="var(--grid)" strokeWidth={1}>
            <line x1={zl + cw * i} x2={zl + cw * i} y1={zt} y2={zb} />
            <line x1={zl} x2={zr} y1={zt + ch * i} y2={zt + ch * i} />
          </g>
        ))}
        {/* 홈플레이트 (포수 시점) */}
        <path
          d={`M${sx(-0.708)},${sz(0.22)} L${sx(0.708)},${sz(0.22)} L${sx(0.708)},${sz(0.12)} L${sx(0)},${sz(0.02)} L${sx(-0.708)},${sz(0.12)} Z`}
          fill="var(--surface-2)"
          stroke="var(--axis)"
        />
        <text x={8} y={H - 10} fontSize={11} fill="var(--muted)">
          ← 3루쪽
        </text>
        <text x={W - 8} y={H - 10} fontSize={11} fill="var(--muted)" textAnchor="end">
          1루쪽 →
        </text>
        {layer}
        <rect x={zl} y={zt} width={zr - zl} height={zb - zt} fill="none" stroke="var(--zone-line)" strokeWidth={1.5} />
        {hover && hp && (
          <g pointerEvents="none">
            <circle cx={hp.x} cy={hp.y} r={10} fill="none" stroke="var(--ink)" strokeWidth={1.5} />
          </g>
        )}
      </svg>

      {hover && hp && <Tooltip p={hover} left={(hp.x / W) * 100} top={(hp.y / H) * 100} pitchNames={pitchNames} hint={onPick && hover.s !== null ? "클릭하면 구위 산출 근거" : undefined} />}

      <Legend dark={dark} n={pts.length} />
    </div>
  );
}

export function Tooltip({ p, left, top, pitchNames, hint }: { p: Pitch; left: number; top: number; pitchNames: Record<string, string>; hint?: string }) {
  const right = left > 55;
  const fmt = (v: number | null, d = 1, unit = "") => (v === null ? "-" : `${v.toFixed(d)}${unit}`);
  return (
    <div
      className="absolute z-20 pointer-events-none card shadow-lg px-3 py-2 text-xs w-56"
      style={{ left: `${left}%`, top: `${top}%`, transform: `translate(${right ? "calc(-100% - 14px)" : "14px"}, -50%)` }}
    >
      <div className="flex justify-between font-medium text-ink">
        <span>
          {pitchNames[p.pt] ?? p.pt} ({p.pt})
        </span>
        <span className="tnum">{p.s === null ? "구위 -" : `구위 ${p.s.toFixed(1)}`}</span>
      </div>
      {p.s === null && <div className="text-muted mb-1">{p.r === 9 ? "사구" : "존에서 크게 벗어난 볼"} — 구위 점수 제외</div>}
      <div className="text-muted mb-1">
        {p.date} · {p.inn}회 · {p.b}-{p.k} 카운트 · {p.lhb ? "좌타" : "우타"}
      </div>
      <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 tnum text-ink-2">
        <dt>결과</dt>
        <dd className="text-ink font-medium">
          {RESULT_LABELS[p.r]}
          {p.pa > 0 && p.pa !== 1 && !(p.pa >= 3 && p.pa <= 6) ? ` (${PA_LABELS[p.pa]})` : ""}
        </dd>
        <dt>구속</dt>
        <dd>{fmt(p.v, 1, " mph")}</dd>
        <dt>무브먼트</dt>
        <dd>
          H {fmt(p.hb, 1)} / V {fmt(p.ivb, 1)} in
        </dd>
        <dt>회전수</dt>
        <dd>{fmt(p.spin, 0, " rpm")}</dd>
        {p.ev !== null && (
          <>
            <dt>타구</dt>
            <dd>
              {fmt(p.ev, 1)} mph / {fmt(p.la, 0)}°
            </dd>
            <dt>xBA</dt>
            <dd>{p.xba === null ? "-" : p.xba.toFixed(3)}</dd>
          </>
        )}
        <dt>경기 내</dt>
        <dd>{p.gp}번째 투구</dd>
      </dl>
      {hint && <div className="mt-1.5 text-accent-ink">{hint} →</div>}
    </div>
  );
}

function Legend({ dark, n }: { dark: boolean; n: number }) {
  const stops = Array.from({ length: 11 }, (_, i) => {
    const s = STUFF_DOMAIN[0] + ((STUFF_DOMAIN[1] - STUFF_DOMAIN[0]) * i) / 10;
    const [r, g, b] = stuffColor(s, dark).slice(4, -1).split(",");
    return `rgba(${r},${g},${b},${stuffOpacity(s)})`;
  });
  return (
    <div className="mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-2 text-xs text-ink-2">
      <div className="flex items-center gap-2">
        <span>구위</span>
        <span className="tnum text-muted">≤{STUFF_DOMAIN[0]}</span>
        <span className="h-2.5 w-32 rounded-sm" style={{ background: `linear-gradient(90deg, ${stops.join(",")})` }} />
        <span className="tnum text-muted">{STUFF_DOMAIN[1]}≥</span>
      </div>
      <div className="flex flex-wrap items-center gap-3" aria-label="마커 모양">
        <ResultLegend shapes={["dot", "square", "triangle", "diamond", "star"]} />
        <span className="flex items-center gap-1">
          <svg width={12} height={12}>
            <circle cx={6} cy={6} r={4.5} fill="none" stroke="var(--muted)" strokeWidth={1} />
          </svg>
          점수 제외(존 밖 볼·사구)
        </span>
        <span className="tnum text-muted">{n.toLocaleString()}구</span>
      </div>
    </div>
  );
}
