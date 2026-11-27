// ---------------------------------------------------------------------------
// 구위 시뮬레이터 상태 : 시작점(리그 중앙값 / 투수×구종 평균) -> 편집 입력 -> 모델 입력 행
// 값은 모델 입력 기준 (좌투는 좌우 성분 반전 = 우투 기준, 무브먼트 inch). 구종은 모델 입력이 아니라 시작점·범위만 고른다 (v4 와 같은 14개 입력)
// ---------------------------------------------------------------------------
import type { PitchInput } from "./hofnet";
import type { SimStarts } from "./types";

/** 슬라이더로 바꾸는 입력 (화면 순서). 구속·무브먼트 차이는 주 패스트볼 입력에서 계산 */
export const SIM_INPUTS = [
  "release_speed",
  "pfx_z",
  "pfx_x",
  "release_spin_rate",
  "spin_axis",
  "vaa_aa",
  "release_extension",
  "release_pos_z",
  "release_pos_x",
  "arm_angle",
] as const;

/** 주 패스트볼 기준 (차이 = 이 공 − 주 패스트볼) */
export const FB_INPUTS = ["fb_velo", "fb_hb", "fb_ivb"] as const;
const DIFF_OF = { velo_diff: ["release_speed", "fb_velo"], hb_diff: ["pfx_x", "fb_hb"], ivb_diff: ["pfx_z", "fb_ivb"] } as const;
export const DIFF_COLS = Object.keys(DIFF_OF) as (keyof typeof DIFF_OF)[];

export type SimInputKey = (typeof SIM_INPUTS)[number] | (typeof FB_INPUTS)[number];

/** 단위·표시 자릿수·슬라이더 간격 */
export const FEAT_FMT: Record<string, { unit: string; nd: number; step: number }> = {
  release_speed: { unit: " mph", nd: 1, step: 0.1 },
  pfx_z: { unit: " in", nd: 1, step: 0.1 },
  pfx_x: { unit: " in", nd: 1, step: 0.1 },
  release_spin_rate: { unit: " rpm", nd: 0, step: 10 },
  spin_axis: { unit: "°", nd: 0, step: 1 },
  vaa_aa: { unit: "°", nd: 3, step: 0.005 },
  release_extension: { unit: " ft", nd: 2, step: 0.05 },
  release_pos_z: { unit: " ft", nd: 2, step: 0.05 },
  release_pos_x: { unit: " ft", nd: 2, step: 0.05 },
  arm_angle: { unit: "°", nd: 1, step: 0.1 }, // 모델이 민감 (0.5° 반올림에 구위 최대 0.7점) -> Statcast 정밀도 그대로
  velo_diff: { unit: " mph", nd: 1, step: 0.1 },
  hb_diff: { unit: " in", nd: 1, step: 0.1 },
  ivb_diff: { unit: " in", nd: 1, step: 0.1 },
  fb_velo: { unit: " mph", nd: 1, step: 0.1 },
  fb_hb: { unit: " in", nd: 1, step: 0.1 },
  fb_ivb: { unit: " in", nd: 1, step: 0.1 },
};

export const fmtFeat = (k: string, v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? "-" : `${v.toFixed(FEAT_FMT[k]?.nd ?? 2)}${FEAT_FMT[k]?.unit ?? ""}`);

export interface SimState {
  values: Record<SimInputKey, number>;
  /** 이 공이 주 패스트볼 : 차이 3개 = 0 (구속을 바꾸면 기준도 같이 바뀜) */
  primary: boolean;
  hand: "L" | "R";
}

export type StartSource = { kind: "league"; pt: string } | { kind: "pitcher"; pt: string; id: string };

const col = (st: SimStarts, k: string) => st.cols.indexOf(k);

/** 시작점 -> 상태. 투수에 그 구종이 없으면 null */
export function startState(st: SimStarts, src: StartSource, hand?: "L" | "R"): SimState | null {
  let x: (number | null)[];
  let fb: (number | null)[];
  let h: "L" | "R" = hand ?? "R";
  if (src.kind === "pitcher") {
    const p = st.pitchers[src.id];
    const t = p?.types[src.pt];
    if (!p || !t) return null;
    x = t.x;
    fb = p.fb;
    h = hand ?? (p.hand === "L" ? "L" : "R");
  } else {
    const L = st.league[src.pt];
    if (!L) return null;
    x = L.med;
    // 리그 시작점의 차이 = 구종 중앙값 차이가 되도록 기준을 역산
    fb = DIFF_COLS.map((d) => {
      const [a] = DIFF_OF[d];
      const xa = x[col(st, a)], xd = x[col(st, d)];
      return xa === null || xd === null ? null : xa - xd;
    });
  }
  const values = {} as Record<SimInputKey, number>;
  for (const k of SIM_INPUTS) values[k] = x[col(st, k)] ?? NaN;
  FB_INPUTS.forEach((k, i) => (values[k] = fb[i] ?? NaN));
  const diffs = DIFF_COLS.map((d) => x[col(st, d)]);
  // 주 패스트볼 기준은 정규시즌 전체 투구 평균, 시작점은 점수 대상 투구 평균이라 소폭 다름 -> 0.5 이내면 주 패스트볼
  const primary = src.kind === "pitcher" && diffs.every((v) => v !== null && Math.abs(v) < 0.5);
  return { values, primary, hand: h };
}

/** 상태 -> 모델 입력 행 (hofnet.predict). 구종은 모델에 쓰이지 않지만 기록용으로 넣는다 */
export function toRow(s: SimState, pt: string): PitchInput {
  const v = s.values;
  const row: PitchInput = { pitch_type: pt, p_throws: s.hand };
  for (const k of SIM_INPUTS) row[k] = v[k];
  for (const d of DIFF_COLS) {
    const [a, b] = DIFF_OF[d];
    row[d] = s.primary ? 0 : v[a] - v[b];
  }
  return row;
}

const FB_COL: Record<string, string> = { fb_velo: "release_speed", fb_hb: "pfx_x", fb_ivb: "pfx_z" };
const FASTBALLS = ["FF", "SI", "FC"];

/** 리그 구종의 1–99 분위 범위 (슬라이더·반응 곡선). 주 패스트볼 입력은 FF·SI·FC 범위의 합 */
export function rangeOf(st: SimStarts, pt: string, k: string): [number, number] | null {
  const c = FB_COL[k] ?? k;
  const i = col(st, c);
  if (i < 0) return null;
  const rs = (FB_COL[k] ? FASTBALLS : [pt])
    .map((p) => st.league[p])
    .filter((L) => L && L.lo[i] !== null && L.hi[i] !== null)
    .map((L) => [L.lo[i] as number, L.hi[i] as number]);
  return rs.length ? [Math.min(...rs.map((r) => r[0])), Math.max(...rs.map((r) => r[1]))] : null;
}

export const outOfRange = (r: [number, number] | null, v: number) => !!r && Number.isFinite(v) && (v < r[0] || v > r[1]);
