"use client";

// 데이터 시각화 팔레트 (dataviz 기준 팔레트 : 카테고리 8색 고정 순서, 단일 색상 순차 램프)
export const CATEGORICAL = {
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"],
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
};

// 파랑 순차 램프 (100 -> 700). 라이트 : 옅음 = 낮은 값, 다크 : 표면에 가까운 어두운 색 = 낮은 값
const BLUE = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281", "#0d366b"];
const BLUE_DARK = ["#183150", "#184f95", "#1c5cab", "#256abf", "#2a78d6", "#3987e5", "#5598e7", "#6da7ec", "#86b6ef", "#9ec5f4", "#b7d3f6", "#cde2fb", "#e6f0fd"];

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

function ramp(stops: string[], t: number) {
  t = Math.min(1, Math.max(0, t));
  const pos = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(pos));
  const f = pos - i;
  const a = hex(stops[i]);
  const b = hex(stops[i + 1]);
  return `rgb(${a.map((v, k) => Math.round(v + (b[k] - v) * f)).join(",")})`;
}

// 구위 diverging 램프 (파랑 = 낮음 -> 회색 = 리그 평균 50 -> 빨강 = 높음). 도메인 30~70 의 가운데가 50
const STUFF_LIGHT = ["#1f5fb4", "#4f8ad4", "#9bb8da", "#bdbbb4", "#eba487", "#df5f3f", "#b3221a"];
const STUFF_DARK = ["#4b93ea", "#5b86bd", "#6e7f96", "#7d7c78", "#c4775a", "#ec5b3f", "#ff4a3a"];

/** 구위 색 도메인 : 30 이하 가장 진한 파랑, 50 회색, 70 이상 가장 진한 빨강 */
export const STUFF_DOMAIN: [number, number] = [30, 70];

export function sequential(t: number, dark: boolean) {
  return ramp(dark ? BLUE_DARK : BLUE, t);
}

const stuffT = (s: number) => Math.min(1, Math.max(0, (s - STUFF_DOMAIN[0]) / (STUFF_DOMAIN[1] - STUFF_DOMAIN[0])));

/** 구위 색 : 낮은 구위 = 파랑, 평균 = 회색, 높은 구위 = 빨강 */
export function stuffColor(s: number, dark: boolean) {
  return ramp(dark ? STUFF_DARK : STUFF_LIGHT, stuffT(s));
}

/** 구위 램프 직접 접근 (t = 0~1, 0.5 = 평균). 히트맵처럼 도메인을 따로 쓰는 곳용 */
export function stuffRamp(t: number, dark: boolean) {
  return ramp(dark ? STUFF_DARK : STUFF_LIGHT, t);
}

/** 구위 마커 불투명도 : 평균 근처 0.5 -> 양 끝 1 (평균에서 먼 공이 눈에 띄게) */
export function stuffOpacity(s: number) {
  return 0.5 + 0.5 * Math.abs(2 * stuffT(s) - 1);
}

/** 배경색(rgb(...) 또는 #hex) 위에 올릴 글자색 : 휘도 기준 검정/흰색 */
export function inkOn(bg: string) {
  const v = bg.startsWith("#") ? hex(bg) : bg.slice(bg.indexOf("(") + 1, -1).split(",").map(Number);
  const l = (0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2]) / 255;
  return l > 0.55 ? "#111110" : "#ffffff";
}

/** 구위 배지 배경 : 램프 색을 반투명으로 */
export function stuffTint(s: number, dark: boolean, alpha = 0.16) {
  return stuffColor(s, dark).replace("rgb(", "rgba(").replace(")", `,${alpha})`);
}

export { useDarkMode } from "./theme";

/** 투수 구종 순서(구사율 순)대로 카테고리 슬롯 고정 -> 필터해도 색이 바뀌지 않는다 */
export function pitchColor(pitchTypes: string[], pt: string, dark: boolean) {
  const i = pitchTypes.indexOf(pt);
  const pal = dark ? CATEGORICAL.dark : CATEGORICAL.light;
  return i >= 0 && i < pal.length ? pal[i] : dark ? "#898781" : "#898781";
}

/** 타구 결과 색 (아웃 / 1루타 / 2·3루타 / 홈런). validate_palette 라이트·다크 4색 PASS
 *  라이트는 대비 WARN -> 결과마다 기호를 다르게 하고 범례·요약표를 함께 둔다 */
export const HIT_COLORS = {
  light: ["#1baf7a", "#2a78d6", "#eda100", "#e87ba4"],
  dark: ["#199e70", "#3987e5", "#c98500", "#d55181"],
};
export const hitColor = (cls: number, dark: boolean) => (dark ? HIT_COLORS.dark : HIT_COLORS.light)[cls];

/** 기여도 diverging : + (구위를 올림) = 빨강 / − (깎음) = 파랑 / 0 = 회색. 양 극 validate_palette 라이트·다크 PASS */
const DIV = {
  light: { neg: "#2a78d6", mid: "#f0efec", pos: "#e34948" },
  dark: { neg: "#3987e5", mid: "#383835", pos: "#e66767" },
};

/** v 를 [-dom, dom] 으로 보고 회색 -> 극 색으로 보간. ink 는 셀 위 글자색 */
export function divergingColor(v: number, dom: number, dark: boolean) {
  const p = dark ? DIV.dark : DIV.light;
  const t = Math.min(1, Math.abs(v) / dom);
  const fill = ramp([p.mid, v >= 0 ? p.pos : p.neg], t);
  const ink = dark ? (t > 0.7 ? "#0b0b0b" : "#e8e6e1") : t > 0.65 ? "#ffffff" : "#1a1a19";
  return { fill, ink };
}

export const divergingPole = (positive: boolean, dark: boolean) => (dark ? DIV.dark : DIV.light)[positive ? "pos" : "neg"];
