import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Stuff Lab — MLB 구위 분석",
  description: "투구 물리량 기반 구위(Stuff) 모델로 본 MLB 투수 분석",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">{children}</body>
    </html>
  );
}
