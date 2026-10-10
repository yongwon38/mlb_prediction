"use client";
import { useState } from "react";
import type { Pitch } from "@/lib/types";
import { pitchColor, useDarkMode } from "@/lib/colors";
import { useT } from "@/lib/i18n";

const W = 720;
const H = 200;
const PAD = { l: 34, r: 10, t: 18, b: 22 };
const Y_DOM: [number, number] = [25, 75];

/** 경기 내 투구 순서별 구위 (점 색 = 구종, 세로 점선 = 이닝 경계, 음영 = 선택 타석) */
export default function PitchSequence({
  ps,
  pitchTypes,
  selectedPa,
  onPickPa,
}: {
  ps: Pitch[];
  pitchTypes: string[];
  selectedPa: number | null;
  onPickPa: (pai: number) => void;
}) {
  const dark = useDarkMode();
  const [hover, setHover] = useState<Pitch | null>(null);
  const tt = useT();
  const t = tt.games;
  const n = ps.length;
  if (!n) return <p className="text-sm text-muted">{t.seqEmpty}</p>;
  const x = (k: number) => PAD.l + ((W - PAD.l - PAD.r) * (k + 0.5)) / n;
  const y = (s: number) => PAD.t + ((H - PAD.t - PAD.b) * (Y_DOM[1] - Math.min(Math.max(s, Y_DOM[0]), Y_DOM[1]))) / (Y_DOM[1] - Y_DOM[0]);
  const innStarts = ps.map((p, k) => (k === 0 || ps[k - 1].inn !== p.inn ? k : -1)).filter((k) => k >= 0);
  const selIdx = ps.map((p, k) => (p.pai === selectedPa ? k : -1)).filter((k) => k >= 0);
  const step = (W - PAD.l - PAD.r) / n;

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto" role="img" aria-label={t.seqAria(n)}>
        {selIdx.length > 0 && <rect x={x(selIdx[0]) - step / 2} y={PAD.t} width={step * selIdx.length} height={H - PAD.t - PAD.b} fill="var(--accent)" fillOpacity={0.12} />}
        {[30, 40, 50, 60, 70].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(v)} y2={y(v)} stroke={v === 50 ? "var(--axis)" : "var(--grid)"} strokeDasharray={v === 50 ? undefined : "2 3"} />
            <text x={PAD.l - 6} y={y(v) + 4} fontSize={10} textAnchor="end" fill="var(--muted)">
              {v}
            </text>
          </g>
        ))}
        {innStarts.map((k) => (
          <g key={k}>
            {k > 0 && <line x1={x(k) - step / 2} x2={x(k) - step / 2} y1={PAD.t - 6} y2={H - PAD.b} stroke="var(--axis)" strokeDasharray="3 3" />}
            <text x={x(k) - step / 2 + 3} y={PAD.t - 6} fontSize={10} fill="var(--muted)">
              {tt.common.inning(ps[k].inn)}
            </text>
          </g>
        ))}
        {ps.map((p, k) =>
          p.s === null ? (
            <circle key={p.i} cx={x(k)} cy={H - PAD.b - 4} r={2.5} fill="none" stroke="var(--muted)" />
          ) : (
            <circle
              key={p.i}
              cx={x(k)}
              cy={y(p.s)}
              r={hover?.i === p.i ? 5.5 : 3.8}
              fill={pitchColor(pitchTypes, p.pt, dark)}
              stroke="var(--surface)"
              strokeWidth={1}
              style={{ cursor: "pointer" }}
              onPointerEnter={() => setHover(p)}
              onPointerLeave={() => setHover(null)}
              onClick={() => onPickPa(p.pai)}
            />
          ),
        )}
        <text x={W - PAD.r} y={H - 6} fontSize={10} textAnchor="end" fill="var(--muted)">
          {t.seqAxis}
        </text>
      </svg>
      {hover && (
        <div className="absolute top-1 right-2 card px-2.5 py-1.5 text-xs pointer-events-none tnum">
          {t.seqHover(hover.gp, hover.inn, hover.pt, hover.v?.toFixed(1) ?? "-")}
          <b>{hover.s?.toFixed(1) ?? "-"}</b> · {tt.results[hover.r]}
        </div>
      )}
    </div>
  );
}
