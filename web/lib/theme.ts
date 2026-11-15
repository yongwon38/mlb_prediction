"use client";
import { useSyncExternalStore } from "react";
import { THEME_KEY } from "./i18n/init";

/** 화면 테마 : system = OS 설정을 따름. 고르면 html[data-theme] + localStorage 에 저장 */
export type Theme = "system" | "light" | "dark";

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());

const readTheme = (): Theme => {
  const v = document.documentElement.getAttribute("data-theme");
  return v === "light" || v === "dark" ? v : "system";
};

export function setTheme(t: Theme) {
  const h = document.documentElement;
  if (t === "system") h.removeAttribute("data-theme");
  else h.setAttribute("data-theme", t);
  try {
    if (t === "system") localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, t);
  } catch {}
  notify();
}

function subscribe(f: () => void) {
  listeners.add(f);
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  mq.addEventListener("change", f);
  return () => {
    listeners.delete(f);
    mq.removeEventListener("change", f);
  };
}

export const useTheme = (): Theme => useSyncExternalStore(subscribe, readTheme, () => "system");

/** 실제로 보이는 테마가 다크인지 (차트 색 선택용) */
export function useDarkMode(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => {
      const t = readTheme();
      return t === "system" ? window.matchMedia("(prefers-color-scheme: dark)").matches : t === "dark";
    },
    () => false,
  );
}
