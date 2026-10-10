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
import { type Dict, useT } from "@/lib/i18n";
import type { SeasonSummary, SeasonSummaryGt } from "@/lib/types";

const SECTIONS = ["pitcher", "games", "explain"] as const;

/** 홈 : 시즌 요약 (리그 지표, 구위 리더, 승부처, 구위 하이라이트) */
export default function Home() {
  const router = useRouter();
  const { meta, season, setSeason, gt, setGt, index, error, setError } = usePageState();
  const [summary, setSummary] = useState<{ season: number; s: SeasonSummary } | null>(null);
  const dark = useDarkMode();
  const tt = useT();
  const t = tt.home;

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
          <p className="text-sm text-ink-2">{t.tagline}</p>
        </div>
        <SeasonSelect meta={meta} season={season} onChange={setSeason} />
      </header>

      {error && <div className="card p-3 text-sm text-bad">{tt.common.loadError(error)}</div>}

      <SearchPanel key={season ?? 0} index={index} selectedId={null} onSelect={(id) => router.push(ctxHref("/pitcher", { season, pitcher: id, gt: [g] }))} />
      {index && <SeasonNotice index={index} trainSeason={meta?.trainSeason ?? 2025} />}

      <div className="grid gap-3 sm:grid-cols-3">
        {SECTIONS.map((k) => (
          <Link key={k} href={ctxHref(`/${k}`, { season, gt: [g] })} className="card p-4 hover:bg-surface-2 flex flex-col gap-1">
            <span className="text-sm font-semibold text-ink">{tt.nav[k]} →</span>
            <span className="text-xs text-muted">{t.cards[k]}</span>
          </Link>
        ))}
      </div>

      {meta && index && (
        <div className="card p-3">
          <GameTypePicker value={[g]} onChange={setGt} counts={index.gameTypes} single />
        </div>
      )}

      {!sm || !meta ? (
        <div className="card p-10 text-center text-sm text-muted">{t.loading}</div>
      ) : (
        <>
          <LeagueTiles sm={sm} label={tt.gameTypes[g]} t={tt} />
          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Section title={t.leaders(tt.gameTypes[g])} sub={t.leadersSub(sm.minPitches)}>
              <ol className="text-sm">
                {sm.leaders.map((p, i) => (
                  <li key={p.id}>
                    <Link href={go("/pitcher", p.id)} className="flex items-center gap-3 py-1.5 border-b border-grid hover:bg-surface-2 rounded px-1">
                      <span className="w-5 text-muted tnum text-right">{i + 1}</span>
                      <span className="flex-1 min-w-0 truncate">
                        <span className="font-medium text-ink">{p.name}</span>
                        <span className="text-muted ml-2 text-xs">{p.teams.join("/")}</span>
                      </span>
                      <span className="text-xs text-muted tnum">{tt.common.pitches(p.n)}</span>
                      <span className="w-12 text-right font-semibold tnum" style={{ color: stuffColor(p.stuff, dark) }}>
                        {p.stuff.toFixed(1)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ol>
            </Section>
            <Section title={t.buckets} sub={t.bucketsSub}>
              <BucketTable sm={sm} t={tt} />
            </Section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Section title={t.impGames} sub={t.impGamesSub}>
              <GameList rows={sm.impGames} metric="imp" href={(r) => go("/games", r.pid, { game: r.gi })} />
            </Section>
            <Section title={t.stuffGames} sub={t.stuffGamesSub}>
              <GameList rows={sm.stuffGames} metric="s" href={(r) => go("/games", r.pid, { game: r.gi })} />
            </Section>
          </div>

          <Section title={t.impPas} sub={t.impPasSub}>
            <ul className="text-sm">
              {sm.impPas.map((r) => (
                <li key={`${r.pid}-${r.pai}`}>
                  <Link href={go("/games", r.pid, { game: r.g, pa: r.pai })} className="grid grid-cols-[auto_1fr_auto] items-center gap-x-3 py-1.5 border-b border-grid hover:bg-surface-2 rounded px-1">
                    <span className="text-xs text-muted tnum w-20">{r.date}</span>
                    <span className="min-w-0">
                      <span className="block truncate text-ink">
                        <b>{r.name}</b> vs {r.batName} · {r.ev === 0 ? t.removed : tt.paEvents[r.ev]}
                        <span className="text-muted text-xs ml-2">
                          {r.team} vs {r.opp} · {tt.game.innOuts(r.inn, r.o)}
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

function LeagueTiles({ sm, label, t }: { sm: SeasonSummaryGt; label: string; t: Dict }) {
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

function BucketTable({ sm, t }: { sm: SeasonSummaryGt; t: Dict }) {
  const maxW = Math.max(...sm.buckets.map((b) => b.whiff ?? 0), 0.01);
  return (
    <table className="w-full text-xs tnum">
      <thead>
        <tr className="text-muted border-b border-grid">
          <th className="text-left font-normal py-1.5">{t.home.th.stuff}</th>
          <th className="text-right font-normal py-1.5">{t.home.th.pitches}</th>
          <th className="text-left font-normal py-1.5 pl-3">Whiff%</th>
          <th className="text-right font-normal py-1.5">{t.common.ba}</th>
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

function GameList({ rows, metric, href }: { rows: SeasonSummaryGt["impGames"]; metric: "imp" | "s"; href: (r: SeasonSummaryGt["impGames"][number]) => string }) {
  const dark = useDarkMode();
  const t = useT();
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
                {r.rd !== "R" ? `${t.rounds[r.rd] ?? r.rd} · ` : ""}
                {t.home.gameMeta(scoreText(r, t), ipText(r.outs), r.n)}
              </span>
            </span>
            {metric === "imp" ? (
              <span className="tnum font-semibold text-ink" title={t.home.leverage}>
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
