import type { NextConfig } from "next";

// 정적 export : 데이터는 public/data 의 JSON 을 클라이언트에서 fetch 한다
const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
};

export default nextConfig;
