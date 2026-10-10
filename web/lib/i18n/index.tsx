"use client";
import { useEffect, useSyncExternalStore } from "react";
import { ko, type Dict } from "./ko";
import { en } from "./en";
import { LANG_KEY as KEY } from "./init";

export type Lang = "ko" | "en";
export type { Dict };

const DICTS: Record<Lang, Dict> = { ko, en };

const listeners = new Set<() => void>();
const readLang = (): Lang => (document.documentElement.getAttribute("data-lang") === "en" ? "en" : "ko");

export function setLang(l: Lang) {
  try {
    localStorage.setItem(KEY, l);
  } catch {}
  document.documentElement.setAttribute("data-lang", l);
  listeners.forEach((f) => f());
}

/** 현재 언어. 서버(정적 HTML) 렌더는 한국어, 하이드레이션 직후 실제 언어로 다시 그린다 */
export function useLang(): Lang {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => listeners.delete(f)),
    readLang,
    () => "ko",
  );
}

export const useT = (): Dict => DICTS[useLang()];

/** html lang · 문서 제목 반영, 가림 해제 (상단 내비에서 1회 사용) */
export function useLangEffects() {
  const lang = useLang();
  useEffect(() => {
    const h = document.documentElement;
    h.lang = lang;
    document.title = DICTS[lang].meta.title;
    h.classList.remove("lang-pending");
  }, [lang]);
  return lang;
}

/** league.json 의 요인 그룹 이름(한국어) 대신 사전의 이름. 개수가 다르면 원래 이름 */
export const groupNames = (t: Dict, groups: string[]) =>
  groups.length === t.groups.length ? t.groups.map((g, i) => (groups[i] === "투구손" ? t.handOnly : g)) : groups;
