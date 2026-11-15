"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import SearchPanel from "@/components/SearchPanel";
import { LoadingBlock, Section, StuffBadge, Toggle, f1, f3, pct } from "@/components/Panels";
import { GameTypePicker, SeasonSelect } from "@/components/PageHeader";
import Methodology from "@/components/Methodology";
import SeasonNotice from "@/components/SeasonNotice";
import { ctxHref, readQuery, usePageState } from "@/lib/appState";
import { loadSummary } from "@/lib/data";
import { stuffColor, useDarkMode } from "@/lib/colors";
import { scoreText, signedPct, ipText } from "@/lib/games";
import { type Dict, useT } from "@/lib/i18n";
import type { SeasonSummary, SeasonSummaryGt } from "@/lib/types";

const SECTIONS = ["pitcher", "games", "explain"] as const;
type HiTab = "imp" | "stuff" | "pa";

/** 홈 : 시즌 요약 (리그 지표, 구위 리더, 승부처, 구위 하이라이트) */
export default function Home() {
  const router = useRouter();
  const { meta, season, setSeason, gt, setGt, index, error, setError, model } = usePageState();
  const [summary, setSummary] = useState<{ season: number; s: SeasonSummary; model: string } | null>(null);
  const [hi, setHi] = useState<HiTab>("imp");
  const tt = useT();
  const t = tt.home;

  // 예전 링크(/?season=..&pitcher=..) -> 투수 분석 페이지 (URL 동기화와 겹치지 않게 즉시 전체 이동)
  useEffect(() => {
    if (readQuery().get("pitcher")) window.location.replace(`/pitcher${window.location.search}`);
  }, []);

  useEffect(() => {
    if (!season || !index) return; // index 가 준비된 뒤 = 모델이 URL 에서 복원된 뒤
    let alive = true;
    loadSummary(season, model)
      .then((s) => alive && setSummary({ season, s, model }))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [season, setError, model, index]);

  const g = gt[0] ?? 0;
  const sm = summary?.season === season && summary.model === model ? (summary.s.byGt[String(g)] ?? null) : null;
  const go = (path: string, pitcher: number, extra: Record<string, number> = {}) => ctxHref(path, { season, pitcher, gt: [g] }, extra);

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 pb-10 flex flex-col gap-5">
      {/* 히어로 : 사이트 소개 + 큰 검색창 */}
      <section className="relative overflow-hidden rounded-b-3xl -mx-4 px-4 sm:mx-0 sm:px-8 pt-10 pb-8 sm:rounded-3xl sm:mt-5 bg-surface border-b sm:border border-line">
        <HeroArt />
        <div className="relative max-w-[640px]">
          <p className="eyebrow mb-3">{t.eyebrow}</p>
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight text-ink leading-[1.1]">{t.heroTitle}</h1>
          <p className="text-base text-ink-2 mt-3">{t.tagline}</p>
        </div>
        <div className="relative mt-7 max-w-[720px]">
          <SearchPanel key={season ?? 0} index={index} selectedId={null} hero onSelect={(id) => router.push(ctxHref("/pitcher", { season, pitcher: id, gt: [g] }))} />
        </div>
        <nav aria-label={t.explore} className="relative mt-6 flex flex-wrap gap-2">
          {SECTIONS.map((k) => (
            <Link key={k} href={ctxHref(`/${k}`, { season, gt: [g] })} title={t.cards[k]} className="group flex items-center gap-2 rounded-full border border-line bg-page/60 px-4 py-2 text-sm text-ink-2 hover:text-ink hover:border-line-strong transition-colors">
              {tt.nav[k]}
              <span className="text-muted group-hover:translate-x-0.5 transition-transform">→</span>
            </Link>
          ))}
        </nav>
      </section>

      {error && <div className="card p-3 text-sm text-bad">{tt.common.loadError(error)}</div>}
      {index && <SeasonNotice index={index} trainSeason={meta?.trainSeason ?? 2025} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        {meta && index ? <GameTypePicker value={[g]} onChange={setGt} counts={index.gameTypes} single /> : <span />}
        <SeasonSelect meta={meta} season={season} onChange={setSeason} />
      </div>

      {!sm || !meta ? (
        <LoadingBlock label={t.loading} rows={5} />
      ) : (
        <>
          <LeagueStrip sm={sm} label={tt.gameTypes[g]} t={tt} />
          <div className="grid gap-5 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
            <Section title={t.leaders(tt.gameTypes[g])} sub={t.leadersSub(sm.minPitches)}>
              <ol className="text-sm -mx-2">
                {sm.leaders.map((p, i) => (
                  <li key={p.id}>
                    <Link href={go("/pitcher", p.id)} className="flex items-center gap-3 py-2 px-2 rounded-lg hover:bg-surface-2 transition-colors">
                      <span className={`w-6 text-right tnum ${i < 3 ? "text-ink font-bold" : "text-muted"}`}>{i + 1}</span>
                      <span className="flex-1 min-w-0 truncate">
                        <span className="font-medium text-ink">{p.name}</span>
                        <span className="text-muted ml-2 text-xs">{p.teams.join("/")}</span>
                      </span>
                      <span className="text-xs text-muted tnum hidden sm:inline">{tt.common.pitches(p.n)}</span>
                      <StuffBadge v={p.stuff} size="sm" className="w-[4.25rem] justify-center" />
                    </Link>
                  </li>
                ))}
              </ol>
            </Section>
            <Section title={t.buckets} sub={t.bucketsSub}>
              <BucketBars sm={sm} t={tt} />
            </Section>
          </div>

          <Section
            title={t.highlights}
            right={
              <Toggle
                label={t.highlightsAria}
                value={hi}
                options={[
                  ["imp", t.tabs.imp],
                  ["stuff", t.tabs.stuff],
                  ["pa", t.tabs.pa],
                ]}
                onChange={setHi}
              />
            }
          >
            <p className="text-xs text-muted -mt-2 mb-3">{hi === "imp" ? t.impGamesSub : hi === "stuff" ? t.stuffGamesSub : t.impPasSub}</p>
            {hi === "pa" ? (
              <ul className="text-sm -mx-2">
                {sm.impPas.map((r) => (
                  <li key={`${r.pid}-${r.pai}`}>
                    <Link href={go("/games", r.pid, { game: r.g, pa: r.pai })} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 py-2 px-2 rounded-lg hover:bg-surface-2 transition-colors">
                      <span className="text-xs text-muted tnum w-20">{r.date}</span>
                      <span className="min-w-0">
                        <span className="block truncate text-ink">
                          <b className="font-semibold">{r.name}</b> vs {r.batName} · {r.ev === 0 ? t.removed : tt.paEvents[r.ev]}
                          <span className="text-muted text-xs ml-2">
                            {r.team} vs {r.opp} · {tt.game.innOuts(r.inn, r.o)}
                          </span>
                        </span>
                        {r.des && <span className="block truncate text-xs text-muted mt-0.5">{r.des}</span>}
                      </span>
                      <span className={`num text-sm ${(r.wpa ?? 0) >= 0 ? "text-good" : "text-bad"}`}>{signedPct(r.wpa)}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <GameList rows={hi === "imp" ? sm.impGames : sm.stuffGames} metric={hi === "imp" ? "imp" : "s"} href={(r) => go("/games", r.pid, { game: r.gi })} />
            )}
          </Section>
        </>
      )}

      <Methodology />
    </main>
  );
}

/** 히어로 배경 : 옅은 스트라이크 존 격자 + 구위 색 점 (장식) */
function HeroArt() {
  const dark = useDarkMode();
  const dots: [number, number, number][] = [
    [62, 30, 68], [70, 44, 61], [58, 52, 55], [76, 60, 47], [66, 70, 38], [82, 36, 64], [54, 40, 50], [74, 24, 71], [86, 54, 44], [60, 64, 58], [80, 72, 33], [68, 56, 66],
  ];
  return (
    <svg className="absolute right-10 top-8 bottom-8 w-[24%] max-w-[260px] pointer-events-none hidden lg:block" viewBox="48 18 44 60" preserveAspectRatio="xMaxYMid meet" aria-hidden="true">
      <rect x="56" y="26" width="24" height="44" fill="none" stroke="var(--border-strong)" strokeWidth="0.4" />
      {[1, 2].map((i) => (
        <g key={i}>
          <line x1={56 + i * 8} x2={56 + i * 8} y1="26" y2="70" stroke="var(--border)" strokeWidth="0.3" />
          <line x1="56" x2="80" y1={26 + (i * 44) / 3} y2={26 + (i * 44) / 3} stroke="var(--border)" strokeWidth="0.3" />
        </g>
      ))}
      {dots.map(([x, y, s], i) => (
        <circle key={i} cx={x} cy={y} r={1.25} fill={stuffColor(s, dark)} opacity={0.35 + Math.abs(s - 50) / 40} />
      ))}
    </svg>
  );
}

function LeagueStrip({ sm, label, t }: { sm: SeasonSummaryGt; label: string; t: Dict }) {
  const cells: [string, string][] = [
    [t.home.tiles.pitches(label), sm.pitches.toLocaleString()],
    [t.home.tiles.pitchersGames, `${sm.pitchers.toLocaleString()} / ${sm.games.toLocaleString()}`],
    [t.common.avgStuff, f1(sm.stuff)],
    ["Whiff%", pct(sm.rates.whiff)],
    ["CSW%", pct(sm.rates.csw)],
    [t.common.ba, f3(sm.rates.ba)],
    [t.common.slg, f3(sm.rates.slg)],
    ["xwOBA", f3(sm.rates.xwoba)],
  ];
  return (
    // 칸 사이 1px 선 = 배경(line) 위에 gap-px
    <dl className="card !bg-line grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-px overflow-hidden">
      {cells.map(([l, v]) => (
        <div key={l} className="bg-surface px-4 py-3.5">
          <dt className="text-[11px] text-muted truncate" title={l}>
            {l}
          </dt>
          <dd className="text-xl num text-ink mt-1">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** 구위 구간별 결과 : 구간마다 Whiff% 막대(높을수록 좋음)와 피안타율 막대(낮을수록 좋음) */
function BucketBars({ sm, t }: { sm: SeasonSummaryGt; t: Dict }) {
  const dark = useDarkMode();
  const maxW = Math.max(...sm.buckets.map((b) => b.whiff ?? 0), 0.01);
  const maxB = Math.max(...sm.buckets.map((b) => b.ba ?? 0), 0.01);
  const MID: Record<string, number> = { "<40": 35, "40-45": 42.5, "45-50": 47.5, "50-55": 52.5, "55-60": 57.5, "60+": 65 };
  return (
    <div className="text-xs tnum">
      <div className="grid grid-cols-[3.5rem_1fr_1fr_3.5rem] gap-x-4 text-muted pb-2 border-b border-line">
        <span>{t.home.th.stuff}</span>
        <span>Whiff%</span>
        <span>{t.common.ba}</span>
        <span className="text-right">xwOBAcon</span>
      </div>
      {sm.buckets.map((b) => (
        <div key={b.label} className="grid grid-cols-[3.5rem_1fr_1fr_3.5rem] gap-x-4 items-center py-2.5 border-b border-grid last:border-0" title={t.common.pitches(b.n)}>
          <span className="flex items-center gap-1.5 font-semibold text-ink">
            <span className="w-2 h-2 rounded-full" style={{ background: stuffColor(MID[b.label] ?? 50, dark) }} />
            {b.label}
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2 rounded-full bg-accent" style={{ width: `${((b.whiff ?? 0) / maxW) * 70}%` }} />
            <span className="text-ink-2">{pct(b.whiff)}</span>
          </span>
          <span className="flex items-center gap-2">
            <span className="h-2 rounded-full bg-muted/60" style={{ width: `${((b.ba ?? 0) / maxB) * 70}%` }} />
            <span className="text-ink-2">{f3(b.ba)}</span>
          </span>
          <span className="text-right text-ink-2">{f3(b.xwobacon)}</span>
        </div>
      ))}
    </div>
  );
}

function GameList({ rows, metric, href }: { rows: SeasonSummaryGt["impGames"]; metric: "imp" | "s"; href: (r: SeasonSummaryGt["impGames"][number]) => string }) {
  const t = useT();
  return (
    <ul className="text-sm -mx-2">
      {rows.map((r) => (
        <li key={`${r.pid}-${r.gi}`}>
          <Link href={href(r)} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-4 py-2 px-2 rounded-lg hover:bg-surface-2 transition-colors">
            <span className="text-xs text-muted tnum w-20">{r.date}</span>
            <span className="min-w-0 truncate">
              <b className="text-ink font-semibold">{r.name}</b>
              <span className="text-ink-2">
                {" "}
                {r.team} {r.home ? "vs" : "@"} {r.opp}
              </span>
              <span className="text-muted text-xs ml-2">
                {r.rd !== "R" ? `${t.rounds[r.rd] ?? r.rd} · ` : ""}
                {t.home.gameMeta(scoreText(r, t), ipText(r.outs), r.n)}
              </span>
            </span>
            {metric === "imp" ? (
              <span className="num text-sm text-ink" title={t.home.leverage}>
                {r.imp.toFixed(2)}
              </span>
            ) : (
              <StuffBadge v={r.s} size="sm" />
            )}
          </Link>
        </li>
      ))}
    </ul>
  );
}
