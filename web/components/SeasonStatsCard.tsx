"use client";
import { useState } from "react";
import type { SeasonStats, StatLine } from "@/lib/types";
import { Section, Toggle } from "@/components/Panels";
import { useT } from "@/lib/i18n";

type Key = "R" | "P" | "S";
const GT_KEY: Key[] = ["R", "P", "S"]; // 경기 유형 0 / 1 / 2

export const fmtIP = (outs: number) => `${Math.floor(outs / 3)}.${outs % 3}`;
const rate = (num: number, den: number, mult = 1, d = 2) => (den > 0 ? ((num / den) * mult).toFixed(d) : "-");

/** 공식 기록에서 파생 지표 계산 (ERA, WHIP, FIP, K% 등) */
export function derived(s: StatLine, fipC: number | undefined) {
  const ip = s.outs / 3;
  return {
    ip: fmtIP(s.outs),
    era: rate(s.ER, ip, 9),
    whip: rate(s.BB + s.H, ip),
    fip: ip > 0 && fipC !== undefined ? ((13 * s.HR + 3 * (s.BB + s.HBP) - 2 * s.K) / ip + fipC).toFixed(2) : "-",
    k9: rate(s.K, ip, 9, 1),
    bb9: rate(s.BB, ip, 9, 1),
    kPct: s.BF ? `${((s.K / s.BF) * 100).toFixed(1)}%` : "-",
    bbPct: s.BF ? `${((s.BB / s.BF) * 100).toFixed(1)}%` : "-",
    avg: s.AB ? (s.H / s.AB).toFixed(3).replace(/^0/, "") : "-",
  };
}

/** 데이터 기준일 시점의 MLB 공식 시즌 기록 */
export default function SeasonStatsCard({ stats, pitcherId, gt }: { stats: SeasonStats | null | undefined; pitcherId: number; gt: number[] }) {
  const tt = useT();
  const t = tt.stats;
  const KEYS: [Key, string][] = GT_KEY.map((k, i) => [k, tt.gameTypes[i]]);
  const mine = stats?.players[String(pitcherId)];
  const avail = KEYS.filter(([k]) => mine?.[k]);
  const preferred = GT_KEY.find((k, i) => gt.includes(i) && mine?.[k]) ?? avail[0]?.[0] ?? "R";
  const [pick, setPick] = useState<Key | null>(null);
  const key = pick && mine?.[pick] ? pick : preferred;

  if (stats === undefined) return null;
  if (!stats || !mine || !avail.length)
    return (
      <Section title={t.title}>
        <p className="text-sm text-muted">{stats ? t.none : t.noFile}</p>
      </Section>
    );

  const s = mine[key]!;
  const d = derived(s, stats.fip[key]);
  const vals: string[] = [
    `${s.G} (${s.GS})`,
    `${s.W}-${s.L}`,
    `${s.SV} / ${s.HLD}`,
    d.ip,
    d.era,
    d.fip,
    d.whip,
    d.avg,
    `${s.K} (${d.kPct})`,
    `${s.BB} (${d.bbPct})`,
    String(s.HR),
    `${d.k9} · ${d.bb9}`,
  ];
  const cells: [string, string, string?][] = vals.map((v, i) => [t.cells[i], v, i === 5 ? t.fipTitle : undefined]);
  return (
    <Section
      title={t.title}
      sub={t.sub(stats.asOf)}
      right={avail.length > 1 ? <Toggle label={tt.header.gameType} value={key} options={avail} onChange={setPick} /> : <span className="text-xs text-muted">{KEYS.find(([k]) => k === key)?.[1]}</span>}
    >
      <dl className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-2">
        {cells.map(([l, v, t]) => (
          <div key={l} className="rounded-lg bg-surface-2 px-3 py-2" title={t}>
            <dt className="text-xs text-muted">{l}</dt>
            <dd className="text-base font-semibold text-ink tnum mt-0.5">{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}
