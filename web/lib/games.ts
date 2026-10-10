import type { GameRow, PaRow, PitcherFile } from "./types";
import type { Dict } from "./i18n/ko";

/** 주자 bitmask -> "1·3루" / "주자 없음" / "만루" */
export function runnersText(on: number, t: Dict) {
  if (on === 7) return t.game.loaded;
  const xs = [1, 2, 3].filter((b) => on & (1 << (b - 1)));
  return xs.length ? t.game.runners(xs) : t.game.empty;
}

export const ipText = (outs: number) => `${Math.floor(outs / 3)}.${outs % 3}`;

export const signedPct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "-" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(d)}%`);

/** 경기 라벨 : "2026-06-19 vs CWS · 디비전시리즈" */
export function gameLabel(g: GameRow, t: Dict, withType = true) {
  const rd = t.rounds[g.rd] ?? g.rd;
  return `${g.date} ${g.home ? "vs" : "@"} ${g.opp}${withType && g.rd !== "R" ? ` · ${rd}` : ""}`;
}

/** 경기 결과 : "승 4-3" / "W 4-3" */
export function scoreText(g: GameRow, t: Dict) {
  if (g.rs === null || g.ra === null) return "-";
  return t.game.score(g.rs, g.ra);
}

export function paResult(pa: PaRow, t: Dict) {
  return pa.ev === 0 ? t.game.removed : t.paEvents[pa.ev];
}

export const batterName = (file: PitcherFile, pa: PaRow) => file.batters[pa.bat]?.[1] ?? "-";

/** 타석 상황 : "7회 2사 1·3루, 1점 앞섬" */
export function situation(pa: PaRow, t: Dict) {
  const sc = pa.sc === null ? "" : t.game.lead(pa.sc);
  return t.game.situation(pa.inn, pa.o, runnersText(pa.on, t), sc);
}
