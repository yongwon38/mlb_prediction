"use client";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, ComposedChart, Line, LineChart, ReferenceArea, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { EmptyState, LoadingBlock, Section, Toggle } from "@/components/Panels";
import Methodology from "@/components/Methodology";
import { loadMonitor } from "@/lib/data";
import { useT } from "@/lib/i18n";
import type { Monitor, MonitorMetrics } from "@/lib/types";

const AXIS = { stroke: "var(--axis)", tick: { fill: "var(--muted)", fontSize: 11 }, tickLine: false };
const tooltipStyle = {
  contentStyle: { background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--ink)" },
  labelStyle: { color: "var(--ink)", fontWeight: 600 },
  itemStyle: { color: "var(--ink-2)" },
};
const f3s = (x: number | null | undefined) => (x === null || x === undefined ? "-" : x.toFixed(3));
const f4s = (x: number | null | undefined) => (x === null || x === undefined ? "-" : x.toFixed(4));
const sgn = (x: number | null | undefined, d = 3) => (x === null || x === undefined ? "-" : `${x >= 0 ? "+" : ""}${x.toFixed(d)}`);
const ci = (c?: [number | null, number | null]) => (c ? `[${f3s(c[0])}, ${f3s(c[1])}]` : "-");

type Metric = "whiff" | "xwoba";

/** 운영 모델(v4) 모니터링 : 주별 성능·입력 분포 변화·재학습 게이트·모델 카드 (monitor.py, retrain_gate.py) */
export default function ModelPage() {
  const tt = useT();
  const t = tt.modelPage;
  const [mon, setMon] = useState<Monitor | null | undefined>(undefined);
  const [metric, setMetric] = useState<Metric>("whiff");

  useEffect(() => {
    let alive = true;
    loadMonitor().then((m) => alive && setMon(m));
    return () => {
      alive = false;
    };
  }, []);

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 pb-10 flex flex-col gap-5">
      {mon === undefined ? (
        <div className="pt-5">
          <LoadingBlock label={tt.common.seasonLoading} rows={4} />
        </div>
      ) : mon === null ? (
        <div className="pt-5">
          <EmptyState title={t.empty} body={t.emptyBody} />
        </div>
      ) : (
        <Body mon={mon} metric={metric} setMetric={setMetric} />
      )}
      <Methodology />
    </main>
  );
}

function Body({ mon, metric, setMetric }: { mon: Monitor; metric: Metric; setMetric: (m: Metric) => void }) {
  const tt = useT();
  const t = tt.modelPage;
  const last = mon.weeks[mon.weeks.length - 1];
  const base = mon.ref.baseline;
  const featName = (f: string) => t.feat[f] ?? f;

  const statusTone = mon.status === "ok" ? "text-good" : mon.status === "warn" ? "text-bad" : "text-muted";
  const statusDot = mon.status === "ok" ? "bg-good" : mon.status === "warn" ? "bg-bad" : "bg-muted";

  return (
    <>
      <header className="pt-6 flex flex-col gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-ink">{t.title}</h1>
          <span className={`inline-flex items-center gap-1.5 rounded-full border border-line px-3 py-1 text-xs font-semibold ${statusTone}`}>
            <span className={`w-2 h-2 rounded-full ${statusDot}`} aria-hidden="true" />
            {t.status[mon.status]}
          </span>
          {mon.offseason && <span className="rounded-full bg-surface-2 px-3 py-1 text-xs text-muted">{t.offseason}</span>}
        </div>
        <p className="text-sm text-muted">{t.sub(mon.season, mon.dataThrough, mon.generatedAt)}</p>
        {mon.reasons.length > 0 && (
          <ul className="text-sm text-bad list-disc pl-5">
            {mon.reasons.map((r, i) => (
              <li key={i}>{r.code === "rho" ? t.reasonRho(f3s(r.value), f3s(r.limit)) : t.reasonPsi(featName(r.feature ?? ""), r.value.toFixed(3))}</li>
            ))}
          </ul>
        )}
      </header>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Tile label={t.rhoWhiff} value={f3s(last.cum.rhoWhiff)} ci={ci(last.cum.rhoWhiffCI)} sub={t.cumSub(last.cum.groups)} base={t.baseSub(f3s(base.rhoWhiff), f3s(base.rhoWhiffCI?.[0]), f3s(base.rhoWhiffCI?.[1]))} />
        <Tile label={t.rhoXwoba} value={f3s(last.cum.rhoXwoba)} ci={ci(last.cum.rhoXwobaCI)} sub={t.cumSub(last.cum.groups)} base={t.baseSub(f3s(base.rhoXwoba), f3s(base.rhoXwobaCI?.[0]), f3s(base.rhoXwobaCI?.[1]))} />
        <Tile label={t.rmse} value={f4s(last.cum.rmse)} sub={tt.common.pitches(last.cum.rmseN)} base={t.rmseSub(f4s(base.rmse))} />
      </div>

      <Section
        title={t.perf}
        sub={t.perfSub(mon.thresholds.bootstrap)}
        right={
          <Toggle
            label={t.metricAria}
            value={metric}
            options={[
              ["whiff", t.whiff],
              ["xwoba", t.xwoba],
            ]}
            onChange={setMetric}
          />
        }
      >
        <PerfChart mon={mon} metric={metric} />
      </Section>

      <Section title={t.drift} sub={t.driftSub}>
        <DriftCharts mon={mon} featName={featName} />
      </Section>

      <GateCard mon={mon} />
      <ModelCard mon={mon} featName={featName} />
    </>
  );
}

function Tile({ label, value, ci, sub, base }: { label: string; value: string; ci?: string; sub: string; base: string }) {
  return (
    <div className="card p-4 flex flex-col gap-1">
      <p className="text-xs text-muted">{label}</p>
      <p className="flex items-baseline gap-2">
        <span className="num text-2xl font-semibold text-ink">{value}</span>
        {ci && <span className="num text-xs text-muted">{ci}</span>}
      </p>
      <p className="text-[11px] text-muted">{sub}</p>
      <p className="text-[11px] text-ink-2">{base}</p>
    </div>
  );
}

function PerfChart({ mon, metric }: { mon: Monitor; metric: Metric }) {
  const t = useT().modelPage;
  const key = metric === "whiff" ? "rhoWhiff" : "rhoXwoba";
  const ciKey = metric === "whiff" ? "rhoWhiffCI" : "rhoXwobaCI";
  const base = mon.ref.baseline;
  const data = useMemo(
    () => mon.weeks.map((w) => ({ label: w.week.slice(5), range: `${w.start} ~ ${w.end}`, cum: w.cum[key], wk: w.wk[key] })),
    [mon, key],
  );
  const bci = base[ciKey as keyof MonitorMetrics] as [number | null, number | null] | undefined;
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={data} margin={{ top: 8, right: 12, left: -12, bottom: 0 }}>
          <CartesianGrid vertical={false} stroke="var(--grid)" />
          <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={16} />
          <YAxis {...AXIS} axisLine={false} domain={["auto", "auto"]} tickFormatter={(v) => Number(v).toFixed(2)} />
          {bci && bci[0] !== null && bci[1] !== null && <ReferenceArea y1={bci[0]} y2={bci[1]} fill="var(--surface-3)" fillOpacity={0.8} ifOverflow="extendDomain" />}
          {base[key] !== null && <ReferenceLine y={base[key] as number} stroke="var(--muted)" strokeDasharray="4 3" ifOverflow="extendDomain" />}
          <Tooltip
            {...tooltipStyle}
            cursor={{ stroke: "var(--axis)" }}
            labelFormatter={(_, p) => (p?.[0]?.payload?.range as string) ?? ""}
            formatter={(v, name) => [typeof v === "number" ? v.toFixed(3) : "-", name === "cum" ? t.cumulative : t.weekly]}
          />
          <Line type="monotone" dataKey="wk" stroke="none" dot={{ r: 3, strokeWidth: 0, fill: "var(--muted)" }} isAnimationActive={false} connectNulls={false} />
          <Line type="monotone" dataKey="cum" stroke="var(--accent)" strokeWidth={2.2} dot={false} connectNulls isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

function DriftCharts({ mon, featName }: { mon: Monitor; featName: (f: string) => string }) {
  const t = useT().modelPage;
  const { psiWatch, psiWarn } = mon.thresholds;
  const bars = useMemo(
    () =>
      Object.entries(mon.psiSeason)
        .map(([f, v]) => ({ name: featName(f), v: v ?? 0 }))
        .sort((a, b) => b.v - a.v),
    [mon, featName],
  );
  const weekly = useMemo(() => mon.weeks.map((w) => ({ label: w.week.slice(5), range: `${w.start} ~ ${w.end}`, v: w.psiMax })), [mon]);
  const xMax = Math.max(psiWarn * 1.1, ...bars.map((b) => b.v));
  const color = (v: number) => (v > psiWarn ? "var(--bad)" : v > psiWatch ? "var(--accent-ink)" : "var(--accent)");
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
      <div>
        <p className="text-xs font-semibold text-ink-2 mb-2">{t.psiSeason}</p>
        <div className="h-[360px]">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={bars} layout="vertical" margin={{ top: 4, right: 16, left: 8, bottom: 0 }}>
              <CartesianGrid horizontal={false} stroke="var(--grid)" />
              <XAxis type="number" {...AXIS} domain={[0, xMax]} tickFormatter={(v) => Number(v).toFixed(2)} />
              <YAxis type="category" dataKey="name" {...AXIS} axisLine={false} width={150} interval={0} />
              <ReferenceLine x={psiWatch} stroke="var(--muted)" strokeDasharray="4 3" />
              <ReferenceLine x={psiWarn} stroke="var(--bad)" strokeDasharray="4 3" />
              <Tooltip {...tooltipStyle} cursor={{ fill: "var(--surface-2)" }} formatter={(v) => [typeof v === "number" ? v.toFixed(4) : "-", "PSI"]} />
              <Bar dataKey="v" isAnimationActive={false} radius={[0, 3, 3, 0]} shape={(p: { x?: number; y?: number; width?: number; height?: number; payload?: { v: number } }) => <rect x={p.x} y={p.y} width={Math.max(p.width ?? 0, 1)} height={p.height} rx={3} fill={color(p.payload?.v ?? 0)} />} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div>
        <p className="text-xs font-semibold text-ink-2 mb-2">{t.psiWeekMax}</p>
        <div className="h-[360px]">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={weekly} margin={{ top: 4, right: 12, left: -12, bottom: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--grid)" />
              <XAxis dataKey="label" {...AXIS} interval="preserveStartEnd" minTickGap={16} />
              <YAxis {...AXIS} axisLine={false} domain={[0, (dataMax: number) => Math.max(psiWarn * 1.1, dataMax)]} tickFormatter={(v) => Number(v).toFixed(2)} />
              <ReferenceLine y={psiWatch} stroke="var(--muted)" strokeDasharray="4 3" />
              <ReferenceLine y={psiWarn} stroke="var(--bad)" strokeDasharray="4 3" />
              <Tooltip {...tooltipStyle} cursor={{ stroke: "var(--axis)" }} labelFormatter={(_, p) => (p?.[0]?.payload?.range as string) ?? ""} formatter={(v) => [typeof v === "number" ? v.toFixed(3) : "-", "PSI max"]} />
              <Line type="linear" dataKey="v" stroke="var(--accent)" strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: "var(--accent)" }} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}

function GateCard({ mon }: { mon: Monitor }) {
  const t = useT().modelPage;
  const g = mon.gate;
  if (!g)
    return (
      <Section title={t.gate} sub={t.gateRule}>
        <p className="text-sm text-muted">{t.gateNone}</p>
      </Section>
    );
  const rows: [string, number | null, number | null, number | null, [number | null, number | null] | null, number][] = [
    [t.rhoWhiff, g.champion.rhoWhiff, g.challenger.rhoWhiff, g.delta.rhoWhiff, g.delta.rhoWhiffCI, 3],
    [t.rhoXwoba, g.champion.rhoXwoba, g.challenger.rhoXwoba, g.delta.rhoXwoba, g.delta.rhoXwobaCI, 3],
    [t.rmse, g.champion.rmse, g.challenger.rmse, g.delta.rmse, null, 5],
  ];
  const replace = g.decision === "replace";
  return (
    <Section
      title={t.gate}
      sub={t.gateSub(g.holdout[0], g.holdout[1])}
      right={
        <span className={`rounded-full border px-3 py-1 text-xs font-semibold ${replace ? "border-bad text-bad" : "border-line text-ink"}`}>
          {t.decision[g.decision]} · {g.date}
        </span>
      }
    >
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted text-left border-b border-line">
              <th className="py-2 pr-3 font-medium">{t.colMetric}</th>
              <th className="py-2 px-3 font-medium text-right">{t.colChampion}</th>
              <th className="py-2 px-3 font-medium text-right">{t.colChallenger}</th>
              <th className="py-2 px-3 font-medium text-right">{t.colDelta}</th>
              <th className="py-2 pl-3 font-medium text-right">{t.colCI}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([name, a, b, d, c, nd]) => (
              <tr key={name} className="border-b border-line last:border-0">
                <td className="py-2 pr-3 text-ink-2">{name}</td>
                <td className="py-2 px-3 text-right num">{a === null ? "-" : a.toFixed(nd)}</td>
                <td className="py-2 px-3 text-right num">{b === null ? "-" : b.toFixed(nd)}</td>
                <td className="py-2 px-3 text-right num">{sgn(d, nd)}</td>
                <td className="py-2 pl-3 text-right num text-muted">{c ? `[${sgn(c[0])}, ${sgn(c[1])}]` : "-"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-[11px] text-muted mt-3">{t.gateRule}</p>
    </Section>
  );
}

function ModelCard({ mon, featName }: { mon: Monitor; featName: (f: string) => string }) {
  const t = useT().modelPage;
  const r = mon.ref;
  const b = r.baseline;
  const items: [string, React.ReactNode][] = [
    [t.cardModel, t.cardModelV],
    [t.cardData, t.cardDataV(r.trainPeriod[0], r.trainPeriod[1], r.trainPitches)],
    [t.cardValid, `${r.validPeriod[0]} ~ ${r.validPeriod[1]}`],
    [t.cardTarget, t.cardTargetV],
    [t.cardFeatures, r.features.map(featName).join(" · ")],
    [t.cardMetrics, t.cardMetricsV(f3s(b.rhoWhiff), f3s(b.rhoXwoba), f4s(b.rmse))],
    [
      t.cardLimits,
      <ul key="l" className="list-disc pl-4 flex flex-col gap-1">
        {t.limits.map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>,
    ],
  ];
  return (
    <Section title={t.card}>
      <dl className="grid grid-cols-1 sm:grid-cols-[160px_1fr] gap-x-4 gap-y-2 text-sm">
        {items.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-muted">{k}</dt>
            <dd className="text-ink-2 leading-relaxed">{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
