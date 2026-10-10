"use client";
import BandPicker from "@/components/BandPicker";
import SearchPanel from "@/components/SearchPanel";
import { GameTypePicker, PitcherHeader, SeasonSelect, type PitcherTab } from "@/components/PageHeader";
import { Caveats } from "@/components/explain/Parts";
import { pitchColor, useDarkMode } from "@/lib/colors";
import type { ExplainState } from "@/lib/useExplain";
import { useT } from "@/lib/i18n";

/** 구위 산출 근거 하위 페이지 공통 틀 : 머리·탭, 투수 선택, 경기 유형·구종·구위 구간 필터 */
export default function ExplainShell({
  st,
  active,
  filters = "both",
  note,
  children,
}: {
  st: ExplainState;
  active: PitcherTab;
  filters?: "both" | "pt" | "band" | "none";
  note?: string;
  children: React.ReactNode;
}) {
  const dark = useDarkMode();
  const tt = useT();
  const t = tt.explain;
  const { meta, season, setSeason, pitcherId, setPitcherId, gt, setGt, index, entry, error, file, lg, pts, setPts, band, setBand, byPt, gtCounts, effGt, setSel } = st;
  const ready = !!(file && lg && meta);

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 py-6 flex flex-col gap-4">
      <PitcherHeader
        title={t.titles[active]}
        name={entry?.name ?? null}
        info={entry ? `${tt.common.throws(entry.throws)} · ${entry.teams.join(" → ")} · ${t.info(season)}` : t.idle}
        season={season}
        pitcherId={entry ? pitcherId : null}
        gt={gt}
        active={active}
        right={<SeasonSelect meta={meta} season={season} onChange={(s) => (setSeason(s), setSel(null))} />}
      />

      {error && <div className="card p-3 text-sm text-bad">{tt.common.loadError(error)}</div>}

      {(!entry || !pitcherId) && (
        <>
          <SearchPanel key={season ?? 0} index={index} selectedId={pitcherId} onSelect={(id) => (setPitcherId(id), setSel(null), setPts([]), setBand([]))} />
          {pitcherId && index && !entry && <div className="card p-10 text-center text-sm text-muted">{tt.common.noRecord}</div>}
        </>
      )}
      {entry && !ready && <div className="card p-10 text-center text-sm text-muted">{t.loading(entry.name)}</div>}

      {ready && (
        <>
          {filters !== "none" && (
            <div className="card p-3 flex flex-col gap-2 text-xs">
              <GameTypePicker value={effGt} onChange={setGt} counts={gtCounts} />
              {(filters === "both" || filters === "pt") && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-muted mr-1">{tt.common.pitch}</span>
                  <button className="chip" aria-pressed={!pts.length} onClick={() => setPts([])}>
                    {tt.common.all}
                  </button>
                  {file!.pitchTypes.map((pt) => (
                    <button key={pt} className="chip" aria-pressed={pts.includes(pt)} onClick={() => setPts(pts.includes(pt) ? pts.filter((v) => v !== pt) : [...pts, pt])}>
                      <span className="w-2.5 h-2.5 rounded-full" style={{ background: pitchColor(file!.pitchTypes, pt, dark) }} />
                      {pt}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {(filters === "both" || filters === "band") && <BandPicker ps={byPt} band={band} setBand={setBand} showNone={false} note={note ?? ""} />}
          {children}
          <Caveats method={lg?.method ?? "saabas"} />
        </>
      )}
    </main>
  );
}
