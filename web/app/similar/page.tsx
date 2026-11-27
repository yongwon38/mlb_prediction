"use client";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { EmptyState, LoadingBlock, Section, StuffBadge, pct } from "@/components/Panels";
import { SeasonSelect } from "@/components/PageHeader";
import { PlayerPhoto } from "@/components/Avatar";
import Icon from "@/components/Icon";
import { ctxHref, usePageState } from "@/lib/appState";
import { loadSimilar } from "@/lib/data";
import { type InputDiff, type SimSpace, type SimilarIndex, findItem, inputDiffs, inputRaw, searchItem } from "@/lib/similar";
import { FEAT_FMT } from "@/lib/simulator";
import { type Dict, useT } from "@/lib/i18n";

/** 입력 차이 한 개 : '구속 −3.8 mph' (투구손은 '투구손 다름') */
function fmtDiff(tt: Dict, d: InputDiff) {
  if (d.col === "p_throws") return tt.similar.handDiff;
  const f = FEAT_FMT[d.col] ?? { nd: 2, unit: "" };
  const v = Math.abs(d.diff).toFixed(f.nd);
  return `${tt.sim.feats[d.col] ?? d.col} ${d.diff >= 0 ? "+" : "−"}${v}${f.unit}`;
}

/** 유사 구종 검색 : 투수×구종의 가장 비슷한 다른 투수 구종 10개 (모델 표현 / 물리량) */
export default function SimilarPage() {
  const [pt, setPt] = useState<string | null>(null);
  const [space, setSpace] = useState<SimSpace>("model");
  const { meta, season, setSeason, pitcherId, setPitcherId, error } = usePageState({ pt, sp: space === "input" ? "input" : null }, (q) => {
    if (q.get("pt")) setPt(q.get("pt"));
    if (q.get("sp") === "input") setSpace("input");
  });
  const tt = useT();
  const t = tt.similar;

  const [loaded, setLoaded] = useState<{ season: number; idx: SimilarIndex | null } | null>(null);
  useEffect(() => {
    if (!season) return;
    let alive = true;
    loadSimilar(season)
      .then((idx) => alive && setLoaded({ season, idx }))
      .catch(() => alive && setLoaded({ season, idx: null }));
    return () => {
      alive = false;
    };
  }, [season]);
  const idx = loaded?.season === season ? loaded.idx : undefined;

  // 투수 목록 (이름순) 과 선택한 투수의 구종 (투구 수 순)
  const pitchers = useMemo(() => {
    if (!idx) return [];
    const m = new Map<number, string>();
    idx.json.items.forEach((it) => m.set(it.id, it.name));
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [idx]);
  const types = useMemo(() => (idx && pitcherId ? idx.json.items.filter((it) => it.id === pitcherId).sort((a, b) => b.n - a.n) : []), [idx, pitcherId]);
  const curPt = pt && types.some((it) => it.pt === pt) ? pt : (types[0]?.pt ?? null);
  const qi = idx && pitcherId && curPt ? findItem(idx, pitcherId, curPt) : -1;
  const q = idx && qi >= 0 ? idx.json.items[qi] : null;
  const nbs = useMemo(() => (idx && qi >= 0 ? searchItem(idx, space, qi, 10) : []), [idx, qi, space]);
  const qRaw = useMemo(() => (idx && qi >= 0 ? inputRaw(idx, qi) : null), [idx, qi]);
  const missingPt = !!(pt && types.length && !types.some((it) => it.pt === pt));
  const pName = pitcherId ? (pitchers.find(([id]) => id === pitcherId)?.[1] ?? null) : null;

  const [query, setQuery] = useState("");
  const pick = (v: string) => {
    setQuery(v);
    const hit = pitchers.find(([, name]) => name === v);
    if (!hit) return;
    setPitcherId(hit[0]);
    setPt(null);
    setQuery("");
  };
  const c = { season };

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 pt-6 pb-10 flex flex-col gap-5">
      <header className="flex flex-wrap items-end justify-between gap-4 pt-2">
        <div className="min-w-0">
          <h1 className="text-[28px] sm:text-[32px] font-bold tracking-tight text-ink leading-tight">{t.title}</h1>
          <p className="text-sm text-ink-2 mt-2">{t.sub}</p>
        </div>
        <SeasonSelect meta={meta} season={season} onChange={setSeason} />
      </header>

      {error && <div className="card p-3 text-sm text-bad">{tt.common.loadError(error)}</div>}
      {idx === null && <div className="card p-3 text-sm text-muted">{t.noData}</div>}

      {idx === undefined ? (
        <LoadingBlock label={t.loading} rows={4} />
      ) : idx === null ? null : (
        <>
          <section className="card p-4 sm:p-5 flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <input
                type="search"
                list="similar-pitchers"
                value={query}
                onChange={(e) => pick(e.target.value)}
                placeholder={t.pickPlaceholder}
                aria-label={t.pickPlaceholder}
                className="w-52 !py-1.5 text-sm"
              />
              <datalist id="similar-pitchers">
                {pitchers.map(([id, name]) => (
                  <option key={id} value={name} />
                ))}
              </datalist>
              {types.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={t.pitch}>
                  <span className="text-xs text-muted mr-1">{t.pitch}</span>
                  {types.map((it) => (
                    <button key={it.pt} className="chip" aria-pressed={it.pt === curPt} onClick={() => setPt(it.pt)} title={meta?.pitchNames[it.pt]}>
                      {it.pt}
                      <span className="tnum text-muted">{it.n.toLocaleString()}</span>
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-center gap-1.5 ml-auto" role="group" aria-label={t.space}>
                <span className="text-xs text-muted mr-1">{t.space}</span>
                {(["model", "input"] as const).map((s) => (
                  <button key={s} className="chip" aria-pressed={space === s} onClick={() => setSpace(s)}>
                    {s === "model" ? t.spaceModel : t.spaceInput}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted">{space === "model" ? t.spaceModelDef : t.spaceInputDef}</p>
            {missingPt && pName && <p className="text-xs text-muted">{t.notInIndex(pName, pt!)}</p>}
          </section>

          {!q ? (
            <EmptyState title={t.idle} body={t.idleBody} />
          ) : (
            <>
              <section className="card p-4 sm:p-5 flex flex-wrap items-center gap-4">
                <PlayerPhoto id={q.id} name={q.name} size={56} />
                <div className="min-w-0 flex-1">
                  <p className="eyebrow mb-1">{t.query}</p>
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    <Link href={ctxHref("/pitcher", { ...c, pitcher: q.id })} className="text-[22px] font-bold tracking-tight text-ink hover:underline underline-offset-2">
                      {q.name}
                    </Link>
                    <span className="text-[15px] font-semibold text-ink">
                      {q.pt} <span className="text-muted font-normal">{meta?.pitchNames[q.pt]}</span>
                    </span>
                    <StuffBadge v={q.stuff} size="md" />
                  </div>
                  <p className="text-sm text-ink-2 mt-1">
                    {tt.common.throws(q.hand === "L" ? "L" : "R")} · {tt.common.pitches(q.n)} · {t.whiff(pct(q.whiff))}
                  </p>
                </div>
                <Link href={ctxHref("/simulator", { ...c, pitcher: q.id }, { pt: q.pt })} className="chip">
                  <Icon name="sliders" size={14} />
                  {t.openSim}
                </Link>
              </section>

              <Section title={t.results} sub={t.resultsSub(idx.json.asOf, idx.n)}>
                <div className="overflow-x-auto -mx-5 px-5">
                  <table className="w-full text-sm tnum min-w-[760px]">
                    <thead>
                      <tr className="text-xs text-muted border-b border-line">
                        <th className="w-8 text-right py-2 pr-3">{t.cols[0]}</th>
                        <th className="text-left py-2">{t.cols[1]}</th>
                        <th className="text-left py-2 pl-3">{t.cols[2]}</th>
                        <th className="text-right py-2 pr-3">{t.cols[3]}</th>
                        <th className="text-left py-2">{t.cols[4]}</th>
                        <th className="text-right py-2 pr-3">{t.cols[5]}</th>
                        <th className="text-left py-2">{t.cols[6]}</th>
                        <th className="py-2" />
                      </tr>
                    </thead>
                    <tbody>
                      {nbs.map(({ i, sim }, r) => {
                        const it = idx.json.items[i];
                        const diffs = qRaw ? inputDiffs(idx, qRaw, i, 3) : [];
                        return (
                          <tr key={`${it.id}-${it.pt}`} className="border-b border-grid last:border-0">
                            <td className="text-right py-2.5 pr-3 text-muted">{r + 1}</td>
                            <td className="py-2.5">
                              <span className="flex items-center gap-2.5">
                                <PlayerPhoto id={it.id} name={it.name} size={28} />
                                <Link href={ctxHref("/pitcher", { ...c, pitcher: it.id })} className="font-semibold text-ink hover:underline underline-offset-2">
                                  {it.name}
                                </Link>
                                <span className="text-muted text-xs">{it.hand}HP</span>
                              </span>
                            </td>
                            <td className="py-2.5 pl-3 whitespace-nowrap">
                              <span className="font-medium text-ink">{it.pt}</span>
                              <span className="text-muted text-xs ml-1.5 hidden sm:inline">{meta?.pitchNames[it.pt]}</span>
                            </td>
                            <td className="text-right py-2.5 pr-3 text-ink">{sim.toFixed(3)}</td>
                            <td className="py-2.5">
                              <StuffBadge v={it.stuff} size="sm" />
                            </td>
                            <td className="text-right py-2.5 pr-3 text-ink-2">{pct(it.whiff)}</td>
                            <td className="py-2.5 text-xs text-ink-2">{diffs.map((d) => fmtDiff(tt, d)).join(" · ")}</td>
                            <td className="py-2.5 text-right whitespace-nowrap">
                              <Link
                                href={ctxHref("/similar", { ...c, pitcher: it.id }, { pt: it.pt, sp: space === "input" ? "input" : null })}
                                title={t.searchThis}
                                aria-label={t.searchThis}
                                className="inline-flex p-1 rounded text-muted hover:text-accent-ink"
                              >
                                <Icon name="search" size={15} />
                              </Link>
                              <Link
                                href={ctxHref("/simulator", { ...c, pitcher: it.id }, { pt: it.pt })}
                                title={t.openSim}
                                aria-label={t.openSim}
                                className="inline-flex p-1 rounded text-muted hover:text-accent-ink"
                              >
                                <Icon name="sliders" size={15} />
                              </Link>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <p className="text-[11px] text-muted mt-2 leading-relaxed">{t.diffNote}</p>
              </Section>
            </>
          )}
        </>
      )}
    </main>
  );
}
