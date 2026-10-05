"use client";
import { useMemo } from "react";
import { Section } from "@/components/Panels";
import ContribBars from "@/components/explain/ContribBars";
import ContribMatrix, { type MatrixRow } from "@/components/explain/ContribMatrix";
import ExplainShell from "@/components/explain/ExplainShell";
import { PtLabel, ReasonList } from "@/components/explain/Parts";
import { useDarkMode } from "@/lib/colors";
import { fmtSigned, meanContrib, meanScore, scored, topReasons } from "@/lib/explain";
import { useExplainState } from "@/lib/useExplain";

/** 구위 산출 근거 — 구종별 */
export default function ExplainPitchTypes() {
  const st = useExplainState();
  const dark = useDarkMode();
  const { lg, file, byBand, pts, setPts, meta } = st;
  const nG = lg?.groups.length ?? 0;

  const rows: MatrixRow[] = useMemo(() => {
    if (!lg || !file) return [];
    return file.pitchTypes
      .map((pt) => {
        const g = byBand.filter((p) => p.pt === pt);
        return { key: pt, label: <PtLabel pt={pt} pitchTypes={file.pitchTypes} dark={dark} name={meta?.pitchNames[pt]} />, n: scored(g).length, score: meanScore(g), c: meanContrib(g, nG), ref: lg.pitchTypes[pt]?.contrib ?? null };
      })
      .filter((r) => r.n > 0);
  }, [lg, file, byBand, nG, dark, meta]);

  const one = pts.length === 1 ? pts[0] : null;
  const g1 = useMemo(() => (one ? byBand.filter((p) => p.pt === one) : []), [byBand, one]);
  const mean = useMemo(() => (lg && one ? meanContrib(g1, nG) : null), [g1, lg, one, nG]);
  const reasons = useMemo(() => (lg && one ? topReasons(g1, lg) : null), [g1, lg, one]);
  const avg = meanScore(g1);

  return (
    <ExplainShell st={st} active="explain/pitch-types" filters="band" note="구위 구간 선택은 구종별 표에 적용됩니다. 표의 행을 누르면 그 구종의 상세가 아래에 나옵니다.">
      {lg && (
        <>
          <Section title="구종별 요인 기여" sub="구종마다 어떤 요인이 구위를 올리고 깎는지 (셀 = 평균 기여, 점). 셀에 마우스를 올리면 리그 동일 구종 평균과 비교. 행을 누르면 상세">
            <ContribMatrix groups={lg.groups} rows={rows} base={lg.base} active={one} onRow={(k) => setPts(one === k ? [] : [k])} />
          </Section>
          {one ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
              <Section
                title={`${one} ${meta?.pitchNames[one] ?? ""} — 요인별 기여`}
                sub={`평균 구위 ${avg?.toFixed(1) ?? "-"} = 기준 ${lg.base.toFixed(1)} + 요인 합 ${avg !== null ? fmtSigned(avg - lg.base, 1) : "-"} · 점선 = 리그 ${one} 평균`}
              >
                {mean ? <ContribBars groups={lg.groups} values={mean} compare={lg.pitchTypes[one]?.contrib ?? null} /> : <p className="text-sm text-muted">점수가 있는 투구가 없습니다.</p>}
              </Section>
              <Section title={`${one} 주요 근거`} sub="원값은 리그 동일 구종 평균과 비교">
                <ReasonList reasons={reasons} />
              </Section>
            </div>
          ) : (
            <p className="text-sm text-muted px-1">표에서 구종 행을 누르면 그 구종의 요인별 기여와 주요 근거가 표시됩니다.</p>
          )}
        </>
      )}
    </ExplainShell>
  );
}
