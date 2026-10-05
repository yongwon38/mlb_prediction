"use client";
import { useState } from "react";
import type { SeasonStats, StatLine } from "@/lib/types";
import { Section, Toggle } from "@/components/Panels";

type Key = "R" | "P" | "S";
const KEYS: [Key, string][] = [
  ["R", "정규시즌"],
  ["P", "포스트시즌"],
  ["S", "시범경기"],
];
const GT_KEY: Key[] = ["R", "P", "S"];

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
  const mine = stats?.players[String(pitcherId)];
  const avail = KEYS.filter(([k]) => mine?.[k]);
  const preferred = GT_KEY.find((k, i) => gt.includes(i) && mine?.[k]) ?? avail[0]?.[0] ?? "R";
  const [pick, setPick] = useState<Key | null>(null);
  const key = pick && mine?.[pick] ? pick : preferred;

  if (stats === undefined) return null;
  if (!stats || !mine || !avail.length)
    return (
      <Section title="시즌 공식 기록">
        <p className="text-sm text-muted">{stats ? "이 시즌 공식 기록이 없습니다." : "공식 기록 파일이 없습니다 (export 시 MLB Stats API 조회 실패)."}</p>
      </Section>
    );

  const s = mine[key]!;
  const d = derived(s, stats.fip[key]);
  const cells: [string, string, string?][] = [
    ["경기 (선발)", `${s.G} (${s.GS})`],
    ["승-패", `${s.W}-${s.L}`],
    ["세이브 / 홀드", `${s.SV} / ${s.HLD}`],
    ["이닝", d.ip],
    ["ERA", d.era],
    ["FIP", d.fip, "리그 평균 ERA 에 맞춘 상수"],
    ["WHIP", d.whip],
    ["피안타율", d.avg],
    ["탈삼진 (K%)", `${s.K} (${d.kPct})`],
    ["볼넷 (BB%)", `${s.BB} (${d.bbPct})`],
    ["피홈런", String(s.HR)],
    ["K/9 · BB/9", `${d.k9} · ${d.bb9}`],
  ];
  return (
    <Section
      title="시즌 공식 기록"
      sub={`${stats.asOf} 기준 (데이터 기준일) · MLB Stats API`}
      right={avail.length > 1 ? <Toggle label="경기 유형" value={key} options={avail} onChange={setPick} /> : <span className="text-xs text-muted">{KEYS.find(([k]) => k === key)?.[1]}</span>}
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
