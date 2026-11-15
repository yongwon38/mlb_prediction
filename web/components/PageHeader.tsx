"use client";
import Link from "next/link";
import { ctxHref } from "@/lib/appState";
import { useT } from "@/lib/i18n";
import type { Meta } from "@/lib/types";
import { StuffBadge } from "@/components/Panels";

/** 시즌 선택 */
export function SeasonSelect({ meta, season, onChange }: { meta: Meta | null; season: number | null; onChange: (s: number) => void }) {
  const t = useT().header;
  return (
    <label className="flex items-center gap-2 text-xs text-muted shrink-0">
      {t.season}
      <select value={season ?? ""} onChange={(e) => onChange(Number(e.target.value))} aria-label={t.seasonAria} className="!text-sm font-medium">
        {meta?.seasons.map((s) => (
          <option key={s} value={s}>
            {s}
            {s !== meta.trainSeason ? t.oosTag : t.trainTag}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 경기 유형 선택 (정규 / 포스트시즌 / 시범). single = 하나만 */
export function GameTypePicker({
  value,
  onChange,
  counts,
  single = false,
  label = true,
}: {
  value: number[];
  onChange: (v: number[]) => void;
  counts?: (number | null | undefined)[];
  single?: boolean;
  label?: boolean;
}) {
  const t = useT();
  const toggle = (g: number) => {
    if (single) return onChange([g]);
    const next = value.includes(g) ? value.filter((v) => v !== g) : [...value, g].sort();
    onChange(next.length ? next : [g]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label={t.header.gameType}>
      {label && <span className="text-muted mr-1">{t.header.gameType}</span>}
      {t.gameTypes.map((l, g) => {
        const n = counts?.[g];
        const disabled = counts !== undefined && !n;
        return (
          <button key={g} className="chip disabled:opacity-40 disabled:cursor-not-allowed" aria-pressed={value.includes(g)} disabled={disabled} onClick={() => toggle(g)}>
            {l}
            {n !== undefined && <span className="tnum text-muted">{(n ?? 0).toLocaleString()}</span>}
          </button>
        );
      })}
    </div>
  );
}

export type PitcherTab = "pitcher" | "games" | "explain" | "explain/pitch-types" | "explain/bands" | "explain/pitch";

const MAIN_TABS: PitcherTab[] = ["pitcher", "games", "explain"];
const EXPLAIN_TABS: PitcherTab[] = ["explain", "explain/pitch-types", "explain/bands", "explain/pitch"];

/** 투수 페이지 공통 머리 : 이름·구위 배지·정보 + 1단 탭(분석 / 경기·타석 / 구위 산출 근거) + 근거 하위 탭 */
export function PitcherHeader({
  title,
  name,
  info,
  stuff,
  season,
  pitcherId,
  gt,
  active,
  right,
}: {
  title?: string;
  name: string | null;
  info?: React.ReactNode;
  stuff?: number | null;
  season: number | null;
  pitcherId: number | null;
  gt: number[];
  active: PitcherTab;
  right?: React.ReactNode;
}) {
  const tt = useT();
  const t = tt.header;
  const c = { season, pitcher: pitcherId, gt };
  const inExplain = active.startsWith("explain");
  const mainLabel = (k: PitcherTab) => (k === "explain" ? t.explainGroup : t.tabs[k]);
  return (
    <header className="flex flex-col gap-4 pt-2">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          {title && name && <p className="eyebrow mb-1.5">{title}</p>}
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-bold tracking-tight text-ink">{name ?? t.pickPitcher}</h1>
            {pitcherId && stuff !== undefined && stuff !== null && <StuffBadge v={stuff} size="md" />}
          </div>
          {info && <div className="text-sm text-ink-2 mt-1.5">{info}</div>}
        </div>
        {right}
      </div>
      {pitcherId && (
        <div className="flex flex-col gap-2">
          <div className="flex items-center gap-1 border-b border-line overflow-x-auto no-scrollbar" role="tablist" aria-label={t.tabsAria}>
            {MAIN_TABS.map((k) => {
              const on = k === "explain" ? inExplain : active === k;
              return (
                <Link
                  key={k}
                  href={ctxHref(`/${k}`, c)}
                  role="tab"
                  aria-selected={on}
                  className={`shrink-0 px-3 py-2.5 text-sm border-b-2 -mb-px transition-colors ${on ? "border-ink text-ink font-semibold" : "border-transparent text-ink-2 hover:text-ink"}`}
                >
                  {mainLabel(k)}
                </Link>
              );
            })}
          </div>
          {inExplain && (
            <div className="flex flex-wrap items-center gap-1" role="tablist" aria-label={t.explainGroup}>
              {EXPLAIN_TABS.map((k) => (
                <Link
                  key={k}
                  href={ctxHref(`/${k}`, c)}
                  role="tab"
                  aria-selected={active === k}
                  className={`px-3 py-1 rounded-full text-xs transition-colors ${active === k ? "bg-ink text-surface font-semibold" : "text-ink-2 hover:bg-surface-2 hover:text-ink"}`}
                >
                  {t.tabs[k]}
                </Link>
              ))}
            </div>
          )}
        </div>
      )}
    </header>
  );
}
