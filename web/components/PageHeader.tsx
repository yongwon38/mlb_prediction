"use client";
import Link from "next/link";
import { ctxHref } from "@/lib/appState";
import type { Meta } from "@/lib/types";

/** 시즌 선택 */
export function SeasonSelect({ meta, season, onChange }: { meta: Meta | null; season: number | null; onChange: (s: number) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm text-ink-2">
      시즌
      <select value={season ?? ""} onChange={(e) => onChange(Number(e.target.value))} aria-label="시즌 선택">
        {meta?.seasons.map((s) => (
          <option key={s} value={s}>
            {s}
            {s !== meta.trainSeason ? " (out-of-sample)" : " (학습 시즌)"}
          </option>
        ))}
      </select>
    </label>
  );
}

/** 경기 유형 선택 (정규 / 포스트시즌 / 시범). single = 하나만 */
export function GameTypePicker({
  labels,
  value,
  onChange,
  counts,
  single = false,
}: {
  labels: string[];
  value: number[];
  onChange: (v: number[]) => void;
  counts?: (number | null | undefined)[];
  single?: boolean;
}) {
  const toggle = (g: number) => {
    if (single) return onChange([g]);
    const next = value.includes(g) ? value.filter((v) => v !== g) : [...value, g].sort();
    onChange(next.length ? next : [g]);
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="경기 유형">
      <span className="text-muted mr-1">경기 유형</span>
      {labels.map((l, g) => {
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

const TABS: { key: PitcherTab; label: string; group?: string }[] = [
  { key: "pitcher", label: "분석" },
  { key: "games", label: "경기·타석" },
  { key: "explain", label: "개요", group: "구위 산출 근거" },
  { key: "explain/pitch-types", label: "구종별", group: "구위 산출 근거" },
  { key: "explain/bands", label: "점수대별", group: "구위 산출 근거" },
  { key: "explain/pitch", label: "투구 1개", group: "구위 산출 근거" },
];

/** 투수 페이지 공통 머리 : 이름·정보 + 하위 페이지 탭 */
export function PitcherHeader({
  title,
  name,
  info,
  season,
  pitcherId,
  gt,
  active,
  right,
}: {
  title?: string;
  name: string | null;
  info?: React.ReactNode;
  season: number | null;
  pitcherId: number | null;
  gt: number[];
  active: PitcherTab;
  right?: React.ReactNode;
}) {
  const c = { season, pitcher: pitcherId, gt };
  return (
    <header className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          {title && <p className="text-xs text-muted">{title}</p>}
          <h1 className="text-2xl font-bold tracking-tight text-ink">{name ?? "투수를 선택하세요"}</h1>
          {info && <div className="text-sm text-ink-2 mt-0.5">{info}</div>}
        </div>
        {right}
      </div>
      {pitcherId && (
        <div className="flex flex-wrap items-center gap-1 text-sm border-b border-line" role="tablist" aria-label="투수 하위 페이지">
          {TABS.map((t, i) => (
            <span key={t.key} className="flex items-center">
              {t.group && TABS[i - 1]?.group !== t.group && <span className="text-xs text-muted ml-3 mr-1">{t.group}</span>}
              <Link
                href={ctxHref(`/${t.key}`, c)}
                role="tab"
                aria-selected={active === t.key}
                className={`px-2.5 py-2 border-b-2 -mb-px ${active === t.key ? "border-accent text-ink font-semibold" : "border-transparent text-ink-2 hover:text-ink"}`}
              >
                {t.label}
              </Link>
            </span>
          ))}
        </div>
      )}
    </header>
  );
}
