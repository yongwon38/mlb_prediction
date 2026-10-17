import type { ExplainFile, ExplainPitch, League, Meta, Pitch, PitcherFile, SeasonIndex, SeasonStats, SeasonSummary } from "./types";
import { getModel, MODEL_FIELD, modelSuffix, type ModelId } from "./model";

const cache = new Map<string, Promise<unknown>>();

function getJSON<T>(url: string): Promise<T> {
  if (!cache.has(url)) {
    const p = fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url} : ${r.status}`);
      return r.json();
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url) as Promise<T>;
}

export const loadMeta = () => getJSON<Meta>("/data/meta.json");
// 구위가 들어 있는 집계 파일은 모델별 (index.json / index.hof.json). 모델을 생략하면 현재 선택 모델
export const loadIndex = (season: number, m: ModelId = getModel()) => getJSON<SeasonIndex>(`/data/${season}/index${modelSuffix(m)}.json`);
export const loadLeague = (season: number, m: ModelId = getModel()) => getJSON<League>(`/data/${season}/league${modelSuffix(m)}.json`);
export const loadSummary = (season: number, m: ModelId = getModel()) => getJSON<SeasonSummary>(`/data/${season}/summary${modelSuffix(m)}.json`);
/** 공식 기록은 네트워크 실패 시 export 에서 생략될 수 있음 -> 없으면 null */
export const loadStats = (season: number) => getJSON<SeasonStats>(`/data/${season}/stats.json`).catch(() => null);

/** 투수별 파일은 .json.gz. 서버가 Content-Encoding 으로 이미 풀어 준 경우(gzip 매직넘버 없음)는 그대로 파싱 */
async function getGzipJSON<T>(url: string): Promise<T> {
  if (!cache.has(url)) {
    const p = (async () => {
      const r = await fetch(url);
      if (!r.ok) throw new Error(`${url} : ${r.status}`);
      const buf = new Uint8Array(await r.arrayBuffer());
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
        return JSON.parse(await new Response(stream).text());
      }
      return JSON.parse(new TextDecoder().decode(buf));
    })();
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return cache.get(url) as Promise<T>;
}

/** 투수 파일 하나에 두 모델의 점수가 함께 있다 (대체 모델은 접두사 필드 sh, 경기 sh·sh60, 타석 sh·shmax) -> 선택 모델 값을 s 로 */
export async function loadPitches(season: number, id: number, m: ModelId = getModel()): Promise<{ file: PitcherFile; pitches: Pitch[] }> {
  const raw = await getGzipJSON<PitcherFile>(`/data/${season}/p/${id}.json.gz`);
  const f = MODEL_FIELD[m];
  if (f && !raw.cols[`s${f}`]) throw new Error(`model ${m} : no scores in /data/${season}/p/${id}.json.gz`);
  const file: PitcherFile = f
    ? {
        ...raw,
        games: raw.games.map((g) => ({ ...g, s: g[`s${f}` as keyof typeof g] as number | null, s60: g[`s${f}60` as keyof typeof g] as number | null })),
        pas: raw.pas.map((p) => ({ ...p, s: p[`s${f}` as keyof typeof p] as number | null, smax: p[`s${f}max` as keyof typeof p] as number | null })),
      }
    : raw;
  const c = file.cols;
  const sc = c[`s${f}`];
  const base = new Date(file.d0 + "T00:00:00Z").getTime();
  const pitches: Pitch[] = c.s.map((_, i) => {
    const d = new Date(base + (c.day[i] as number) * 86400000);
    return {
      i,
      date: d.toISOString().slice(0, 10),
      month: d.getUTCMonth() + 1,
      day: c.day[i] as number,
      game: c.game[i] as number,
      gt: (c.gt?.[i] as number) ?? 0,
      pai: (c.pai?.[i] as number) ?? -1,
      pn: (c.pn?.[i] as number) ?? 0,
      wpa: c.wpa?.[i] ?? null,
      re: c.re?.[i] ?? null,
      gp: c.gp[i] as number,
      inn: c.inn[i] as number,
      team: file.teams[c.tm[i] as number],
      pt: file.pitchTypes[c.pt[i] as number],
      s: sc[i],
      x: c.x[i],
      z: c.z[i],
      zone: c.zone[i],
      r: c.r[i] as number,
      pa: c.pa[i] as number,
      lhb: c.st[i] === 1,
      b: c.b[i] as number,
      k: c.k[i] as number,
      sw: c.sw[i] === 1,
      wh: c.wh[i] === 1,
      v: c.v[i],
      hb: c.hb[i],
      ivb: c.ivb[i],
      spin: c.spin[i],
      ev: c.ev[i],
      la: c.la[i],
      xba: c.xba[i],
      xw: c.xw[i],
      hx: c.hx?.[i] ?? null,
      hy: c.hy?.[i] ?? null,
    };
  });
  return { file, pitches };
}

export const EXPLAIN_FEATS = ["v", "ivb", "hb", "spin", "axis", "vaa", "haa", "havaa", "hahaa", "ext", "rz", "arm"] as const;

/** 설명 페이지 : 투수 파일 + 설명 파일을 합쳐 투구별 기여·원값을 붙인다 */
export async function loadExplainPitches(season: number, id: number, m: ModelId = getModel()): Promise<{ file: PitcherFile; pitches: ExplainPitch[] }> {
  const [{ file, pitches }, ex] = await Promise.all([loadPitches(season, id, m), getGzipJSON<ExplainFile>(`/data/${season}/e/${id}.json.gz`)]);
  if (ex.n !== pitches.length) throw new Error(`explain file pitch count mismatch (${ex.n} / ${pitches.length})`);
  const pre = MODEL_FIELD[m] || "c"; // 기여 열 접두사 : 주 모델 c0.. / 대체 모델 h0..
  const groups = Object.keys(ex.cols).filter((k) => new RegExp(`^${pre}\\d+$`).test(k)).length;
  return {
    file,
    pitches: pitches.map((p, i) => {
      const c0 = ex.cols[`${pre}0`][i];
      const c = c0 === null ? null : Array.from({ length: groups }, (_, j) => (ex.cols[`${pre}${j}`][i] as number) / 10);
      const f = Object.fromEntries(EXPLAIN_FEATS.map((k) => [k, ex.cols[k]?.[i] ?? null]));
      return { ...p, c, f };
    }),
  };
}
