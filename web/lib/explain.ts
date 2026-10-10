import type { ExplainPitch, LeagueExplain } from "./types";
import type { Dict } from "./i18n/ko";
import { groupNames } from "./i18n";

/** 근거 문장용 원값 (모델 입력 기준 : 좌투는 좌우 반전 = 우투 기준). 이름은 사전 t.feat */
export const FEAT_INFO: Record<string, { unit: string; nd: number }> = {
  v: { unit: " mph", nd: 1 },
  ivb: { unit: " in", nd: 1 },
  hb: { unit: " in", nd: 1 },
  spin: { unit: " rpm", nd: 0 },
  axis: { unit: "°", nd: 0 },
  vaa: { unit: "°", nd: 1 },
  haa: { unit: "°", nd: 1 },
  ext: { unit: " ft", nd: 1 },
  rz: { unit: " ft", nd: 1 },
  arm: { unit: "°", nd: 0 },
};

export const EXPLAIN_FEAT_KEYS = Object.keys(FEAT_INFO);

/** 요인 그룹별 대표 원값 (league.explain.groups 순서와 같음) */
export const GROUP_FEATS: string[][] = [["v"], ["ivb"], ["hb"], ["vaa", "haa"], ["rz", "arm"], ["ext"], ["spin", "axis"], []];

export const scored = (ps: ExplainPitch[]) => ps.filter((p) => p.c !== null && p.s !== null);

/** 투구 묶음의 평균 그룹 기여 (점수 있는 공만) */
export function meanContrib(ps: ExplainPitch[], nGroups: number): number[] | null {
  const xs = scored(ps);
  if (!xs.length) return null;
  const m = new Array(nGroups).fill(0);
  for (const p of xs) for (let j = 0; j < nGroups; j++) m[j] += p.c![j];
  return m.map((v) => v / xs.length);
}

export const meanScore = (ps: ExplainPitch[]) => {
  const xs = scored(ps);
  return xs.length ? xs.reduce((a, p) => a + (p.s as number), 0) / xs.length : null;
};

/** 원값의 '같은 구종 리그 평균 대비' 차이 평균 (구종이 섞여 있어도 각 공을 자기 구종 리그 평균과 비교) */
export function featVsLeague(ps: ExplainPitch[], key: string, lg: LeagueExplain) {
  let sv = 0, sd = 0, n = 0;
  for (const p of scored(ps)) {
    const v = p.f[key];
    const ref = lg.pitchTypes[p.pt]?.feat[key];
    if (v === null || v === undefined || ref === undefined) continue;
    sv += v;
    sd += v - ref;
    n++;
  }
  return n ? { value: sv / n, diff: sd / n } : null;
}

const fmt = (v: number, nd: number) => v.toFixed(nd);
const signed = (v: number, nd: number) => `${v >= 0 ? "+" : ""}${v.toFixed(nd)}`;

/** 요인 하나에 대한 원값 근거 문구. 예 : "IVB 18.2 in (리그 같은 구종 대비 +2.9)" */
export function groupDetail(ps: ExplainPitch[], g: number, lg: LeagueExplain, t: Dict): string {
  const keys = GROUP_FEATS[g] ?? [];
  if (!keys.length) {
    const pts = [...new Set(scored(ps).map((p) => p.pt))];
    return pts.length === 1 ? t.explain.ptSelf(pts[0]) : t.explain.ptMix;
  }
  return keys
    .map((k) => {
      const r = featVsLeague(ps, k, lg);
      if (!r) return null;
      const info = FEAT_INFO[k];
      return t.explain.detailRef(t.feat[k], `${fmt(r.value, info.nd)}${info.unit}`, signed(r.diff, info.nd));
    })
    .filter(Boolean)
    .join(", ");
}

export interface Reason {
  g: number;
  name: string;
  value: number;
  detail: string;
}

/** 올린 요인 상위 k 개 / 깎은 요인 상위 k 개 (|기여| ≥ 0.3점만) */
export function topReasons(ps: ExplainPitch[], lg: LeagueExplain, t: Dict, k = 2): { up: Reason[]; down: Reason[] } {
  const m = meanContrib(ps, lg.groups.length);
  if (!m) return { up: [], down: [] };
  const names = groupNames(t, lg.groups);
  const rs = m.map((value, g) => ({ g, name: names[g], value, detail: "" }));
  const pick = (xs: Reason[]) => xs.slice(0, k).map((r) => ({ ...r, detail: groupDetail(ps, r.g, lg, t) }));
  return {
    up: pick(rs.filter((r) => r.value >= 0.3).sort((a, b) => b.value - a.value)),
    down: pick(rs.filter((r) => r.value <= -0.3).sort((a, b) => a.value - b.value)),
  };
}

/** 개별 투구 한 줄 근거 : 가장 크게 올린 요인과 깎은 요인 */
export function pitchOneLiner(p: ExplainPitch, groups: string[], t: Dict): string {
  if (!p.c) return t.common.unscored;
  const idx = p.c.map((v, g) => ({ v, g }));
  const up = [...idx].sort((a, b) => b.v - a.v)[0];
  const down = [...idx].sort((a, b) => a.v - b.v)[0];
  const parts = [];
  if (up.v >= 0.3) parts.push(`${groups[up.g]} ${signed(up.v, 1)}`);
  if (down.v <= -0.3) parts.push(`${groups[down.g]} ${signed(down.v, 1)}`);
  return parts.join(" · ") || t.explain.oneLinerNone;
}

/** 같은 구종 구성일 때 리그 평균 기여 (각 공을 자기 구종 리그 평균 기여로 바꿔 평균) */
export function mixReference(ps: ExplainPitch[], lg: LeagueExplain): number[] | null {
  const xs = scored(ps).filter((p) => lg.pitchTypes[p.pt]);
  if (!xs.length) return null;
  const m = new Array(lg.groups.length).fill(0);
  for (const p of xs) lg.pitchTypes[p.pt].contrib.forEach((v, j) => (m[j] += v));
  return m.map((v) => v / xs.length);
}

export { signed as fmtSigned };
