"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PitcherEntry, SeasonIndex } from "@/lib/types";

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

interface Props {
  index: SeasonIndex | null;
  selectedId: number | null;
  onSelect: (id: number, team?: string) => void;
}

export default function SearchPanel({ index, selectedId, onSelect }: Props) {
  const [mode, setMode] = useState<"name" | "team">("name");

  return (
    <div className="card p-4">
      <div role="tablist" aria-label="검색 방식" className="flex gap-1 mb-3 text-sm">
        {(
          [
            ["name", "이름으로 검색"],
            ["team", "구단으로 찾기"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={mode === key}
            onClick={() => setMode(key)}
            className={`px-3 py-1.5 rounded-lg ${mode === key ? "bg-ink text-surface font-medium" : "text-ink-2 hover:bg-surface-2"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {!index ? (
        <div className="h-10 text-sm text-muted flex items-center">투수 목록 불러오는 중…</div>
      ) : mode === "name" ? (
        <NameSearch pitchers={index.pitchers} onSelect={onSelect} />
      ) : (
        <TeamSearch index={index} selectedId={selectedId} onSelect={onSelect} />
      )}
    </div>
  );
}

function NameSearch({ pitchers, onSelect }: { pitchers: PitcherEntry[]; onSelect: Props["onSelect"] }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);

  const keyed = useMemo(() => pitchers.map((p) => ({ p, key: normalize(p.name) })), [pitchers]);
  const results = useMemo(() => {
    const nq = normalize(q);
    if (!nq) return [];
    const terms = nq.split(" ");
    return keyed
      .filter(({ key }) => terms.every((t) => key.split(" ").some((w) => w.startsWith(t)) || key.includes(t)))
      .map(({ p, key }) => ({ p, starts: key.startsWith(nq) || key.split(" ").some((w) => w.startsWith(nq)) }))
      .sort((a, b) => Number(b.starts) - Number(a.starts) || b.p.n - a.p.n)
      .slice(0, 12)
      .map((r) => r.p);
  }, [q, keyed]);

  useEffect(() => {
    const close = (e: MouseEvent) => !boxRef.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);

  const pick = (p: PitcherEntry) => {
    onSelect(p.id);
    setQ(p.name);
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <input
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="pitcher-results"
        aria-label="투수 이름"
        placeholder="투수 이름 (영문) — 예: Skenes, deGrom, Tarik"
        className="w-full"
        value={q}
        onChange={(e) => (setQ(e.target.value), setOpen(true), setActive(0))}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, results.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter" && results[active]) pick(results[active]);
          else if (e.key === "Escape") setOpen(false);
        }}
      />
      {open && q && (
        <ul id="pitcher-results" role="listbox" className="absolute z-30 mt-1 w-full card shadow-lg max-h-80 overflow-auto py-1">
          {results.length === 0 && <li className="px-3 py-2 text-sm text-muted">검색 결과 없음</li>}
          {results.map((p, i) => (
            <li
              key={p.id}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => (e.preventDefault(), pick(p))}
              className={`px-3 py-2 text-sm flex justify-between gap-3 cursor-pointer ${i === active ? "bg-surface-2" : ""}`}
            >
              <span>
                <span className="font-medium">{p.name}</span>
                <span className="text-muted ml-2">
                  {p.throws}HP · {p.teams.join(" / ")}
                </span>
              </span>
              <span className="text-muted tnum shrink-0">
                {p.n.toLocaleString()}구 · 구위 {p.stuff?.toFixed(1) ?? "-"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function TeamSearch({ index, selectedId, onSelect }: { index: SeasonIndex; selectedId: number | null; onSelect: Props["onSelect"] }) {
  const [league, setLeague] = useState<"" | "AL" | "NL">("");
  const [team, setTeam] = useState("");

  const roster = useMemo(
    () => (team ? index.pitchers.filter((p) => p.teams.includes(team)).sort((a, b) => b.n - a.n) : []),
    [index, team],
  );

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <label className="flex flex-col gap-1 text-xs text-muted">
        리그
        <select value={league} onChange={(e) => (setLeague(e.target.value as "" | "AL" | "NL"), setTeam(""))}>
          <option value="">리그 선택</option>
          <option value="AL">아메리칸리그 (AL)</option>
          <option value="NL">내셔널리그 (NL)</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        구단
        <select value={team} disabled={!league} onChange={(e) => setTeam(e.target.value)}>
          <option value="">{league ? "구단 선택" : "리그를 먼저 선택"}</option>
          {league &&
            Object.entries(index.teams[league])
              .sort((a, b) => a[1].localeCompare(b[1]))
              .map(([abbr, name]) => (
                <option key={abbr} value={abbr}>
                  {name} ({abbr})
                </option>
              ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        선수
        <select
          value={roster.some((p) => p.id === selectedId) ? String(selectedId) : ""}
          disabled={!team}
          onChange={(e) => e.target.value && onSelect(Number(e.target.value), team)}
        >
          <option value="">{team ? `선수 선택 (${roster.length}명, 투구수 순)` : "구단을 먼저 선택"}</option>
          {roster.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name} — {p.n.toLocaleString()}구, 구위 {p.stuff?.toFixed(1) ?? "-"}
              {p.teams.length > 1 ? " (이적)" : ""}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
