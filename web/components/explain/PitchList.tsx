"use client";
import { useMemo, useState } from "react";
import type { ExplainPitch } from "@/lib/types";
import { RESULT_LABELS } from "@/lib/analysis";
import { pitchColor, useDarkMode } from "@/lib/colors";
import { pitchOneLiner, scored } from "@/lib/explain";
import { Toggle } from "@/components/Panels";

type Order = "best" | "worst" | "date";
const ORDERS: [Order, string][] = [
  ["best", "구위 높은 순"],
  ["worst", "구위 낮은 순"],
  ["date", "날짜순"],
];
const PAGE = 30;

export default function PitchList({ ps, pitchTypes, groups, selected, onSelect }: { ps: ExplainPitch[]; pitchTypes: string[]; groups: string[]; selected: number | null; onSelect: (i: number) => void }) {
  const dark = useDarkMode();
  const [order, setOrder] = useState<Order>("best");
  const [limit, setLimit] = useState(PAGE);
  const rows = useMemo(() => {
    const xs = scored(ps);
    if (order === "best") return [...xs].sort((a, b) => (b.s as number) - (a.s as number));
    if (order === "worst") return [...xs].sort((a, b) => (a.s as number) - (b.s as number));
    return [...xs].sort((a, b) => a.i - b.i);
  }, [ps, order]);

  return (
    <div className="flex flex-col gap-2 min-w-0">
      <div className="flex items-center justify-between gap-2">
        <Toggle label="정렬" value={order} options={ORDERS} onChange={(o) => (setOrder(o), setLimit(PAGE))} />
        <span className="text-xs text-muted tnum">{rows.length.toLocaleString()}구</span>
      </div>
      <ul className="max-h-[520px] overflow-y-auto text-xs border-t border-grid">
        {rows.slice(0, limit).map((p) => (
          <li key={p.i}>
            <button
              onClick={() => onSelect(p.i)}
              aria-pressed={selected === p.i}
              className={`w-full text-left grid grid-cols-[auto_auto_1fr_auto] items-center gap-x-2 px-1.5 py-1.5 border-b border-grid hover:bg-surface-2 ${selected === p.i ? "bg-surface-2" : ""}`}
            >
              <span className="tnum text-muted w-[68px]">{p.date.slice(5)}</span>
              <span className="flex items-center gap-1 w-10">
                <span className="w-2 h-2 rounded-full" style={{ background: pitchColor(pitchTypes, p.pt, dark) }} />
                {p.pt}
              </span>
              <span className="truncate text-ink-2">
                {RESULT_LABELS[p.r]} · {pitchOneLiner(p, groups)}
              </span>
              <span className="tnum font-semibold text-ink w-9 text-right">{(p.s as number).toFixed(1)}</span>
            </button>
          </li>
        ))}
      </ul>
      {rows.length > limit && (
        <button className="text-xs text-accent-ink underline underline-offset-2 self-start" onClick={() => setLimit(limit + PAGE)}>
          {PAGE}구 더 보기
        </button>
      )}
    </div>
  );
}
