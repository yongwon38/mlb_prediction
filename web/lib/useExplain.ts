"use client";
import { useEffect, useMemo, useState } from "react";
import { numParam, usePageState } from "./appState";
import { loadExplainPitches } from "./data";
import { bandOf } from "./analysis";
import type { ExplainPitch, LeagueExplain, PitcherFile } from "./types";

const list = (v: string | null) => (v ? v.split(",").filter(Boolean) : []);

/** 구위 산출 근거 하위 페이지 공통 상태 : 시즌·투수·유형 + 구종/구위 구간 필터 + 선택 투구 (모두 URL 유지) */
export function useExplainState() {
  const [pts, setPts] = useState<string[]>([]);
  const [band, setBand] = useState<string[]>([]);
  const [sel, setSel] = useState<number | null>(null);
  const base = usePageState({ pt: pts.join(","), band: band.join(","), pitch: sel }, (q) => {
    setPts(list(q.get("pt")));
    setBand(list(q.get("band")));
    setSel(numParam(q, "pitch"));
  });
  const { season, entry, setError, gt } = base;
  const [data, setData] = useState<{ file: PitcherFile; pitches: ExplainPitch[]; season: number } | null>(null);

  useEffect(() => {
    if (!season || !entry) return;
    let alive = true;
    loadExplainPitches(season, entry.id)
      .then((d) => alive && setData({ ...d, season }))
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [season, entry, setError]);

  const cur = data && entry && data.season === season && data.file.id === entry.id ? data : null;
  const lg: LeagueExplain | null = base.league?.explain ?? null;
  const gtCounts = useMemo(() => {
    const c = [0, 0, 0];
    cur?.pitches.forEach((p) => c[p.gt]++);
    return c;
  }, [cur]);
  const effGt = useMemo(() => {
    const xs = gt.filter((g) => gtCounts[g] > 0);
    const first = gtCounts.findIndex((n) => n > 0);
    return xs.length ? xs : first >= 0 ? [first] : gt;
  }, [gt, gtCounts]);
  const all = useMemo(() => (cur ? cur.pitches.filter((p) => effGt.includes(p.gt)) : []), [cur, effGt]);
  const byPt = useMemo(() => (pts.length ? all.filter((p) => pts.includes(p.pt)) : all), [all, pts]);
  const byBand = useMemo(() => (band.length ? all.filter((p) => band.includes(bandOf(p.s))) : all), [all, band]);
  const ps = useMemo(() => (band.length ? byPt.filter((p) => band.includes(bandOf(p.s))) : byPt), [byPt, band]);

  return { ...base, file: cur?.file ?? null, everything: cur?.pitches ?? [], all, byPt, byBand, ps, lg, pts, setPts, band, setBand, sel, setSel, gtCounts, effGt };
}

export type ExplainState = ReturnType<typeof useExplainState>;
