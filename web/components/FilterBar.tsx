"use client";
import type { Pitch } from "@/lib/types";
import { COUNT_STATES, RESULT_FILTERS } from "@/lib/analysis";
import { pitchColor, useDarkMode } from "@/lib/colors";

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
}

export default function FilterBar({ filters: f, setFilters, pitchTypes, teams, validStart, shown, total }: Props) {
  const dark = useDarkMode();
  const set = (patch: Partial<Filters>) => setFilters({ ...f, ...patch });
  const active = JSON.stringify(f) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <div className="card p-3 flex flex-col gap-2.5 text-xs">
      <Row label="구종">
        {pitchTypes.map((pt) => (
          <button key={pt} className="chip" aria-pressed={f.pitchTypes.includes(pt)} onClick={() => set({ pitchTypes: toggle(f.pitchTypes, pt) })}>
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: pitchColor(pitchTypes, pt, dark) }} />
            {pt}
          </button>
        ))}
      </Row>
      <Row label="결과">
        {RESULT_FILTERS.map((r) => (
          <button key={r.key} className="chip" aria-pressed={f.results.includes(r.key)} onClick={() => set({ results: toggle(f.results, r.key) })}>
            {r.label}
          </button>
        ))}
      </Row>
      <Row label="상황">
        {(
          [
            ["all", "전체 타자"],
            ["L", "vs 좌타"],
            ["R", "vs 우타"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className="chip" aria-pressed={f.hand === k} onClick={() => set({ hand: k })}>
            {label}
          </button>
        ))}
        <span className="w-px h-5 bg-grid mx-1" />
        {COUNT_STATES.map((c) => (
          <button key={c.key} className="chip" aria-pressed={f.counts.includes(c.key)} onClick={() => set({ counts: toggle(f.counts, c.key) })}>
            {c.label}
          </button>
        ))}
      </Row>
      <Row label="기타">
        <label className="flex items-center gap-1.5 text-ink-2">
          구위
          <input
            type="number"
            min={20}
            max={80}
            step={5}
            value={f.stuffMin}
            onChange={(e) => set({ stuffMin: Number(e.target.value) })}
            className="w-14 rounded-md border border-line bg-surface px-1.5 py-1 tnum"
            aria-label="구위 최소"
          />
          ~
          <input
            type="number"
            min={20}
            max={80}
            step={5}
            value={f.stuffMax}
            onChange={(e) => set({ stuffMax: Number(e.target.value) })}
            className="w-14 rounded-md border border-line bg-surface px-1.5 py-1 tnum"
            aria-label="구위 최대"
          />
        </label>
        {teams.length > 1 &&
          teams.map((t) => (
            <button key={t} className="chip" aria-pressed={f.teams.includes(t)} onClick={() => set({ teams: toggle(f.teams, t) })}>
              {t}
            </button>
          ))}
        {validStart && (
          <button
            className="chip"
            aria-pressed={f.validOnly}
            onClick={() => set({ validOnly: !f.validOnly })}
            title="모델 학습에 쓰이지 않은 기간만 보기"
          >
            검증기간만 ({validStart.slice(5)}~)
          </button>
        )}
        <span className="ml-auto text-muted tnum">
          {shown.toLocaleString()} / {total.toLocaleString()}구
        </span>
        {active && (
          <button className="text-accent-ink underline underline-offset-2" onClick={() => setFilters(EMPTY_FILTERS)}>
            필터 초기화
          </button>
        )}
      </Row>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="w-8 shrink-0 pt-1.5 text-muted">{label}</span>
      <div className="flex flex-wrap items-center gap-1.5 flex-1">{children}</div>
    </div>
  );
}
