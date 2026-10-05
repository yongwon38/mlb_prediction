export interface Meta {
  seasons: number[];
  resultLabels: string[];
  paEvents: string[];
  pitchNames: Record<string, string>;
  trainSeason: number;
}

export interface PitcherEntry {
  id: number;
  name: string;
  throws: "L" | "R";
  teams: string[];
  n: number;
  stuff: number | null; // 점수 있는 투구가 없으면 null
}

export interface SeasonIndex {
  season: number;
  outOfSample: boolean;
  validStart: string | null;
  seasonStart: string;
  seasonEnd: string;
  pitches: number;
  teams: Record<"AL" | "NL", Record<string, string>>;
  pitchers: PitcherEntry[];
}

export interface Rates {
  n: number;
  ba: number | null;
  slg: number | null;
  whiff: number | null;
  csw: number | null;
  xwobacon: number | null;
  xwoba: number | null;
}

export interface LeaguePitchType extends Rates {
  name: string;
  pitchQuantiles: number[]; // p5, p25, p50, p75, p95 (투구 단위)
  pitcherPercentiles: number[] | null; // 투수×구종 평균의 1~99 분위수
  velo: number;
}

export interface League {
  pitcherPercentiles: number[];
  minPitcherPitches: number;
  minPitchTypePitches: number;
  overall: Rates;
  pitchTypes: Record<string, LeaguePitchType>;
  stuffBins: number[];
  buckets: (Rates & { label: string })[];
  bucketsValid: (Rates & { label: string })[] | null;
  explain?: LeagueExplain;
}

/** 구위 산출 근거 : 리그 기준 */
export interface LeagueExplain {
  method?: "shap" | "saabas"; // 기여 계산 방법
  base: number; // 기준 점수 S0 (모든 요인 기여가 0 일 때의 구위)
  groups: string[]; // 요인 그룹 이름
  groupFeatures: string[][];
  overall: number[]; // 리그 전체 평균 그룹 기여
  pitchTypes: Record<string, { n: number; feat: Record<string, number>; contrib: number[] }>;
}

/** 설명 페이지 전용 투수 파일 (투수 파일과 같은 투구 순서) */
export interface ExplainFile {
  id: number;
  n: number;
  cols: Record<string, (number | null)[]>;
}

/** 투구 + 요인 기여 (점, 점수 없는 공은 null) + 근거용 원값 (우투 기준) */
export interface ExplainPitch extends Pitch {
  c: number[] | null;
  f: Record<string, number | null>;
}

export interface PitcherFile {
  id: number;
  name: string;
  throws: "L" | "R";
  teams: string[];
  pitchTypes: string[];
  d0: string;
  cols: Record<string, (number | null)[]>;
}

/** 투구 1개 (JSON 컬럼형 배열을 펼친 형태) */
export interface Pitch {
  i: number;
  date: string;
  month: number;
  day: number;
  game: number;
  gp: number; // 경기 내 투구 순번
  inn: number;
  team: string;
  pt: string;
  s: number | null; // 구위 score 20~80 (존에서 크게 벗어난 볼은 null : 점수 제외)
  x: number | null; // plate_x (포수 시점, ft)
  z: number | null; // 존 높이 정규화 plate_z (ft)
  zone: number | null;
  r: number; // 투구 결과 코드
  pa: number; // 타석 종료 이벤트 코드
  lhb: boolean;
  b: number;
  k: number;
  sw: boolean;
  wh: boolean;
  v: number | null;
  hb: number | null;
  ivb: number | null;
  spin: number | null;
  ev: number | null;
  la: number | null;
  xba: number | null;
  xw: number | null;
  hx: number | null; // 타구 좌표 (ft, 홈 = 0,0 / +x = 1루 쪽)
  hy: number | null;
}
