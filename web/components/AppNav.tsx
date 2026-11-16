"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { ctxHref, useNavCtx } from "@/lib/appState";
import { loadMeta } from "@/lib/data";
import { type Lang, setLang, useLangEffects, useT } from "@/lib/i18n";
import { type ModelId, setModel, useModel } from "@/lib/model";
import { type Theme, setTheme, useTheme } from "@/lib/theme";
import { ko } from "@/lib/i18n/ko";
import { en } from "@/lib/i18n/en";

const ITEMS = [
  { href: "/", key: "home", match: (p: string) => p === "/" },
  { href: "/pitcher", key: "pitcher", match: (p: string) => p.startsWith("/pitcher") },
  { href: "/games", key: "games", match: (p: string) => p.startsWith("/games") },
  { href: "/explain", key: "explain", match: (p: string) => p.startsWith("/explain") },
  { href: "/model", key: "model", match: (p: string) => p.startsWith("/model") },
] as const;

const LANGS: [Lang, string][] = [
  ["ko", ko.langName],
  ["en", en.langName],
];

const THEME_NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };

/** 로고 : 야구공 (원 + 실밥 두 줄) */
export function LogoMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="10.5" fill="var(--ink)" />
      <path d="M7.2 3.6c2.3 2.2 3.3 5 3.3 8.4s-1 6.2-3.3 8.4M16.8 3.6c-2.3 2.2-3.3 5-3.3 8.4s1 6.2 3.3 8.4" fill="none" stroke="#e5484d" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function ThemeIcon({ theme }: { theme: Theme }) {
  const common = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
  if (theme === "light")
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
      </svg>
    );
  if (theme === "dark")
    return (
      <svg {...common}>
        <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" />
      </svg>
    );
  return (
    <svg {...common}>
      <rect x="3" y="4" width="18" height="12" rx="2" />
      <path d="M8 20h8M12 16v4" />
    </svg>
  );
}

/** 세그먼트 컨트롤 (모델·언어) */
function Segmented<T extends string>({ value, options, onChange, label, titles }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string; titles?: Record<string, string> }) {
  return (
    <div role="group" aria-label={label} className="flex rounded-lg bg-surface-2 p-0.5 text-xs shrink-0">
      {options.map(([k, l]) => (
        <button
          key={k}
          aria-pressed={value === k}
          title={titles?.[k]}
          onClick={() => onChange(k)}
          className={`px-2.5 py-1 rounded-md transition-colors ${value === k ? "bg-surface text-ink font-semibold shadow-sm" : "text-muted hover:text-ink"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

/** 상단 공통 내비 : 현재 시즌·투수·경기 유형·구위 모델을 유지한 채 페이지 이동 + 모델·테마·언어 전환 */
export default function AppNav() {
  const path = usePathname() ?? "/";
  const c = useNavCtx();
  const lang = useLangEffects();
  const t = useT();
  const model = useModel();
  const theme = useTheme();
  const [models, setModels] = useState<ModelId[]>([]);
  useEffect(() => {
    loadMeta()
      .then((m) => setModels((m.models ?? []).map((x) => x.id)))
      .catch(() => setModels([]));
  }, []);
  const controls = (
    <div className="flex items-center gap-2 pl-3 shrink-0">
      {models.length > 1 && <Segmented label={t.model.aria} value={model} options={models.map((m) => [m, t.model.names[m]])} onChange={setModel} titles={t.model.titles} />}
      <Segmented label={t.langAria} value={lang} options={LANGS} onChange={setLang} />
      <button
        onClick={() => setTheme(THEME_NEXT[theme])}
        aria-label={`${t.theme.aria}: ${t.theme[theme]}`}
        title={`${t.theme.aria}: ${t.theme[theme]}`}
        className="w-8 h-8 rounded-lg flex items-center justify-center text-ink-2 hover:text-ink hover:bg-surface-2"
      >
        <ThemeIcon theme={theme} />
      </button>
    </div>
  );
  return (
    <>
      <nav className="sticky top-0 z-30 border-b border-line bg-page/80 backdrop-blur-md">
        <div className="mx-auto w-full max-w-[1280px] px-4 h-14 flex items-center gap-1">
          <Link href={ctxHref("/", { season: c.season, gt: c.gt })} className="flex items-center gap-2 font-bold tracking-tight text-ink mr-3 shrink-0">
            <LogoMark />
            <span className="text-[15px] hidden min-[420px]:inline">Stuff Lab</span>
          </Link>
          <div className="flex items-center gap-1 overflow-x-auto no-scrollbar min-w-0 flex-1">
            {ITEMS.map((it) => {
              const active = it.match(path);
              return (
                <Link
                  key={it.href}
                  href={ctxHref(it.href, it.href === "/" ? { season: c.season, gt: c.gt } : c)}
                  aria-current={active ? "page" : undefined}
                  className={`shrink-0 px-3 py-1.5 rounded-lg text-sm transition-colors ${active ? "bg-surface-2 text-ink font-semibold" : "text-ink-2 hover:text-ink hover:bg-surface-2/60"}`}
                >
                  {t.nav[it.key]}
                </Link>
              );
            })}
          </div>
          <div className="hidden md:flex">{controls}</div>
        </div>
        <div className="md:hidden border-t border-line">
          <div className="px-4 py-1.5 flex justify-end">{controls}</div>
        </div>
      </nav>
      {model !== "lgbm" && (
        <div role="note" className="border-b border-line bg-accent-soft text-xs text-ink-2">
          <p className="mx-auto w-full max-w-[1280px] px-4 py-2">{t.model.notice}</p>
        </div>
      )}
    </>
  );
}
