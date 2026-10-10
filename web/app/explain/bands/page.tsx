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
import { groupNames, useT } from "@/lib/i18n";

/** 구위 산출 근거 — 점수대별 */
export default function ExplainBands() {
  const st = useExplainState();
  const tt = useT();
  const t = tt.explain;
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
  const reasons = useMemo(() => (lg && one ? topReasons(g1, lg, tt) : null), [g1, lg, one, tt]);
  const avg = meanScore(g1);
  const groups = lg ? groupNames(tt, lg.groups) : [];

  return (
    <ExplainShell st={st} active="explain/bands" filters="pt">
      {lg && (
        <>
          <Section title={t.bandMatrix} sub={t.bandMatrixSub}>
            <ContribMatrix groups={groups} rows={rows} base={lg.base} active={one} onRow={(k) => setBand(one === k ? [] : [k])} />
          </Section>
          {one ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
              <Section
                title={t.bandDetail(one)}
                sub={t.bandDetailSub(scored(g1).length, avg?.toFixed(1) ?? "-", lg.base.toFixed(1), avg !== null ? fmtSigned(avg - lg.base, 1) : "-")}
              >
                {mean ? <ContribBars groups={groups} values={mean} compare={ref} /> : <p className="text-sm text-muted">{tt.common.noScored}</p>}
              </Section>
              <Section title={t.bandReasons(one)} sub={t.vsLeagueSub}>
                <ReasonList reasons={reasons} />
              </Section>
            </div>
          ) : (
            <p className="text-sm text-muted px-1">{t.bandEmpty}</p>
          )}
        </>
      )}
    </ExplainShell>
  );
}
