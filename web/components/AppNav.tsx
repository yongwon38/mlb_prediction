"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ctxHref, useNavCtx } from "@/lib/appState";

const ITEMS = [
  { href: "/", label: "홈", match: (p: string) => p === "/" },
  { href: "/pitcher", label: "투수 분석", match: (p: string) => p.startsWith("/pitcher") },
  { href: "/games", label: "경기·타석", match: (p: string) => p.startsWith("/games") },
  { href: "/explain", label: "구위 산출 근거", match: (p: string) => p.startsWith("/explain") },
];

/** 상단 공통 내비 : 현재 시즌·투수·경기 유형을 유지한 채 페이지 이동 */
export default function AppNav() {
  const path = usePathname() ?? "/";
  const c = useNavCtx();
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
              {it.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
