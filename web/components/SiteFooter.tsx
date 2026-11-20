"use client";
import { useT } from "@/lib/i18n";
import { LogoMark } from "@/components/Icon";

/** 공통 하단 : 데이터·이미지 출처 */
export default function SiteFooter() {
  const t = useT().footer;
  return (
    <footer className="mt-auto border-t border-line">
      <div className="mx-auto w-full max-w-[1280px] px-4 py-6 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5 font-semibold text-ink-2">
          <LogoMark size={16} />
          Stuff Lab
        </span>
        <span>{t.credit}</span>
      </div>
    </footer>
  );
}
