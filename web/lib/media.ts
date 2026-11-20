// 선수 사진 · 팀 로고 (MLB 공식 CDN). 정적 export 라 <img> 로 직접 불러온다

/** Statcast 구단 약어 -> MLB team id (별칭 포함) */
const TEAM_IDS: Record<string, number> = {
  LAA: 108, AZ: 109, ARI: 109, BAL: 110, BOS: 111, CHC: 112, CIN: 113, CLE: 114, COL: 115, DET: 116,
  HOU: 117, KC: 118, KCR: 118, LAD: 119, WSH: 120, WSN: 120, NYM: 121, ATH: 133, OAK: 133, PIT: 134,
  SD: 135, SDP: 135, SEA: 136, SF: 137, SFG: 137, STL: 138, TB: 139, TBR: 139, TEX: 140, TOR: 141,
  MIN: 142, PHI: 143, ATL: 144, CWS: 145, CHW: 145, MIA: 146, NYY: 147, MIL: 158,
};

export const teamId = (abbr: string): number | null => TEAM_IDS[abbr.toUpperCase()] ?? null;

/** 팀 로고 SVG. dark = 어두운 배경용 로고 */
export const teamLogoUrl = (abbr: string, dark = false): string | null => {
  const id = teamId(abbr);
  return id === null ? null : `https://www.mlbstatic.com/team-logos/${dark ? "team-cap-on-dark/" : ""}${id}.svg`;
};

/** 선수 헤드샷. 사진이 없으면 CDN 이 기본 실루엣으로 대체 (d_people:generic) */
export const headshotUrl = (playerId: number, px: number): string =>
  `https://img.mlbstatic.com/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_${Math.round(px)},q_auto:best/v1/people/${playerId}/headshot/67/current`;
