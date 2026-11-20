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
import Icon, { type IconName, LogoMark } from "@/components/Icon";

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

const THEME_ICON: Record<Theme, IconName> = { light: "sun", dark: "moon", system: "monitor" };

/** 세그먼트 컨트롤 (모델·언어) */
function Segmented<T extends string>({ value, options, onChange, label, titles }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string; titles?: Record<string, string> }) {
  return (
    <div role="group" aria-label={label} className="flex rounded-[10px] bg-surface-2 p-[3px] text-xs shrink-0">
      {options.map(([k, l]) => (
        <button
          key={k}
          aria-pressed={value === k}
          title={titles?.[k]}
          onClick={() => onChange(k)}
          className={`px-2.5 py-1 rounded-[8px] font-medium transition-colors ${value === k ? "bg-surface text-ink font-semibold shadow-[0_1px_2px_rgba(0,23,51,0.08)]" : "text-muted hover:text-ink"}`}
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
        className="w-9 h-9 rounded-[10px] flex items-center justify-center text-ink-2 hover:text-ink hover:bg-surface-2 transition-colors"
      >
        <Icon name={THEME_ICON[theme]} size={18} />
      </button>
    </div>
  );
  return (
    <>
      <nav className="sticky top-0 z-30 border-b border-line bg-surface/90 backdrop-blur-md">
        <div className="mx-auto w-full max-w-[1280px] px-4 h-[60px] flex items-stretch gap-1">
          <Link href={ctxHref("/", { season: c.season, gt: c.gt })} className="flex items-center gap-2 font-bold tracking-tight text-ink mr-4 shrink-0">
            <LogoMark size={24} />
            <span className="text-[17px] hidden min-[420px]:inline">Stuff Lab</span>
          </Link>
          <div className="flex items-stretch gap-1 overflow-x-auto no-scrollbar min-w-0 flex-1">
            {ITEMS.map((it) => {
              const active = it.match(path);
              return (
                <Link
                  key={it.href}
                  href={ctxHref(it.href, it.href === "/" ? { season: c.season, gt: c.gt } : c)}
                  aria-current={active ? "page" : undefined}
                  className={`shrink-0 flex items-center px-3 text-[15px] border-b-2 transition-colors ${active ? "border-ink text-ink font-semibold" : "border-transparent text-muted hover:text-ink"}`}
                >
                  {t.nav[it.key]}
                </Link>
              );
            })}
          </div>
          <div className="hidden md:flex items-center">{controls}</div>
        </div>
        <div className="md:hidden border-t border-line">
          <div className="px-4 py-1.5 flex justify-end">{controls}</div>
        </div>
      </nav>
      {model !== "lgbm" && (
        <div role="note" className="border-b border-line bg-accent-soft text-xs text-ink-2">
          <p className="mx-auto w-full max-w-[1280px] px-4 py-2.5 flex items-start gap-2"><Icon name="layers" size={15} className="mt-px text-accent" />{t.model.notice}</p>
        </div>
      )}
    </>
  );
}
