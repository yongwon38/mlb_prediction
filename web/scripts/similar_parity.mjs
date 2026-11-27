// 유사 투구 검색 패리티 : lib/similar.ts (JS) vs export_similar.py 의 Python 검색 (같은 float16 인덱스)
// 실행 (web 폴더) : node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/similar_parity.mjs <check.json>
//   check.json = python export_similar.py --check-out <경로> 가 만든 기대값 (질의 50개 × 공간 2개의 이웃 10개). 로컬 데이터 기준이라 커밋하지 않음
// 기준 : 이웃 목록 완전 일치, 유사도 |Δ| < 1e-9. 참고 : 검색 1회 시간
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSimilarIndex, searchItem } from "../lib/similar.ts";

const here = dirname(fileURLToPath(import.meta.url));
const chk = JSON.parse(readFileSync(process.argv[2], "utf-8"));
const json = JSON.parse(readFileSync(join(here, "..", "public", "data", String(chk.season), "similar.json"), "utf-8"));
const t0 = performance.now();
const idx = loadSimilarIndex(json);
const loadMs = performance.now() - t0;

let listMismatch = 0, maxSim = 0;
for (const q of chk.queries) {
  const nb = searchItem(idx, q.space, q.q);
  if (nb.map((x) => x.i).join() !== q.nb.join()) listMismatch++;
  nb.forEach((x, j) => (maxSim = Math.max(maxSim, Math.abs(x.sim - q.sim[j]))));
}
const times = [];
for (let r = 0; r < 30; r++) {
  const t = performance.now();
  searchItem(idx, "model", r % idx.n);
  times.push(performance.now() - t);
}
times.sort((a, b) => a - b);
console.table([
  { 항목: `이웃 목록 불일치 (질의 ${chk.queries.length}개)`, 값: listMismatch, 기준: "0" },
  { 항목: "유사도 |Δ| 최대", 값: maxSim.toExponential(2), 기준: "< 1e-9" },
  { 항목: "인덱스 로드·표준화 ms", 값: loadMs.toFixed(1), 기준: "참고" },
  { 항목: "검색 1회 ms (중앙값)", 값: times[15].toFixed(2), 기준: "< 20" },
]);
const ok = listMismatch === 0 && maxSim < 1e-9;
console.log(ok ? "유사 검색 패리티 통과" : "유사 검색 패리티 실패");
process.exit(ok ? 0 : 1);
