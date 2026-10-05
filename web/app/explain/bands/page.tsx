"use client";
import { useMemo } from "react";
import { Section } from "@/components/Panels";
import ContribBars from "@/components/explain/ContribBars";
import ContribMatrix, { type MatrixRow } from "@/components/explain/ContribMatrix";
import ExplainShell from "@/components/explain/ExplainShell";
import { ReasonList } from "@/components/explain/Parts";
import { STUFF_BUCKETS, bandOf } from "@/lib/analysis";
import { fmtSigned, meanContrib, meanScore, mixReference, scored, topReasons } from "@/lib/explain";
import { useExplainState } from "@/lib/useExplain";

/** 구위 산출 근거 — 점수대별 */
export default function ExplainBands() {
  const st = useExplainState();
  const { lg, byPt, band, setBand } = st;
  const nG = lg?.groups.length ?? 0;

  const rows: MatrixRow[] = useMemo(() => {
    if (!lg) return [];
    return [...STUFF_BUCKETS]
      .reverse()
      .map((b) => {
        const g = byPt.filter((p) => bandOf(p.s) === b.label);
        return { key: b.label, label: b.label, n: scored(g).length, score: meanScore(g), c: meanContrib(g, nG), ref: mixReference(g, lg) };
      })
      .filter((r) => r.n > 0);
  }, [lg, byPt, nG]);

  const one = band.length === 1 ? band[0] : null;
  const g1 = useMemo(() => (one ? byPt.filter((p) => bandOf(p.s) === one) : []), [byPt, one]);
  const mean = useMemo(() => (lg && one ? meanContrib(g1, nG) : null), [g1, lg, one, nG]);
  const ref = useMemo(() => (lg && one ? mixReference(g1, lg) : null), [g1, lg, one]);
  const reasons = useMemo(() => (lg && one ? topReasons(g1, lg) : null), [g1, lg, one]);
  const avg = meanScore(g1);

  return (
    <ExplainShell st={st} active="explain/bands" filters="pt">
      {lg && (
        <>
          <Section title="점수대별 요인 기여" sub="이 투수의 좋은 공(60+)과 나쁜 공(<40)은 무엇이 다른가. 구종 선택이 적용됩니다. 행을 누르면 상세">
            <ContribMatrix groups={lg.groups} rows={rows} base={lg.base} active={one} onRow={(k) => setBand(one === k ? [] : [k])} />
          </Section>
          {one ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
              <Section
                title={`구위 ${one} 구간 — 요인별 기여`}
                sub={`${scored(g1).length.toLocaleString()}구 · 평균 구위 ${avg?.toFixed(1) ?? "-"} = 기준 ${lg.base.toFixed(1)} + ${avg !== null ? fmtSigned(avg - lg.base, 1) : "-"} · 점선 = 같은 구종 구성의 리그 평균`}
              >
                {mean ? <ContribBars groups={lg.groups} values={mean} compare={ref} /> : <p className="text-sm text-muted">점수가 있는 투구가 없습니다.</p>}
              </Section>
              <Section title={`${one} 구간 주요 근거`} sub="원값은 리그 동일 구종 평균과 비교">
                <ReasonList reasons={reasons} />
              </Section>
            </div>
          ) : (
            <p className="text-sm text-muted px-1">표에서 점수대 행을 누르면 그 구간의 요인별 기여와 주요 근거가 표시됩니다.</p>
          )}
        </>
      )}
    </ExplainShell>
  );
}
