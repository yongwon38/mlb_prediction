import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import AppNav from "@/components/AppNav";
import SiteFooter from "@/components/SiteFooter";
import { LANG_INIT_SCRIPT } from "@/lib/i18n/init";

export const metadata: Metadata = {
  title: "Stuff Lab · MLB Stuff grades",
  description: "MLB pitch grades from pitch physics (20–80 Stuff). 투구 물리량 기반 MLB 구위 지표."
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // 언어 속성은 첫 렌더 전 스크립트가 바꾸므로 html 속성 불일치 경고는 무시
    <html lang="ko" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/* Pretendard (한글·라틴 UI 글꼴, 쓰인 글자만 내려받는 dynamic subset) */}
        <link rel="preconnect" href="https://cdn.jsdelivr.net" crossOrigin="anonymous" />
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css" />
      </head>
      <body className="min-h-full flex flex-col font-sans">
        <Script id="lang-init" strategy="beforeInteractive">
          {LANG_INIT_SCRIPT}
        </Script>
        <AppNav />
        {children}
        <SiteFooter />
      </body>
    </html>
  );
}
