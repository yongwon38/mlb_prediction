// 구위 시뮬레이터 패리티 : lib/hofnet.ts (JS) vs torch CPU float32 기준값 (export_sim_model.py 가 만든 fixtures/sim_parity.json)
// 실행 (web 폴더) : node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON scripts/sim_parity.mjs   (Node 23.6+ : .ts 를 타입 제거로 바로 import)
// 기준 : 예측 |Δ| < 1e-5, 구위 |Δ| < 0.05 (StuffScaler 정확값 대비), erf |Δ| < 1e-12
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { loadSimModel, predict, score, erf, responseCurve, embed, CURVE_POINTS } from "../lib/hofnet.ts";

const here = dirname(fileURLToPath(import.meta.url));
const json = JSON.parse(readFileSync(join(here, "..", "public", "sim", "hof_r.json"), "utf-8"));
const fx = JSON.parse(readFileSync(join(here, "fixtures", "sim_parity.json"), "utf-8"));
if (fx.model_sha256 !== json.model_sha256) throw new Error(`고정 세트와 모델 파일 불일치 ${fx.model_sha256} != ${json.model_sha256}`);
const m = loadSimModel(json);

const maxAbs = (a, b) => a.reduce((mx, v, i) => Math.max(mx, Math.abs(v - b[i])), 0);
const rows = [];
let ok = true;
const check = (name, v, lim) => {
  const pass = v < lim;
  ok &&= pass;
  rows.push({ 항목: name, 값: v.toExponential(2), 기준: lim === Infinity ? "-" : `< ${lim}`, 결과: lim === Infinity ? "참고" : pass ? "통과" : "실패" });
};

// 1. erf (GELU)
check("erf |Δ| 최대 (−7..7, 2,801점)", maxAbs(fx.erf.x.map(erf), fx.erf.y), 1e-12);

// 2. 층별 중간값 (앞 8구)
const tr = {};
predict(m, fx.rows.slice(0, fx.trace_rows), tr);
check("토큰 |Δ| 최대", maxAbs(Array.from(tr.tokens), fx.trace.tokens), 1e-5);
tr.blocks.forEach((b, i) => check(`블록 ${i + 1} 출력 |Δ| 최대`, maxAbs(Array.from(b), fx.trace.blocks[i]), 1e-4));
check("basis z |Δ| 최대", maxAbs(Array.from(tr.basis), fx.trace.basis), 1e-4);
check("ZIB 출력 |Δ| 최대", maxAbs(Array.from(tr.zib), fx.trace.zib), 1e-4);

// 3. 1,000구 예측·구위
const pred = predict(m, fx.rows);
const sc = Array.from(pred, (p) => score(m, p));
check(`예측 E[Y] |Δ| 최대 (${fx.rows.length}구)`, maxAbs(Array.from(pred), fx.pred), 1e-5);
check("구위 |Δ| 최대 (vs StuffScaler 정확값)", maxAbs(sc, fx.score_exact), 0.05);
check("구위 |Δ| 최대 (vs Python 표 보간)", maxAbs(sc, fx.score_table), 0.01);
const worst = sc.map((s, i) => [Math.abs(s - fx.score_exact[i]), i]).sort((a, b) => b[0] - a[0])[0];

// 4. 반응 곡선 20개 × 41점 (같은 구종 1–99 분위, 나머지 입력 고정)
let cPred = 0, cScore = 0, cX = 0;
for (const c of fx.curves) {
  const r = responseCurve(m, fx.rows[c.row], c.feature, c.lo, c.hi);
  if (r.x.length !== c.pred.length) throw new Error("곡선 점 수 불일치");
  cX = Math.max(cX, Math.abs(r.x[r.x.length - 1] - c.hi), Math.abs(r.x[0] - c.lo));
  cPred = Math.max(cPred, maxAbs(Array.from(r.pred), c.pred));
  cScore = Math.max(cScore, maxAbs(r.score, c.score_exact));
}
const feats = new Set(fx.curves.map((c) => c.feature));
check(`곡선 예측 |Δ| 최대 (${fx.curves.length}개 × ${CURVE_POINTS}점, 변수 ${feats.size}개)`, cPred, 1e-5);
check("곡선 구위 |Δ| 최대 (vs StuffScaler 정확값)", cScore, 0.05);
check("곡선 격자 끝점 |Δ|", cX, 1e-9);

// 4b. 유사 투구 검색 표현 embed() : ZIB 은닉 64 (앞 hidden_rows 구)
if (fx.hidden) {
  const emb = embed(m, fx.rows.slice(0, fx.hidden_rows)).flatMap((v) => Array.from(v));
  check(`embed() ZIB 은닉 |Δ| 최대 (${fx.hidden_rows}구 × 64)`, maxAbs(emb, fx.hidden), 1e-5);
}

// 5. 속도 (참고, Node 기준) : 1구, 41구 배치 (반응 곡선)
const time = (f, n) => {
  for (let i = 0; i < 3; i++) f();
  const ts = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    f();
    ts.push(performance.now() - t);
  }
  return ts.sort((a, b) => a - b)[Math.floor(n / 2)];
};
const one = time(() => predict(m, fx.rows.slice(0, 1)), 50);
const b41 = time(() => predict(m, fx.rows.slice(0, 41)), 20);
const c0 = fx.curves[0];
const curveMs = time(() => responseCurve(m, fx.rows[c0.row], c0.feature, c0.lo, c0.hi), 20);
check("1구 예측 ms (중앙값)", one, Infinity);
check("41구 배치 ms (중앙값)", b41, Infinity);
check("반응 곡선 1개 ms (중앙값, 기준 100ms)", curveMs, Infinity);

console.table(rows);
console.log(`가장 큰 구위 차이 : ${fx.rows.length}구 중 ${worst[1]}번째, |Δ| ${worst[0].toFixed(4)}`);
console.log(ok ? "패리티 통과" : "패리티 실패");
process.exit(ok ? 0 : 1);
