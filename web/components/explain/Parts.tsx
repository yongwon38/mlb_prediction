"use client";
import Waterfall from "@/components/explain/Waterfall";
import { pitchColor } from "@/lib/colors";
import { EXPLAIN_FEAT_KEYS, FEAT_INFO, GROUP_FEATS, fmtSigned, groupDetail, topReasons } from "@/lib/explain";
import type { ExplainPitch, LeagueExplain } from "@/lib/types";
import { groupNames, useT } from "@/lib/i18n";

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
  const t = useT();
  if (!reasons || (!reasons.up.length && !reasons.down.length)) return <p className="text-sm text-muted">{t.explain.noneStandout}</p>;
  const item = (r: (typeof reasons.up)[number], up: boolean) => (
    <li key={r.name} className="flex gap-2">
      <span className={`shrink-0 text-xs font-medium px-1.5 py-0.5 rounded ${up ? "text-good bg-surface-2" : "text-bad bg-surface-2"}`}>{up ? t.explain.up : t.explain.down}</span>
      <span>
        <b className="text-ink">
          {r.name} {t.common.points(fmtSigned(r.value, 1))}
        </b>
        {r.detail && <span className="text-ink-2">: {r.detail}</span>}
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
  const t = useT();
  const ref = lg.pitchTypes[p.pt]?.feat;
  const groups = groupNames(t, lg.groups);
  const head = t.explain.rawHead;
  return (
    <div className="flex flex-col gap-3">
      <Waterfall groups={groups} c={p.c!} base={lg.base} final={p.s as number} />
      <table className="w-full text-xs tnum">
        <thead>
          <tr className="text-muted border-b border-grid">
            <th className="text-left font-normal py-1.5">{head[0]}</th>
            <th className="text-right font-normal py-1.5">{head[1]}</th>
            <th className="text-right font-normal py-1.5">{t.explain.lgAvg(p.pt)}</th>
            <th className="text-right font-normal py-1.5">{head[3]}</th>
            <th className="text-right font-normal py-1.5 pl-2">{head[4]}</th>
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
                <td className="py-1.5 text-ink-2">{t.feat[k]}</td>
                <td className="py-1.5 text-right text-ink font-medium">{v === null ? "-" : `${v.toFixed(info.nd)}${info.unit}`}</td>
                <td className="py-1.5 text-right text-ink-2">{r === undefined ? "-" : r.toFixed(info.nd)}</td>
                <td className="py-1.5 text-right text-ink-2">{v === null || r === undefined ? "-" : fmtSigned(v - r, info.nd)}</td>
                <td className="py-1.5 text-right pl-2 text-ink-2">{g >= 0 ? `${groups[g]} ${fmtSigned(p.c![g], 1)}` : ""}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-xs text-muted">
        {groupDetail([p], lg.groups.length - 1, lg, t)}: {t.common.points(fmtSigned(p.c![lg.groups.length - 1], 1))}
      </p>
    </div>
  );
}

export function Caveats({ method }: { method: "shap" | "saabas" }) {
  const c = useT().explain.caveats;
  return (
    <details className="card p-4 text-xs text-ink-2 leading-relaxed" open>
      <summary className="cursor-pointer font-semibold text-ink text-sm">{c.summary}</summary>
      <ul className="list-disc pl-5 mt-2 flex flex-col gap-1">
        <li>
          {c.c1a}
          <b>{method === "shap" ? c.shap : c.saabas}</b>.{method === "saabas" && c.saabasNote}
          {c.c1b}
          <b>{c.c1c}</b>
          {c.c1d}
        </li>
        <li>{c.c2}</li>
        <li>{c.c3}</li>
        <li>{c.c4}</li>
        <li>{c.c5}</li>
        <li>{c.c6}</li>
      </ul>
    </details>
  );
}
