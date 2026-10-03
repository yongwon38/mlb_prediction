"use client";
import { useEffect, useMemo, useState } from "react";
import SearchPanel from "@/components/SearchPanel";
import StrikeZone from "@/components/StrikeZone";
import FilterBar, { EMPTY_FILTERS, type Filters, applyFilters } from "@/components/FilterBar";
import { ArsenalTable, NotesList, Section, SummaryTiles } from "@/components/Panels";
import { BucketChart, CountMix, PlatoonTable, StuffDistribution, TrendCharts, ZoneHeatmap } from "@/components/Charts";
import { loadIndex, loadLeague, loadMeta, loadPitches } from "@/lib/data";
import { percentileOf, scoutingNotes, stats } from "@/lib/analysis";
import type { League, Meta, Pitch, PitcherFile, SeasonIndex } from "@/lib/types";

function readUrl() {
  const q = new URLSearchParams(window.location.search);
  return { season: Number(q.get("season")) || null, pitcher: Number(q.get("pitcher")) || null };
}

export default function Home() {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [index, setIndex] = useState<SeasonIndex | null>(null);
  const [league, setLeague] = useState<League | null>(null);
  const [pitcherId, setPitcherId] = useState<number | null>(null);
  const [data, setData] = useState<{ file: PitcherFile; pitches: Pitch[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);

  // 초기 로드 : URL 의 시즌/투수 복원
  useEffect(() => {
    loadMeta()
      .then((m) => {
        setMeta(m);
        const u = readUrl();
        setSeason(u.season && m.seasons.includes(u.season) ? u.season : m.seasons[0]);
        setPitcherId(u.pitcher);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!season) return;
    let alive = true;
    Promise.all([loadIndex(season), loadLeague(season)])
      .then(([i, l]) => alive && (setIndex(i), setLeague(l)))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [season]);

  const entry = index?.pitchers.find((p) => p.id === pitcherId) ?? null;

  // 투수 데이터
  useEffect(() => {
    if (!season || !entry || index?.season !== season) return;
    let alive = true;
    loadPitches(season, entry.id)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [season, entry, index]);

  // URL 동기화 (공유 가능한 링크)
  useEffect(() => {
    if (!season) return;
    const q = new URLSearchParams();
    q.set("season", String(season));
    if (pitcherId) q.set("pitcher", String(pitcherId));
    window.history.replaceState(null, "", `?${q}`);
  }, [season, pitcherId]);

  const selectPitcher = (id: number, team?: string) => {
    setPitcherId(id);
    setFilters({ ...EMPTY_FILTERS, teams: team ? [team] : [] });
  };

  const changeSeason = (s: number) => {
    setSeason(s);
    setData(null);
    setFilters(EMPTY_FILTERS);
  };

  const ready = !!(data && entry && data.file.id === entry.id && index?.season === season && league && meta);
  const all = ready ? data!.pitches : null;
  const validStart = index?.validStart ?? null;
  const ps = useMemo(() => (all ? applyFilters(all, filters, validStart) : []), [all, filters, validStart]);
  const st = useMemo(() => stats(ps), [ps]);
  const notes = useMemo(
    () => (all && league && meta && data ? scoutingNotes(ps, all, league, data.file.pitchTypes, meta.pitchNames) : []),
    [ps, all, league, meta, data],
  );
  const leagueBuckets = league ? (filters.validOnly && league.bucketsValid ? league.bucketsValid : league.buckets) : [];

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 py-6 flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-ink">Stuff Lab</h1>
          <p className="text-sm text-ink-2">투구 물리량만으로 평가한 MLB 투수 구위(Stuff, 20–80) 분석</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          시즌
          <select value={season ?? ""} onChange={(e) => changeSeason(Number(e.target.value))} aria-label="시즌 선택">
            {meta?.seasons.map((s) => (
              <option key={s} value={s}>
                {s} 정규시즌{s !== meta.trainSeason ? " (out-of-sample)" : ""}
              </option>
            ))}
          </select>
        </label>
      </header>

      {error && <div className="card p-3 text-sm text-bad">데이터를 불러오지 못했습니다 : {error}</div>}

      <SearchPanel key={season ?? 0} index={index?.season === season ? index : null} selectedId={pitcherId} onSelect={selectPitcher} />

      {index && index.season === season && <SeasonNotice index={index} trainSeason={meta?.trainSeason ?? 2025} />}

      {!index || !league || index.season !== season ? (
        <div className="card p-10 text-center text-sm text-muted">시즌 데이터 불러오는 중…</div>
      ) : !entry ? (
        <Leaderboard index={index} league={league} onSelect={selectPitcher} missing={!!pitcherId} />
      ) : !ready ? (
        <div className="card p-10 text-center text-sm text-muted">{`${entry.name} 투구 데이터 불러오는 중…`}</div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <h2 className="text-xl font-bold text-ink">{data!.file.name}</h2>
            <span className="text-sm text-ink-2">
              {data!.file.throws === "R" ? "우투" : "좌투"} · {data!.file.teams.join(" → ")} · {season} 시즌 {all!.length.toLocaleString()}구
            </span>
            <span className="ml-auto flex gap-4 text-xs">
              <button className="text-accent-ink underline underline-offset-2" onClick={() => setPitcherId(null)}>
                리더보드로
              </button>
              <a className="text-accent-ink underline underline-offset-2" href={`https://baseballsavant.mlb.com/savant-player/${data!.file.id}`} target="_blank" rel="noreferrer">
                Baseball Savant ↗
              </a>
            </span>
          </div>

          <FilterBar
            filters={filters}
            setFilters={setFilters}
            pitchTypes={data!.file.pitchTypes}
            teams={data!.file.teams}
            validStart={validStart}
            shown={ps.length}
            total={all!.length}
          />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)]">
            <Section title="투구 로케이션 × 구위" sub="포수 시점(존 높이는 타자별 정규화) · 진하고 불투명할수록 구위 높음 · 모양은 결과 · 점에 마우스를 올리면 상세">
              <StrikeZone pitches={ps} pitchNames={meta!.pitchNames} />
            </Section>
            <div className="flex flex-col gap-4 min-w-0">
              <Section title="요약">
                <SummaryTiles st={st} league={league} />
              </Section>
              <Section title="스카우팅 노트" sub="필터가 적용된 투구 기준, 규칙 기반 자동 생성">
                <NotesList notes={notes} />
              </Section>
            </div>
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

function SeasonNotice({ index, trainSeason }: { index: SeasonIndex; trainSeason: number }) {
  return (
    <p className="text-xs text-muted -mt-1">
      {index.seasonStart} ~ {index.seasonEnd} · 투수 {index.pitchers.length.toLocaleString()}명 · {index.pitches.toLocaleString()}구.{" "}
      {index.outOfSample
        ? `${trainSeason} 시즌으로 학습한 모델을 그대로 적용한 out-of-sample 점수입니다.`
        : `모델 학습 시즌입니다. ${index.validStart} 이후는 학습에 쓰지 않은 검증기간이므로, 결과 지표를 엄밀히 보려면 '검증기간만' 필터를 사용하세요.`}
    </p>
  );
}

function Leaderboard({ index, league, onSelect, missing }: { index: SeasonIndex; league: League; onSelect: (id: number) => void; missing: boolean }) {
  const [minN, setMinN] = useState(league.minPitcherPitches);
  const top = useMemo(
    () =>
      index.pitchers
        .filter((p) => p.n >= minN)
        .sort((a, b) => b.stuff - a.stuff)
        .slice(0, 20),
    [index, minN],
  );
  return (
    <Section
      title={`${index.season} 구위 리더보드`}
      sub={missing ? "선택한 투수는 이 시즌 기록이 없습니다. 다른 투수를 골라 보세요." : "투수를 검색하거나 아래에서 바로 선택하세요"}
      right={
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
      }
    >
      <ol className="grid sm:grid-cols-2 gap-x-6 text-sm">
        {top.map((p, i) => (
          <li key={p.id}>
            <button onClick={() => onSelect(p.id)} className="w-full flex items-center gap-3 py-1.5 border-b border-grid hover:bg-surface-2 rounded px-1 text-left">
              <span className="w-5 text-muted tnum text-right">{i + 1}</span>
              <span className="flex-1 min-w-0 truncate">
                <span className="font-medium text-ink">{p.name}</span>
                <span className="text-muted ml-2 text-xs">
                  {p.throws}HP · {p.teams.join("/")}
                </span>
              </span>
              <span className="text-xs text-muted tnum">{p.n.toLocaleString()}구</span>
              <span className="w-12 text-right font-semibold tnum text-ink">{p.stuff.toFixed(1)}</span>
              <span className="w-16 text-right text-xs text-muted tnum">
                {p.n >= league.minPitcherPitches ? `상위 ${100 - (percentileOf(league.pitcherPercentiles, p.stuff) ?? 0)}%` : ""}
              </span>
            </button>
          </li>
        ))}
      </ol>
    </Section>
  );
}

function Methodology() {
  return (
    <details className="card p-4 text-xs text-ink-2 leading-relaxed">
      <summary className="cursor-pointer font-semibold text-ink text-sm">모델 설명 — 구위(Stuff) 20–80</summary>
      <ol className="list-decimal pl-5 mt-2 flex flex-col gap-1">
        <li>타구방향·타구속도·발사각·공격각도로 타구 결과(아웃/1루타/2·3루타/홈런)를 예측 (RandomForest).</li>
        <li>예측 기대값을 Gamma → Beta 변환해 0–1 타구질 score 로 만듦. 헛스윙·루킹 삼진은 0.</li>
        <li>
          투구 물리량(구속, 무브먼트, 릴리스, 익스텐션, 회전수·축, 팔각도, 주 패스트볼 대비 차이 등)으로 타구질 score 를 예측 (LGBM).{" "}
          <b>로케이션·카운트·타자 정보는 쓰지 않음</b> — 같은 공이면 어디에 던지든 같은 구위.
        </li>
        <li>예측값을 학습기간 분포 기준 정규분위수로 바꿔 50 + 10z (20–80) 스케일로 표시. 50 = 리그 평균 투구.</li>
      </ol>
      <p className="mt-2 text-muted">데이터 : Statcast (pybaseball), 정규시즌. 존 높이는 타자별 존(sz_top/sz_bot)으로 1.5–3.5ft 에 정규화.</p>
    </details>
  );
}
