"use client";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import SearchPanel from "@/components/SearchPanel";
import StrikeZone from "@/components/StrikeZone";
import SprayChart from "@/components/SprayChart";
import BandPicker from "@/components/BandPicker";
import FilterBar, { EMPTY_FILTERS, type Filters, applyFilters } from "@/components/FilterBar";
import { ArsenalTable, NotesList, Section, SummaryTiles } from "@/components/Panels";
import { BucketChart, CountMix, PlatoonTable, StuffDistribution, TrendCharts, ZoneHeatmap } from "@/components/Charts";
import { GameTypePicker, PitcherHeader, SeasonSelect } from "@/components/PageHeader";
import SeasonStatsCard from "@/components/SeasonStatsCard";
import Methodology from "@/components/Methodology";
import SeasonNotice from "@/components/SeasonNotice";
import { ctxHref, usePageState, usePitcherData } from "@/lib/appState";
import { loadStats } from "@/lib/data";
import { bandOf, percentileOf, scoutingNotes, stats } from "@/lib/analysis";
import type { League, Pitch, SeasonIndex, SeasonStats } from "@/lib/types";
import { useT } from "@/lib/i18n";

export default function PitcherPage() {
  const { meta, season, setSeason, pitcherId, setPitcherId, gt, setGt, index, league, entry, error, setError } = usePageState();
  const data = usePitcherData(season, entry?.id ?? null, setError);
  const [statsFile, setStatsFile] = useState<{ season: number; s: SeasonStats | null } | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [band, setBand] = useState<string[]>([]); // 투구·타구 분포 전용 구위 구간 (빈 배열 = 전체)
  const [ghost, setGhost] = useState(true);
  const router = useRouter();
  const tt = useT();
  const t = tt.pitcherPage;

  useEffect(() => {
    if (!season) return;
    let alive = true;
    loadStats(season).then((s) => alive && setStatsFile({ season, s }));
    return () => {
      alive = false;
    };
  }, [season]);

  const selectPitcher = (id: number, team?: string) => {
    setPitcherId(id);
    setFilters({ ...EMPTY_FILTERS, teams: team ? [team] : [] });
    setBand([]);
  };

  const changeSeason = (s: number) => {
    setSeason(s);
    setFilters(EMPTY_FILTERS);
    setBand([]);
  };

  const ready = !!(data && entry && league && meta);
  const gtCounts = useMemo(() => {
    const c = [0, 0, 0];
    data?.pitches.forEach((p) => c[p.gt]++);
    return c;
  }, [data]);
  // 경기 유형 : 선택한 유형에 투구가 없으면 있는 유형으로 대체
  const effGt = useMemo(() => {
    const xs = gt.filter((g) => gtCounts[g] > 0);
    return xs.length ? xs : gtCounts.findIndex((n) => n > 0) >= 0 ? [gtCounts.findIndex((n) => n > 0)] : gt;
  }, [gt, gtCounts]);
  const all = useMemo(() => (ready ? data!.pitches.filter((p) => effGt.includes(p.gt)) : null), [ready, data, effGt]);
  const validStart = index?.validStart ?? null;
  const ps = useMemo(() => (all ? applyFilters(all, filters, validStart) : []), [all, filters, validStart]);
  const st = useMemo(() => stats(ps), [ps]);
  const [bandPs, bandRest] = useMemo(() => {
    if (!band.length) return [ps, [] as Pitch[]];
    const sel = new Set(band);
    return [ps.filter((p) => sel.has(bandOf(p.s))), ps.filter((p) => !sel.has(bandOf(p.s)))];
  }, [ps, band]);
  const ghostPs = ghost ? bandRest : [];
  const notes = useMemo(
    () => (all && league && meta && data ? scoutingNotes(ps, all, league, data.file.pitchTypes, meta.pitchNames, tt) : []),
    [ps, all, league, meta, data, tt],
  );
  const leagueBuckets = league ? (filters.validOnly && league.bucketsValid ? league.bucketsValid : league.buckets) : [];
  const nonRegular = effGt.some((g) => g !== 0);

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 py-6 flex flex-col gap-4">
      <PitcherHeader
        title={t.title}
        name={entry?.name ?? null}
        info={
          data && entry ? (
            <>
              {tt.common.throws(data.file.throws)} · {data.file.teams.join(" → ")} · {t.info(season, data.pitches.length)} ·{" "}
              <a className="text-accent-ink underline underline-offset-2" href={`https://baseballsavant.mlb.com/savant-player/${data.file.id}`} target="_blank" rel="noreferrer">
                Baseball Savant ↗
              </a>
            </>
          ) : (
            t.idle
          )
        }
        season={season}
        pitcherId={entry ? pitcherId : null}
        gt={gt}
        active="pitcher"
        right={<SeasonSelect meta={meta} season={season} onChange={changeSeason} />}
      />

      {error && <div className="card p-3 text-sm text-bad">{tt.common.loadError(error)}</div>}

      <SearchPanel key={season ?? 0} index={index} selectedId={pitcherId} onSelect={selectPitcher} />

      {index && <SeasonNotice index={index} trainSeason={meta?.trainSeason ?? 2025} />}

      {!index || !league ? (
        <div className="card p-10 text-center text-sm text-muted">{tt.common.seasonLoading}</div>
      ) : !entry ? (
        <Leaderboard index={index} league={league} gt={gt} onSelect={selectPitcher} missing={!!pitcherId} setGt={setGt} />
      ) : !ready ? (
        <div className="card p-10 text-center text-sm text-muted">{t.loading(entry.name)}</div>
      ) : (
        <>
          <SeasonStatsCard stats={statsFile?.season === season ? statsFile.s : undefined} pitcherId={entry.id} gt={effGt} />

          <div className="card p-3 flex flex-col gap-1.5">
            <GameTypePicker value={effGt} onChange={setGt} counts={gtCounts} />
            {nonRegular && <p className="text-xs text-muted">{t.nonRegular}</p>}
          </div>

          <FilterBar filters={filters} setFilters={setFilters} pitchTypes={data!.file.pitchTypes} teams={data!.file.teams} validStart={validStart} shown={ps.length} total={all!.length} />

          <BandPicker ps={ps} band={band} setBand={setBand} ghost={ghost} setGhost={setGhost} />

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title={t.loc} sub={t.locSub}>
              <StrikeZone
                pitches={bandPs}
                ghost={ghostPs}
                pitchNames={meta!.pitchNames}
                onPick={(p) => router.push(ctxHref("/explain/pitch", { season, pitcher: data!.file.id, gt: effGt }, { pitch: p.i }))}
              />
            </Section>
            <Section title={t.spray} sub={t.spraySub}>
              <SprayChart ps={bandPs} ghost={ghostPs} all={ps} selecting={band.length > 0} pitchNames={meta!.pitchNames} />
            </Section>
          </div>

          <div className="grid gap-4 items-start lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <Section title={t.summary} sub={t.summarySub}>
              <SummaryTiles st={st} league={league} />
            </Section>
            <Section title={t.notes} sub={t.notesSub}>
              <NotesList notes={notes} />
            </Section>
          </div>

          <Section title={t.arsenal} sub={t.arsenalSub}>
            <ArsenalTable ps={ps} pitchTypes={data!.file.pitchTypes} league={league} pitchNames={meta!.pitchNames} />
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title={t.dist} sub={t.distSub}>
              <StuffDistribution ps={ps} pitchTypes={data!.file.pitchTypes} league={league} />
            </Section>
            <Section title={t.zone} sub={t.zoneSub}>
              <ZoneHeatmap ps={ps} />
            </Section>
            <Section title={t.bucket} sub={t.bucketSub}>
              <BucketChart ps={ps} leagueBuckets={leagueBuckets} />
            </Section>
            <Section title={t.countMix} sub={t.countMixSub}>
              <CountMix ps={ps} pitchTypes={data!.file.pitchTypes} />
            </Section>
            <Section title={t.trend} sub={t.trendSub}>
              <TrendCharts ps={ps} pitchTypes={data!.file.pitchTypes} />
            </Section>
            <Section title={t.platoon} sub={t.platoonSub}>
              <PlatoonTable ps={ps} pitchTypes={data!.file.pitchTypes} />
            </Section>
          </div>
        </>
      )}

      <Methodology />
    </main>
  );
}

function Leaderboard({
  index,
  league,
  gt,
  setGt,
  onSelect,
  missing,
}: {
  index: SeasonIndex;
  league: League;
  gt: number[];
  setGt: (g: number[]) => void;
  onSelect: (id: number) => void;
  missing: boolean;
}) {
  const tt = useT();
  const t = tt.pitcherPage;
  const labels = tt.gameTypes;
  const g = gt[0] ?? 0;
  const [minN, setMinN] = useState(league.minPitcherPitches);
  const n0 = g === 0 ? minN : g === 1 ? Math.min(minN, 40) : Math.min(minN, 100);
  const top = useMemo(
    () =>
      index.pitchers
        .map((p) => ({ p, v: p.byGt?.[g] ?? null }))
        .filter((x) => x.v && x.v[0] >= n0 && x.v[1] !== null)
        .sort((a, b) => (b.v![1] as number) - (a.v![1] as number))
        .slice(0, 20),
    [index, n0, g],
  );
  return (
    <Section
      title={t.board(index.season, labels[g])}
      sub={missing ? t.boardMissing : t.boardSub}
      right={
        <div className="flex flex-wrap items-center gap-3">
          <GameTypePicker value={[g]} onChange={setGt} counts={index.gameTypes} single />
          <label className="text-xs text-ink-2 flex items-center gap-1.5">
            {t.minPitches}
            <select value={minN} onChange={(e) => setMinN(Number(e.target.value))} className="!py-1 !min-h-0 text-xs">
              {[100, 300, 1000, 2000].map((n) => (
                <option key={n} value={n}>
                  {tt.common.pitches(n)}
                </option>
              ))}
            </select>
          </label>
        </div>
      }
    >
      {g !== 0 && <p className="text-xs text-muted mb-2">{t.boardSmall(labels[g], n0)}</p>}
      <ol className="grid sm:grid-cols-2 gap-x-6 text-sm">
        {top.map(({ p, v }, i) => (
          <li key={p.id}>
            <button onClick={() => onSelect(p.id)} className="w-full flex items-center gap-3 py-1.5 border-b border-grid hover:bg-surface-2 rounded px-1 text-left">
              <span className="w-5 text-muted tnum text-right">{i + 1}</span>
              <span className="flex-1 min-w-0 truncate">
                <span className="font-medium text-ink">{p.name}</span>
                <span className="text-muted ml-2 text-xs">
                  {p.throws}HP · {p.teams.join("/")}
                </span>
              </span>
              <span className="text-xs text-muted tnum">{tt.common.pitches(v![0])}</span>
              <span className="w-12 text-right font-semibold tnum text-ink">{v![1]?.toFixed(1) ?? "-"}</span>
              <span className="w-16 text-right text-xs text-muted tnum">
                {g === 0 && v![0] >= league.minPitcherPitches ? t.top(100 - (percentileOf(league.pitcherPercentiles, v![1]) ?? 0)) : ""}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </Section>
  );
}
