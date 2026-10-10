"use client";
import { useMemo } from "react";
import type { Pitch } from "@/lib/types";
import { BAND_NONE, STUFF_BUCKETS, bandOf } from "@/lib/analysis";
import { stuffColor, stuffOpacity, useDarkMode } from "@/lib/colors";
import { useT } from "@/lib/i18n";

/** 칩 색 견본용 구간 대표값 */
const BAND_MID: Record<string, number> = { "<40": 35, "40-45": 42.5, "45-50": 47.5, "50-55": 52.5, "55-60": 57.5, "60+": 65 };

interface Props {
  ps: Pitch[]; // 전역 필터 적용 후 투구
  band: string[]; // 빈 배열 = 전체
  setBand: (b: string[]) => void;
  ghost?: boolean;
  setGhost?: (g: boolean) => void; // 없으면 '나머지 흐리게' 토글을 숨김
  note?: string; // 없으면 기본 안내
  showNone?: boolean; // '점수 제외' 칩 표시 여부
}

/** 투구 분포·타구 분포 공용 구위 구간 선택기 (다른 패널에는 영향 없음) */
export default function BandPicker({ ps, band, setBand, ghost, setGhost, note, showNone = true }: Props) {
  const dark = useDarkMode();
  const tt = useT();
  const t = tt.band;
  const shownNote = note ?? t.note;
  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of ps) {
      const k = bandOf(p.s);
      m.set(k, (m.get(k) ?? 0) + 1);
    }
    return m;
  }, [ps]);
  const toggle = (k: string) => setBand(band.includes(k) ? band.filter((v) => v !== k) : [...band, k]);

  return (
    <div className="card p-3 flex flex-wrap items-center gap-1.5 text-xs">
      <span className="text-muted mr-1">{t.label}</span>
      <button className="chip" aria-pressed={!band.length} onClick={() => setBand([])}>
        {tt.common.all} <span className="tnum text-muted">{ps.length.toLocaleString()}</span>
      </button>
      {STUFF_BUCKETS.map((b) => {
        const s = BAND_MID[b.label];
        return (
          <button key={b.label} className="chip" aria-pressed={band.includes(b.label)} onClick={() => toggle(b.label)}>
            <span className="w-2.5 h-2.5 rounded-full" style={{ background: stuffColor(s, dark), opacity: stuffOpacity(s) }} />
            {b.label} <span className="tnum text-muted">{(counts.get(b.label) ?? 0).toLocaleString()}</span>
          </button>
        );
      })}
      {showNone && (
      <button className="chip" aria-pressed={band.includes(BAND_NONE)} onClick={() => toggle(BAND_NONE)} title={t.noneTitle}>
        <span className="w-2.5 h-2.5 rounded-full border border-muted" />
        {tt.common.unscored} <span className="tnum text-muted">{(counts.get(BAND_NONE) ?? 0).toLocaleString()}</span>
      </button>
      )}
      {setGhost && (
        <label className="ml-auto flex items-center gap-1.5 text-ink-2">
          <input type="checkbox" checked={!!ghost} onChange={(e) => setGhost(e.target.checked)} disabled={!band.length} />
          {t.ghost}
        </label>
      )}
      {shownNote && <span className="basis-full text-muted">{shownNote}</span>}
    </div>
  );
}
