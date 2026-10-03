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
  stuff: number;
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
  s: number; // 구위 score 20~80
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
}
