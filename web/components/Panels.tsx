"use client";
import { useMemo, useState } from "react";
import type { League, Pitch } from "@/lib/types";
import { type Note, type Stats, groupBy, percentileOf, stats } from "@/lib/analysis";
import { pitchColor, stuffColor, stuffTint, useDarkMode } from "@/lib/colors";
import { type Dict, useT } from "@/lib/i18n";

export const f3 = (x: number | null | undefined) => (x === null || x === undefined ? "-" : x.toFixed(3).replace(/^0/, ""));
export const pct = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "-" : `${(x * 100).toFixed(d)}%`);
export const f1 = (x: number | null | undefined, d = 1) => (x === null || x === undefined ? "-" : x.toFixed(d));

export function Section({ title, sub, children, right, className = "" }: { title: string; sub?: string; children: React.ReactNode; right?: React.ReactNode; className?: string }) {
  return (
    <section className={`card p-5 min-w-0 ${className}`}>
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 mb-4">
        <div className="min-w-0 max-w-[68ch]">
          <h2 className="text-[15px] font-semibold tracking-tight text-ink">{title}</h2>
          {sub && <p className="text-xs text-muted mt-1 leading-relaxed">{sub}</p>}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

/** 구위 점수 배지 : 램프 색 점 + 굵은 숫자, 배경은 램프 색을 옅게 */
export function StuffBadge({ v, size = "md", className = "" }: { v: number | null | undefined; size?: "sm" | "md" | "lg"; className?: string }) {
  const dark = useDarkMode();
  if (v === null || v === undefined) return <span className="text-muted">-</span>;
  const cls = size === "lg" ? "text-2xl px-3 py-1 rounded-xl" : size === "sm" ? "text-xs px-1.5 py-0.5 rounded-md" : "text-sm px-2 py-0.5 rounded-lg";
  return (
    <span className={`inline-flex items-center gap-1.5 num text-ink ${cls} ${className}`} style={{ background: stuffTint(v, dark, dark ? 0.22 : 0.16) }}>
      <span className={`rounded-full shrink-0 ${size === "lg" ? "w-2.5 h-2.5" : "w-1.5 h-1.5"}`} style={{ background: stuffColor(v, dark) }} />
      {v.toFixed(1)}
    </span>
  );
}

/** 0~100 퍼센타일 가로 막대 (리그 내 위치) */
export function PctlBar({ v, className = "" }: { v: number | null; className?: string }) {
  if (v === null) return null;
  const tone = v >= 70 ? "bg-bad" : v <= 30 ? "bg-accent" : "bg-muted";
  return (
    <span className={`relative block h-1 rounded-full bg-surface-3 overflow-hidden ${className}`} aria-hidden="true">
      <span className={`absolute inset-y-0 left-0 rounded-full ${tone}`} style={{ width: `${Math.max(3, v)}%` }} />
    </span>
  );
}

/** 빈 상태 : 한 줄 안내 + 선택적 행동 */
export function EmptyState({ title, body, action, className = "" }: { title: string; body?: string; action?: React.ReactNode; className?: string }) {
  return (
    <div className={`card px-6 py-12 flex flex-col items-center justify-center text-center gap-2 ${className}`}>
      <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--muted)" strokeWidth="1.6" aria-hidden="true">
        <circle cx="12" cy="12" r="9.5" />
        <path d="M8.2 4.2c1.6 2 2.4 4.6 2.4 7.8s-.8 5.8-2.4 7.8M15.8 4.2c-1.6 2-2.4 4.6-2.4 7.8s.8 5.8 2.4 7.8" strokeLinecap="round" />
      </svg>
      <p className="text-sm font-medium text-ink">{title}</p>
      {body && <p className="text-xs text-muted max-w-[44ch] leading-relaxed">{body}</p>}
      {action}
    </div>
  );
}

/** 로딩 자리 : 스켈레톤 블록 + 스크린리더용 문구 */
export function LoadingBlock({ label, rows = 3 }: { label: string; rows?: number }) {
  return (
    <div className="card p-5 flex flex-col gap-3" role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      <div className="skeleton h-4 w-40" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton h-10" style={{ opacity: 1 - i * 0.2 }} />
      ))}
      <p className="text-xs text-muted">{label}</p>
    </div>
  );
}

export function Toggle<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex rounded-lg bg-surface-2 p-0.5 text-xs shrink-0">
      {options.map(([k, l]) => (
        <button
          key={k}
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={`px-2.5 py-1 rounded-md transition-colors ${value === k ? "bg-surface text-ink font-semibold shadow-sm" : "text-muted hover:text-ink"}`}
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
    <div className="rounded-xl bg-surface-2 px-3.5 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-xl num text-ink mt-1 whitespace-nowrap">{value}</div>
      {sub && <div className={`text-xs mt-1 ${tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-muted"}`}>{sub}</div>}
    </div>
  );
}

export function SummaryTiles({ st, league }: { st: Stats; league: League }) {
  const t = useT();
  const T = t.tiles;
  const p = percentileOf(league.pitcherPercentiles, st.stuff);
  const lg = league.overall;
  // 투수 관점 : 높을수록 좋은 지표(good-high) / 낮을수록 좋은 지표
  const cmp = (v: number | null, ref: number | null, higherIsGood: boolean, fmt: (x: number) => string) => {
    if (v === null || ref === null) return { sub: undefined, tone: undefined };
    const better = higherIsGood ? v > ref : v < ref;
    return { sub: T.lg(fmt(ref)), tone: (Math.abs(v - ref) / ref > 0.05 ? (better ? "good" : "bad") : undefined) as "good" | "bad" | undefined };
  };
  const pc = (x: number) => pct(x);
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
      <Tile label={T.stuff} value={f1(st.stuff)} sub={p === null ? undefined : T.stuffSub(100 - p)} tone={p === null ? undefined : p >= 60 ? "good" : p <= 40 ? "bad" : undefined} />
      <Tile label={T.pitchesPa} value={`${st.n.toLocaleString()}`} sub={T.pitchesPaSub(st.pa, st.k, st.bb)} />
      <Tile label="Whiff%" value={pct(st.whiff)} {...cmp(st.whiff, lg.whiff, true, pc)} />
      <Tile label="CSW%" value={pct(st.csw)} {...cmp(st.csw, lg.csw, true, pc)} />
      <Tile label={t.common.ba} value={f3(st.ba)} {...cmp(st.ba, lg.ba, false, f3)} />
      <Tile label={t.common.slg} value={f3(st.slg)} {...cmp(st.slg, lg.slg, false, f3)} />
      <Tile label={t.common.xwoba} value={f3(st.xwoba)} {...cmp(st.xwoba, lg.xwoba, false, f3)} />
      <Tile label="Chase% / Zone%" value={`${pct(st.chase, 0)} / ${pct(st.zonePct, 0)}`} sub={T.chaseZoneSub} />
    </div>
  );
}

export function NotesList({ notes }: { notes: Note[] }) {
  const icon = { good: "▲", bad: "▼", info: "•" };
  const label = useT().noteTone;
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {notes.map((n, i) => (
        <li key={i} className="flex gap-2 leading-relaxed">
          <span
            className={`shrink-0 mt-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-md h-fit whitespace-nowrap ${
              n.tone === "good" ? "text-good bg-good/10" : n.tone === "bad" ? "text-bad bg-bad/10" : "text-muted bg-surface-2"
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

const arsenalCols = (t: Dict): Col[] => [
  { key: "n", label: t.arsenal.n, get: (r) => r.st.n, fmt: (v) => (v ?? 0).toLocaleString() },
  { key: "usage", label: t.arsenal.usage, get: (r) => r.usage, fmt: (v) => pct(v) },
  { key: "velo", label: t.arsenal.velo, title: t.arsenal.veloTitle, get: (r) => r.st.velo, fmt: (v) => f1(v) },
  { key: "ivb", label: "IVB", title: t.arsenal.ivbTitle, get: (r) => r.st.ivb, fmt: (v) => f1(v) },
  { key: "hb", label: "HB", title: t.arsenal.hbTitle, get: (r) => r.st.hb, fmt: (v) => f1(v) },
  { key: "spin", label: t.arsenal.spin, get: (r) => r.st.spin, fmt: (v) => f1(v, 0) },
  { key: "stuff", label: t.arsenal.stuff, title: t.arsenal.stuffTitle, get: (r) => r.st.stuff, fmt: (v) => f1(v) },
  { key: "pctl", label: t.arsenal.pctl, title: t.arsenal.pctlTitle, get: (r) => r.pctl, fmt: (v) => (v === null ? "-" : String(v)) },
  { key: "whiff", label: "Whiff%", get: (r) => r.st.whiff, fmt: (v) => pct(v) },
  { key: "csw", label: "CSW%", get: (r) => r.st.csw, fmt: (v) => pct(v) },
  { key: "chase", label: "Chase%", get: (r) => r.st.chase, fmt: (v) => pct(v) },
  { key: "ba", label: t.common.ba, get: (r) => r.st.ba, fmt: (v) => f3(v) },
  { key: "slg", label: t.common.slg, get: (r) => r.st.slg, fmt: (v) => f3(v) },
  { key: "xwobacon", label: "xwOBAcon", title: t.arsenal.xwobaconTitle, get: (r) => r.st.xwobacon, fmt: (v) => f3(v) },
];

export function ArsenalTable({ ps, pitchTypes, league, pitchNames }: { ps: Pitch[]; pitchTypes: string[]; league: League; pitchNames: Record<string, string> }) {
  const dark = useDarkMode();
  const t = useT();
  const COLS = useMemo(() => arsenalCols(t), [t]);
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
  }, [ps, pitchTypes, league, sort, COLS]);

  return (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="w-full text-xs tnum border-collapse min-w-[860px]">
        <thead>
          <tr className="text-muted border-b border-grid">
            <th className="text-left font-normal py-2 pr-2">{t.arsenal.pitch}</th>
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
                    {c.key === "pctl" ? <PctlBadge v={r.pctl} /> : c.key === "stuff" ? <StuffBadge v={r.st.stuff} size="sm" /> : c.fmt(c.get(r))}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[11px] text-muted mt-2">
        {t.arsenal.foot(league.minPitchTypePitches)}
      </p>
    </div>
  );
}

function PctlBadge({ v }: { v: number | null }) {
  if (v === null) return <span className="text-muted">-</span>;
  const tone = v >= 70 ? "text-good" : v <= 30 ? "text-bad" : "text-ink";
  return <span className={tone}>{v}</span>;
}
