import type { ExplainFile, ExplainPitch, League, Meta, Pitch, PitcherFile, SeasonIndex, SeasonStats, SeasonSummary } from "./types";

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
export const loadIndex = (season: number) => getJSON<SeasonIndex>(`/data/${season}/index.json`);
export const loadLeague = (season: number) => getJSON<League>(`/data/${season}/league.json`);
export const loadSummary = (season: number) => getJSON<SeasonSummary>(`/data/${season}/summary.json`);
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

export async function loadPitches(season: number, id: number): Promise<{ file: PitcherFile; pitches: Pitch[] }> {
  const file = await getGzipJSON<PitcherFile>(`/data/${season}/p/${id}.json.gz`);
  const c = file.cols;
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
      s: c.s[i],
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

export const EXPLAIN_FEATS = ["v", "ivb", "hb", "spin", "axis", "vaa", "haa", "ext", "rz", "arm"] as const;

/** 설명 페이지 : 투수 파일 + 설명 파일을 합쳐 투구별 기여·원값을 붙인다 */
export async function loadExplainPitches(season: number, id: number): Promise<{ file: PitcherFile; pitches: ExplainPitch[] }> {
  const [{ file, pitches }, ex] = await Promise.all([loadPitches(season, id), getGzipJSON<ExplainFile>(`/data/${season}/e/${id}.json.gz`)]);
  if (ex.n !== pitches.length) throw new Error(`explain file pitch count mismatch (${ex.n} / ${pitches.length})`);
  const groups = Object.keys(ex.cols).filter((k) => /^c\d+$/.test(k)).length;
  return {
    file,
    pitches: pitches.map((p, i) => {
      const c0 = ex.cols.c0[i];
      const c = c0 === null ? null : Array.from({ length: groups }, (_, j) => (ex.cols[`c${j}`][i] as number) / 10);
      const f = Object.fromEntries(EXPLAIN_FEATS.map((k) => [k, ex.cols[k]?.[i] ?? null]));
      return { ...p, c, f };
    }),
  };
}
