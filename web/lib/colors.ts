"use client";
import { useEffect, useState } from "react";

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

/** 구위 색 도메인 : 30 이하 가장 옅게, 70 이상 가장 진하게 */
export const STUFF_DOMAIN: [number, number] = [30, 70];

export function sequential(t: number, dark: boolean) {
  return ramp(dark ? BLUE_DARK : BLUE, t);
}

/** 구위 마커 : 낮은 구위는 투명하게(옅게), 높은 구위는 불투명하게(진하게). 라이트 램프 300~700 / 다크 램프 450~150 */
export function stuffColor(s: number, dark: boolean) {
  const t = Math.min(1, Math.max(0, (s - STUFF_DOMAIN[0]) / (STUFF_DOMAIN[1] - STUFF_DOMAIN[0])));
  return dark ? ramp(BLUE_DARK, 0.3 + 0.55 * t) : ramp(BLUE, 0.33 + 0.67 * t);
}

export function stuffOpacity(s: number) {
  const t = Math.min(1, Math.max(0, (s - STUFF_DOMAIN[0]) / (STUFF_DOMAIN[1] - STUFF_DOMAIN[0])));
  return 0.18 + 0.82 * t;
}

export function useDarkMode() {
  const [dark, setDark] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  return dark;
}

/** 투수 구종 순서(구사율 순)대로 카테고리 슬롯 고정 -> 필터해도 색이 바뀌지 않는다 */
export function pitchColor(pitchTypes: string[], pt: string, dark: boolean) {
  const i = pitchTypes.indexOf(pt);
  const pal = dark ? CATEGORICAL.dark : CATEGORICAL.light;
  return i >= 0 && i < pal.length ? pal[i] : dark ? "#898781" : "#898781";
}

/** 타구 결과 색 (1루타 / 2·3루타 / 홈런). 아웃은 중립 회색(--muted). validate_palette 라이트·다크 통과
 *  라이트는 대비 WARN -> 결과마다 모양을 다르게 하고 범례·요약표를 함께 둔다 */
export const HIT_COLORS = {
  light: ["#2a78d6", "#eda100", "#e87ba4"],
  dark: ["#3987e5", "#c98500", "#d55181"],
};
export const hitColor = (cls: number, dark: boolean) => (cls === 0 ? "var(--muted)" : (dark ? HIT_COLORS.dark : HIT_COLORS.light)[cls - 1]);
