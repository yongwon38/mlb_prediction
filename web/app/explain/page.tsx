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

const SUBPAGES = [
  { href: "/explain/pitch-types", t: "구종별", d: "구종마다 어떤 요인이 구위를 올리고 깎는지 — 리그 동일 구종과 비교" },
  { href: "/explain/bands", t: "점수대별", d: "이 투수의 좋은 공(60+)과 나쁜 공(<40)은 무엇이 다른가" },
  { href: "/explain/pitch", t: "투구 1개", d: "공 하나의 구위가 기준 점수에서 어떻게 만들어졌는지 단계별로" },
];

/** 구위 산출 근거 — 개요 : 선택한 투구 묶음의 요인별 기여와 주요 근거 */
export default function ExplainOverview() {
  const st = useExplainState();
  const { lg, ps, season, pitcherId, effGt, pts, band } = st;
  const nG = lg?.groups.length ?? 0;
  const mean = useMemo(() => (lg ? meanContrib(ps, nG) : null), [ps, lg, nG]);
  const ref = useMemo(() => (lg ? mixReference(ps, lg) : null), [ps, lg]);
  const reasons = useMemo(() => (lg ? topReasons(ps, lg) : null), [ps, lg]);
  const avg = meanScore(ps);
  const c = { season, pitcher: pitcherId, gt: effGt };
  const keep = { pt: pts.join(","), band: band.join(",") };

  return (
    <ExplainShell st={st} active="explain" note="구종·구위 구간 선택은 이 페이지의 요약에 적용되고, 다른 근거 페이지로 이동해도 유지됩니다.">
      {lg && (
        <>
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
          <div className="grid gap-3 sm:grid-cols-3">
            {SUBPAGES.map((x) => (
              <Link key={x.href} href={ctxHref(x.href, c, keep)} className="card p-4 hover:bg-surface-2 flex flex-col gap-1">
                <span className="text-sm font-semibold text-ink">{x.t} →</span>
                <span className="text-xs text-muted">{x.d}</span>
              </Link>
            ))}
          </div>
        </>
      )}
    </ExplainShell>
  );
}
