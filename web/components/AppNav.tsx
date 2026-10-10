"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ctxHref, useNavCtx } from "@/lib/appState";
import { type Lang, setLang, useLangEffects, useT } from "@/lib/i18n";
import { ko } from "@/lib/i18n/ko";
import { en } from "@/lib/i18n/en";

const ITEMS = [
  { href: "/", key: "home", match: (p: string) => p === "/" },
  { href: "/pitcher", key: "pitcher", match: (p: string) => p.startsWith("/pitcher") },
  { href: "/games", key: "games", match: (p: string) => p.startsWith("/games") },
  { href: "/explain", key: "explain", match: (p: string) => p.startsWith("/explain") },
] as const;

const LANGS: [Lang, string][] = [
  ["ko", ko.langName],
  ["en", en.langName],
];

/** 상단 공통 내비 : 현재 시즌·투수·경기 유형을 유지한 채 페이지 이동 + 언어 전환 */
export default function AppNav() {
  const path = usePathname() ?? "/";
  const c = useNavCtx();
  const lang = useLangEffects();
  const t = useT();
  return (
    <nav className="sticky top-0 z-30 border-b border-line bg-page/90 backdrop-blur">
      <div className="mx-auto w-full max-w-[1280px] px-4 flex items-center gap-1 overflow-x-auto">
        <Link href={ctxHref("/", { season: c.season, gt: c.gt })} className="font-bold tracking-tight text-ink mr-3 py-3 shrink-0">
          Stuff Lab
        </Link>
        {ITEMS.map((it) => {
          const active = it.match(path);
          return (
            <Link
              key={it.href}
              href={ctxHref(it.href, it.href === "/" ? { season: c.season, gt: c.gt } : c)}
              aria-current={active ? "page" : undefined}
              className={`shrink-0 px-3 py-3 text-sm border-b-2 -mb-px ${active ? "border-ink text-ink font-semibold" : "border-transparent text-ink-2 hover:text-ink"}`}
            >
              {t.nav[it.key]}
            </Link>
          );
        })}
        <div role="group" aria-label={t.langAria} className="ml-auto shrink-0 flex items-center gap-1 pl-3 text-xs">
          {LANGS.map(([l, label], i) => (
            <span key={l} className="flex items-center gap-1">
              {i > 0 && <span className="text-muted">|</span>}
              <button
                lang={l}
                aria-pressed={lang === l}
                onClick={() => setLang(l)}
                className={`px-1 py-1 ${lang === l ? "text-ink font-semibold" : "text-muted hover:text-ink"}`}
              >
                {label}
              </button>
            </span>
          ))}
        </div>
      </div>
    </nav>
  );
}
