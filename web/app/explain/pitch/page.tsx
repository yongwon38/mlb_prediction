"use client";
import { useMemo } from "react";
import Link from "next/link";
import { Section } from "@/components/Panels";
import ExplainShell from "@/components/explain/ExplainShell";
import PitchList from "@/components/explain/PitchList";
import { PitchDetail } from "@/components/explain/Parts";
import { ctxHref } from "@/lib/appState";
import { RESULT_LABELS } from "@/lib/analysis";
import { pitchColor, stuffColor, useDarkMode } from "@/lib/colors";
import { batterName, gameLabel, paResult, scoreText, signedPct, situation } from "@/lib/games";
import { useExplainState } from "@/lib/useExplain";

/** 구위 산출 근거 — 투구 1개 : 목록에서 고르거나 URL(pitch=) 로 바로 진입 */
export default function ExplainPitch() {
  const st = useExplainState();
  const dark = useDarkMode();
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
    <ExplainShell st={st} active="explain/pitch" note="구종·구위 구간 선택은 왼쪽 투구 목록에 적용됩니다.">
      {lg && file && meta && (
        <div className="grid gap-4 lg:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)] items-start">
          <Section title="투구 목록" sub="공을 고르면 오른쪽에 산출 과정이 나옵니다 (투수 분석·경기·타석 페이지에서 점이나 행을 클릭해도 열림)">
            <PitchList ps={ps} pitchTypes={file.pitchTypes} groups={lg.groups} selected={sel} onSelect={setSel} />
          </Section>

          <div className="flex flex-col gap-4 min-w-0">
            {!selPitch ? (
              <Section title="투구 1개의 구위 산출 과정">
                <p className="text-sm text-muted">왼쪽 목록에서 공을 고르세요.</p>
              </Section>
            ) : (
              <>
                <Section
                  title="이 공의 상황"
                  right={
                    <div className="flex gap-2 text-xs">
                      <button className="chip" disabled={!prev} onClick={() => prev && setSel(prev.i)}>
                        ← 이전 공
                      </button>
                      <button className="chip" disabled={!next} onClick={() => next && setSel(next.i)}>
                        다음 공 →
                      </button>
                    </div>
                  }
                >
                  {game && pa ? (
                    <div className="flex flex-col gap-2 text-sm">
                      <p className="text-ink">
                        <b>{gameLabel(game, meta)}</b> <span className="text-ink-2">({scoreText(game)})</span> · {situation(pa)} · vs <b>{batterName(file, pa)}</b> ({pa.lhb ? "좌타" : "우타"})
                      </p>
                      <p className="text-ink-2">
                        타석 {selPitch.pn}구째 · {selPitch.b}-{selPitch.k} 카운트 · {meta.pitchNames[selPitch.pt] ?? selPitch.pt} {selPitch.v?.toFixed(1) ?? "-"}mph · 결과 <b className="text-ink">{RESULT_LABELS[selPitch.r]}</b> · 타석 결과 {paResult(pa)} (WPA {signedPct(pa.wpa)})
                      </p>
                      {pa.des && <p className="text-xs text-muted">{pa.des}</p>}
                      <div className="flex flex-wrap items-center gap-1.5 mt-1">
                        <span className="text-xs text-muted mr-1">같은 타석</span>
                        {paPitches.map((p) => (
                          <button
                            key={p.i}
                            onClick={() => setSel(p.i)}
                            aria-pressed={p.i === selPitch.i}
                            disabled={!p.c}
                            title={`${p.pn}구 ${p.pt} ${RESULT_LABELS[p.r]}`}
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
                          이 타석 보기 (경기·타석) →
                        </Link>
                        <a className="text-accent-ink underline underline-offset-2" href={`https://baseballsavant.mlb.com/gamefeed?gamePk=${game.pk}`} target="_blank" rel="noreferrer">
                          Savant 게임피드 ↗
                        </a>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-muted">상황 정보가 없습니다.</p>
                  )}
                </Section>
                <Section
                  title="투구 1개의 구위 산출 과정"
                  sub={`${selPitch.date} · ${selPitch.inn}회 · ${selPitch.b}-${selPitch.k} · ${meta.pitchNames[selPitch.pt] ?? selPitch.pt} · ${RESULT_LABELS[selPitch.r]}`}
                >
                  {selPitch.c ? <PitchDetail p={selPitch} lg={lg} /> : <p className="text-sm text-muted">존에서 크게 벗어난 볼이라 구위 점수와 근거가 없습니다.</p>}
                </Section>
              </>
            )}
          </div>
        </div>
      )}
    </ExplainShell>
  );
}
