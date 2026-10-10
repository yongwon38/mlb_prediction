"use client";
import { useMemo } from "react";
import Link from "next/link";
import { Section } from "@/components/Panels";
import ExplainShell from "@/components/explain/ExplainShell";
import PitchList from "@/components/explain/PitchList";
import { PitchDetail } from "@/components/explain/Parts";
import { ctxHref } from "@/lib/appState";
import { pitchColor, stuffColor, useDarkMode } from "@/lib/colors";
import { batterName, gameLabel, paResult, scoreText, signedPct, situation } from "@/lib/games";
import { useExplainState } from "@/lib/useExplain";
import { groupNames, useT } from "@/lib/i18n";

/** 구위 산출 근거 — 투구 1개 : 목록에서 고르거나 URL(pitch=) 로 바로 진입 */
export default function ExplainPitch() {
  const st = useExplainState();
  const dark = useDarkMode();
  const tt = useT();
  const t = tt.explain;
  const R = tt.results;
  const { lg, ps, everything, file, sel, setSel, meta, season, pitcherId, effGt } = st;

  const selPitch = sel !== null ? (everything.find((p) => p.i === sel) ?? null) : null;
  const game = selPitch && file ? file.games[selPitch.game] : null;
  const pa = selPitch && file ? file.pas[selPitch.pai] : null;
  const paPitches = useMemo(() => (selPitch ? everything.filter((p) => p.pai === selPitch.pai) : []), [everything, selPitch]);
  // 이전·다음 : 점수 있는 공 기준 시간순
  const [prev, next] = useMemo(() => {
    if (!selPitch) return [null, null];
    let a = null, b = null;
    for (let k = selPitch.i - 1; k >= 0; k--) if (everything[k]?.c) { a = everything[k]; break; }
    for (let k = selPitch.i + 1; k < everything.length; k++) if (everything[k]?.c) { b = everything[k]; break; }
    return [a, b];
  }, [everything, selPitch]);
  const c = { season, pitcher: pitcherId, gt: effGt };

  return (
    <ExplainShell st={st} active="explain/pitch" note={t.pitchNote}>
      {lg && file && meta && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] items-start">
          <Section title={t.list} sub={t.listSub}>
            <PitchList ps={ps} pitchTypes={file.pitchTypes} groups={groupNames(tt, lg.groups)} selected={sel} onSelect={setSel} />
          </Section>

          <div className="flex flex-col gap-4 min-w-0">
            {!selPitch ? (
              <Section title={t.process}>
                <p className="text-sm text-muted">{t.pickPitch}</p>
              </Section>
            ) : (
              <>
                <Section
                  title={t.context}
                  right={
                    <div className="flex gap-2 text-xs">
                      <button className="chip" disabled={!prev} onClick={() => prev && setSel(prev.i)}>
                        {t.prev}
                      </button>
                      <button className="chip" disabled={!next} onClick={() => next && setSel(next.i)}>
                        {t.next}
                      </button>
                    </div>
                  }
                >
                  {game && pa ? (
                    <div className="flex flex-col gap-2 text-sm">
                      <p className="text-ink">
                        <b>{gameLabel(game, tt)}</b> <span className="text-ink-2">({scoreText(game, tt)})</span> · {situation(pa, tt)} · vs <b>{batterName(file, pa)}</b> ({tt.common.side(!!pa.lhb)})
                      </p>
                      <p className="text-ink-2">
                        {t.ctxLine(selPitch.pn, selPitch.b, selPitch.k, meta.pitchNames[selPitch.pt] ?? selPitch.pt, selPitch.v?.toFixed(1) ?? "-")}
                        <b className="text-ink">{R[selPitch.r]}</b>
                        {t.paResult(paResult(pa, tt), signedPct(pa.wpa))}
                      </p>
                      {pa.des && <p className="text-xs text-muted">{pa.des}</p>}
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        <span className="text-xs text-muted mr-1">{t.samePa}</span>
                        {paPitches.map((p) => (
                          <button
                            key={p.i}
                            onClick={() => setSel(p.i)}
                            aria-pressed={p.i === selPitch.i}
                            disabled={!p.c}
                            title={t.chipTitle(p.pn, p.pt, R[p.r])}
                            className="chip tnum disabled:opacity-50"
                          >
                            <span className="w-2 h-2 rounded-full" style={{ background: pitchColor(file.pitchTypes, p.pt, dark) }} />
                            {p.pn}. {p.pt}
                            <span style={{ color: p.s !== null ? stuffColor(p.s, dark) : undefined }} className="font-semibold">
                              {p.s?.toFixed(0) ?? "-"}
                            </span>
                          </button>
                        ))}
                      </div>
                      <div className="flex gap-4 text-xs">
                        <Link className="text-accent-ink underline underline-offset-2" href={ctxHref("/games", c, { game: selPitch.game, pa: selPitch.pai })}>
                          {t.openPa}
                        </Link>
                        <a className="text-accent-ink underline underline-offset-2" href={`https://baseballsavant.mlb.com/gamefeed?gamePk=${game.pk}`} target="_blank" rel="noreferrer">
                          {tt.common.savantFeed}
                        </a>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted">{t.noContext}</p>
                  )}
                </Section>
                <Section
                  title={t.process}
                  sub={t.processSub(selPitch.date, selPitch.inn, selPitch.b, selPitch.k, meta.pitchNames[selPitch.pt] ?? selPitch.pt, R[selPitch.r])}
                >
                  {selPitch.c ? <PitchDetail p={selPitch} lg={lg} /> : <p className="text-sm text-muted">{t.unscored}</p>}
                </Section>
              </>
            )}
          </div>
        </div>
      )}
    </ExplainShell>
  );
}
