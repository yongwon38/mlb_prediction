"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { PitcherEntry, SeasonIndex } from "@/lib/types";
import { useT } from "@/lib/i18n";
import Icon from "@/components/Icon";
import { PlayerPhoto, TeamLogos } from "@/components/Avatar";

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
  compact?: boolean; // 머리 오른쪽에 넣는 작은 이름 검색창
  hero?: boolean; // 홈 첫 화면의 큰 검색창
  placeholder?: string;
}

export default function SearchPanel({ index, selectedId, onSelect, compact = false, hero = false, placeholder }: Props) {
  const [mode, setMode] = useState<"name" | "team">("name");
  const t = useT().search;

  if (compact)
    return (
      <div className="w-full sm:w-64">
        {index ? <NameSearch pitchers={index.pitchers} onSelect={onSelect} small placeholder={placeholder} /> : <div className="skeleton h-9" />}
      </div>
    );

  return (
    <div className={hero ? "" : "card p-4"}>
      <div role="tablist" aria-label={t.modeAria} className="inline-flex rounded-[10px] bg-surface-2 p-[3px] mb-3 text-sm">
        {(
          [
            ["name", t.byName],
            ["team", t.byTeam],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            role="tab"
            aria-selected={mode === key}
            onClick={() => setMode(key)}
            className={`px-3.5 py-1.5 rounded-[8px] font-medium transition-colors ${mode === key ? "bg-surface text-ink font-semibold shadow-[0_1px_2px_rgba(0,23,51,0.08)]" : "text-muted hover:text-ink"}`}
          >
            {label}
          </button>
        ))}
      </div>
      {!index ? (
        <div className="h-10 text-sm text-muted flex items-center">{t.loading}</div>
      ) : mode === "name" ? (
        <NameSearch pitchers={index.pitchers} onSelect={onSelect} large={hero} />
      ) : (
        <TeamSearch index={index} selectedId={selectedId} onSelect={onSelect} />
      )}
    </div>
  );
}

function NameSearch({ pitchers, onSelect, small = false, large = false, placeholder }: { pitchers: PitcherEntry[]; onSelect: Props["onSelect"]; small?: boolean; large?: boolean; placeholder?: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const t = useT().search;

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
    setQ(small ? "" : p.name);
    setOpen(false);
  };

  return (
    <div ref={boxRef} className="relative">
      <Icon name="search" size={large ? 20 : 16} className={`absolute top-1/2 -translate-y-1/2 text-muted pointer-events-none ${large ? "left-4" : "left-3"}`} />
      <input
        type="search"
        role="combobox"
        aria-expanded={open && results.length > 0}
        aria-controls="pitcher-results"
        aria-label={t.nameAria}
        placeholder={placeholder ?? t.placeholder}
        className={`w-full ${small ? "!min-h-9 !py-1.5 !text-sm !pl-9" : "!pl-10"} ${large ? "!min-h-14 !text-[17px] !pl-12 !pr-4 !rounded-2xl" : ""}`}
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
        <ul id="pitcher-results" role="listbox" className={`absolute z-40 mt-2 pop max-h-96 overflow-auto p-1.5 ${small ? "right-0 w-[min(92vw,400px)]" : "w-full"}`}>
          {results.length === 0 && <li className="px-3 py-2.5 text-sm text-muted">{t.none}</li>}
          {results.map((p, i) => (
            <li
              key={p.id}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => (e.preventDefault(), pick(p))}
              className={`px-2.5 py-2 text-sm flex items-center gap-3 rounded-xl cursor-pointer ${i === active ? "bg-surface-2" : ""}`}
            >
              <PlayerPhoto id={p.id} name={p.name} size={32} />
              <span className="flex-1 min-w-0">
                <span className="block truncate font-semibold text-ink">{p.name}</span>
                <span className="flex items-center gap-1.5 text-xs text-muted mt-0.5">
                  <TeamLogos teams={p.teams} size={13} />
                  {p.throws}HP · {p.teams.join(" / ")}
                </span>
              </span>
              <span className="text-xs text-muted tnum shrink-0">
                {t.resultMeta(p.n, p.stuff?.toFixed(1) ?? "-")}
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
  const t = useT().search;

  const roster = useMemo(
    () => (team ? index.pitchers.filter((p) => p.teams.includes(team)).sort((a, b) => b.n - a.n) : []),
    [index, team],
  );

  return (
    <div className="grid gap-2 sm:grid-cols-3">
      <label className="flex flex-col gap-1 text-xs text-muted">
        {t.league}
        <select value={league} onChange={(e) => (setLeague(e.target.value as "" | "AL" | "NL"), setTeam(""))}>
          <option value="">{t.pickLeague}</option>
          <option value="AL">{t.al}</option>
          <option value="NL">{t.nl}</option>
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs text-muted">
        {t.team}
        <select value={team} disabled={!league} onChange={(e) => setTeam(e.target.value)}>
          <option value="">{league ? t.pickTeam : t.leagueFirst}</option>
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
        {t.player}
        <select
          value={roster.some((p) => p.id === selectedId) ? String(selectedId) : ""}
          disabled={!team}
          onChange={(e) => e.target.value && onSelect(Number(e.target.value), team)}
        >
          <option value="">{team ? t.pickPlayer(roster.length) : t.teamFirst}</option>
          {roster.map((p) => (
            <option key={p.id} value={p.id}>
              {t.rosterItem(p.name, p.n, p.stuff?.toFixed(1) ?? "-", p.teams.length > 1)}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
