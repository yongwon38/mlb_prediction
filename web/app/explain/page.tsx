"use client";
import { useMemo } from "react";
import Link from "next/link";
import { Section } from "@/components/Panels";
import ContribBars from "@/components/explain/ContribBars";
import ExplainShell from "@/components/explain/ExplainShell";
import { ReasonList } from "@/components/explain/Parts";
import { ctxHref } from "@/lib/appState";
import { fmtSigned, meanContrib, meanScore, mixReference, scored, topReasons } from "@/lib/explain";
import { useExplainState } from "@/lib/useExplain";
import { groupNames, useT } from "@/lib/i18n";

const SUBPAGES = ["pitch-types", "bands", "pitch"] as const;

/** 구위 산출 근거 — 개요 : 선택한 투구 묶음의 요인별 기여와 주요 근거 */
export default function ExplainOverview() {
  const st = useExplainState();
  const tt = useT();
  const t = tt.explain;
  const { lg, ps, season, pitcherId, effGt, pts, band } = st;
  const nG = lg?.groups.length ?? 0;
  const mean = useMemo(() => (lg ? meanContrib(ps, nG) : null), [ps, lg, nG]);
  const ref = useMemo(() => (lg ? mixReference(ps, lg) : null), [ps, lg]);
  const reasons = useMemo(() => (lg ? topReasons(ps, lg, tt) : null), [ps, lg, tt]);
  const avg = meanScore(ps);
  const c = { season, pitcher: pitcherId, gt: effGt };
  const keep = { pt: pts.join(","), band: band.join(",") };

  return (
    <ExplainShell st={st} active="explain" note={t.overviewNote}>
      {lg && (
        <>
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start">
            <Section
              title={t.byFactor}
              sub={t.byFactorSub(avg?.toFixed(1) ?? "-", lg.base.toFixed(1), avg !== null ? fmtSigned(avg - lg.base, 1) : "-", scored(ps).length)}
            >
              {mean ? <ContribBars groups={groupNames(tt, lg.groups)} values={mean} compare={ref} /> : <p className="text-sm text-muted">{tt.common.noScored}</p>}
            </Section>
            <Section title={t.reasons} sub={t.reasonsSub}>
              <ReasonList reasons={reasons} />
            </Section>
          </div>
          <div className="grid gap-3 sm:grid-cols-3">
            {SUBPAGES.map((k) => (
              <Link key={k} href={ctxHref(`/explain/${k}`, c, keep)} className="card p-4 hover:bg-surface-2 flex flex-col gap-1">
                <span className="text-sm font-semibold text-ink">{tt.header.tabs[`explain/${k}`]} →</span>
                <span className="text-xs text-muted">{t.sub[k]}</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </ExplainShell>
  );
}
