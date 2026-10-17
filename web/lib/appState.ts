"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { loadIndex, loadLeague, loadMeta, loadPitches } from "./data";
import { DEFAULT_MODEL, getModel, parseModel, setModel, useModel, type ModelId } from "./model";
import type { League, Meta, Pitch, PitcherFile, SeasonIndex } from "./types";

// ---------------------------------------------------------------------------
// 페이지 간 공통 맥락 (시즌·투수·경기 유형) : 상단 내비가 현재 맥락을 유지한 채 이동하도록
// ---------------------------------------------------------------------------
export interface NavCtx {
  season: number | null;
  pitcher: number | null;
  gt: number[];
}

export const DEFAULT_GT = [0];
let ctx: NavCtx = { season: null, pitcher: null, gt: DEFAULT_GT };
const listeners = new Set<() => void>();

function setNavCtx(next: NavCtx) {
  if (next.season === ctx.season && next.pitcher === ctx.pitcher && next.gt.join() === ctx.gt.join()) return;
  ctx = next;
  listeners.forEach((l) => l());
}

export function useNavCtx(): NavCtx {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => ctx,
    () => ctx,
  );
}

/** 맥락을 쿼리 문자열로 (extra 는 페이지 고유 키). 구위 모델은 현재 선택이 기본(lgbm)이 아닐 때만 model= 로 붙는다 */
export function ctxHref(path: string, c: Partial<NavCtx>, extra: Record<string, string | number | null | undefined> = {}) {
  const q = new URLSearchParams();
  if (c.season) q.set("season", String(c.season));
  if (c.pitcher) q.set("pitcher", String(c.pitcher));
  if (c.gt && c.gt.join() !== DEFAULT_GT.join()) q.set("gt", c.gt.join(","));
  if (getModel() !== DEFAULT_MODEL) q.set("model", getModel());
  for (const [k, v] of Object.entries(extra)) if (v !== null && v !== undefined && v !== "") q.set(k, String(v));
  const s = q.toString();
  return s ? `${path}?${s}` : path;
}

export function readQuery() {
  return new URLSearchParams(window.location.search);
}

export const numParam = (q: URLSearchParams, k: string) => (q.get(k) === null || q.get(k) === "" ? null : Number(q.get(k)));

export function parseGt(v: string | null): number[] {
  if (!v) return DEFAULT_GT;
  const xs = v
    .split(",")
    .map(Number)
    .filter((x) => [0, 1, 2].includes(x));
  return xs.length ? [...new Set(xs)].sort() : DEFAULT_GT;
}

// ---------------------------------------------------------------------------
// 페이지 공통 상태 : URL 에서 시즌·투수·유형 복원 -> 메타·시즌 인덱스·리그 로드 -> URL 동기화
// ---------------------------------------------------------------------------
export function usePageState(extra: Record<string, string | number | null | undefined> = {}, onInit?: (q: URLSearchParams) => void) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const [season, setSeason] = useState<number | null>(null);
  const [pitcherId, setPitcherId] = useState<number | null>(null);
  const [gt, setGt] = useState<number[]>(DEFAULT_GT);
  const [index, setIndex] = useState<SeasonIndex | null>(null);
  const [league, setLeague] = useState<League | null>(null);
  const [error, setError] = useState<string | null>(null);
  const model = useModel();

  useEffect(() => {
    loadMeta()
      .then((m) => {
        const q = readQuery();
        const s = numParam(q, "season");
        const md = parseModel(q.get("model"));
        setModel(m.models?.some((x) => x.id === md) ? md : DEFAULT_MODEL); // 데이터에 없는 모델이면 기본
        setMeta(m);
        setSeason(s && m.seasons.includes(s) ? s : m.seasons[0]);
        setPitcherId(numParam(q, "pitcher"));
        setGt(parseGt(q.get("gt")));
        onInit?.(q); // 페이지 고유 URL 키 복원
      })
      .catch((e) => setError(String(e)));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 최초 1회만
  }, []);

  const [loaded, setLoaded] = useState<ModelId | null>(null);
  useEffect(() => {
    if (!season || !meta) return;
    let alive = true;
    Promise.all([loadIndex(season, model), loadLeague(season, model)])
      .then(([i, l]) => alive && (setIndex(i), setLeague(l), setLoaded(model)))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [season, model, meta]);

  const extraKey = JSON.stringify(extra);
  useEffect(() => {
    if (!season) return;
    const href = ctxHref(window.location.pathname, { season, pitcher: pitcherId, gt }, JSON.parse(extraKey));
    window.history.replaceState(null, "", href);
    setNavCtx({ season, pitcher: pitcherId, gt });
  }, [season, pitcherId, gt, extraKey, model]);

  const ready = !!(index && league && meta && index.season === season && loaded === model);
  const entry = ready ? (index!.pitchers.find((p) => p.id === pitcherId) ?? null) : null;
  return { meta, season, setSeason, pitcherId, setPitcherId, gt, setGt, model, index: ready ? index : null, league: ready ? league : null, entry, error, setError };
}

/** 투수 투구 파일 로드 (시즌·투수가 바뀌면 다시) */
export function usePitcherData(season: number | null, entryId: number | null, setError: (e: string) => void) {
  const model = useModel();
  const [data, setData] = useState<{ file: PitcherFile; pitches: Pitch[]; season: number; model: ModelId } | null>(null);
  useEffect(() => {
    if (!season || !entryId) return;
    let alive = true;
    loadPitches(season, entryId, model)
      .then((d) => alive && setData({ ...d, season, model }))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [season, entryId, setError, model]);
  return data && data.season === season && data.file.id === entryId && data.model === model ? data : null;
}
