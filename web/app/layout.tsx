import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import AppNav from "@/components/AppNav";
import { LANG_INIT_SCRIPT } from "@/lib/i18n/init";

export const metadata: Metadata = {
  title: "Stuff Lab · MLB Stuff grades",
  description: "MLB pitchers graded on pitch physics alone (20–80 Stuff). 투구 물리량만으로 매긴 MLB 투수 구위 분석.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    // 언어 속성은 첫 렌더 전 스크립트가 바꾸므로 html 속성 불일치 경고는 무시
    <html lang="ko" className="h-full antialiased" suppressHydrationWarning>
      <body className="min-h-full flex flex-col font-sans">
        <Script id="lang-init" strategy="beforeInteractive">
          {LANG_INIT_SCRIPT}
        </Script>
        <AppNav />
        {children}
      </body>
    </html>
  );
}
