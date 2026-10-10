export interface Meta {
  seasons: number[];
  resultLabels: string[];
  paEvents: string[];
  pitchNames: Record<string, string>;
  trainSeason: number;
  gameTypes: string[]; // 경기 유형 이름 (0 정규시즌 / 1 포스트시즌 / 2 시범경기)
  rounds: Record<string, string>; // Statcast game_type -> 라운드 이름
  importanceWeight: Record<string, number>;
}

export interface PitcherEntry {
  id: number;
  name: string;
  throws: "L" | "R";
  teams: string[];
  n: number; // 정규시즌 투구 수
  stuff: number | null; // 정규시즌 평균 구위 (점수 있는 투구가 없으면 null)
  byGt: ([number, number | null] | null)[]; // 경기 유형별 [투구 수, 평균 구위]
}

export interface SeasonIndex {
  season: number;
  outOfSample: boolean;
  validStart: string | null;
  seasonStart: string;
  seasonEnd: string; // 전체 데이터 마지막 날 (= 데이터 기준일)
  regularStart: string;
  regularEnd: string;
  pitches: number; // 정규시즌 투구 수
  gameTypes: number[]; // 경기 유형별 투구 수
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
  base: number; // 기준 점수 S0 (모든 요인 기여가 0 일 때의 구위)
  groups: string[]; // 요인 그룹 이름
  groupFeatures: string[][];
  overall: number[]; // 리그 전체 평균 그룹 기여
  pitchTypes: Record<string, { n: number; feat: Record<string, number | null>; contrib: number[] }>;
  method?: "shap" | "saabas"; // 기여 계산 방법
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
  batters: [number, string][]; // 타자 [id, 이름]
  games: GameRow[];
  pas: PaRow[];
  cols: Record<string, (number | null)[]>;
}

/** 투수 1명의 경기 1개 */
export interface GameRow {
  pk: number; // MLB game_pk
  date: string;
  gt: number; // 0 정규 / 1 포스트 / 2 시범
  rd: string; // Statcast game_type (R, S, F, D, L, W)
  team: string;
  opp: string;
  home: number;
  rs: number | null; // 최종 득점 (투수 팀)
  ra: number | null; // 최종 실점
  st: number; // 선발 여부
  n: number; // 투구 수
  outs: number; // 잡은 아웃 (Statcast 이벤트 기준 추정)
  h: number;
  bb: number;
  k: number;
  hr: number;
  r: number; // 등판 중 실점
  s: number | null; // 평균 구위
  s60: number | null; // 60+ 비율
  wpa: number; // 투수 관점 WPA 합
  imp: number; // 승부 영향 = 타석 |WPA| 합 x 유형 가중치
  i0: number; // 첫 투구 위치
  pa0: number; // 첫 타석 위치
  npa: number;
}

/** 투수 1명의 타석 1개 */
export interface PaRow {
  g: number; // 경기 인덱스
  ab: number;
  inn: number;
  o: number | null; // 타석 시작 아웃
  on: number; // 주자 bitmask (1루 1, 2루 2, 3루 4)
  sc: number | null; // 투수 팀 - 상대 점수차
  bat: number; // batters 인덱스
  lhb: number;
  ev: number; // 타석 종료 이벤트 (0 = 이 투수가 끝내지 않음)
  des: string | null;
  wpa: number | null;
  re: number | null;
  runs: number;
  n: number;
  i0: number;
  s: number | null;
  smax: number | null;
}

/** 리그 경기·타석 목록 (요약 페이지) : 투수 정보 포함 */
export type LeagueGameRow = GameRow & { pid: number; name: string; gi: number };
export type LeaguePaRow = Omit<PaRow, "bat"> & { bat: number; pid: number; name: string; pai: number; gt: number; date: string; opp: string; team: string; batName: string };

export interface SeasonSummaryGt {
  pitches: number;
  pitchers: number;
  games: number;
  stuff: number;
  rates: Rates;
  buckets: (Rates & { label: string })[];
  minPitches: number;
  leaders: { id: number; name: string; teams: string[]; n: number; stuff: number }[];
  impGames: LeagueGameRow[];
  stuffGames: LeagueGameRow[];
  impPas: LeaguePaRow[];
}

export interface SeasonSummary {
  byGt: Record<string, SeasonSummaryGt>;
}

/** MLB 공식 기록 (카운팅 스탯) */
export interface StatLine {
  G: number; GS: number; W: number; L: number; SV: number; HLD: number; BS: number;
  outs: number; R: number; ER: number; H: number; HR: number; BB: number; IBB: number; HBP: number; K: number; BF: number; AB: number; NP: number;
}
export interface SeasonStats {
  asOf: string;
  fip: Record<string, number>; // 유형(R/P/S)별 FIP 상수
  players: Record<string, Partial<Record<"R" | "P" | "S", StatLine>>>;
}

/** 투구 1개 (JSON 컬럼형 배열을 펼친 형태) */
export interface Pitch {
  i: number;
  date: string;
  month: number;
  day: number;
  game: number; // 투수 파일 games 인덱스
  gt: number; // 경기 유형
  pai: number; // 투수 파일 pas 인덱스
  pn: number; // 타석 내 투구 순번
  wpa: number | null; // 투수 관점 승리확률 변화
  re: number | null; // 투수 관점 기대득점 변화
  gp: number; // 경기 내 투구 순번
  inn: number;
  team: string;
  pt: string;
  s: number | null; // 구위 score 20~80 (존에서 크게 벗어난 볼·사구는 null : 점수 제외)
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
