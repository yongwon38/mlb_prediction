"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import SearchPanel from "@/components/SearchPanel";
import StrikeZone from "@/components/StrikeZone";
import PitchSequence from "@/components/games/PitchSequence";
import { Section, Toggle } from "@/components/Panels";
import { GameTypePicker, PitcherHeader, SeasonSelect } from "@/components/PageHeader";
import Methodology from "@/components/Methodology";
import { ctxHref, numParam, usePageState, usePitcherData } from "@/lib/appState";
import { pitchColor, stuffColor, useDarkMode } from "@/lib/colors";
import { batterName, gameLabel, ipText, paResult, runnersText, scoreText, signedPct, situation } from "@/lib/games";
import { useT } from "@/lib/i18n";
import type { GameRow, Meta, PaRow, Pitch, PitcherFile } from "@/lib/types";

const MIN_GAME_PITCHES = 15; // 구위 하이라이트 경기 최소 투구
const MIN_PA_PITCHES = 3; // 구위 하이라이트 타석 최소 투구

/** 경기·타석 : 추천(승부처·구위 하이라이트) 또는 직접 선택 -> 경기 보기 -> 타석 보기 -> 투구 1개 근거 */
export default function GamesPage() {
  const [game, setGame] = useState<number | null>(null);
  const [pa, setPa] = useState<number | null>(null);
  const { meta, season, setSeason, pitcherId, setPitcherId, gt, setGt, index, entry, error, setError } = usePageState({ game, pa }, (q) => {
    setGame(numParam(q, "game"));
    setPa(numParam(q, "pa"));
  });
  const data = usePitcherData(season, entry?.id ?? null, setError);
  const router = useRouter();
  const tt = useT();
  const t = tt.games;

  const gtCounts = useMemo(() => {
    const c = [0, 0, 0];
    data?.file.games.forEach((g) => (c[g.gt] += g.n));
    return c;
  }, [data]);
  const effGt = useMemo(() => {
    const xs = gt.filter((g) => gtCounts[g] > 0);
    const first = gtCounts.findIndex((n) => n > 0);
    return xs.length ? xs : first >= 0 ? [first] : gt;
  }, [gt, gtCounts]);

  const file = data?.file ?? null;
  const g = file && game !== null ? (file.games[game] ?? null) : null;
  const gamePs = useMemo(() => (data && g ? data.pitches.slice(g.i0, g.i0 + g.n) : []), [data, g]);
  const p = file && pa !== null && g && file.pas[pa]?.g === game ? file.pas[pa] : null;
  const paPs = useMemo(() => (data && p ? data.pitches.slice(p.i0, p.i0 + p.n) : []), [data, p]);

  const pickGame = (gi: number | null, pai: number | null = null) => {
    setGame(gi);
    setPa(pai);
  };
  const c = { season, pitcher: pitcherId, gt: effGt };
  const toExplain = (x: Pitch) => router.push(ctxHref("/explain/pitch", c, { pitch: x.i }));

  return (
    <main className="mx-auto w-full max-w-[1280px] px-4 py-6 flex flex-col gap-4">
      <PitcherHeader
        title={t.title}
        name={entry?.name ?? null}
        info={entry ? `${tt.common.throws(entry.throws)} · ${entry.teams.join(" → ")} · ${t.info(season, file ? file.games.length : null)}` : t.idle}
        season={season}
        pitcherId={entry ? pitcherId : null}
        gt={gt}
        active="games"
        right={<SeasonSelect meta={meta} season={season} onChange={(s) => (setSeason(s), pickGame(null))} />}
      />

      {error && <div className="card p-3 text-sm text-bad">{tt.common.loadError(error)}</div>}

      {!entry && (
        <>
          <SearchPanel key={season ?? 0} index={index} selectedId={pitcherId} onSelect={(id) => (setPitcherId(id), pickGame(null))} />
          {pitcherId && index && <div className="card p-10 text-center text-sm text-muted">{tt.common.noRecord}</div>}
        </>
      )}
      {entry && !data && <div className="card p-10 text-center text-sm text-muted">{t.loading(entry.name)}</div>}

      {data && meta && file && (
        <>
          <div className="card p-3">
            <GameTypePicker value={effGt} onChange={(v) => (setGt(v), pickGame(null))} counts={gtCounts} />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)] items-start">
            <Picker file={file} meta={meta} gts={effGt} game={game} pa={pa} onPick={pickGame} />

            <div className="flex flex-col gap-4 min-w-0">
              {!g ? (
                <Section title={t.pick}>
                  <p className="text-sm text-muted">{t.pickBody}</p>
                </Section>
              ) : (
                <>
                  <GameSummary g={g} />
                  {p ? (
                    <PaView file={file} meta={meta} p={p} ps={paPs} gamePs={gamePs} onBack={() => setPa(null)} onPick={toExplain} />
                  ) : (
                    <Section title={t.gameDist} sub={t.gameDistSub}>
                      <StrikeZone pitches={gamePs} pitchNames={meta.pitchNames} onPick={toExplain} />
                    </Section>
                  )}
                  <Section title={t.seq} sub={t.seqSub}>
                    <PitchSequence ps={gamePs} pitchTypes={file.pitchTypes} selectedPa={pa} onPickPa={(k) => setPa(k)} />
                  </Section>
                  <PaTable file={file} g={g} selected={pa} onPick={(k) => setPa(k)} />
                </>
              )}
            </div>
          </div>
        </>
      )}

      <Methodology />
    </main>
  );
}

// ---------------------------------------------------------------------------
// 왼쪽 : 추천 / 직접 선택
// ---------------------------------------------------------------------------
function Picker({ file, meta, gts, game, pa, onPick }: { file: PitcherFile; meta: Meta; gts: number[]; game: number | null; pa: number | null; onPick: (g: number | null, pa?: number | null) => void }) {
  const [mode, setMode] = useState<"rec" | "manual">("rec");
  const tt = useT();
  const t = tt.games;
  const games = useMemo(() => file.games.map((g, gi) => ({ g, gi })).filter(({ g }) => gts.includes(g.gt)), [file, gts]);
  const pas = useMemo(() => {
    const ok = new Set(games.map((x) => x.gi));
    return file.pas.map((p, pai) => ({ p, pai })).filter(({ p }) => ok.has(p.g));
  }, [file, games]);

  const rec = useMemo(() => {
    const byImp = [...games].sort((a, b) => b.g.imp - a.g.imp).slice(0, 5);
    const paImp = pas.filter(({ p }) => p.wpa !== null).sort((a, b) => Math.abs(b.p.wpa!) - Math.abs(a.p.wpa!)).slice(0, 8);
    const sg = games.filter(({ g }) => g.n >= MIN_GAME_PITCHES && g.s !== null).sort((a, b) => b.g.s! - a.g.s!);
    const sp = pas.filter(({ p }) => p.n >= MIN_PA_PITCHES && p.s !== null).sort((a, b) => b.p.s! - a.p.s!);
    return { byImp, paImp, bestGames: sg.slice(0, 3), worstGames: sg.slice(-2).reverse(), bestPas: sp.slice(0, 5) };
  }, [games, pas]);

  return (
    <Section title={t.pickerTitle} right={<Toggle label={t.modeAria} value={mode} options={[["rec", t.rec], ["manual", t.manual]]} onChange={setMode} />}>
      {mode === "rec" ? (
        <div className="flex flex-col gap-4 text-sm">
          <RecGroup title={t.impGames} note={t.impGamesNote(meta.importanceWeight.D, meta.importanceWeight.W, meta.importanceWeight.S)}>
            {rec.byImp.map(({ g, gi }) => (
              <RecItem key={gi} active={game === gi && pa === null} onClick={() => onPick(gi)} main={gameLabel(g, tt)} sub={t.impGameSub(scoreText(g, tt), ipText(g.outs), g.n, signedPct(g.wpa))} value={g.imp.toFixed(2)} valueLabel={t.leverage} />
            ))}
          </RecGroup>
          <RecGroup title={t.impPas} note={t.impPasNote}>
            {rec.paImp.map(({ p, pai }) => (
              <RecItem
                key={pai}
                active={pa === pai}
                onClick={() => onPick(p.g, pai)}
                main={t.paMain(file.games[p.g].date, batterName(file, p), paResult(p, tt))}
                sub={situation(p, tt)}
                value={signedPct(p.wpa)}
                valueLabel="WPA"
                tone={(p.wpa ?? 0) >= 0 ? "good" : "bad"}
              />
            ))}
          </RecGroup>
          <RecGroup title={t.stuffGames} note={t.stuffGamesNote(MIN_GAME_PITCHES)}>
            {[...rec.bestGames.map((x) => ({ ...x, tag: t.best })), ...rec.worstGames.map((x) => ({ ...x, tag: t.worst }))].map(({ g, gi, tag }) => (
              <RecItem key={`${tag}${gi}`} active={game === gi && pa === null} onClick={() => onPick(gi)} main={`${tag} · ${gameLabel(g, tt)}`} sub={t.stuffGameSub(g.n, g.s60 !== null ? String(Math.round(g.s60 * 100)) : "-", scoreText(g, tt))} value={g.s!.toFixed(1)} valueLabel={tt.common.avgStuff} />
            ))}
          </RecGroup>
          <RecGroup title={t.stuffPas} note={t.stuffPasNote(MIN_PA_PITCHES)}>
            {rec.bestPas.map(({ p, pai }) => (
              <RecItem key={pai} active={pa === pai} onClick={() => onPick(p.g, pai)} main={t.paMain(file.games[p.g].date, batterName(file, p), paResult(p, tt))} sub={t.stuffPaSub(p.n, p.smax?.toFixed(1) ?? "-", situation(p, tt))} value={p.s!.toFixed(1)} valueLabel={tt.common.avgStuff} />
            ))}
          </RecGroup>
        </div>
      ) : (
        <ManualPicker games={games} game={game} onPick={onPick} />
      )}
    </Section>
  );
}

function RecGroup({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-ink">{title}</h3>
      <p className="text-xs text-muted mb-1">{note}</p>
      <ul className="border-t border-grid">{children}</ul>
    </div>
  );
}

function RecItem({ main, sub, value, valueLabel, active, onClick, tone }: { main: string; sub: string; value: string; valueLabel: string; active: boolean; onClick: () => void; tone?: "good" | "bad" }) {
  return (
    <li>
      <button onClick={onClick} aria-pressed={active} className={`w-full text-left flex items-center gap-2 px-1.5 py-1.5 border-b border-grid hover:bg-surface-2 ${active ? "bg-surface-2" : ""}`}>
        <span className="flex-1 min-w-0">
          <span className="block truncate text-ink">{main}</span>
          <span className="block truncate text-xs text-muted">{sub}</span>
        </span>
        <span className="text-right shrink-0">
          <span className={`block font-semibold tnum ${tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-ink"}`}>{value}</span>
          <span className="block text-[10px] text-muted">{valueLabel}</span>
        </span>
      </button>
    </li>
  );
}

function ManualPicker({ games, game, onPick }: { games: { g: GameRow; gi: number }[]; game: number | null; onPick: (g: number | null, pa?: number | null) => void }) {
  const [q, setQ] = useState("");
  const tt = useT();
  const t = tt.games;
  const shown = games.filter(({ g }) => !q || `${g.date} ${g.opp} ${tt.rounds[g.rd] ?? ""}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="flex flex-col gap-2 text-sm">
      <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t.searchPh} aria-label={t.searchAria} />
      <ul className="max-h-[560px] overflow-y-auto border-t border-grid">
        {shown.map(({ g, gi }) => (
          <li key={gi}>
            <button onClick={() => onPick(gi)} aria-pressed={game === gi} className={`w-full text-left grid grid-cols-[1fr_auto_auto] items-center gap-x-3 px-1.5 py-1.5 border-b border-grid hover:bg-surface-2 ${game === gi ? "bg-surface-2" : ""}`}>
              <span className="truncate">
                <span className="text-ink">{gameLabel(g, tt)}</span>
                <span className="text-xs text-muted ml-2">{g.st ? t.starter : t.reliever}</span>
              </span>
              <span className="text-xs text-muted tnum">{t.ipPitches(ipText(g.outs), g.n)}</span>
              <span className="tnum font-semibold text-ink w-10 text-right">{g.s?.toFixed(1) ?? "-"}</span>
            </button>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">{t.manualFoot(shown.length)}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// 오른쪽 : 경기 요약, 타석 목록, 타석 보기
// ---------------------------------------------------------------------------
function GameSummary({ g }: { g: GameRow }) {
  const tt = useT();
  const t = tt.games;
  const vals = [
    scoreText(g, tt),
    g.st ? t.starter : t.reliever,
    ipText(g.outs),
    String(g.n),
    `${g.h} / ${g.r}`,
    `${g.k} / ${g.bb} / ${g.hr}`,
    g.s?.toFixed(1) ?? "-",
    g.s60 !== null ? `${Math.round(g.s60 * 100)}%` : "-",
    signedPct(g.wpa),
    g.imp.toFixed(2),
  ];
  const cells: [string, string][] = vals.map((v, i) => [t.summaryCells[i], v]);
  return (
    <Section
      title={`${gameLabel(g, tt, false)} · ${tt.rounds[g.rd] ?? g.rd}`}
      sub={t.summarySub}
      right={
        <a className="text-xs text-accent-ink underline underline-offset-2" href={`https://baseballsavant.mlb.com/gamefeed?gamePk=${g.pk}`} target="_blank" rel="noreferrer">
          {tt.common.savantFeed}
        </a>
      }
    >
      <dl className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {cells.map(([l, v]) => (
          <div key={l} className="rounded-lg bg-surface-2 px-3 py-2">
            <dt className="text-xs text-muted">{l}</dt>
            <dd className="text-base font-semibold text-ink tnum mt-0.5">{v}</dd>
          </div>
        ))}
      </dl>
    </Section>
  );
}

function PaTable({ file, g, selected, onPick }: { file: PitcherFile; g: GameRow; selected: number | null; onPick: (pai: number) => void }) {
  const dark = useDarkMode();
  const tt = useT();
  const t = tt.games;
  const rows = file.pas.slice(g.pa0, g.pa0 + g.npa).map((p, k) => ({ p, pai: g.pa0 + k }));
  const h = t.paHead;
  return (
    <Section title={t.paList} sub={t.paListSub}>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tnum">
          <thead>
            <tr className="text-muted border-b border-grid">
              <th className="text-left font-normal py-1.5">{h[0]}</th>
              <th className="text-left font-normal py-1.5">{h[1]}</th>
              <th className="text-left font-normal py-1.5">{h[2]}</th>
              <th className="text-left font-normal py-1.5">{h[3]}</th>
              <th className="text-right font-normal py-1.5">{h[4]}</th>
              <th className="text-right font-normal py-1.5">{h[5]}</th>
              <th className="text-right font-normal py-1.5">{h[6]}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ p, pai }) => (
              <tr key={pai} onClick={() => onPick(pai)} className={`border-b border-grid cursor-pointer hover:bg-surface-2 ${selected === pai ? "bg-surface-2" : ""}`}>
                <td className="py-1.5 text-ink-2">{tt.common.inning(p.inn)}</td>
                <td className="py-1.5 text-ink-2 whitespace-nowrap">{t.outsRunners(p.o, runnersText(p.on, tt))}</td>
                <td className="py-1.5 text-ink whitespace-nowrap">
                  {batterName(file, p)} <span className="text-muted">{p.lhb ? "L" : "R"}</span>
                </td>
                <td className="py-1.5 text-ink-2 whitespace-nowrap">{paResult(p, tt)}</td>
                <td className="py-1.5 text-right text-ink-2">{p.n}</td>
                <td className="py-1.5 text-right font-semibold" style={{ color: p.s !== null ? stuffColor(p.s, dark) : undefined }}>
                  {p.s?.toFixed(1) ?? "-"}
                </td>
                <td className={`py-1.5 text-right ${(p.wpa ?? 0) > 0.005 ? "text-good" : (p.wpa ?? 0) < -0.005 ? "text-bad" : "text-ink-2"}`}>{signedPct(p.wpa)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

function PaView({ file, meta, p, ps, gamePs, onBack, onPick }: { file: PitcherFile; meta: Meta; p: PaRow; ps: Pitch[]; gamePs: Pitch[]; onBack: () => void; onPick: (x: Pitch) => void }) {
  const dark = useDarkMode();
  const tt = useT();
  const t = tt.games;
  const pai = ps[0]?.pai;
  const ghost = gamePs.filter((x) => x.pai !== pai);
  const h = t.pitchHead;
  return (
    <Section
      title={t.paView(batterName(file, p), !!p.lhb)}
      sub={t.paViewSub(situation(p, tt), paResult(p, tt), signedPct(p.wpa))}
      right={
        <button className="text-xs text-accent-ink underline underline-offset-2" onClick={onBack}>
          {t.back}
        </button>
      }
    >
      {p.des && <p className="text-sm text-ink-2 mb-3">{p.des}</p>}
      <div className="grid gap-4 md:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] items-start">
        <StrikeZone pitches={ps} ghost={ghost} pitchNames={meta.pitchNames} onPick={onPick} numbered />
        <table className="w-full text-xs tnum">
          <thead>
            <tr className="text-muted border-b border-grid">
              <th className="text-left font-normal py-1.5">{h[0]}</th>
              <th className="text-left font-normal py-1.5">{h[1]}</th>
              <th className="text-left font-normal py-1.5">{h[2]}</th>
              <th className="text-right font-normal py-1.5">{h[3]}</th>
              <th className="text-right font-normal py-1.5">{h[4]}</th>
              <th className="text-left font-normal py-1.5 pl-3">{h[5]}</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {ps.map((x) => (
              <tr key={x.i} className="border-b border-grid">
                <td className="py-1.5 text-muted">{x.pn}</td>
                <td className="py-1.5 text-ink-2">
                  {x.b}-{x.k}
                </td>
                <td className="py-1.5">
                  <span className="inline-flex items-center gap-1">
                    <span className="w-2 h-2 rounded-full" style={{ background: pitchColor(file.pitchTypes, x.pt, dark) }} />
                    {x.pt}
                  </span>
                </td>
                <td className="py-1.5 text-right text-ink-2">{x.v?.toFixed(1) ?? "-"}</td>
                <td className="py-1.5 text-right font-semibold" style={{ color: x.s !== null ? stuffColor(x.s, dark) : undefined }}>
                  {x.s?.toFixed(1) ?? "-"}
                </td>
                <td className="py-1.5 pl-3 text-ink-2">{tt.results[x.r]}</td>
                <td className="py-1.5 text-right">
                  {x.s !== null && (
                    <button className="text-accent-ink underline underline-offset-2" onClick={() => onPick(x)}>
                      {t.why}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="text-xs text-muted mt-2">{t.paFoot}</p>
    </Section>
  );
}
