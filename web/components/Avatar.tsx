"use client";
import { useState } from "react";
import { headshotUrl, teamLogoUrl } from "@/lib/media";
import { useDarkMode } from "@/lib/theme";
import Icon from "@/components/Icon";

const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

/** 선수 사진 (원형). 불러오지 못하면 이니셜 */
export function PlayerPhoto({ id, name, size = 32, className = "" }: { id: number; name: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState<number | null>(null);
  const box = { width: size, height: size };
  if (failed === id)
    return (
      <span className={`inline-flex items-center justify-center rounded-full bg-surface-3 text-ink-2 font-semibold shrink-0 ${className}`} style={{ ...box, fontSize: size * 0.36 }} aria-hidden="true">
        {initials(name)}
      </span>
    );
  return (
    // 외부 CDN 이미지 : next/image 최적화 없이(static export) 그대로
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={headshotUrl(id, size * 2)}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      onError={() => setFailed(id)}
      className={`rounded-full bg-surface-2 object-cover object-top shrink-0 ${className}`}
      style={box}
    />
  );
}

/** 팀 로고. 매핑에 없는 약어는 텍스트 */
export function TeamLogo({ abbr, size = 16, className = "" }: { abbr: string; size?: number; className?: string }) {
  const dark = useDarkMode();
  const [failed, setFailed] = useState(false);
  const url = teamLogoUrl(abbr, dark);
  if (!url || failed) return <span className={`text-[11px] font-semibold text-muted ${className}`}>{abbr}</span>;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={url} alt={abbr} title={abbr} width={size} height={size} loading="lazy" decoding="async" onError={() => setFailed(true)} className={`shrink-0 object-contain ${className}`} style={{ width: size, height: size }} />
  );
}

/** 시즌 중 소속 팀 순서 : 로고 + 약어, 이적은 화살표 아이콘 */
export function TeamChain({ teams, size = 18 }: { teams: string[]; size?: number }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {teams.map((t, i) => (
        <span key={t} className="inline-flex items-center gap-1.5">
          {i > 0 && <Icon name="chevronRight" size={12} className="text-muted" />}
          <TeamLogo abbr={t} size={size} />
          <span className="font-medium text-ink-2">{t}</span>
        </span>
      ))}
    </span>
  );
}

/** 여러 팀(시즌 중 이적) 로고 나열 */
export function TeamLogos({ teams, size = 16, className = "" }: { teams: string[]; size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 align-middle ${className}`}>
      {teams.map((t) => (
        <TeamLogo key={t} abbr={t} size={size} />
      ))}
    </span>
  );
}
