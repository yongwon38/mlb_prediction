"use client";
import { useState } from "react";
import type { Pitch } from "@/lib/types";
import { COUNT_STATES, RESULT_FILTERS } from "@/lib/analysis";
import { pitchColor, useDarkMode } from "@/lib/colors";
import { useT } from "@/lib/i18n";

export interface Filters {
  pitchTypes: string[]; // 빈 배열 = 전체
  results: string[];
  hand: "all" | "L" | "R";
  counts: string[];
  teams: string[];
  stuffMin: number;
  stuffMax: number;
  validOnly: boolean;
}

export const EMPTY_FILTERS: Filters = {
  pitchTypes: [],
  results: [],
  hand: "all",
  counts: [],
  teams: [],
  stuffMin: 20,
  stuffMax: 80,
  validOnly: false,
};

export function applyFilters(ps: Pitch[], f: Filters, validStart: string | null): Pitch[] {
  const codes = new Set(RESULT_FILTERS.filter((r) => f.results.includes(r.key)).flatMap((r) => r.codes));
  const counts = COUNT_STATES.filter((c) => f.counts.includes(c.key));
  return ps.filter(
    (p) =>
      (!f.pitchTypes.length || f.pitchTypes.includes(p.pt)) &&
      (!codes.size || codes.has(p.r)) &&
      (f.hand === "all" || (f.hand === "L") === p.lhb) &&
      (!counts.length || counts.some((c) => c.test(p))) &&
      (!f.teams.length || f.teams.includes(p.team)) &&
      // 점수 없는 공(존 밖 볼·사구)은 구위 범위를 기본값(20~80)으로 둘 때만 표시
      (p.s === null ? f.stuffMin <= 20 && f.stuffMax >= 80 : p.s >= f.stuffMin && p.s <= f.stuffMax) &&
      (!f.validOnly || !validStart || p.date >= validStart),
  );
}

const toggle = (xs: string[], x: string) => (xs.includes(x) ? xs.filter((v) => v !== x) : [...xs, x]);

interface Props {
  filters: Filters;
  setFilters: (f: Filters) => void;
  pitchTypes: string[];
  teams: string[];
  validStart: string | null;
  shown: number;
  total: number;
  lead?: React.ReactNode; // 맨 앞 (경기 유형)
  below?: React.ReactNode; // 아래 줄 (구위 구간)
}

/** 투수 분석 필터 툴바 : 경기 유형·구종은 항상 보이고, 결과·상황·기타는 '필터 더보기'로 펼친다 */
export default function FilterBar({ filters: f, setFilters, pitchTypes, teams, validStart, shown, total, lead, below }: Props) {
  const dark = useDarkMode();
  const tt = useT();
  const t = tt.filters;
  const [open, setOpen] = useState(false);
  const set = (patch: Partial<Filters>) => setFilters({ ...f, ...patch });
  const active = JSON.stringify(f) !== JSON.stringify(EMPTY_FILTERS);
  // 펼침 영역에서 적용 중인 필터 수 (접혀 있어도 보이게)
  const hidden =
    f.results.length + f.counts.length + (f.hand !== "all" ? 1 : 0) + (f.stuffMin !== 20 || f.stuffMax !== 80 ? 1 : 0) + f.teams.length + (f.validOnly ? 1 : 0);

  return (
    <div className="card p-3 flex flex-col gap-3 text-xs lg:sticky lg:top-16 z-20">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        {lead}
        {lead && <span className="hidden sm:block w-px h-5 bg-line" />}
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t.pitch}>
          <span className="text-muted mr-1">{t.pitch}</span>
          {pitchTypes.map((pt) => (
            <button key={pt} className="chip" aria-pressed={f.pitchTypes.includes(pt)} onClick={() => set({ pitchTypes: toggle(f.pitchTypes, pt) })}>
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: pitchColor(pitchTypes, pt, dark) }} />
              {pt}
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-muted tnum">{t.shown(shown, total)}</span>
          {active && (
            <button className="text-accent-ink hover:underline underline-offset-2" onClick={() => setFilters(EMPTY_FILTERS)}>
              {t.reset}
            </button>
          )}
          <button
            className={`chip ${hidden ? "!border-accent !text-accent-ink" : ""}`}
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 6h16M7 12h10M10 18h4" />
            </svg>
            {open ? t.lessBtn : t.moreBtn(hidden)}
          </button>
        </div>
      </div>
      {open && (
        <div className="flex flex-col gap-2.5 border-t border-line pt-3">
          <Row label={t.result}>
            {RESULT_FILTERS.map((r) => (
              <button key={r.key} className="chip" aria-pressed={f.results.includes(r.key)} onClick={() => set({ results: toggle(f.results, r.key) })}>
                {tt.resultFilters[r.key]}
              </button>
            ))}
          </Row>
          <Row label={t.situation}>
            {(["all", "L", "R"] as const).map((k) => (
              <button key={k} className="chip" aria-pressed={f.hand === k} onClick={() => set({ hand: k })}>
                {t.hand[k]}
              </button>
            ))}
            <span className="w-px h-5 bg-line mx-1" />
            {COUNT_STATES.map((c) => (
              <button key={c.key} className="chip" aria-pressed={f.counts.includes(c.key)} onClick={() => set({ counts: toggle(f.counts, c.key) })}>
                {tt.countStates[c.key]}
              </button>
            ))}
          </Row>
          <Row label={t.more}>
            <label className="flex items-center gap-1.5 text-ink-2">
              {t.stuff}
              <input
                type="number"
                min={20}
                max={80}
                step={5}
                value={f.stuffMin}
                onChange={(e) => set({ stuffMin: Number(e.target.value) })}
                className="w-16 !min-h-0 !py-1 !px-2 !text-xs tnum"
                aria-label={t.stuffMin}
              />
              ~
              <input
                type="number"
                min={20}
                max={80}
                step={5}
                value={f.stuffMax}
                onChange={(e) => set({ stuffMax: Number(e.target.value) })}
                className="w-16 !min-h-0 !py-1 !px-2 !text-xs tnum"
                aria-label={t.stuffMax}
              />
            </label>
            {teams.length > 1 &&
              teams.map((t) => (
                <button key={t} className="chip" aria-pressed={f.teams.includes(t)} onClick={() => set({ teams: toggle(f.teams, t) })}>
                  {t}
                </button>
              ))}
            {validStart && (
              <button className="chip" aria-pressed={f.validOnly} onClick={() => set({ validOnly: !f.validOnly })} title={t.validTitle}>
                {t.validOnly(validStart.slice(5))}
              </button>
            )}
          </Row>
        </div>
      )}
      {below && <div className="border-t border-line pt-3">{below}</div>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-10 shrink-0 pt-1.5 text-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5 flex-1">{children}</div>
    </div>
  );
}
