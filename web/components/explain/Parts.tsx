"use client";
import Waterfall from "@/components/explain/Waterfall";
import { pitchColor } from "@/lib/colors";
import { EXPLAIN_FEAT_KEYS, FEAT_INFO, GROUP_FEATS, fmtSigned, groupDetail, topReasons } from "@/lib/explain";
import type { ExplainPitch, LeagueExplain } from "@/lib/types";

export function PtLabel({ pt, pitchTypes, dark, name }: { pt: string; pitchTypes: string[]; dark: boolean; name?: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="w-2.5 h-2.5 rounded-full" style={{ background: pitchColor(pitchTypes, pt, dark) }} />
      <span className="font-medium">{pt}</span>
      {name && <span className="text-muted hidden sm:inline">{name}</span>}
    </span>
  );
}

export function ReasonList({ reasons }: { reasons: ReturnType<typeof topReasons> | null }) {
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

export function PitchDetail({ p, lg }: { p: ExplainPitch; lg: LeagueExplain }) {
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

export function Caveats({ method }: { method: "shap" | "saabas" }) {
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
        <li>존에서 크게 벗어난 볼과 사구(점수 제외)는 근거도 표시하지 않습니다.</li>
      </ul>
    </details>
  );
}
