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

export default function PitcherPage() {
  const { meta, season, setSeason, pitcherId, setPitcherId, gt, setGt, index, league, entry, error, setError } = usePageState();
  const data = usePitcherData(season, entry?.id ?? null, setError);
  const [statsFile, setStatsFile] = useState<{ season: number; s: SeasonStats | null } | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [band, setBand] = useState<string[]>([]); // 투구·타구 분포 전용 구위 구간 (빈 배열 = 전체)
  const [ghost, setGhost] = useState(true);
  const router = useRouter();

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
    () => (all && league && meta && data ? scoutingNotes(ps, all, league, data.file.pitchTypes, meta.pitchNames) : []),
    [ps, all, league, meta, data],
  );
  const leagueBuckets = league ? (filters.validOnly && league.bucketsValid ? league.bucketsValid : league.buckets) : [];
  const nonRegular = effGt.some((g) => g !== 0);

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 py-6 flex flex-col gap-4">
      <PitcherHeader
        title="투수 분석"
        name={entry?.name ?? null}
        info={
          data && entry ? (
            <>
              {data.file.throws === "R" ? "우투" : "좌투"} · {data.file.teams.join(" → ")} · {season} 시즌 {data.pitches.length.toLocaleString()}구 ·{" "}
              <a className="text-accent-ink underline underline-offset-2" href={`https://baseballsavant.mlb.com/savant-player/${data.file.id}`} target="_blank" rel="noreferrer">
                Baseball Savant ↗
              </a>
            </>
          ) : (
            "투수를 검색하거나 리더보드에서 고르세요"
          )
        }
        season={season}
        pitcherId={entry ? pitcherId : null}
        gt={gt}
        active="pitcher"
        right={<SeasonSelect meta={meta} season={season} onChange={changeSeason} />}
      />

      {error && <div className="card p-3 text-sm text-bad">데이터를 불러오지 못했습니다 : {error}</div>}

      <SearchPanel key={season ?? 0} index={index} selectedId={pitcherId} onSelect={selectPitcher} />

      {index && <SeasonNotice index={index} trainSeason={meta?.trainSeason ?? 2025} />}

      {!index || !league ? (
        <div className="card p-10 text-center text-sm text-muted">시즌 데이터 불러오는 중…</div>
      ) : !entry ? (
        <Leaderboard index={index} league={league} gt={gt} labels={meta!.gameTypes} onSelect={selectPitcher} missing={!!pitcherId} setGt={setGt} />
      ) : !ready ? (
        <div className="card p-10 text-center text-sm text-muted">{`${entry.name} 투구 데이터 불러오는 중…`}</div>
      ) : (
        <>
          <SeasonStatsCard stats={statsFile?.season === season ? statsFile.s : undefined} pitcherId={entry.id} gt={effGt} />

          <div className="card p-3 flex flex-col gap-1.5">
            <GameTypePicker labels={meta!.gameTypes} value={effGt} onChange={setGt} counts={gtCounts} />
            {nonRegular && <p className="text-xs text-muted">리그 비교값(퍼센타일·리그 평균·구간별 결과)은 정규시즌 기준입니다. 시범경기·포스트시즌 점수는 정규시즌으로 학습한 모델을 그대로 적용한 값입니다.</p>}
          </div>

          <FilterBar filters={filters} setFilters={setFilters} pitchTypes={data!.file.pitchTypes} teams={data!.file.teams} validStart={validStart} shown={ps.length} total={all!.length} />

          <BandPicker ps={ps} band={band} setBand={setBand} ghost={ghost} setGhost={setGhost} />

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="투구 로케이션 × 구위" sub="포수 시점(존 높이는 타자별 정규화) · 빨갈수록 구위 높음 · 모양은 결과 · 점을 클릭하면 그 공의 구위 산출 근거">
              <StrikeZone
                pitches={bandPs}
                ghost={ghostPs}
                pitchNames={meta!.pitchNames}
                onPick={(p) => router.push(ctxHref("/explain/pitch", { season, pitcher: data!.file.id, gt: effGt }, { pitch: p.i }))}
              />
            </Section>
            <Section title="타구 분포" sub="인플레이 타구가 떨어진 위치 · 색과 모양은 결과 · 점에 마우스를 올리면 상세">
              <SprayChart ps={bandPs} ghost={ghostPs} all={ps} selecting={band.length > 0} pitchNames={meta!.pitchNames} />
            </Section>
          </div>

          <div className="grid gap-4 items-start lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
            <Section title="요약" sub="필터가 적용된 투구 기준 (Statcast)">
              <SummaryTiles st={st} league={league} />
            </Section>
            <Section title="스카우팅 노트" sub="필터가 적용된 투구 기준, 규칙 기반 자동 생성">
              <NotesList notes={notes} />
            </Section>
          </div>

          <Section title="구종 아스널" sub="열 이름을 눌러 정렬">
            <ArsenalTable ps={ps} pitchTypes={data!.file.pitchTypes} league={league} pitchNames={meta!.pitchNames} />
          </Section>

          <div className="grid gap-4 lg:grid-cols-2">
            <Section title="구종별 구위 분포" sub="리그 동일 구종 분포(회색) 대비 위치">
              <StuffDistribution ps={ps} pitchTypes={data!.file.pitchTypes} league={league} />
            </Section>
            <Section title="코스별 분석" sub="Statcast 존 1–9 + 존 밖 4개 영역">
              <ZoneHeatmap ps={ps} />
            </Section>
            <Section title="구위 구간별 결과" sub="모델 점수가 실제 결과로 이어지는지 — 리그 기준과 비교">
              <BucketChart ps={ps} leagueBuckets={leagueBuckets} />
            </Section>
            <Section title="카운트별 구종 선택" sub="상황별 피치 믹스와 평균 구위">
              <CountMix ps={ps} pitchTypes={data!.file.pitchTypes} />
            </Section>
            <Section title="구위 추이" sub="시즌 흐름과 경기 내 체력 저하">
              <TrendCharts ps={ps} pitchTypes={data!.file.pitchTypes} />
            </Section>
            <Section title="좌우 스플릿" sub="타자 손 방향별 구종 운용과 결과">
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
  labels,
  onSelect,
  missing,
}: {
  index: SeasonIndex;
  league: League;
  gt: number[];
  setGt: (g: number[]) => void;
  labels: string[];
  onSelect: (id: number) => void;
  missing: boolean;
}) {
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
      title={`${index.season} 구위 리더보드 — ${labels[g]}`}
      sub={missing ? "선택한 투수는 이 시즌 기록이 없습니다. 다른 투수를 골라 보세요." : "투수를 검색하거나 아래에서 바로 선택하세요 · 퍼센타일은 정규시즌 투수 기준"}
      right={
        <div className="flex flex-wrap items-center gap-3">
          <GameTypePicker labels={labels} value={[g]} onChange={setGt} counts={index.gameTypes} single />
          <label className="text-xs text-ink-2 flex items-center gap-1.5">
            최소 투구
            <select value={minN} onChange={(e) => setMinN(Number(e.target.value))} className="!py-1 !min-h-0 text-xs">
              {[100, 300, 1000, 2000].map((n) => (
                <option key={n} value={n}>
                  {n}구
                </option>
              ))}
            </select>
          </label>
        </div>
      }
    >
      {g !== 0 && <p className="text-xs text-muted mb-2">{labels[g]}은 표본이 적어 최소 투구를 {n0}구로 낮춰 적용합니다.</p>}
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
              <span className="text-xs text-muted tnum">{v![0].toLocaleString()}구</span>
              <span className="w-12 text-right font-semibold tnum text-ink">{v![1]?.toFixed(1) ?? "-"}</span>
              <span className="w-16 text-right text-xs text-muted tnum">
                {g === 0 && v![0] >= league.minPitcherPitches ? `상위 ${100 - (percentileOf(league.pitcherPercentiles, v![1]) ?? 0)}%` : ""}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </Section>
  );
}
