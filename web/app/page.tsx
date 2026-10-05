"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SearchPanel from "@/components/SearchPanel";
import { Section, f1, f3, pct } from "@/components/Panels";
import { GameTypePicker, SeasonSelect } from "@/components/PageHeader";
import Methodology from "@/components/Methodology";
import SeasonNotice from "@/components/SeasonNotice";
import { ctxHref, readQuery, usePageState } from "@/lib/appState";
import { loadSummary } from "@/lib/data";
import { stuffColor, useDarkMode } from "@/lib/colors";
import { scoreText, signedPct, ipText } from "@/lib/games";
import { PA_LABELS } from "@/lib/analysis";
import type { Meta, SeasonSummary, SeasonSummaryGt } from "@/lib/types";

const SECTIONS = [
  { href: "/pitcher", t: "투수 분석", d: "투구 로케이션·타구 분포·구종 아스널·시즌 공식 기록 등 투수 한 명의 전체 분석" },
  { href: "/games", t: "경기·타석", d: "승부처·구위 하이라이트로 추천된 경기와 타석, 또는 직접 고른 경기를 투구 단위로" },
  { href: "/explain", t: "구위 산출 근거", d: "구위 점수가 어떤 요인(구속·무브먼트·진입각…)으로 만들어졌는지 — 개요·구종별·점수대별·투구 1개" },
];

/** 홈 : 시즌 요약 (리그 지표, 구위 리더, 승부처, 구위 하이라이트) */
export default function Home() {
  const router = useRouter();
  const { meta, season, setSeason, gt, setGt, index, error, setError } = usePageState();
  const [summary, setSummary] = useState<{ season: number; s: SeasonSummary } | null>(null);
  const dark = useDarkMode();

  // 예전 링크(/?season=..&pitcher=..) -> 투수 분석 페이지 (URL 동기화와 겹치지 않게 즉시 전체 이동)
  useEffect(() => {
    if (readQuery().get("pitcher")) window.location.replace(`/pitcher${window.location.search}`);
  }, []);

  useEffect(() => {
    if (!season) return;
    let alive = true;
    loadSummary(season)
      .then((s) => alive && setSummary({ season, s }))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [season, setError]);

  const g = gt[0] ?? 0;
  const sm = summary?.season === season ? (summary.s.byGt[String(g)] ?? null) : null;
  const go = (path: string, pitcher: number, extra: Record<string, number> = {}) => ctxHref(path, { season, pitcher, gt: [g] }, extra);

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 py-6 flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Stuff Lab</h1>
          <p className="text-sm text-ink-2">투구 물리량만으로 평가한 MLB 투수 구위(Stuff, 20–80) — 시즌 요약</p>
        </div>
        <SeasonSelect meta={meta} season={season} onChange={setSeason} />
      </header>

      {error && <div className="card p-3 text-sm text-bad">데이터를 불러오지 못했습니다 : {error}</div>}

      <SearchPanel key={season ?? 0} index={index} selectedId={null} onSelect={(id) => router.push(ctxHref("/pitcher", { season, pitcher: id, gt: [g] }))} />
      {index && <SeasonNotice index={index} trainSeason={meta?.trainSeason ?? 2025} />}

      <div className="grid gap-3 sm:grid-cols-3">
        {SECTIONS.map((x) => (
          <Link key={x.href} href={ctxHref(x.href, { season, gt: [g] })} className="card p-4 hover:bg-surface-2 flex flex-col gap-1">
            <span className="text-sm font-semibold text-ink">{x.t} →</span>
            <span className="text-xs text-muted">{x.d}</span>
          </Link>
        ))}
      </div>

      {meta && index && (
        <div className="card p-3">
          <GameTypePicker labels={meta.gameTypes} value={[g]} onChange={setGt} counts={index.gameTypes} single />
        </div>
      )}

      {!sm || !meta ? (
        <div className="card p-10 text-center text-sm text-muted">시즌 요약 불러오는 중…</div>
      ) : (
        <>
          <LeagueTiles sm={sm} label={meta.gameTypes[g]} />
          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Section title={`구위 리더 TOP 10 — ${meta.gameTypes[g]}`} sub={`평균 구위 · ${sm.minPitches}구 이상 · 이름을 누르면 투수 분석`}>
              <ol className="text-sm">
                {sm.leaders.map((p, i) => (
                  <li key={p.id}>
                    <Link href={go("/pitcher", p.id)} className="flex items-center gap-3 py-1.5 border-b border-grid hover:bg-surface-2 rounded px-1">
                      <span className="w-5 text-muted tnum text-right">{i + 1}</span>
                      <span className="flex-1 min-w-0 truncate">
                        <span className="font-medium text-ink">{p.name}</span>
                        <span className="text-muted ml-2 text-xs">{p.teams.join("/")}</span>
                      </span>
                      <span className="text-xs text-muted tnum">{p.n.toLocaleString()}구</span>
                      <span className="w-12 text-right font-semibold tnum" style={{ color: stuffColor(p.stuff, dark) }}>
                        {p.stuff.toFixed(1)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </Section>
            <Section title="구위 구간별 실제 결과" sub="구위 점수가 높을수록 헛스윙↑ 피안타율↓ — 모델이 실제 결과와 맞는지">
              <BucketTable sm={sm} />
            </Section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Section title="승부처 경기 TOP 10" sub="투수 한 명의 등판 기준 · 타석별 |WPA| 합 × 경기 유형 가중치 · 누르면 경기·타석 페이지">
              <GameList rows={sm.impGames} meta={meta} metric="imp" href={(r) => go("/games", r.pid, { game: r.gi })} />
            </Section>
            <Section title="구위 하이라이트 경기 TOP 10" sub="평균 구위가 가장 높았던 등판 (40구 이상)">
              <GameList rows={sm.stuffGames} meta={meta} metric="s" href={(r) => go("/games", r.pid, { game: r.gi })} />
            </Section>
          </div>

          <Section title="승부처 타석 TOP 10" sub="승리확률을 가장 크게 바꾼 타석 (투수 관점 : + 막아냄 / − 허용) · 누르면 그 타석">
            <ul className="text-sm">
              {sm.impPas.map((r) => (
                <li key={`${r.pid}-${r.pai}`}>
                  <Link href={go("/games", r.pid, { game: r.g, pa: r.pai })} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 py-1.5 border-b border-grid hover:bg-surface-2 rounded px-1">
                    <span className="text-xs text-muted tnum w-20">{r.date}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-ink">
                        <b>{r.name}</b> vs {r.batName} — {r.ev === 0 ? "교체" : PA_LABELS[r.ev]}
                        <span className="text-muted text-xs ml-2">
                          {r.team} vs {r.opp} · {r.inn}회 {r.o ?? "-"}사
                        </span>
                      </span>
                      {r.des && <span className="block truncate text-xs text-muted">{r.des}</span>}
                    </span>
                    <span className={`tnum font-semibold ${(r.wpa ?? 0) >= 0 ? "text-good" : "text-bad"}`}>{signedPct(r.wpa)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}

      <Methodology />
    </main>
  );
}

function LeagueTiles({ sm, label }: { sm: SeasonSummaryGt; label: string }) {
  const cells: [string, string][] = [
    [`${label} 투구 (점수 있는)`, sm.pitches.toLocaleString()],
    ["투수 / 경기", `${sm.pitchers.toLocaleString()} / ${sm.games.toLocaleString()}`],
    ["평균 구위", f1(sm.stuff)],
    ["Whiff%", pct(sm.rates.whiff)],
    ["CSW%", pct(sm.rates.csw)],
    ["피안타율", f3(sm.rates.ba)],
    ["피장타율", f3(sm.rates.slg)],
    ["xwOBA", f3(sm.rates.xwoba)],
  ];
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-2">
      {cells.map(([l, v]) => (
        <div key={l} className="card px-3 py-2.5">
          <dt className="text-xs text-muted">{l}</dt>
          <dd className="text-lg font-semibold text-ink tnum mt-0.5">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

function BucketTable({ sm }: { sm: SeasonSummaryGt }) {
  const maxW = Math.max(...sm.buckets.map((b) => b.whiff ?? 0), 0.01);
  return (
    <table className="w-full text-xs tnum">
      <thead>
        <tr className="text-muted border-b border-grid">
          <th className="text-left font-normal py-1.5">구위</th>
          <th className="text-right font-normal py-1.5">투구</th>
          <th className="text-left font-normal py-1.5 pl-3">Whiff%</th>
          <th className="text-right font-normal py-1.5">피안타율</th>
          <th className="text-right font-normal py-1.5">xwOBAcon</th>
        </tr>
      </thead>
      <tbody>
        {sm.buckets.map((b) => (
          <tr key={b.label} className="border-b border-grid last:border-0">
            <td className="py-1.5 font-medium text-ink">{b.label}</td>
            <td className="py-1.5 text-right text-ink-2">{b.n.toLocaleString()}</td>
            <td className="py-1.5 pl-3">
              <span className="flex items-center gap-2">
                <span className="h-2 rounded-sm bg-accent" style={{ width: `${((b.whiff ?? 0) / maxW) * 80}px` }} />
                <span className="text-ink-2">{pct(b.whiff)}</span>
              </span>
            </td>
            <td className="py-1.5 text-right text-ink-2">{f3(b.ba)}</td>
            <td className="py-1.5 text-right text-ink-2">{f3(b.xwobacon)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function GameList({ rows, meta, metric, href }: { rows: SeasonSummaryGt["impGames"]; meta: Meta; metric: "imp" | "s"; href: (r: SeasonSummaryGt["impGames"][number]) => string }) {
  const dark = useDarkMode();
  return (
    <ul className="text-sm">
      {rows.map((r) => (
        <li key={`${r.pid}-${r.gi}`}>
          <Link href={href(r)} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 py-1.5 border-b border-grid hover:bg-surface-2 rounded px-1">
            <span className="text-xs text-muted tnum w-20">{r.date}</span>
            <span className="min-w-0 truncate">
              <b className="text-ink">{r.name}</b>
              <span className="text-ink-2">
                {" "}
                {r.team} {r.home ? "vs" : "@"} {r.opp}
              </span>
              <span className="text-muted text-xs ml-2">
                {r.rd !== "R" ? `${meta.rounds[r.rd]} · ` : ""}
                {scoreText(r)} · {ipText(r.outs)}이닝 {r.n}구
              </span>
            </span>
            {metric === "imp" ? (
              <span className="tnum font-semibold text-ink" title="중요도">
                {r.imp.toFixed(2)}
              </span>
            ) : (
              <span className="tnum font-semibold" style={{ color: r.s !== null ? stuffColor(r.s, dark) : undefined }}>
                {r.s?.toFixed(1) ?? "-"}
              </span>
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
