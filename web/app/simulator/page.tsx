"use client";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { LoadingBlock, Section, StuffBadge } from "@/components/Panels";
import { SeasonSelect } from "@/components/PageHeader";
import Icon from "@/components/Icon";
import { ctxHref, usePageState } from "@/lib/appState";
import { loadLeague, loadSimModel, loadSimStarts } from "@/lib/data";
import { predictScores, responseCurve, type SimModel } from "@/lib/hofnet";
import { DIFF_COLS, FB_INPUTS, FEAT_FMT, SIM_INPUTS, type SimInputKey, type SimState, type StartSource, fmtFeat, outOfRange, rangeOf, startState, toRow } from "@/lib/simulator";
import { percentileOf } from "@/lib/analysis";
import { useT } from "@/lib/i18n";
import type { League, SimStarts } from "@/lib/types";

const AXIS = { stroke: "var(--axis)", tick: { fill: "var(--muted)", fontSize: 11 }, tickLine: false };
const fmtSigned = (v: number) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;

/** 구위 시뮬레이터 : 시작점(리그 중앙값·투수 평균) 입력을 바꿔 HOF-Net-R 구위·반응 곡선을 브라우저에서 계산 */
export default function SimulatorPage() {
  const [pt, setPt] = useState<string | null>(null);
  const [src, setSrc] = useState<"league" | "pitcher">("pitcher");
  const [cv, setCv] = useState<string>("release_speed");
  const { meta, season, setSeason, pitcherId, setPitcherId, error, setError } = usePageState({ pt, src: src === "league" ? "league" : null, cv }, (q) => {
    if (q.get("pt")) setPt(q.get("pt"));
    if (q.get("src") === "league") setSrc("league");
    if (q.get("cv")) setCv(q.get("cv")!);
  });
  const tt = useT();
  const t = tt.sim;

  const [model, setModel] = useState<SimModel | null>(null);
  useEffect(() => {
    loadSimModel()
      .then(setModel)
      .catch((e) => setError(String(e)));
  }, [setError]);

  const [starts, setStarts] = useState<{ season: number; st: SimStarts | null } | null>(null);
  const [league, setLeague] = useState<League | null>(null);
  useEffect(() => {
    if (!season) return;
    let alive = true;
    loadSimStarts(season)
      .then((st) => alive && setStarts({ season, st }))
      .catch(() => alive && setStarts({ season, st: null }));
    loadLeague(season, "hof")
      .then((l) => alive && setLeague(l))
      .catch(() => alive && setLeague(null));
    return () => {
      alive = false;
    };
  }, [season]);
  const st = starts?.season === season ? starts.st : null;

  // 시작점 : 투수에 그 구종(정규시즌 100구+)이 있으면 투수 평균, 아니면 리그 중앙값
  const pitcher = st && pitcherId ? (st.pitchers[String(pitcherId)] ?? null) : null;
  const ptList = useMemo(() => {
    if (!st) return [];
    if (src === "pitcher" && pitcher) return Object.keys(pitcher.types);
    return Object.entries(st.league)
      .sort((a, b) => b[1].n - a[1].n)
      .map(([k]) => k);
  }, [st, src, pitcher]);
  const curPt = pt && st?.league[pt] ? pt : (ptList[0] ?? null);
  const usePitcher = src === "pitcher" && !!pitcher && !!curPt && !!pitcher.types[curPt];
  const source: StartSource | null = curPt ? (usePitcher ? { kind: "pitcher", pt: curPt, id: String(pitcherId) } : { kind: "league", pt: curPt }) : null;
  const startKey = `${season}|${JSON.stringify(source)}`;
  const base = useMemo(() => (st && source ? startState(st, source) : null), [st, startKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const [edit, setEdit] = useState<{ key: string; s: SimState } | null>(null);
  const cur = edit?.key === startKey ? edit.s : base;
  const update = (f: (s: SimState) => SimState) => cur && setEdit({ key: startKey, s: f(cur) });
  const setValue = (k: SimInputKey, v: number) => update((s) => ({ ...s, values: { ...s.values, [k]: v } }));

  // 점수 : 현재·시작점·반대 투구손
  const scores = useMemo(() => {
    if (!model || !cur || !base || !curPt) return null;
    const other: "L" | "R" = cur.hand === "R" ? "L" : "R";
    const [now, start, flip] = predictScores(model, [toRow(cur, curPt), toRow(base, curPt), toRow({ ...cur, hand: other }, curPt)]);
    return { now, start, flip, other };
  }, [model, cur, base, curPt]);

  // 반응 곡선 : 입력 변경 후 지연 계산 (슬라이더를 끄는 동안 화면을 막지 않게)
  const curDeferred = useDeferredValue(cur);
  const curveVar = model?.json.num_cols.includes(cv) ? cv : "release_speed";
  const curve = useMemo(() => {
    if (!model || !curDeferred || !st || !curPt) return null;
    const r = rangeOf(st, curPt, curveVar);
    if (!r) return null;
    const c = responseCurve(model, toRow(curDeferred, curPt), curveVar, r[0], r[1]);
    return c.x.map((x, i) => ({ x, s: c.score[i] }));
  }, [model, curDeferred, st, curPt, curveVar]);
  const curX = cur && curPt ? Number(toRow(cur, curPt)[curveVar]) : null;
  const startX = base && curPt ? Number(toRow(base, curPt)[curveVar]) : null;

  const pctl = scores && curPt ? percentileOf(league?.pitchTypes[curPt]?.pitcherPercentiles, scores.now) : null;
  const pitcherNames = useMemo(() => (st ? Object.entries(st.pitchers).sort((a, b) => a[1].name.localeCompare(b[1].name)) : []), [st]);
  const [query, setQuery] = useState("");
  const pickPitcher = (v: string) => {
    setQuery(v);
    const hit = pitcherNames.find(([, p]) => p.name === v);
    if (!hit) return;
    setPitcherId(Number(hit[0]));
    setSrc("pitcher");
    setQuery("");
    if (!curPt || !hit[1].types[curPt]) setPt(Object.keys(hit[1].types)[0] ?? null);
  };

  const ready = !!(model && st && cur && scores && curPt);
  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 pt-6 pb-10 flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 pt-2">
        <div className="min-w-0">
          <h1 className="text-[28px] sm:text-[32px] font-bold tracking-tight text-ink leading-tight">{t.title}</h1>
          <p className="text-sm text-ink-2 mt-2">{t.sub}</p>
        </div>
        <SeasonSelect meta={meta} season={season} onChange={(s) => (setSeason(s), setEdit(null))} />
      </header>

      {error && <div className="card p-3 text-sm text-bad">{tt.common.loadError(error)}</div>}
      {starts?.season === season && !st && <div className="card p-3 text-sm text-muted">{t.noStarts}</div>}

      {!ready ? (
        st !== null && <LoadingBlock label={t.loading} rows={5} />
      ) : (
        <>
          {/* 시작점 */}
          <section className="card p-4 sm:p-5 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <span className="text-[15px] font-bold text-ink">{t.start}</span>
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t.start}>
                <button className="chip" aria-pressed={!usePitcher} onClick={() => setSrc("league")}>
                  {t.srcLeague}
                </button>
                <button className="chip" aria-pressed={usePitcher} disabled={!pitcher} onClick={() => setSrc("pitcher")}>
                  {pitcher ? pitcher.name : t.srcPitcher}
                </button>
              </div>
              <input
                type="search"
                list="sim-pitchers"
                value={query}
                onChange={(e) => pickPitcher(e.target.value)}
                placeholder={t.pitcherPlaceholder}
                aria-label={t.pitcherPlaceholder}
                className="w-48 !py-1.5 text-sm"
              />
              <datalist id="sim-pitchers">
                {pitcherNames.map(([id, p]) => (
                  <option key={id} value={p.name} />
                ))}
              </datalist>
              <label className="flex items-center gap-2 text-xs text-muted">
                {t.pitchType}
                <select value={curPt} onChange={(e) => setPt(e.target.value)} className="!text-sm font-medium">
                  {ptList.map((k) => (
                    <option key={k} value={k}>
                      {k} {meta?.pitchNames[k] ?? ""}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex items-center gap-1.5" role="group" aria-label={t.hand}>
                <span className="text-xs text-muted mr-1">{t.hand}</span>
                {(["R", "L"] as const).map((h) => (
                  <button key={h} className="chip" aria-pressed={cur!.hand === h} onClick={() => update((s) => ({ ...s, hand: h }))}>
                    {tt.common.throws(h)}
                  </button>
                ))}
              </div>
              <button className="chip ml-auto" onClick={() => setEdit(null)}>
                {t.reset}
              </button>
            </div>
            <p className="text-xs text-muted">
              {usePitcher ? `${pitcher!.name} ${curPt} · ${t.startN(pitcher!.types[curPt!].n)}` : t.startLeague(curPt!, st!.league[curPt!].n)} · {t.asOf(st!.asOf)}
              {src === "pitcher" && pitcher && !usePitcher && <> · {t.noPitcherType(pitcher.name, curPt!)}</>}
            </p>
          </section>

          <div className="grid gap-5 items-start lg:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
            {/* 입력 */}
            <Section title={t.inputs} sub={t.inputsSub}>
              <div className="flex flex-col gap-3.5">
                {SIM_INPUTS.map((k) => (
                  <SliderRow key={k} k={k} label={t.feats[k]} value={cur!.values[k]} start={base!.values[k]} range={rangeOf(st!, curPt!, k)} onChange={(v) => setValue(k, v)} warn={t.outOfRange} />
                ))}
              </div>
              <div className="mt-6 pt-5 border-t border-line flex flex-col gap-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h3 className="text-[15px] font-bold text-ink">{t.fb}</h3>
                  <label className="flex items-center gap-2 text-xs text-ink-2">
                    <input type="checkbox" checked={cur!.primary} onChange={(e) => update((s) => ({ ...s, primary: e.target.checked }))} />
                    {t.primary}
                  </label>
                </div>
                <p className="text-[13px] text-muted -mt-2">{t.fbSub}</p>
                {FB_INPUTS.map((k) => (
                  <SliderRow key={k} k={k} label={t.feats[k]} value={cur!.values[k]} start={base!.values[k]} range={rangeOf(st!, curPt!, k)} onChange={(v) => setValue(k, v)} warn={t.outOfRange} disabled={cur!.primary} />
                ))}
                <p className="text-xs text-muted">
                  {t.derived} :{" "}
                  {DIFF_COLS.map((d) => `${t.feats[d]} ${fmtFeat(d, Number(toRow(cur!, curPt!)[d]))}`).join(" · ")}
                </p>
              </div>
            </Section>

            <div className="flex flex-col gap-5 min-w-0">
              {/* 결과 */}
              <Section title={t.result} sub={t.resultSub}>
                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <StuffBadge v={scores!.now} size="lg" />
                  <div className="flex flex-col gap-1 text-sm">
                    <span className="text-ink-2">
                      {t.delta} <span className={`num font-semibold ${scores!.now - scores!.start >= 0.05 ? "text-bad" : scores!.now - scores!.start <= -0.05 ? "text-accent-ink" : "text-ink"}`}>{fmtSigned(scores!.now - scores!.start)}</span>
                      <span className="text-muted"> ({t.startMark} {scores!.start.toFixed(1)})</span>
                    </span>
                    {pctl !== null && (
                      <span className="text-ink-2">
                        {t.pctl(curPt!)} <span className="num font-semibold text-ink">{pctl}</span>
                      </span>
                    )}
                    <span className="text-ink-2">
                      {t.otherHand(tt.common.throws(scores!.other))} <span className="num font-semibold text-ink">{scores!.flip.toFixed(1)}</span>
                    </span>
                  </div>
                </div>
                <p className="text-xs text-muted mt-4 flex flex-wrap items-center gap-1">
                  {t.whyNote}
                  <Link href={ctxHref("/explain", { season, pitcher: usePitcher ? pitcherId : null }, { pt: curPt })} className="inline-flex items-center gap-0.5 text-accent-ink font-medium hover:underline underline-offset-2">
                    {t.why}
                    <Icon name="arrowUpRight" size={13} />
                  </Link>
                </p>
              </Section>

              {/* 반응 곡선 */}
              <Section
                title={t.curve}
                sub={t.curveSub}
                right={
                  <label className="flex items-center gap-2 text-xs text-muted">
                    {t.curveVar}
                    <select value={curveVar} onChange={(e) => setCv(e.target.value)} className="!text-sm font-medium">
                      {model!.json.num_cols.map((k) => (
                        <option key={k} value={k}>
                          {t.feats[k] ?? k}
                        </option>
                      ))}
                    </select>
                  </label>
                }
              >
                {curve ? (
                  <div className="h-64">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={curve} margin={{ top: 8, right: 16, left: -12, bottom: 4 }}>
                        <CartesianGrid stroke="var(--grid)" />
                        <XAxis dataKey="x" type="number" domain={["dataMin", "dataMax"]} {...AXIS} tickFormatter={(v: number) => v.toFixed(FEAT_FMT[curveVar]?.nd ?? 1)} />
                        <YAxis {...AXIS} axisLine={false} domain={[(m: number) => Math.max(20, Math.floor(m - 2)), (m: number) => Math.min(80, Math.ceil(m + 2))]} />
                        <Tooltip
                          contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12, color: "var(--ink)" }}
                          labelFormatter={(v) => `${t.feats[curveVar]} ${fmtFeat(curveVar, Number(v))}`}
                          formatter={(v) => [typeof v === "number" ? v.toFixed(1) : "-", tt.common.stuff]}
                        />
                        {startX !== null && Number.isFinite(startX) && (curX === null || Math.abs(curX - startX) > (FEAT_FMT[curveVar]?.step ?? 0.01)) && <ReferenceLine x={startX} stroke="var(--muted)" strokeDasharray="4 3" label={{ value: t.startMark, position: "insideTopLeft", fill: "var(--muted)", fontSize: 11 }} />}
                        {curX !== null && Number.isFinite(curX) && <ReferenceLine x={curX} stroke="var(--accent)" label={{ value: t.current, position: "insideTopRight", fill: "var(--accent-ink)", fontSize: 11 }} />}
                        <Line type="monotone" dataKey="s" stroke="var(--ink)" strokeWidth={2} dot={false} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                ) : (
                  <p className="text-sm text-muted">-</p>
                )}
                <p className="text-[11px] text-muted mt-2 leading-relaxed">{t.curveNote}</p>
              </Section>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

/** 입력 한 줄 : 이름 · 숫자 입력 · 1–99 분위 슬라이더 · 범위 밖 경고 */
function SliderRow({
  k,
  label,
  value,
  start,
  range,
  onChange,
  warn,
  disabled = false,
}: {
  k: string;
  label: string;
  value: number;
  start: number;
  range: [number, number] | null;
  onChange: (v: number) => void;
  warn: string;
  disabled?: boolean;
}) {
  const f = FEAT_FMT[k];
  const out = outOfRange(range, value);
  const changed = Number.isFinite(value) && Number.isFinite(start) && Math.abs(value - start) > f.step / 2;
  return (
    <div className={`flex flex-col gap-1 ${disabled ? "opacity-50" : ""}`}>
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={`sim-${k}`} className={`text-[13px] ${changed ? "text-ink font-semibold" : "text-ink-2"}`}>
          {label}
          {out && <span className="ml-2 text-[11px] font-medium text-bad">{warn}</span>}
        </label>
        <span className="flex items-center gap-1">
          <input
            id={`sim-${k}`}
            type="number"
            step={f.step}
            disabled={disabled}
            value={Number.isFinite(value) ? Number(value.toFixed(f.nd)) : ""}
            onChange={(e) => onChange(e.target.value === "" ? NaN : Number(e.target.value))}
            className="w-24 !py-1 !min-h-0 text-right text-sm num"
          />
          <span className="text-xs text-muted w-8">{f.unit.trim()}</span>
        </span>
      </div>
      {range && (
        <input
          type="range"
          aria-label={label}
          min={range[0]}
          max={range[1]}
          step={f.step}
          disabled={disabled}
          value={Number.isFinite(value) ? Math.min(range[1], Math.max(range[0], value)) : (range[0] + range[1]) / 2}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full accent-[var(--accent)]"
        />
      )}
    </div>
  );
}
