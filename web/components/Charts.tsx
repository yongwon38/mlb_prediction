"use client";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { League, Pitch, Rates } from "@/lib/types";
import { COUNT_STATES, GAME_PITCH_BUCKETS, STUFF_BUCKETS, type Stats, groupBy, quantile, stats } from "@/lib/analysis";
import { pitchColor, sequential, useDarkMode } from "@/lib/colors";
import { Toggle, f1, f3, pct } from "./Panels";

const AXIS = { stroke: "var(--axis)", tick: { fill: "var(--muted)", fontSize: 11 }, tickLine: false };
const tooltipStyle = {
  contentStyle: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--ink)" },
  labelStyle: { color: "var(--ink)", fontWeight: 600 },
  itemStyle: { color: "var(--ink-2)" },
  cursor: { fill: "var(--surface-2)" },
};

// ---------------------------------------------------------------------------
// 1. 구종별 구위 분포 (박스 : 투수 / 음영 : 리그 동일 구종)
// ---------------------------------------------------------------------------
export function StuffDistribution({ ps, pitchTypes, league }: { ps: Pitch[]; pitchTypes: string[]; league: League }) {
  const dark = useDarkMode();
  const [hover, setHover] = useState<string | null>(null);
  const rows = useMemo(() => {
    const g = groupBy(ps, (p) => p.pt);
    return pitchTypes
      .filter((pt) => (g.get(pt)?.length ?? 0) >= 5)
      .map((pt) => {
        const s = g.get(pt)!.map((p) => p.s).sort((a, b) => a - b);
        return { pt, n: s.length, q: [0.05, 0.25, 0.5, 0.75, 0.95].map((q) => quantile(s, q)), mean: s.reduce((a, b) => a + b, 0) / s.length, lg: league.pitchTypes[pt]?.pitchQuantiles };
      });
  }, [ps, pitchTypes, league]);

  const W = 560, L = 44, R = 16, RH = 34, T = 8;
  const H = T + rows.length * RH + 28;
  const x = (v: number) => L + ((Math.min(80, Math.max(20, v)) - 20) / 60) * (W - L - R);
  if (!rows.length) return <Empty />;
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="구종별 구위 분포">
        {[20, 30, 40, 50, 60, 70, 80].map((v) => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={T} y2={H - 24} stroke={v === 50 ? "var(--axis)" : "var(--grid)"} />
            <text x={x(v)} y={H - 8} fontSize={11} fill="var(--muted)" textAnchor="middle" className="tnum">
              {v}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const cy = T + i * RH + RH / 2;
          const c = pitchColor(pitchTypes, r.pt, dark);
          return (
            <g key={r.pt} onPointerEnter={() => setHover(r.pt)} onPointerLeave={() => setHover(null)}>
              <rect x={0} y={cy - RH / 2} width={W} height={RH} fill={hover === r.pt ? "var(--surface-2)" : "transparent"} />
              <text x={8} y={cy + 4} fontSize={12} fill="var(--ink)" fontWeight={600}>
                {r.pt}
              </text>
              {r.lg && (
                <>
                  <line x1={x(r.lg[0])} x2={x(r.lg[4])} y1={cy} y2={cy} stroke="var(--axis)" strokeWidth={2} />
                  <rect x={x(r.lg[1])} y={cy - 11} width={x(r.lg[3]) - x(r.lg[1])} height={22} fill="var(--muted)" fillOpacity={0.22} rx={3} />
                </>
              )}
              <line x1={x(r.q[0])} x2={x(r.q[4])} y1={cy} y2={cy} stroke={c} strokeWidth={2} />
              <rect x={x(r.q[1])} y={cy - 6} width={Math.max(2, x(r.q[3]) - x(r.q[1]))} height={12} fill={c} rx={3} />
              <line x1={x(r.q[2])} x2={x(r.q[2])} y1={cy - 9} y2={cy + 9} stroke="var(--ink)" strokeWidth={2} />
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-4 text-xs text-ink-2 mt-1">
        <span className="flex items-center gap-1.5">
          <span className="w-5 h-2 rounded-sm bg-accent" /> 이 투수 (25–75%, 선 5–95%)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-5 h-3 rounded-sm bg-muted/25" /> 리그 동일 구종 (25–75%)
        </span>
        <span className="flex items-center gap-1.5">
          <span className="w-0.5 h-3 bg-ink" /> 중앙값
        </span>
      </div>
      <div className="text-xs text-muted mt-1 h-4 tnum">
        {hover &&
          (() => {
            const r = rows.find((v) => v.pt === hover)!;
            return `${r.pt} ${r.n}구 · 중앙값 ${f1(r.q[2])} (리그 ${f1(r.lg?.[2])}) · 평균 ${f1(r.mean)} · 25–75% ${f1(r.q[1])}–${f1(r.q[3])}`;
          })()}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 2. 코스별 히트맵 (포수 시점, Statcast zone 1~9 + 바깥 11~14)
// ---------------------------------------------------------------------------
type ZoneMetric = "stuff" | "ba" | "whiff" | "usage";
const ZONE_METRICS: [ZoneMetric, string][] = [
  ["stuff", "평균 구위"],
  ["usage", "투구 비중"],
  ["whiff", "Whiff%"],
  ["ba", "피안타율"],
];

export function ZoneHeatmap({ ps }: { ps: Pitch[] }) {
  const dark = useDarkMode();
  const [metric, setMetric] = useState<ZoneMetric>("stuff");
  const [hover, setHover] = useState<number | null>(null);
  const zs = useMemo(() => {
    const g = groupBy(
      ps.filter((p) => p.zone !== null),
      (p) => p.zone as number,
    );
    const total = ps.filter((p) => p.zone !== null).length;
    const m = new Map<number, { st: Stats; share: number }>();
    for (const [z, arr] of g) m.set(z, { st: stats(arr), share: arr.length / total });
    return m;
  }, [ps]);

  const spec = {
    stuff: { get: (c: { st: Stats }) => c.st.stuff, dom: [40, 60], fmt: (v: number) => v.toFixed(1), min: (c: { st: Stats }) => c.st.n >= 10, sub: (c: { st: Stats }) => `${c.st.n}구` },
    usage: { get: (c: { share: number }) => c.share, dom: [0, 0.15], fmt: (v: number) => pct(v, 0), min: () => true, sub: (c: { st: Stats }) => `${c.st.n}구` },
    whiff: { get: (c: { st: Stats }) => c.st.whiff, dom: [0, 0.45], fmt: (v: number) => pct(v, 0), min: (c: { st: Stats }) => c.st.swings >= 10, sub: (c: { st: Stats }) => `스윙 ${c.st.swings}` },
    ba: { get: (c: { st: Stats }) => c.st.ba, dom: [0.1, 0.4], fmt: (v: number) => f3(v), min: (c: { st: Stats }) => c.st.ab >= 8, sub: (c: { st: Stats }) => `${c.st.hits}/${c.st.ab}` },
  }[metric];

  // 레이아웃 : 바깥 5×5 셀 박스, 안쪽 3×3 = 존
  const S = 56, O = 24, P = 8;
  const W = S * 5 + P * 2, H = S * 5 + P * 2 + 20;
  const inner = (z: number) => ({ x: P + S + ((z - 1) % 3) * S, y: P + S + Math.floor((z - 1) / 3) * S, w: S, h: S });
  const outerPath: Record<number, string> = {
    11: `M${P},${P} h${S * 2.5} v${S} h${-S * 1.5} v${S * 1.5} h${-S} Z`,
    12: `M${P + S * 2.5},${P} h${S * 2.5} v${S * 2.5} h${-S} v${-S * 1.5} h${-S * 1.5} Z`,
    13: `M${P},${P + S * 2.5} h${S} v${S * 1.5} h${S * 1.5} v${S} h${-S * 2.5} Z`,
    14: `M${P + S * 4},${P + S * 2.5} h${S} v${S * 2.5} h${-S * 2.5} v${-S} h${S * 1.5} Z`,
  };
  const outerLabel: Record<number, [number, number]> = { 11: [P + O, P + O], 12: [W - P - O, P + O], 13: [P + O, P + S * 5 - O + 6], 14: [W - P - O, P + S * 5 - O + 6] };

  const cell = (z: number) => {
    const c = zs.get(z);
    const v = c ? spec.get(c as never) : null;
    const ok = c && v !== null && spec.min(c as never);
    const t = ok ? ((v as number) - spec.dom[0]) / (spec.dom[1] - spec.dom[0]) : 0;
    const fill = ok ? sequential(t, dark) : "var(--surface-2)";
    const light = dark ? t > 0.6 : t < 0.55;
    return { c, v, ok, fill, ink: ok ? (light ? (dark ? "#0b0b0b" : "#0b0b0b") : "#ffffff") : "var(--muted)" };
  };

  const hc = hover !== null ? zs.get(hover) : null;
  return (
    <div>
      <div className="flex justify-end mb-2">
        <Toggle label="히트맵 지표" value={metric} options={ZONE_METRICS} onChange={setMetric} />
      </div>
      <div className="flex flex-col items-center">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full max-w-[320px] h-auto" role="img" aria-label={`코스별 ${ZONE_METRICS.find((m) => m[0] === metric)![1]}`}>
          {[11, 12, 13, 14].map((z) => {
            const k = cell(z);
            return (
              <g key={z} onPointerEnter={() => setHover(z)} onPointerLeave={() => setHover(null)}>
                <path d={outerPath[z]} fill={k.fill} stroke="var(--surface)" strokeWidth={2} />
                <text x={outerLabel[z][0]} y={outerLabel[z][1]} fontSize={12} textAnchor="middle" fill={k.ink} fontWeight={600} className="tnum">
                  {k.ok ? spec.fmt(k.v as number) : "-"}
                </text>
              </g>
            );
          })}
          {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((z) => {
            const r = inner(z);
            const k = cell(z);
            return (
              <g key={z} onPointerEnter={() => setHover(z)} onPointerLeave={() => setHover(null)}>
                <rect x={r.x} y={r.y} width={r.w} height={r.h} fill={k.fill} stroke="var(--surface)" strokeWidth={2} />
                <text x={r.x + S / 2} y={r.y + S / 2 + 1} fontSize={13} textAnchor="middle" fill={k.ink} fontWeight={600} className="tnum">
                  {k.ok ? spec.fmt(k.v as number) : "-"}
                </text>
                <text x={r.x + S / 2} y={r.y + S / 2 + 15} fontSize={9.5} textAnchor="middle" fill={k.ink} opacity={0.8} className="tnum">
                  {k.c ? spec.sub(k.c as never) : ""}
                </text>
              </g>
            );
          })}
          <rect x={P + S} y={P + S} width={S * 3} height={S * 3} fill="none" stroke="var(--zone-line)" strokeWidth={2} />
          <text x={P} y={H - 4} fontSize={10} fill="var(--muted)">
            ← 3루쪽
          </text>
          <text x={W - P} y={H - 4} fontSize={10} fill="var(--muted)" textAnchor="end">
            1루쪽 → (포수 시점)
          </text>
        </svg>
        <div className="text-xs text-muted h-4 tnum mt-1">
          {hc
            ? `${hover! <= 9 ? `존 ${hover}` : "존 밖"} · ${hc.st.n}구 · 구위 ${f1(hc.st.stuff)} · Whiff ${pct(hc.st.whiff)} · 피안타율 ${f3(hc.st.ba)} (${hc.st.hits}/${hc.st.ab})`
            : "칸에 마우스를 올리면 상세 지표 · 표본이 적은 칸은 회색"}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 3. 구위 구간별 결과 (이 투수 vs 리그)
// ---------------------------------------------------------------------------
type BucketMetric = "ba" | "slg" | "whiff" | "xwobacon";
const BUCKET_METRICS: [BucketMetric, string][] = [
  ["ba", "피안타율"],
  ["slg", "피장타율"],
  ["whiff", "Whiff%"],
  ["xwobacon", "xwOBAcon"],
];

export function BucketChart({ ps, leagueBuckets }: { ps: Pitch[]; leagueBuckets: (Rates & { label: string })[] }) {
  const [metric, setMetric] = useState<BucketMetric>("ba");
  const data = useMemo(
    () =>
      STUFF_BUCKETS.map((b, i) => {
        const g = ps.filter((p) => p.s >= b.lo && p.s < b.hi);
        const st = stats(g);
        const enough = metric === "whiff" ? st.swings >= 10 : metric === "xwobacon" ? g.filter((p) => p.r >= 4 && p.r <= 8).length >= 8 : st.ab >= 10;
        return {
          label: b.label,
          share: ps.length ? g.length / ps.length : 0,
          n: g.length,
          pitcher: enough ? (st[metric] as number | null) : null,
          league: leagueBuckets[i]?.[metric] ?? null,
        };
      }),
    [ps, leagueBuckets, metric],
  );
  const isPct = metric === "whiff";
  const fmt = (v: number) => (isPct ? pct(v, 0) : f3(v));

  return (
    <div>
      <div className="flex justify-end mb-2">
        <Toggle label="구간 지표" value={metric} options={BUCKET_METRICS} onChange={setMetric} />
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} barGap={2} barCategoryGap="22%" margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <CartesianGrid vertical={false} stroke="var(--grid)" />
            <XAxis dataKey="label" {...AXIS} />
            <YAxis {...AXIS} axisLine={false} tickFormatter={fmt} width={48} />
            <Tooltip {...tooltipStyle} formatter={(v) => (typeof v === "number" ? fmt(v) : "-")} labelFormatter={(l) => `구위 ${l}`} />
            <Legend wrapperStyle={{ fontSize: 12, color: "var(--ink-2)" }} iconType="circle" iconSize={8} />
            <Bar dataKey="pitcher" name="이 투수" fill="var(--accent)" radius={[4, 4, 0, 0]} />
            <Bar dataKey="league" name="리그" fill="var(--axis)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="grid grid-cols-6 text-center text-[11px] text-muted tnum mt-1 pl-9">
        {data.map((d) => (
          <div key={d.label}>
            <div className="text-ink-2">{pct(d.share, 0)}</div>
            <div>{d.n}구</div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted mt-2">구간별 투구 비중(아래 숫자)과 결과. 타석을 끝낸 투구의 구위 기준이며 표본이 적은 구간(10타수 미만)은 비워 둠.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 4. 카운트별 구종 선택
// ---------------------------------------------------------------------------
export function CountMix({ ps, pitchTypes }: { ps: Pitch[]; pitchTypes: string[] }) {
  const dark = useDarkMode();
  const [hover, setHover] = useState<string | null>(null);
  const rows = useMemo(
    () =>
      COUNT_STATES.map((c) => {
        const g = ps.filter(c.test);
        const by = groupBy(g, (p) => p.pt);
        return {
          key: c.key,
          label: c.label,
          n: g.length,
          stuff: stats(g).stuff,
          parts: pitchTypes.filter((pt) => by.has(pt)).map((pt) => ({ pt, share: by.get(pt)!.length / g.length, stuff: stats(by.get(pt)!).stuff })),
        };
      }),
    [ps, pitchTypes],
  );
  const W = 560, L = 76, R = 64, RH = 34;
  const H = rows.length * RH + 4;
  const bw = W - L - R;
  return (
    <div>
      <div className="flex flex-wrap gap-3 text-xs text-ink-2 mb-2">
        {pitchTypes.map((pt) => (
          <span key={pt} className="flex items-center gap-1.5">
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: pitchColor(pitchTypes, pt, dark) }} />
            {pt}
          </span>
        ))}
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label="카운트 상황별 구종 비율">
        <text x={W - 4} y={10} fontSize={10} fill="var(--muted)" textAnchor="end">
          평균 구위
        </text>
        {rows.map((r, i) => {
          const y = i * RH + 12;
          let acc = 0;
          return (
            <g key={r.key}>
              <text x={0} y={y + 13} fontSize={12} fill="var(--ink)">
                {r.label}
              </text>
              <text x={0} y={y + 25} fontSize={9.5} fill="var(--muted)" className="tnum">
                {r.n}구
              </text>
              {r.parts.map((p) => {
                const x0 = L + acc * bw;
                acc += p.share;
                const w = Math.max(0, p.share * bw - 2);
                const on = hover === `${r.key}:${p.pt}`;
                return (
                  <g key={p.pt} onPointerEnter={() => setHover(`${r.key}:${p.pt}`)} onPointerLeave={() => setHover(null)}>
                    <rect x={x0} y={y} width={w} height={20} rx={3} fill={pitchColor(pitchTypes, p.pt, dark)} opacity={hover && !on ? 0.55 : 1} />
                    {w > 34 && (
                      <text x={x0 + w / 2} y={y + 14} fontSize={10.5} textAnchor="middle" fill="#ffffff" fontWeight={600} className="tnum" pointerEvents="none">
                        {Math.round(p.share * 100)}%
                      </text>
                    )}
                  </g>
                );
              })}
              <text x={W - 4} y={y + 14} fontSize={12} textAnchor="end" fill="var(--ink)" fontWeight={600} className="tnum">
                {r.stuff === null ? "-" : r.stuff.toFixed(1)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="text-xs text-muted h-4 tnum">
        {hover &&
          (() => {
            const [k, pt] = hover.split(":");
            const r = rows.find((v) => v.key === k)!;
            const p = r.parts.find((v) => v.pt === pt)!;
            return `${r.label} · ${pt} ${pct(p.share)} · 구위 ${f1(p.stuff)}`;
          })()}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 5. 추이 : 월별 / 경기 내 투구수별 구종 평균 구위
// ---------------------------------------------------------------------------
export function TrendCharts({ ps, pitchTypes }: { ps: Pitch[]; pitchTypes: string[] }) {
  const dark = useDarkMode();
  const [mode, setMode] = useState<"month" | "fatigue">("month");
  const shown = useMemo(() => pitchTypes.filter((pt) => ps.filter((p) => p.pt === pt).length >= 40), [ps, pitchTypes]);

  const data = useMemo(() => {
    const minN = 15;
    if (mode === "month") {
      const byM = groupBy(ps, (p) => p.month);
      return [...byM.keys()]
        .sort((a, b) => a - b)
        .map((m) => {
          const row: Record<string, number | string | null> = { label: `${m}월` };
          const g = groupBy(byM.get(m)!, (p) => p.pt);
          for (const pt of shown) row[pt] = (g.get(pt)?.length ?? 0) >= minN ? stats(g.get(pt)!).stuff : null;
          return row;
        });
    }
    return GAME_PITCH_BUCKETS.map((b) => {
      const row: Record<string, number | string | null> = { label: b.label };
      const g = groupBy(
        ps.filter((p) => p.gp >= b.lo && p.gp <= b.hi),
        (p) => p.pt,
      );
      for (const pt of shown) row[pt] = (g.get(pt)?.length ?? 0) >= minN ? stats(g.get(pt)!).stuff : null;
      return row;
    });
  }, [ps, shown, mode]);

  return (
    <div>
      <div className="flex justify-end mb-2">
        <Toggle
          label="추이 기준"
          value={mode}
          options={[
            ["month", "월별"],
            ["fatigue", "경기 내 투구수"],
          ]}
          onChange={setMode}
        />
      </div>
      {shown.length === 0 ? (
        <Empty />
      ) : (
        <div className="h-60">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, left: -16, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="label" {...AXIS} />
              <YAxis {...AXIS} axisLine={false} domain={["dataMin - 2", "dataMax + 2"]} tickFormatter={(v) => Math.round(v).toString()} />
              <Tooltip {...tooltipStyle} cursor={{ stroke: "var(--axis)" }} formatter={(v) => (typeof v === "number" ? v.toFixed(1) : "-")} />
              <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" iconSize={8} />
              {shown.map((pt) => (
                <Line key={pt} type="monotone" dataKey={pt} stroke={pitchColor(pitchTypes, pt, dark)} strokeWidth={2} dot={{ r: 3.5, strokeWidth: 0, fill: pitchColor(pitchTypes, pt, dark) }} connectNulls isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
      <p className="text-[11px] text-muted mt-2">
        {mode === "month" ? "월별 구종 평균 구위 (해당 월 15구 이상)." : "경기 내 투구 순번 구간별 구종 평균 구위 — 체력 저하에 따른 구위 하락을 확인 (15구 이상)."}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 6. 좌우 스플릿
// ---------------------------------------------------------------------------
export function PlatoonTable({ ps, pitchTypes }: { ps: Pitch[]; pitchTypes: string[] }) {
  const dark = useDarkMode();
  const sides = useMemo(() => {
    const out = { L: ps.filter((p) => p.lhb), R: ps.filter((p) => !p.lhb) };
    return (["L", "R"] as const).map((s) => {
      const g = groupBy(out[s], (p) => p.pt);
      return { s, total: stats(out[s]), byPt: new Map(pitchTypes.map((pt) => [pt, g.has(pt) ? stats(g.get(pt)!) : null])), n: out[s].length };
    });
  }, [ps, pitchTypes]);
  const cell = "text-right px-1.5 py-1.5";
  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="w-full text-xs tnum min-w-[520px] border-collapse">
        <thead>
          <tr className="text-muted">
            <th />
            <th colSpan={4} className="font-normal text-center border-b border-grid pb-1">
              vs 좌타자
            </th>
            <th colSpan={4} className="font-normal text-center border-b border-grid pb-1">
              vs 우타자
            </th>
          </tr>
          <tr className="text-muted border-b border-grid">
            <th className="text-left font-normal py-1.5">구종</th>
            {[0, 1].map((i) => (
              <FragmentHead key={i} />
            ))}
          </tr>
        </thead>
        <tbody>
          {pitchTypes.map((pt) => (
            <tr key={pt} className="border-b border-grid">
              <td className="py-1.5 whitespace-nowrap">
                <span className="inline-block w-2.5 h-2.5 rounded-full mr-2 align-middle" style={{ background: pitchColor(pitchTypes, pt, dark) }} />
                {pt}
              </td>
              {sides.map(({ s, byPt, n }) => {
                const st = byPt.get(pt);
                return (
                  <FragmentCells key={s} cls={cell} vals={st ? [pct(st.n / n, 0), f1(st.stuff), pct(st.whiff, 0), f3(st.ba)] : ["-", "-", "-", "-"]} dim={!st || st.n < 20} />
                );
              })}
            </tr>
          ))}
          <tr className="font-semibold text-ink">
            <td className="py-1.5">전체</td>
            {sides.map(({ s, total }) => (
              <FragmentCells key={s} cls={cell} vals={[`${total.n}구`, f1(total.stuff), pct(total.whiff, 0), f3(total.ba)]} />
            ))}
          </tr>
          <tr className="text-ink-2">
            <td className="py-1.5">피xwOBA</td>
            {sides.map(({ s, total }) => (
              <td key={s} colSpan={4} className="text-center py-1.5">
                {f3(total.xwoba)} <span className="text-muted">({total.pa} 타석)</span>
              </td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function FragmentHead() {
  return (
    <>
      {["구사율", "구위", "Whiff", "피안타율"].map((h) => (
        <th key={h} className="text-right font-normal px-1.5 py-1.5">
          {h}
        </th>
      ))}
    </>
  );
}

function FragmentCells({ vals, cls, dim }: { vals: string[]; cls: string; dim?: boolean }) {
  return (
    <>
      {vals.map((v, i) => (
        <td key={i} className={`${cls} ${dim ? "text-muted" : "text-ink-2"}`}>
          {v}
        </td>
      ))}
    </>
  );
}

function Empty() {
  return <div className="h-24 flex items-center justify-center text-sm text-muted">표본 부족</div>;
}
