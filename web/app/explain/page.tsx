"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import BandPicker from "@/components/BandPicker";
import { Section } from "@/components/Panels";
import ContribBars from "@/components/explain/ContribBars";
import ContribMatrix, { type MatrixRow } from "@/components/explain/ContribMatrix";
import Waterfall from "@/components/explain/Waterfall";
import PitchList from "@/components/explain/PitchList";
import { loadExplainPitches, loadIndex, loadLeague, loadMeta } from "@/lib/data";
import { RESULT_LABELS, STUFF_BUCKETS, bandOf } from "@/lib/analysis";
import { pitchColor, useDarkMode } from "@/lib/colors";
import { EXPLAIN_FEAT_KEYS, FEAT_INFO, GROUP_FEATS, fmtSigned, groupDetail, meanContrib, meanScore, scored, topReasons } from "@/lib/explain";
import type { ExplainPitch, League, LeagueExplain, Meta, PitcherFile, SeasonIndex } from "@/lib/types";

function readUrl() {
  const q = new URLSearchParams(window.location.search);
  const num = (k: string) => (q.get(k) === null || q.get(k) === "" ? null : Number(q.get(k)));
  return { season: num("season"), pitcher: num("pitcher"), pitch: num("pitch") };
}

/** 같은 구종 구성일 때 리그 평균 기여 (각 공을 자기 구종 리그 평균 기여로 바꿔 평균) */
function mixReference(ps: ExplainPitch[], lg: LeagueExplain): number[] | null {
  const xs = scored(ps).filter((p) => lg.pitchTypes[p.pt]);
  if (!xs.length) return null;
  const m = new Array(lg.groups.length).fill(0);
  for (const p of xs) lg.pitchTypes[p.pt].contrib.forEach((v, j) => (m[j] += v));
  return m.map((v) => v / xs.length);
}

export default function ExplainPage() {
  const dark = useDarkMode();
  const [meta, setMeta] = useState<Meta | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [pitcherId, setPitcherId] = useState<number | null>(null);
  const [index, setIndex] = useState<SeasonIndex | null>(null);
  const [league, setLeague] = useState<League | null>(null);
  const [data, setData] = useState<{ file: PitcherFile; pitches: ExplainPitch[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pts, setPts] = useState<string[]>([]); // 구종 필터 (빈 배열 = 전체)
  const [band, setBand] = useState<string[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const scrolled = useRef(false); // URL 로 특정 투구가 지정되면 처음 한 번 그 투구 상세로 스크롤

  useEffect(() => {
    loadMeta()
      .then((m) => {
        const u = readUrl();
        setMeta(m);
        setSeason(u.season && m.seasons.includes(u.season) ? u.season : m.seasons[0]);
        setPitcherId(u.pitcher);
        setSel(u.pitch);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    if (!season) return;
    let alive = true;
    Promise.all([loadIndex(season), loadLeague(season)])
      .then(([i, l]) => alive && (setIndex(i), setLeague(l)))
      .catch((e) => alive && setError(String(e)));
    if (pitcherId)
      loadExplainPitches(season, pitcherId)
        .then((d) => alive && setData(d))
        .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [season, pitcherId]);

  useEffect(() => {
    if (!season) return;
    const q = new URLSearchParams({ season: String(season) });
    if (pitcherId) q.set("pitcher", String(pitcherId));
    if (sel !== null) q.set("pitch", String(sel));
    window.history.replaceState(null, "", `?${q}`);
  }, [season, pitcherId, sel]);

  const lg = league?.explain ?? null;
  const all = useMemo(() => data?.pitches ?? [], [data]);
  const byPt = useMemo(() => (pts.length ? all.filter((p) => pts.includes(p.pt)) : all), [all, pts]);
  const byBand = useMemo(() => (band.length ? all.filter((p) => band.includes(bandOf(p.s))) : all), [all, band]);
  const ps = useMemo(() => (band.length ? byPt.filter((p) => band.includes(bandOf(p.s))) : byPt), [byPt, band]);

  const nG = lg?.groups.length ?? 0;
  const mean = useMemo(() => (lg ? meanContrib(ps, nG) : null), [ps, lg, nG]);
  const ref = useMemo(() => (lg ? mixReference(ps, lg) : null), [ps, lg]);
  const reasons = useMemo(() => (lg ? topReasons(ps, lg) : null), [ps, lg]);
  const avg = meanScore(ps);

  const ptRows: MatrixRow[] = useMemo(() => {
    if (!lg || !data) return [];
    return data.file.pitchTypes
      .map((pt) => {
        const g = byBand.filter((p) => p.pt === pt);
        return { key: pt, label: <PtLabel pt={pt} pitchTypes={data.file.pitchTypes} dark={dark} name={meta?.pitchNames[pt]} />, n: scored(g).length, score: meanScore(g), c: meanContrib(g, nG), ref: lg.pitchTypes[pt]?.contrib ?? null };
      })
      .filter((r) => r.n > 0);
  }, [lg, data, byBand, nG, dark, meta]);

  const bandRows: MatrixRow[] = useMemo(() => {
    if (!lg) return [];
    return [...STUFF_BUCKETS]
      .reverse()
      .map((b) => {
        const g = byPt.filter((p) => bandOf(p.s) === b.label);
        return { key: b.label, label: b.label, n: scored(g).length, score: meanScore(g), c: meanContrib(g, nG), ref: mixReference(g, lg) };
      })
      .filter((r) => r.n > 0);
  }, [lg, byPt, nG]);

  const selPitch = sel !== null ? (all.find((p) => p.i === sel && p.c) ?? null) : null;
  const ready = !!(selPitch && lg);
  useEffect(() => {
    if (!ready || scrolled.current) return;
    // 차트가 그려지며 레이아웃이 바뀌므로 한 박자 뒤에 즉시 스크롤 (개발 모드 effect 2회 실행에도 한 번만)
    const t = setTimeout(() => {
      scrolled.current = true;
      document.getElementById("pitch-detail")?.scrollIntoView({ block: "start" });
    }, 250);
    return () => clearTimeout(t);
  }, [ready]);
  const entry = index?.pitchers.find((p) => p.id === pitcherId) ?? null;
  const backHref = `/?season=${season ?? ""}${pitcherId ? `&pitcher=${pitcherId}` : ""}`;
  const toggleOne = (xs: string[], x: string) => (xs.length === 1 && xs[0] === x ? [] : [x]);

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 py-6 flex flex-col gap-4">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <Link href={backHref} className="text-xs text-accent-ink underline underline-offset-2">
            ← 분석 페이지로
          </Link>
          <h1 className="text-2xl font-bold tracking-tight text-ink mt-1">구위 산출 근거</h1>
          <p className="text-sm text-ink-2">
            {entry ? `${entry.name} · ${entry.throws === "R" ? "우투" : "좌투"} · ${season} 시즌` : "투수를 분석 페이지에서 선택하세요"}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-ink-2">
          시즌
          <select value={season ?? ""} onChange={(e) => (setData(null), setLeague(null), setSeason(Number(e.target.value)), setSel(null))} aria-label="시즌 선택">
            {meta?.seasons.map((s) => (
              <option key={s} value={s}>
                {s} 정규시즌
              </option>
            ))}
          </select>
        </label>
      </header>

      {error && <div className="card p-3 text-sm text-bad">데이터를 불러오지 못했습니다 : {error}</div>}
      {!pitcherId && <div className="card p-10 text-center text-sm text-muted">분석 페이지에서 투수를 고른 뒤 &lsquo;구위 산출 근거&rsquo;를 눌러 주세요.</div>}
      {pitcherId && entry === null && index && <div className="card p-10 text-center text-sm text-muted">이 시즌에는 이 투수의 기록이 없습니다.</div>}
      {pitcherId && entry && (!data || !lg) && <div className="card p-10 text-center text-sm text-muted">{entry.name} 데이터 불러오는 중…</div>}

      {data && lg && meta && (
        <>
          <div className="card p-3 flex flex-wrap items-center gap-1.5 text-xs">
            <span className="text-muted mr-1">구종</span>
            <button className="chip" aria-pressed={!pts.length} onClick={() => setPts([])}>
              전체
            </button>
            {data.file.pitchTypes.map((pt) => (
              <button key={pt} className="chip" aria-pressed={pts.includes(pt)} onClick={() => setPts(pts.includes(pt) ? pts.filter((v) => v !== pt) : [...pts, pt])}>
                <span className="w-2.5 h-2.5 rounded-full" style={{ background: pitchColor(data.file.pitchTypes, pt, dark) }} />
                {pt}
              </button>
            ))}
          </div>
          <BandPicker ps={byPt} band={band} setBand={setBand} showNone={false} note="구종·구위 구간 선택은 요약과 개별 투구 목록에 적용됩니다. 구종별 표는 구간 선택만, 점수대별 표는 구종 선택만 반영합니다." />

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
            <Section
              title="요인별 기여 — 요약"
              sub={`평균 구위 ${avg?.toFixed(1) ?? "-"} = 기준 ${lg.base.toFixed(1)} + 요인 합 ${avg !== null ? fmtSigned(avg - lg.base, 1) : "-"} (점수 있는 ${scored(ps).length.toLocaleString()}구) · 점선 = 같은 구종 구성의 리그 평균`}
            >
              {mean ? <ContribBars groups={lg.groups} values={mean} compare={ref} /> : <p className="text-sm text-muted">점수가 있는 투구가 없습니다.</p>}
            </Section>
            <Section title="주요 근거" sub="선택한 투구 묶음에서 구위를 가장 많이 올리고 깎은 요인 (원값은 리그 동일 구종 평균과 비교)">
              <ReasonList reasons={reasons} />
            </Section>
          </div>

          <div className="grid gap-4 lg:grid-cols-2 items-start">
            <Section title="구종별" sub="구종마다 어떤 요인이 구위를 올리고 깎는지 (셀 = 평균 기여, 점). 셀에 마우스를 올리면 리그 동일 구종 평균과 비교. 행을 누르면 구종 필터">
              <ContribMatrix groups={lg.groups} rows={ptRows} base={lg.base} active={pts.length === 1 ? pts[0] : null} onRow={(k) => setPts(toggleOne(pts, k))} />
            </Section>
            <Section title="점수대별" sub="이 투수의 좋은 공(60+)과 나쁜 공(<40)은 무엇이 다른가. 행을 누르면 구위 구간 필터">
              <ContribMatrix groups={lg.groups} rows={bandRows} base={lg.base} active={band.length === 1 ? band[0] : null} onRow={(k) => setBand(toggleOne(band, k))} />
            </Section>
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-start">
            <Section title="개별 투구" sub="공을 고르면 오른쪽에 산출 과정이 나옵니다 (분석 페이지의 투구 분포도에서 점을 클릭해도 열림)">
              <PitchList ps={ps} pitchTypes={data.file.pitchTypes} groups={lg.groups} selected={sel} onSelect={setSel} />
            </Section>
            <div id="pitch-detail" className="scroll-mt-4 min-w-0">
            <Section title="투구 1개의 구위 산출 과정" sub={selPitch ? `${selPitch.date} · ${selPitch.inn}회 · ${selPitch.b}-${selPitch.k} · ${meta.pitchNames[selPitch.pt] ?? selPitch.pt} · ${RESULT_LABELS[selPitch.r]}` : "왼쪽 목록에서 공을 고르세요"}>
              {selPitch ? <PitchDetail p={selPitch} lg={lg} /> : <p className="text-sm text-muted">선택한 투구가 없습니다.</p>}
            </Section>
            </div>
          </div>

          <Caveats method={lg.method ?? "saabas"} />
        </>
      )}
    </main>
  );
}

function PtLabel({ pt, pitchTypes, dark, name }: { pt: string; pitchTypes: string[]; dark: boolean; name?: string }) {
  return (
    <span className="flex items-center gap-1.5" title={name}>
      <span className="w-2.5 h-2.5 rounded-full" style={{ background: pitchColor(pitchTypes, pt, dark) }} />
      <span className="font-medium">{pt}</span>
      {name && <span className="sr-only">{name}</span>}
    </span>
  );
}

function ReasonList({ reasons }: { reasons: ReturnType<typeof topReasons> | null }) {
  if (!reasons || (!reasons.up.length && !reasons.down.length)) return <p className="text-sm text-muted">두드러진 요인이 없습니다 (모든 요인이 ±0.3점 이내).</p>;
  const item = (r: (typeof reasons.up)[number], up: boolean) => (
    <li key={r.name} className="flex gap-2">
      <span className={`shrink-0 text-xs font-medium px-1.5 py-0.5 rounded ${up ? "text-good bg-surface-2" : "text-bad bg-surface-2"}`}>{up ? "▲ 올림" : "▼ 깎음"}</span>
      <span>
        <b className="text-ink">
          {r.name} {fmtSigned(r.value, 1)}점
        </b>
        {r.detail && <span className="text-ink-2"> — {r.detail}</span>}
      </span>
    </li>
  );
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {reasons.up.map((r) => item(r, true))}
      {reasons.down.map((r) => item(r, false))}
    </ul>
  );
}

function PitchDetail({ p, lg }: { p: ExplainPitch; lg: LeagueExplain }) {
  const ref = lg.pitchTypes[p.pt]?.feat;
  return (
    <div className="flex flex-col gap-3">
      <Waterfall groups={lg.groups} c={p.c!} base={lg.base} final={p.s as number} />
      <table className="w-full text-xs tnum">
        <thead>
          <tr className="text-muted border-b border-grid">
            <th className="text-left font-normal py-1.5">원값 (우투 기준)</th>
            <th className="text-right font-normal py-1.5">이 공</th>
            <th className="text-right font-normal py-1.5">리그 {p.pt} 평균</th>
            <th className="text-right font-normal py-1.5">차이</th>
            <th className="text-right font-normal py-1.5 pl-2">관련 요인 기여</th>
          </tr>
        </thead>
        <tbody>
          {EXPLAIN_FEAT_KEYS.map((k) => {
            const info = FEAT_INFO[k];
            const v = p.f[k];
            const r = ref?.[k];
            const g = GROUP_FEATS.findIndex((fs) => fs.includes(k));
            return (
              <tr key={k} className="border-b border-grid last:border-0">
                <td className="py-1.5 text-ink-2">{info.label}</td>
                <td className="py-1.5 text-right text-ink font-medium">{v === null ? "-" : `${v.toFixed(info.nd)}${info.unit}`}</td>
                <td className="py-1.5 text-right text-ink-2">{r === undefined ? "-" : r.toFixed(info.nd)}</td>
                <td className="py-1.5 text-right text-ink-2">{v === null || r === undefined ? "-" : fmtSigned(v - r, info.nd)}</td>
                <td className="py-1.5 text-right pl-2 text-ink-2">{g >= 0 ? `${lg.groups[g]} ${fmtSigned(p.c![g], 1)}` : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-xs text-muted">{groupDetail([p], lg.groups.length - 1, lg)} : {fmtSigned(p.c![lg.groups.length - 1], 1)}점</p>
    </div>
  );
}

function Caveats({ method }: { method: "shap" | "saabas" }) {
  return (
    <details className="card p-4 text-xs text-ink-2 leading-relaxed" open>
      <summary className="cursor-pointer font-semibold text-ink text-sm">읽는 법과 주의점</summary>
      <ul className="list-disc pl-5 mt-2 flex flex-col gap-1">
        <li>
          구위 모델(LGBM)의 요인별 기여를 구위 점수 단위로 바꾼 값입니다. 현재 계산 방식 :{" "}
          <b>{method === "shap" ? "SHAP (TreeSHAP, 정확값)" : "Saabas (트리 분기 경로 기반 근사)"}</b>
          {method === "saabas" && " — 정확한 SHAP 계산이 끝나면 교체됩니다. 요인 그룹 단위로 SHAP 과의 상관 0.83–0.98."}
          {" "} 투구마다 <b>기준 점수 + 요인별 기여 = 그 공의 구위</b>가 정확히 성립합니다. 기준 점수는 모든 요인이 리그 평균일 때의 구위입니다.
        </li>
        <li>+ (빨강) 는 구위를 올린 요인, − (파랑) 은 깎은 요인입니다. 묶음 단위 값은 투구별 기여의 평균입니다.</li>
        <li>서로 강하게 얽힌 변수(예 : 수직 무브먼트·수직 가속도·패스트볼 대비 IVB 차이)는 기여를 나눠 갖기 때문에 8개 요인 그룹으로 묶었습니다.</li>
        <li>모델이 점수를 그렇게 매긴 이유이지, 그 요인을 바꾸면 결과가 그만큼 바뀐다는 인과 관계는 아닙니다.</li>
        <li>VAA(수직 진입각)는 원값이라 투구 높이 정보가 일부 섞여 있습니다. 좌투는 수평 성분을 우투 기준으로 반전한 값입니다.</li>
        <li>존에서 크게 벗어난 볼(점수 제외)은 근거도 표시하지 않습니다.</li>
      </ul>
    </details>
  );
}
