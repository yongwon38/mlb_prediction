"use client";
import { useMemo, useState } from "react";
import type { League, Pitch } from "@/lib/types";
import { type Note, type Stats, groupBy, percentileOf, stats } from "@/lib/analysis";
import { pitchColor, useDarkMode } from "@/lib/colors";

export const f3 = (x: number | null | undefined) => (x === null || x === undefined ? "-" : x.toFixed(3).replace(/^0/, ""));
export const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "-" : `${(x * 100).toFixed(d)}%`);
export const f1 = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "-" : x.toFixed(d));

export function Section({ title, sub, children, right }: { title: string; sub?: string; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="card p-4 min-w-0">
      <header className="flex flex-wrap items-start justify-between gap-2 mb-3">
        <div>
          <h2 className="text-sm font-semibold text-ink">{title}</h2>
          {sub && <p className="text-xs text-muted mt-0.5">{sub}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

export function Toggle<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-surface-2 p-0.5 text-xs">
      {options.map(([k, l]) => (
        <button
          key={k}
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={`px-2.5 py-1 rounded-md ${value === k ? "bg-surface text-ink font-medium shadow-sm" : "text-ink-2"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// 요약 카드
// ---------------------------------------------------------------------------
function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: "good" | "bad" }) {
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2.5">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-xl font-semibold text-ink mt-0.5">{value}</div>
      {sub && <div className={`text-xs mt-0.5 ${tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-muted"}`}>{sub}</div>}
    </div>
  );
}

export function SummaryTiles({ st, league }: { st: Stats; league: League }) {
  const p = percentileOf(league.pitcherPercentiles, st.stuff);
  const lg = league.overall;
  // 투수 관점 : 높을수록 좋은 지표(good-high) / 낮을수록 좋은 지표
  const cmp = (v: number | null, ref: number | null, higherIsGood: boolean, fmt: (x: number) => string) => {
    if (v === null || ref === null) return { sub: undefined, tone: undefined };
    const better = higherIsGood ? v > ref : v < ref;
    return { sub: `리그 ${fmt(ref)}`, tone: (Math.abs(v - ref) / ref > 0.05 ? (better ? "good" : "bad") : undefined) as "good" | "bad" | undefined };
  };
  const pc = (x: number) => pct(x);
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <Tile label="평균 구위 (20-80)" value={f1(st.stuff)} sub={p === null ? undefined : `리그 투수 상위 ${100 - p}%`} tone={p === null ? undefined : p >= 60 ? "good" : p <= 40 ? "bad" : undefined} />
      <Tile label="투구 / 타석" value={`${st.n.toLocaleString()}`} sub={`${st.pa.toLocaleString()} 타석 · K ${st.k} · BB ${st.bb}`} />
      <Tile label="Whiff%" value={pct(st.whiff)} {...cmp(st.whiff, lg.whiff, true, pc)} />
      <Tile label="CSW%" value={pct(st.csw)} {...cmp(st.csw, lg.csw, true, pc)} />
      <Tile label="피안타율" value={f3(st.ba)} {...cmp(st.ba, lg.ba, false, f3)} />
      <Tile label="피장타율" value={f3(st.slg)} {...cmp(st.slg, lg.slg, false, f3)} />
      <Tile label="피xwOBA" value={f3(st.xwoba)} {...cmp(st.xwoba, lg.xwoba, false, f3)} />
      <Tile label="Chase% / Zone%" value={`${pct(st.chase, 0)} / ${pct(st.zonePct, 0)}`} sub="존 밖 스윙 / 존 투구" />
    </div>
  );
}

export function NotesList({ notes }: { notes: Note[] }) {
  const icon = { good: "▲", bad: "▼", info: "•" };
  const label = { good: "강점", bad: "주의", info: "참고" };
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {notes.map((n, i) => (
        <li key={i} className="flex gap-2 leading-relaxed">
          <span
            className={`shrink-0 mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded h-fit ${
              n.tone === "good" ? "text-good bg-surface-2" : n.tone === "bad" ? "text-bad bg-surface-2" : "text-muted bg-surface-2"
            }`}
          >
            {icon[n.tone]} {label[n.tone]}
          </span>
          <span className="text-ink-2">{n.text}</span>
        </li>
      ))}
    </ul>
  );
}

// ---------------------------------------------------------------------------
// 구종 아스널 테이블
// ---------------------------------------------------------------------------
type Col = { key: string; label: string; title?: string; get: (r: Row) => number | null; fmt: (v: number | null) => string };
interface Row {
  pt: string;
  st: Stats;
  usage: number;
  pctl: number | null;
  lgStuff: number | null;
}

const COLS: Col[] = [
  { key: "n", label: "투구", get: (r) => r.st.n, fmt: (v) => (v ?? 0).toLocaleString() },
  { key: "usage", label: "구사율", get: (r) => r.usage, fmt: (v) => pct(v) },
  { key: "velo", label: "구속", title: "평균 구속 (mph)", get: (r) => r.st.velo, fmt: (v) => f1(v) },
  { key: "ivb", label: "IVB", title: "수직 무브먼트 (in, 중력 제외)", get: (r) => r.st.ivb, fmt: (v) => f1(v) },
  { key: "hb", label: "HB", title: "수평 무브먼트 (in, 포수 시점 +는 1루쪽)", get: (r) => r.st.hb, fmt: (v) => f1(v) },
  { key: "spin", label: "회전", get: (r) => r.st.spin, fmt: (v) => f1(v, 0) },
  { key: "stuff", label: "구위", title: "평균 구위 score (20-80)", get: (r) => r.st.stuff, fmt: (v) => f1(v) },
  { key: "pctl", label: "리그 %ile", title: "리그 동일 구종(50구+ 투수) 대비 퍼센타일", get: (r) => r.pctl, fmt: (v) => (v === null ? "-" : String(v)) },
  { key: "whiff", label: "Whiff%", get: (r) => r.st.whiff, fmt: (v) => pct(v) },
  { key: "csw", label: "CSW%", get: (r) => r.st.csw, fmt: (v) => pct(v) },
  { key: "chase", label: "Chase%", get: (r) => r.st.chase, fmt: (v) => pct(v) },
  { key: "ba", label: "피안타율", get: (r) => r.st.ba, fmt: (v) => f3(v) },
  { key: "slg", label: "피장타율", get: (r) => r.st.slg, fmt: (v) => f3(v) },
  { key: "xwobacon", label: "xwOBAcon", title: "인플레이 타구 xwOBA", get: (r) => r.st.xwobacon, fmt: (v) => f3(v) },
];

export function ArsenalTable({ ps, pitchTypes, league, pitchNames }: { ps: Pitch[]; pitchTypes: string[]; league: League; pitchNames: Record<string, string> }) {
  const dark = useDarkMode();
  const [sort, setSort] = useState<{ key: string; desc: boolean }>({ key: "usage", desc: true });
  const rows = useMemo(() => {
    const g = groupBy(ps, (p) => p.pt);
    const out: Row[] = pitchTypes
      .filter((pt) => g.has(pt))
      .map((pt) => {
        const st = stats(g.get(pt)!);
        const lp = league.pitchTypes[pt];
        return { pt, st, usage: st.n / ps.length, pctl: percentileOf(lp?.pitcherPercentiles, st.stuff), lgStuff: lp?.pitchQuantiles[2] ?? null };
      });
    const col = COLS.find((c) => c.key === sort.key)!;
    return out.sort((a, b) => ((col.get(a) ?? -Infinity) - (col.get(b) ?? -Infinity)) * (sort.desc ? -1 : 1));
  }, [ps, pitchTypes, league, sort]);

  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="w-full text-xs tnum border-collapse min-w-[860px]">
        <thead>
          <tr className="text-muted border-b border-grid">
            <th className="text-left font-normal py-2 pr-2">구종</th>
            {COLS.map((c) => (
              <th key={c.key} className="text-right font-normal py-2 px-1.5" title={c.title} aria-sort={sort.key === c.key ? (sort.desc ? "descending" : "ascending") : "none"}>
                <button className="hover:text-ink" onClick={() => setSort({ key: c.key, desc: sort.key === c.key ? !sort.desc : true })}>
                  {c.label}
                  {sort.key === c.key ? (sort.desc ? " ↓" : " ↑") : ""}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const small = r.st.n < 20;
            return (
              <tr key={r.pt} className={`border-b border-grid last:border-0 ${small ? "opacity-50" : ""}`}>
                <td className="py-2 pr-2 whitespace-nowrap">
                  <span className="inline-block w-2.5 h-2.5 rounded-full mr-2 align-middle" style={{ background: pitchColor(pitchTypes, r.pt, dark) }} />
                  <span className="font-medium text-ink">{r.pt}</span>
                  <span className="text-muted ml-1.5">{pitchNames[r.pt]}</span>
                </td>
                {COLS.map((c) => (
                  <td key={c.key} className={`text-right py-2 px-1.5 ${c.key === "stuff" || c.key === "pctl" ? "font-semibold text-ink" : "text-ink-2"}`}>
                    {c.key === "pctl" ? <PctlBadge v={r.pctl} /> : c.fmt(c.get(r))}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[11px] text-muted mt-2">
        리그 %ile : 같은 구종을 {league.minPitchTypePitches}구 이상 던진 투수들의 평균 구위 분포에서의 위치. 20구 미만 구종은 흐리게 표시.
      </p>
    </div>
  );
}

function PctlBadge({ v }: { v: number | null }) {
  if (v === null) return <span className="text-muted">-</span>;
  const tone = v >= 70 ? "text-good" : v <= 30 ? "text-bad" : "text-ink";
  return <span className={tone}>{v}</span>;
}
