import type { GameRow, Meta, PaRow, PitcherFile } from "./types";
import { PA_LABELS } from "./analysis";

/** 주자 bitmask -> "1·3루" / "주자 없음" / "만루" */
export function runnersText(on: number) {
  if (on === 7) return "만루";
  const xs = [1, 2, 3].filter((b) => on & (1 << (b - 1)));
  return xs.length ? `${xs.join("·")}루` : "주자 없음";
}

export const ipText = (outs: number) => `${Math.floor(outs / 3)}.${outs % 3}`;

export const signedPct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "-" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);

/** 경기 라벨 : "2026-06-19 vs CWS (정규시즌)" */
export function gameLabel(g: GameRow, meta: Meta | null, withType = true) {
  const rd = meta?.rounds[g.rd] ?? g.rd;
  return `${g.date} ${g.home ? "vs" : "@"} ${g.opp}${withType && g.rd !== "R" ? ` · ${rd}` : ""}`;
}

/** 경기 결과 : "W 4-3" */
export function scoreText(g: GameRow) {
  if (g.rs === null || g.ra === null) return "-";
  return `${g.rs > g.ra ? "승" : g.rs < g.ra ? "패" : "무"} ${g.rs}-${g.ra}`;
}

export function paResult(pa: PaRow) {
  return pa.ev === 0 ? "교체(타석 중)" : PA_LABELS[pa.ev];
}

export const batterName = (file: PitcherFile, pa: PaRow) => file.batters[pa.bat]?.[1] ?? "-";

/** 타석 상황 : "7회 2사 1·3루, 1점 리드" */
export function situation(pa: PaRow) {
  const sc = pa.sc === null ? "" : pa.sc > 0 ? `, ${pa.sc}점 리드` : pa.sc < 0 ? `, ${-pa.sc}점 열세` : ", 동점";
  return `${pa.inn}회 ${pa.o ?? "-"}사 ${runnersText(pa.on)}${sc}`;
}
