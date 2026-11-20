/** 공용 선 아이콘 (24 격자, stroke 1.75, round cap). 텍스트 기호(→ ↗ ▲▼ ↑↓) 대신 사용 */
export type IconName =
  | "chevronRight"
  | "chevronLeft"
  | "chevronDown"
  | "arrowUpRight"
  | "arrowRight"
  | "arrowLeft"
  | "sortUp"
  | "sortDown"
  | "trendUp"
  | "trendDown"
  | "dot"
  | "search"
  | "user"
  | "calendar"
  | "layers"
  | "sun"
  | "moon"
  | "monitor";

const PATHS: Record<IconName, React.ReactNode> = {
  chevronRight: <path d="m9 5.5 6.5 6.5L9 18.5" />,
  chevronLeft: <path d="M15 5.5 8.5 12l6.5 6.5" />,
  chevronDown: <path d="m5.5 9 6.5 6.5L18.5 9" />,
  arrowUpRight: <path d="M8 16 16.5 7.5M9 7h8v8" />,
  arrowRight: <path d="M4.5 12h15M13.5 6l6 6-6 6" />,
  arrowLeft: <path d="M19.5 12h-15M10.5 6l-6 6 6 6" />,
  sortUp: <path d="M12 19V5M6.5 10.5 12 5l5.5 5.5" />,
  sortDown: <path d="M12 5v14M6.5 13.5 12 19l5.5-5.5" />,
  trendUp: <path d="m3.5 16.5 6-6 4 4 7-7M15 7.5h5.5V13" />,
  trendDown: <path d="m3.5 7.5 6 6 4-4 7 7M15 16.5h5.5V11" />,
  dot: <circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m16 16 4.5 4.5" />
    </>
  ),
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.75" />
      <path d="M4.75 20c.9-3.6 3.8-5.5 7.25-5.5s6.35 1.9 7.25 5.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="4" y="5.5" width="16" height="14.5" rx="3" />
      <path d="M4 10h16M8.5 3.5v3.5M15.5 3.5v3.5" />
    </>
  ),
  layers: (
    <>
      <path d="m12 4 8.5 4.5L12 13 3.5 8.5 12 4Z" />
      <path d="m3.5 12.5 8.5 4.5 8.5-4.5M3.5 16.5 12 21l8.5-4.5" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M2.5 12h2M19.5 12h2M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />,
  monitor: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="2.5" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
};

export default function Icon({ name, size = 16, className = "", strokeWidth = 1.75, title }: { name: IconName; size?: number; className?: string; strokeWidth?: number; title?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`shrink-0 ${className}`}
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      {PATHS[name]}
    </svg>
  );
}

/** 로고 : 야구공 (원 + 실밥 두 줄) */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" className="shrink-0">
      <circle cx="12" cy="12" r="10.5" fill="var(--accent)" />
      <path d="M7.2 3.6c2.3 2.2 3.3 5 3.3 8.4s-1 6.2-3.3 8.4M16.8 3.6c-2.3 2.2-3.3 5-3.3 8.4s1 6.2 3.3 8.4" fill="none" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
