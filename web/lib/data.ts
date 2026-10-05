import type { League, Meta, Pitch, PitcherFile, SeasonIndex } from "./types";

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
    };
  });
  return { file, pitches };
}
