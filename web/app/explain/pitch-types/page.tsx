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
import { groupNames, useT } from "@/lib/i18n";

/** 구위 산출 근거 — 구종별 */
export default function ExplainPitchTypes() {
  const st = useExplainState();
  const dark = useDarkMode();
  const tt = useT();
  const t = tt.explain;
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
  const reasons = useMemo(() => (lg && one ? topReasons(g1, lg, tt) : null), [g1, lg, one, tt]);
  const avg = meanScore(g1);
  const groups = lg ? groupNames(tt, lg.groups) : [];

  return (
    <ExplainShell st={st} active="explain/pitch-types" filters="band" note={t.ptNote}>
      {lg && (
        <>
          <Section title={t.ptMatrix} sub={t.ptMatrixSub}>
            <ContribMatrix groups={groups} rows={rows} base={lg.base} active={one} onRow={(k) => setPts(one === k ? [] : [k])} />
          </Section>
          {one ? (
            <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
              <Section
                title={t.ptDetail(one, meta?.pitchNames[one] ?? "")}
                sub={t.ptDetailSub(avg?.toFixed(1) ?? "-", lg.base.toFixed(1), avg !== null ? fmtSigned(avg - lg.base, 1) : "-", one)}
              >
                {mean ? <ContribBars groups={groups} values={mean} compare={lg.pitchTypes[one]?.contrib ?? null} /> : <p className="text-sm text-muted">{tt.common.noScored}</p>}
              </Section>
              <Section title={t.ptReasons(one)} sub={t.vsLeagueSub}>
                <ReasonList reasons={reasons} />
              </Section>
            </div>
          ) : (
            <p className="text-sm text-muted px-1">{t.ptEmpty}</p>
          )}
        </>
      )}
    </ExplainShell>
  );
}
