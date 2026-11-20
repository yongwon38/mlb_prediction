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
import Icon, { type IconName } from "@/components/Icon";
import { PlayerPhoto, TeamLogo, TeamLogos } from "@/components/Avatar";

const SECTIONS = ["pitcher", "games", "explain"] as const;
const SECTION_ICON: Record<(typeof SECTIONS)[number], IconName> = { pitcher: "user", games: "calendar", explain: "layers" };
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
    <main className="mx-auto w-full max-w-[1280px] px-4 pb-12 flex flex-col gap-5">
      {/* 히어로 : 사이트 소개 + 큰 검색창 */}
      <section className="pt-10 pb-2 sm:pt-14">
        <div className="max-w-[720px]">
          {t.eyebrow && <p className="eyebrow mb-3 text-accent">{t.eyebrow}</p>}
          <h1 className="text-[36px] sm:text-[48px] font-bold tracking-[-0.035em] text-ink leading-[1.12]">{t.heroTitle}</h1>
          <p className="text-[17px] text-ink-2 mt-3">{t.tagline}</p>
          <div className="mt-8 card p-4 sm:p-5">
            <SearchPanel key={season ?? 0} index={index} selectedId={null} hero onSelect={(id) => router.push(ctxHref("/pitcher", { season, pitcher: id, gt: [g] }))} />
          </div>
        </div>
        <nav aria-label={t.explore} className="mt-4 grid gap-3 sm:grid-cols-3">
          {SECTIONS.map((k) => (
            <Link key={k} href={ctxHref(`/${k}`, { season, gt: [g] })} className="card group flex items-center gap-3.5 px-5 py-4">
              <span className="w-10 h-10 rounded-full bg-accent-soft text-accent flex items-center justify-center shrink-0">
                <Icon name={SECTION_ICON[k]} size={20} />
              </span>
              <span className="flex-1 min-w-0">
                <span className="block text-[15px] font-semibold text-ink">{tt.nav[k]}</span>
                <span className="block text-[13px] text-muted truncate">{t.cards[k]}</span>
              </span>
              <Icon name="chevronRight" size={18} className="text-muted group-hover:translate-x-0.5 transition-transform" />
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
                    <Link href={go("/pitcher", p.id)} className="flex items-center gap-3 py-2 px-2 rounded-xl hover:bg-surface-2 transition-colors">
                      <span className={`w-5 text-center tnum text-[15px] ${i < 3 ? "text-accent font-bold" : "text-muted font-medium"}`}>{i + 1}</span>
                      <PlayerPhoto id={p.id} name={p.name} size={36} />
                      <span className="flex-1 min-w-0">
                        <span className="block truncate font-semibold text-ink">{p.name}</span>
                        <span className="flex items-center gap-1.5 text-xs text-muted mt-0.5">
                          <TeamLogos teams={p.teams} size={14} />
                          {p.teams.join(" / ")}
                        </span>
                      </span>
                      <span className="text-xs text-muted tnum hidden sm:inline">{tt.common.pitches(p.n)}</span>
                      <StuffBadge v={p.stuff} size="sm" className="w-[4.25rem] justify-center" />
                      <Icon name="chevronRight" size={16} className="text-muted hidden sm:block" />
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
                    <Link href={go("/games", r.pid, { game: r.g, pa: r.pai })} className="grid grid-cols-[auto_auto_1fr_auto] items-center gap-x-3 sm:gap-x-4 py-2.5 px-2 rounded-xl hover:bg-surface-2 transition-colors">
                      <span className="text-xs text-muted tnum w-[4.5rem]">{r.date}</span>
                      <PlayerPhoto id={r.pid} name={r.name} size={32} />
                      <span className="min-w-0">
                        <span className="block truncate text-ink">
                          <b className="font-semibold">{r.name}</b> vs {r.batName} · {r.ev === 0 ? t.removed : tt.paEvents[r.ev]}
                          <span className="text-muted text-xs ml-2 inline-flex items-center gap-1 align-middle">
                            <TeamLogo abbr={r.team} size={14} />
                            {r.team} vs
                            <TeamLogo abbr={r.opp} size={14} />
                            {r.opp} · {tt.game.innOuts(r.inn, r.o)}
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
    <dl className="card px-5 sm:px-6 py-5 grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-x-6 gap-y-5">
      {cells.map(([l, v]) => (
        <div key={l} className="min-w-0">
          <dt className="text-[13px] text-muted truncate" title={l}>
            {l}
          </dt>
          <dd className="text-[22px] num text-ink mt-1">{v}</dd>
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
          <Link href={href(r)} className="grid grid-cols-[auto_auto_1fr_auto] items-center gap-x-3 sm:gap-x-4 py-2.5 px-2 rounded-xl hover:bg-surface-2 transition-colors">
            <span className="text-xs text-muted tnum w-[4.5rem]">{r.date}</span>
            <PlayerPhoto id={r.pid} name={r.name} size={32} />
            <span className="min-w-0 truncate">
              <b className="text-ink font-semibold">{r.name}</b>
              <span className="text-ink-2 inline-flex items-center gap-1 ml-1.5 align-middle">
                <TeamLogo abbr={r.team} size={14} />
                {r.team} {r.home ? "vs" : "@"}
                <TeamLogo abbr={r.opp} size={14} />
                {r.opp}
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
