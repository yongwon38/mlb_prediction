import type { League, Pitch } from "./types";

// ---------------------------------------------------------------------------
// 라벨 / 분류
// ---------------------------------------------------------------------------
export const RESULT_LABELS = ["볼", "루킹 스트라이크", "헛스윙", "파울", "인플레이 아웃", "1루타", "2루타", "3루타", "홈런", "사구"];
export const PA_LABELS = ["", "아웃", "삼진", "1루타", "2루타", "3루타", "홈런", "볼넷", "사구", "희생타/기타"];

/** 스캐터 마커 모양용 결과 그룹 */
export type ResultGroup = "noncontact" | "out" | "hit";
export const resultGroup = (r: number): ResultGroup => (r >= 5 && r <= 8 ? "hit" : r === 4 ? "out" : "noncontact");

/** 결과 필터 칩 */
export const RESULT_FILTERS: { key: string; label: string; codes: number[] }[] = [
  { key: "ball", label: "볼·사구", codes: [0, 9] },
  { key: "called", label: "루킹 S", codes: [1] },
  { key: "whiff", label: "헛스윙", codes: [2] },
  { key: "foul", label: "파울", codes: [3] },
  { key: "out", label: "인플레이 아웃", codes: [4] },
  { key: "hit", label: "안타", codes: [5, 6, 7] },
  { key: "hr", label: "홈런", codes: [8] },
];

export const COUNT_STATES: { key: string; label: string; test: (p: Pitch) => boolean }[] = [
  { key: "first", label: "초구", test: (p) => p.b === 0 && p.k === 0 },
  { key: "ahead", label: "투수 유리", test: (p) => p.k > p.b },
  { key: "even", label: "동등", test: (p) => p.b === p.k && p.b > 0 },
  { key: "behind", label: "타자 유리", test: (p) => p.b > p.k },
  { key: "two", label: "2스트라이크", test: (p) => p.k === 2 },
];

export const STUFF_BUCKETS = [
  { label: "<40", lo: -Infinity, hi: 40 },
  { label: "40-45", lo: 40, hi: 45 },
  { label: "45-50", lo: 45, hi: 50 },
  { label: "50-55", lo: 50, hi: 55 },
  { label: "55-60", lo: 55, hi: 60 },
  { label: "60+", lo: 60, hi: Infinity },
];

/** 구위 구간 키 : STUFF_BUCKETS 라벨, 점수 없는 공(존 밖 볼)은 "none" */
export const BAND_NONE = "none";
export function bandOf(s: number | null): string {
  if (s === null) return BAND_NONE;
  return STUFF_BUCKETS.find((b) => s >= b.lo && s < b.hi)!.label;
}

// ---------------------------------------------------------------------------
// 타구 (스프레이)
// ---------------------------------------------------------------------------
/** 타구 결과 범주 : 0 아웃 / 1 1루타 / 2 2·3루타 / 3 홈런 */
export const HIT_CLASS_LABELS = ["아웃", "1루타", "2·3루타", "홈런"];
export const hitClass = (r: number) => (r === 5 ? 1 : r === 6 || r === 7 ? 2 : r === 8 ? 3 : 0);

/** 타구 방향 (deg) : 0 = 센터, 음수 = 3루 쪽, 양수 = 1루 쪽 */
export const sprayAngle = (p: Pitch) => (p.hx === null || p.hy === null ? null : (Math.atan2(p.hx, p.hy) * 180) / Math.PI);

/** 타자 손 기준 방향 : 우타는 3루 쪽, 좌타는 1루 쪽이 당겨친 타구 */
export function battedDir(p: Pitch): "pull" | "center" | "oppo" | null {
  const a = sprayAngle(p);
  if (a === null) return null;
  const toPull = p.lhb ? a : -a;
  return toPull > 15 ? "pull" : toPull < -15 ? "oppo" : "center";
}

/** 발사각 유형 */
export function laType(la: number | null): "gb" | "ld" | "fb" | "pu" | null {
  if (la === null) return null;
  return la < 10 ? "gb" : la < 25 ? "ld" : la <= 50 ? "fb" : "pu";
}

export interface BattedStats {
  n: number;
  ev: number | null;
  hardHit: number | null;
  ba: number | null;
  dir: Record<"pull" | "center" | "oppo", number | null>;
  la: Record<"gb" | "ld" | "fb" | "pu", number | null>;
}

/** 인플레이 타구 요약 (ps 는 인플레이 타구만) */
export function battedStats(ps: Pitch[]): BattedStats {
  const n = ps.length;
  const evs = ps.map((p) => p.ev).filter((v): v is number => v !== null);
  const dirs = ps.map(battedDir).filter((d) => d !== null);
  const las = ps.map((p) => laType(p.la)).filter((d) => d !== null);
  const share = <K extends string>(xs: K[], k: K) => (xs.length ? xs.filter((x) => x === k).length / xs.length : null);
  return {
    n,
    ev: evs.length ? evs.reduce((a, b) => a + b, 0) / evs.length : null,
    hardHit: evs.length ? evs.filter((v) => v >= 95).length / evs.length : null,
    ba: n ? ps.filter((p) => p.r >= 5 && p.r <= 8).length / n : null,
    dir: { pull: share(dirs, "pull"), center: share(dirs, "center"), oppo: share(dirs, "oppo") },
    la: { gb: share(las, "gb"), ld: share(las, "ld"), fb: share(las, "fb"), pu: share(las, "pu") },
  };
}

export const GAME_PITCH_BUCKETS = [
  { label: "1-25", lo: 1, hi: 25 },
  { label: "26-50", lo: 26, hi: 50 },
  { label: "51-75", lo: 51, hi: 75 },
  { label: "76-100", lo: 76, hi: 100 },
  { label: "101+", lo: 101, hi: Infinity },
];

// ---------------------------------------------------------------------------
// 지표
// ---------------------------------------------------------------------------
export interface Stats {
  n: number;
  stuff: number | null;
  ab: number;
  hits: number;
  ba: number | null;
  slg: number | null;
  swings: number;
  whiff: number | null;
  csw: number | null;
  zonePct: number | null;
  chase: number | null;
  xwoba: number | null;
  xwobacon: number | null;
  velo: number | null;
  ivb: number | null;
  hb: number | null;
  spin: number | null;
  k: number;
  bb: number;
  pa: number;
}

const mean = (xs: (number | null)[]) => {
  let s = 0;
  let n = 0;
  for (const x of xs) {
    if (x !== null && x !== undefined && !Number.isNaN(x)) {
      s += x;
      n++;
    }
  }
  return n ? s / n : null;
};

const TB: Record<number, number> = { 3: 1, 4: 2, 5: 3, 6: 4 };

export function stats(ps: Pitch[]): Stats {
  let ab = 0, hits = 0, tb = 0, swings = 0, whiffs = 0, csw = 0, inZone = 0, zoneKnown = 0;
  let outSw = 0, outN = 0, k = 0, bb = 0, pa = 0;
  for (const p of ps) {
    if (p.pa >= 1 && p.pa <= 6) ab++;
    if (p.pa >= 3 && p.pa <= 6) {
      hits++;
      tb += TB[p.pa];
    }
    if (p.pa > 0) pa++;
    if (p.pa === 2) k++;
    if (p.pa === 7) bb++;
    if (p.sw) swings++;
    if (p.wh) whiffs++;
    if (p.r === 1 || p.wh) csw++;
    if (p.zone !== null) {
      zoneKnown++;
      if (p.zone <= 9) inZone++;
      else {
        outN++;
        if (p.sw) outSw++;
      }
    }
  }
  const n = ps.length;
  return {
    n,
    stuff: mean(ps.map((p) => p.s)),
    ab,
    hits,
    ba: ab ? hits / ab : null,
    slg: ab ? tb / ab : null,
    swings,
    whiff: swings ? whiffs / swings : null,
    csw: n ? csw / n : null,
    zonePct: zoneKnown ? inZone / zoneKnown : null,
    chase: outN ? outSw / outN : null,
    xwoba: mean(ps.map((p) => p.xw)),
    xwobacon: mean(ps.filter((p) => p.r >= 4 && p.r <= 8).map((p) => p.xw)),
    velo: mean(ps.map((p) => p.v)),
    ivb: mean(ps.map((p) => p.ivb)),
    hb: mean(ps.map((p) => p.hb)),
    spin: mean(ps.map((p) => p.spin)),
    k,
    bb,
    pa,
  };
}

export function groupBy<T, K>(xs: T[], key: (x: T) => K): Map<K, T[]> {
  const m = new Map<K, T[]>();
  for (const x of xs) {
    const k = key(x);
    const arr = m.get(k);
    if (arr) arr.push(x);
    else m.set(k, [x]);
  }
  return m;
}

export function quantile(sorted: number[], q: number) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** 리그 분위수 배열(p1~p99) 기준 퍼센타일 (0~100) */
export function percentileOf(pcts: number[] | null | undefined, x: number | null) {
  if (!pcts || x === null) return null;
  let c = 0;
  for (const v of pcts) if (v <= x) c++;
  return c;
}

// ---------------------------------------------------------------------------
// 존
// ---------------------------------------------------------------------------
export const ZONE_HALF_WIDTH = 0.83; // 홈플레이트 17인치 / 2 + 공 반지름 근사 (ft)
export const ZONE_BOT = 1.5;
export const ZONE_TOP = 3.5;

/** 3×3 존 + 4개 바깥 영역(Statcast zone 11~14) 셀 정의 */
export const ZONE_CELLS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 14];

// ---------------------------------------------------------------------------
// 스카우팅 노트 (규칙 기반)
// ---------------------------------------------------------------------------
const f3 = (x: number | null) => (x === null ? "-" : x.toFixed(3).replace(/^0/, ""));
const pct = (x: number | null) => (x === null ? "-" : `${(x * 100).toFixed(1)}%`);
const ord = (p: number) => (p >= 50 ? `상위 ${100 - p}%` : `하위 ${p}%`);

export interface Note {
  tone: "good" | "bad" | "info";
  text: string;
}

export function scoutingNotes(ps: Pitch[], all: Pitch[], league: League, pitchTypes: string[], pitchNames: Record<string, string>): Note[] {
  const notes: Note[] = [];
  if (ps.length < 30) return [{ tone: "info", text: "선택한 조건의 투구가 30구 미만이라 노트를 만들지 않았습니다. 필터를 넓혀 보세요." }];

  const total = stats(ps);
  const overallPct = percentileOf(league.pitcherPercentiles, total.stuff);
  if (overallPct !== null) {
    notes.push({
      tone: overallPct >= 60 ? "good" : overallPct <= 40 ? "bad" : "info",
      text: `평균 구위 ${total.stuff!.toFixed(1)} — 리그 투수(${league.minPitcherPitches}구 이상) 중 ${ord(overallPct)}.${
        all.length < league.minPitcherPitches ? " 시즌 표본이 작아 해석에 주의." : ""
      }`,
    });
  }

  // 구종별 리그 동일 구종 대비 퍼센타일
  const byPt = groupBy(ps, (p) => p.pt);
  const ranked = pitchTypes
    .filter((pt) => (byPt.get(pt)?.length ?? 0) >= 40)
    .map((pt) => {
      const st = stats(byPt.get(pt)!);
      return { pt, st, pctl: percentileOf(league.pitchTypes[pt]?.pitcherPercentiles, st.stuff), usage: st.n / ps.length };
    })
    .filter((r) => r.pctl !== null) as { pt: string; st: Stats; pctl: number; usage: number }[];

  if (ranked.length) {
    const best = ranked.reduce((a, b) => (b.pctl > a.pctl ? b : a));
    const worst = ranked.reduce((a, b) => (b.pctl < a.pctl ? b : a));
    const nm = (pt: string) => `${pitchNames[pt] ?? pt}(${pt})`;
    notes.push({
      tone: "good",
      text: `최고 구종 ${nm(best.pt)} : 구위 ${best.st.stuff!.toFixed(1)}, 리그 동일 구종 ${ord(best.pctl)}. Whiff ${pct(best.st.whiff)}, 구사율 ${pct(best.usage)}${
        best.usage < 0.15 && best.pctl >= 70 ? " — 구사율을 늘릴 여지가 있음" : ""
      }.`,
    });
    if (worst.pt !== best.pt && worst.pctl <= 40) {
      notes.push({
        tone: "bad",
        text: `약점 구종 ${nm(worst.pt)} : 리그 동일 구종 ${ord(worst.pctl)}, 피안타율 ${f3(worst.st.ba)}, xwOBAcon ${f3(worst.st.xwobacon)}${
          worst.usage >= 0.3 ? ` — 구사율 ${pct(worst.usage)}로 의존도가 높아 리스크` : ""
        }.`,
      });
    }
  }

  // 코스 : 피안타율 최고 존 / 헛스윙 최고 존
  const byZone = groupBy(ps.filter((p) => p.zone !== null && p.zone <= 9), (p) => p.zone as number);
  const zoneName = (z: number) => {
    const row = ["상단", "중단", "하단"][Math.floor((z - 1) / 3)];
    const col = ["3루쪽", "가운데", "1루쪽"][(z - 1) % 3];
    return z === 5 ? "한가운데" : `${row} ${col}`;
  };
  const zoneStats = [...byZone.entries()].map(([z, g]) => ({ z, st: stats(g) }));
  const hot = zoneStats.filter((r) => r.st.ab >= 15 && r.st.ba !== null).sort((a, b) => b.st.ba! - a.st.ba!)[0];
  if (hot && hot.st.ba! >= (league.overall.ba ?? 0.245) + 0.04) {
    notes.push({ tone: "bad", text: `${zoneName(hot.z)} 코스 피안타율 ${f3(hot.st.ba)} (${hot.st.hits}/${hot.st.ab}) — 이 코스로 몰리는 공을 줄여야 함 (포수 시점).` });
  }
  const whiffZone = zoneStats.filter((r) => r.st.swings >= 20 && r.st.whiff !== null).sort((a, b) => b.st.whiff! - a.st.whiff!)[0];
  if (whiffZone) {
    notes.push({ tone: "good", text: `존 안 헛스윙 최다 코스는 ${zoneName(whiffZone.z)} : Whiff ${pct(whiffZone.st.whiff)} (스윙 ${whiffZone.st.swings}회).` });
  }
  if (total.chase !== null) {
    const lgChase = 0.29;
    notes.push({
      tone: total.chase >= lgChase + 0.03 ? "good" : total.chase <= lgChase - 0.03 ? "bad" : "info",
      text: `존 밖 공 스윙 유도(Chase) ${pct(total.chase)}, 존 투구 비율 ${pct(total.zonePct)}.`,
    });
  }

  // 좌우 스플릿
  const vsL = stats(ps.filter((p) => p.lhb));
  const vsR = stats(ps.filter((p) => !p.lhb));
  if (vsL.pa >= 40 && vsR.pa >= 40 && vsL.xwoba !== null && vsR.xwoba !== null) {
    const diff = vsL.xwoba - vsR.xwoba;
    if (Math.abs(diff) >= 0.03) {
      notes.push({
        tone: "bad",
        text: `${diff > 0 ? "좌타자" : "우타자"} 상대로 약함 : 피xwOBA 좌 ${f3(vsL.xwoba)} / 우 ${f3(vsR.xwoba)}. 상대 타순 좌우 구성에 따라 매치업 관리 필요.`,
      });
    } else {
      notes.push({ tone: "info", text: `좌우 스플릿 차이 작음 : 피xwOBA 좌 ${f3(vsL.xwoba)} / 우 ${f3(vsR.xwoba)}.` });
    }
  }

  // 2스트라이크 결정구
  const two = ps.filter((p) => p.k === 2);
  if (two.length >= 40) {
    const g = [...groupBy(two, (p) => p.pt).entries()].sort((a, b) => b[1].length - a[1].length)[0];
    const st = stats(g[1]);
    notes.push({
      tone: "info",
      text: `2스트라이크 결정구는 ${pitchNames[g[0]] ?? g[0]} (구사율 ${pct(g[1].length / two.length)}, Whiff ${pct(st.whiff)}, 구위 ${st.stuff?.toFixed(1)}).`,
    });
  }

  // 피로도 : 경기 내 1~25구 vs 76구 이후 (주 구종 기준)
  const fb = pitchTypes[0];
  const early = ps.filter((p) => p.pt === fb && p.gp <= 25);
  const late = ps.filter((p) => p.pt === fb && p.gp >= 76);
  if (early.length >= 40 && late.length >= 40) {
    const e = stats(early), l = stats(late);
    const ds = l.stuff! - e.stuff!;
    const dv = (l.velo ?? 0) - (e.velo ?? 0);
    notes.push({
      tone: ds <= -2 ? "bad" : "info",
      text: `${fb} 경기 내 1~25구 → 76구 이후 : 구위 ${e.stuff!.toFixed(1)} → ${l.stuff!.toFixed(1)} (${ds >= 0 ? "+" : ""}${ds.toFixed(1)}), 구속 ${dv >= 0 ? "+" : ""}${dv.toFixed(1)} mph.${
        ds <= -2 ? " 후반 구위 저하가 뚜렷해 교체 타이밍 지표로 활용 가능." : ""
      }`,
    });
  }

  // 시즌 추이 : 첫 달 vs 마지막 달
  const months = [...groupBy(ps, (p) => p.month).entries()].filter(([, g]) => g.length >= 100).sort((a, b) => a[0] - b[0]);
  if (months.length >= 2) {
    const a = stats(months[0][1]).stuff!, b = stats(months[months.length - 1][1]).stuff!;
    if (Math.abs(b - a) >= 1.5) {
      notes.push({
        tone: b > a ? "good" : "bad",
        text: `시즌 추이 : ${months[0][0]}월 평균 구위 ${a.toFixed(1)} → ${months[months.length - 1][0]}월 ${b.toFixed(1)} (${b > a ? "상승" : "하락"}).`,
      });
    }
  }
  return notes;
}
