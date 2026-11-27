// ---------------------------------------------------------------------------
// HOF-Net-R (시드 42 단일) 브라우저 추론 : 구위 시뮬레이터용
// 모델 파일 = public/sim/hof_r.json (export_sim_model.py). 기준 사양은 export_sim_model.py 의 numpy forward (sim_predict)
// 의존성 없음 (React·DOM 미사용) -> 브라우저·Node 패리티 테스트(scripts/sim_parity.mjs)가 같은 파일을 쓴다
//
// 예측 E[Y] (예측 타구질, 낮을수록 좋은 구위) -> score() 로 구위 20–80 (학습기간 ECDF 표 선형보간)
// 중간값은 float32 로 저장 (torch float32 와 같은 반올림 지점), 마지막 ZIB 평균만 float64
// ---------------------------------------------------------------------------

export interface SimModelJson {
  format: string;
  model: string;
  seeds: number[];
  model_sha256: string;
  created: string;
  arch: { d: number; heads: number; layers: number; d_r: number; ln_eps: number; precision_floor: number; gelu: string };
  input_features: string[];
  num_cols: string[];
  cat_cols: string[];
  cats: string[][];
  mean: number[];
  std: number[];
  havaa: { feature: string; coef: Record<string, [number, number]>; default: [number, number] };
  pitch_types: string[];
  scaler: { score_lo: number; score_hi: number; n: number; fit_n: number; neg_pred: number[] };
  tensors: Record<string, { shape: number[]; offset: number }>;
  n_weights: number;
  weights_b64: string;
}

export interface SimModel {
  json: SimModelJson;
  w: Record<string, Float32Array>;
  /** 토큰 수 (수치 13 + 범주 1) */
  K: number;
  d: number;
}

/** 입력 1구 : input_features 원값 (release_speed … ivb_diff, vaa, plate_z, p_throws, pitch_type). 결측은 null/NaN/undefined */
export type PitchInput = Record<string, number | string | null | undefined>;

/** 패리티 테스트용 중간값 (행 우선 평탄화) */
export interface SimTrace {
  tokens?: Float32Array; // (B, K, d)
  blocks?: Float32Array[]; // 블록마다 (B, K, d)
  basis?: Float32Array; // (B, d_r)
  zib?: Float32Array; // (B, 3) : logit π, m_B 앞 항, precision 원값
}

export function loadSimModel(json: SimModelJson): SimModel {
  const bin = atob(json.weights_b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const flat = new Float32Array(bytes.buffer); // 리틀엔디언 float32 (브라우저·Node 모두 LE)
  if (flat.length !== json.n_weights) throw new Error(`hof_r.json 가중치 수 불일치 ${flat.length} != ${json.n_weights}`);
  const w: Record<string, Float32Array> = {};
  for (const [k, t] of Object.entries(json.tensors)) {
    const n = t.shape.reduce((a, b) => a * b, 1);
    w[k] = flat.subarray(t.offset, t.offset + n);
  }
  return { json, w, K: json.num_cols.length + json.cat_cols.length, d: json.arch.d };
}

// --- 스칼라 함수 ----------------------------------------------------------

const f32 = Math.fround;

// erf : fdlibm s_erf.c (배정밀도, 오차 < 1ulp). torch GELU(approximate='none') = 0.5·x·(1 + erf(x/√2))
const ERX = 8.45062911510467529297e-1;
const EFX = 1.28379167095512586316e-1;
const PP = [1.28379167095512558561e-1, -3.25042107247001499370e-1, -2.84817495755985104766e-2, -5.77027029648944159157e-3, -2.37630166566501626084e-5];
const QQ = [3.97917223959155352819e-1, 6.50222499887672944485e-2, 5.08130628187576562776e-3, 1.32494738004321644526e-4, -3.96022827877536812320e-6];
const PA = [-2.36211856075265944077e-3, 4.14856118683748331666e-1, -3.72207876035701323847e-1, 3.18346619901161753674e-1, -1.10894694282396677476e-1, 3.54783043256182359371e-2, -2.16637559486879084300e-3];
const QA = [1.06420880400844228286e-1, 5.40397917702171048937e-1, 7.18286544141962662868e-2, 1.26171219808761642112e-1, 1.36370839120290507362e-2, 1.19844998467991074170e-2];
const RA = [-9.86494403484714822705e-3, -6.93858572707181764372e-1, -1.05586262253232909814e1, -6.23753324503260060396e1, -1.62396669462573470355e2, -1.84605092906711035994e2, -8.12874355063065934246e1, -9.81432934416914548592];
const SA = [1.96512716674392571292e1, 1.37657754143519042600e2, 4.34565877475229228821e2, 6.45387271733267880336e2, 4.29008140027567833386e2, 1.08635005541779435134e2, 6.57024977031928170135, -6.04244152148580987438e-2];
const RB = [-9.86494292470009928597e-3, -7.99283237680523006574e-1, -1.77579549177547519889e1, -1.60636384855821916062e2, -6.37566443368389627722e2, -1.02509513161107724954e3, -4.83519191608651397019e2];
const SB = [3.03380607434824582924e1, 3.25792512996573918826e2, 1.53672958608443695994e3, 3.19985821950859553908e3, 2.55305040643316442583e3, 4.74528541206955367215e2, -2.24409524465858183362e1];

/** c[0] + s·(c[1] + s·(…)) */
function poly(c: number[], s: number): number {
  let r = c[c.length - 1];
  for (let i = c.length - 2; i >= 0; i--) r = c[i] + s * r;
  return r;
}

/** 1 + s·(c[0] + s·(c[1] + …)) */
const poly1 = (c: number[], s: number) => 1 + s * poly(c, s);

const _f64 = new Float64Array(1);
const _u32 = new Uint32Array(_f64.buffer);
const LOW = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1 ? 0 : 1; // 리틀엔디언이면 하위 워드 = [0]

export function erf(x: number): number {
  if (Number.isNaN(x)) return NaN;
  const ax = Math.abs(x);
  const sign = x < 0 ? -1 : 1;
  if (ax < 0.84375) {
    if (ax < 3.725290298461914e-9) return x + EFX * x;
    const z = x * x;
    return x + x * (poly(PP, z) / poly1(QQ, z));
  }
  if (ax < 1.25) {
    const s = ax - 1;
    return sign * (ERX + poly(PA, s) / poly1(QA, s));
  }
  if (ax >= 6) return sign;
  const s = 1 / (ax * ax);
  const R = ax < 1 / 0.35 ? poly(RA, s) : poly(RB, s);
  const S = ax < 1 / 0.35 ? poly1(SA, s) : poly1(SB, s);
  _f64[0] = ax;
  _u32[LOW] = 0; // fdlibm SET_LOW_WORD(z, 0)
  const z = _f64[0];
  const r = Math.exp(-z * z - 0.5625) * Math.exp((z - ax) * (z + ax) + R / S);
  return sign * (1 - r / ax);
}

export const gelu = (x: number) => 0.5 * x * (1 + erf(x * Math.SQRT1_2));
const sigmoid = (x: number) => 1 / (1 + Math.exp(-x));
const softplus = (x: number) => (x > 20 ? x : Math.log1p(Math.exp(x))); // torch 기본 threshold 20

// --- 선형 연산 ------------------------------------------------------------

/** out(rows, nOut) = x(rows, nIn) · Wᵀ + b   (W 는 torch Linear (nOut, nIn)) */
function linear(x: Float32Array, rows: number, nIn: number, W: Float32Array, b: Float32Array, act?: (v: number) => number): Float32Array {
  const nOut = b.length;
  const out = new Float32Array(rows * nOut);
  for (let r = 0; r < rows; r++) {
    const xo = r * nIn;
    for (let o = 0; o < nOut; o++) {
      const wo = o * nIn;
      let s = 0;
      for (let i = 0; i < nIn; i++) s += x[xo + i] * W[wo + i];
      s = f32(s + b[o]);
      out[r * nOut + o] = act ? act(s) : s;
    }
  }
  return out;
}

function layerNorm(x: Float32Array, rows: number, d: number, g: Float32Array, b: Float32Array, eps: number): Float32Array {
  const out = new Float32Array(rows * d);
  for (let r = 0; r < rows; r++) {
    const o = r * d;
    let mu = 0;
    for (let i = 0; i < d; i++) mu += x[o + i];
    mu /= d;
    let v = 0;
    for (let i = 0; i < d; i++) v += (x[o + i] - mu) ** 2;
    const inv = 1 / Math.sqrt(v / d + eps);
    for (let i = 0; i < d; i++) out[o + i] = (x[o + i] - mu) * inv * g[i] + b[i];
  }
  return out;
}

// --- 전처리 ---------------------------------------------------------------

const toNum = (v: number | string | null | undefined): number => {
  if (v === null || v === undefined || v === "") return NaN;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
};

/** HAVAA = vaa − (a + b·plate_z), 구종별 계수 (없는 구종은 공통 계수). 입력 결측이면 NaN */
export function havaa(m: SimModel, vaa: number, plateZ: number, pitchType: string | null | undefined): number {
  const h = m.json.havaa;
  const [a, b] = (pitchType != null && h.coef[String(pitchType)]) || h.default;
  return vaa - (a + plateZ * b);
}

/** 모델 입력 열 (num_cols 순서, vaa_aa 포함) 원값. row.vaa_aa 가 숫자면 HAVAA 직접 입력으로 쓰고, 아니면 vaa·plate_z·구종으로 계산 */
export function modelInputs(m: SimModel, row: PitchInput): number[] {
  const hf = m.json.havaa.feature;
  return m.json.num_cols.map((c) => {
    if (c !== hf) return toNum(row[c]);
    const direct = toNum(row[hf]);
    return Number.isNaN(direct) ? havaa(m, toNum(row.vaa), toNum(row.plate_z), row.pitch_type as string) : direct;
  });
}

// --- 예측 -----------------------------------------------------------------

/** 여러 구를 한 번에 (반응 곡선 = 41행 배치). 반환 E[Y] (float64) */
export function predict(m: SimModel, rows: PitchInput[], trace?: SimTrace): Float64Array {
  const { w, K, d } = m;
  const { heads, layers, ln_eps, precision_floor } = m.json.arch;
  const B = rows.length;
  const nNum = m.json.num_cols.length;
  const dh = d / heads;
  const scale = 1 / Math.sqrt(dh);

  // 토큰 : 수치 e = x·w + b + miss·m_miss, 범주 = 임베딩 (코드 = 목록 위치 + 1, 모름 0)
  const z = new Float32Array(B * K * d);
  const tw = w["tok.w"], tb = w["tok.b"], tm = w["tok.miss"];
  rows.forEach((row, r) => {
    const raw = modelInputs(m, row);
    for (let k = 0; k < nNum; k++) {
      const v = f32((raw[k] - m.json.mean[k]) / m.json.std[k]);
      const miss = Number.isNaN(v);
      const xv = miss ? 0 : v;
      const o = (r * K + k) * d;
      for (let i = 0; i < d; i++) z[o + i] = f32(f32(xv * tw[k * d + i]) + tb[k * d + i]) + (miss ? tm[k * d + i] : 0);
    }
    m.json.cat_cols.forEach((c, j) => {
      const v = row[c];
      const code = v === null || v === undefined ? 0 : m.json.cats[j].indexOf(String(v)) + 1;
      const emb = w[`cat.${j}`];
      z.set(emb.subarray(code * d, (code + 1) * d), (r * K + nNum + j) * d);
    });
  });
  if (trace) {
    trace.tokens = z.slice();
    trace.blocks = [];
  }

  // 블록 : pre-LN, x + MHA(LN1 x), x + FF(LN2 x)
  const N = B * K;
  for (let l = 0; l < layers; l++) {
    const p = `blk${l}.`;
    const h = layerNorm(z, N, d, w[p + "ln1.g"], w[p + "ln1.b"], ln_eps);
    const qkv = linear(h, N, d, w[p + "attn.in.W"], w[p + "attn.in.b"]); // (N, 3d) : q·k·v 순
    const att = new Float32Array(N * d);
    const sc = new Float64Array(K);
    for (let r = 0; r < B; r++) {
      for (let hd = 0; hd < heads; hd++) {
        const off = hd * dh;
        for (let i = 0; i < K; i++) {
          const qi = (r * K + i) * 3 * d + off;
          let mx = -Infinity;
          for (let j = 0; j < K; j++) {
            const kj = (r * K + j) * 3 * d + d + off;
            let s = 0;
            for (let t = 0; t < dh; t++) s += qkv[qi + t] * qkv[kj + t];
            sc[j] = s * scale;
            if (sc[j] > mx) mx = sc[j];
          }
          let sum = 0;
          for (let j = 0; j < K; j++) sum += (sc[j] = Math.exp(sc[j] - mx));
          const ao = (r * K + i) * d + off;
          for (let t = 0; t < dh; t++) {
            let s = 0;
            for (let j = 0; j < K; j++) s += sc[j] * qkv[(r * K + j) * 3 * d + 2 * d + off + t];
            att[ao + t] = s / sum;
          }
        }
      }
    }
    const a = linear(att, N, d, w[p + "attn.out.W"], w[p + "attn.out.b"]);
    for (let i = 0; i < z.length; i++) z[i] = z[i] + a[i];
    const f1 = linear(layerNorm(z, N, d, w[p + "ln2.g"], w[p + "ln2.b"], ln_eps), N, d, w[p + "ff1.W"], w[p + "ff1.b"], gelu);
    const f2 = linear(f1, N, 2 * d, w[p + "ff2.W"], w[p + "ff2.b"]);
    for (let i = 0; i < z.length; i++) z[i] = z[i] + f2[i];
    if (trace) trace.blocks!.push(z.slice());
  }

  // 헤드 : h = flatten (B, K·d)
  const KD = K * d;
  const zb = linear(linear(z, B, KD, w["basis1.W"], w["basis1.b"], gelu), B, w["basis1.b"].length, w["basis2.W"], w["basis2.b"], gelu);
  const z1 = linear(z, B, KD, w["zib1.W"], w["zib1.b"], gelu);
  const z2 = linear(z1, B, z1.length / B, w["zib2.W"], w["zib2.b"], gelu);
  const o3 = linear(z2, B, z2.length / B, w["zib3.W"], w["zib3.b"]);
  if (trace) {
    trace.basis = zb;
    trace.zib = o3;
  }

  const omega = w["zib.omega"];
  const dr = omega.length - 1;
  const out = new Float64Array(B);
  for (let r = 0; r < B; r++) {
    let mb = 0;
    for (let i = 0; i < dr; i++) mb += zb[r * dr + i] * omega[i];
    mb = f32(o3[r * 3 + 1] + f32(mb + omega[dr]));
    const pm = Math.min(Math.max(f32(sigmoid(mb)), 1e-5), 1 - 1e-5);
    const prec = f32(f32(softplus(o3[r * 3 + 2])) + precision_floor);
    const al = Math.max(f32(pm * prec), 1e-6);
    const be = Math.max(f32(f32(1 - pm) * prec), 1e-6);
    const pi = f32(sigmoid(o3[r * 3]));
    out[r] = (1 - pi) * (al / (al + be));
  }
  return out;
}

/** 예측 E[Y] -> 구위 20–80 (−예측을 등간격 구위 격자 표에서 선형보간) */
export function score(m: SimModel, pred: number): number {
  const { neg_pred: t, score_lo: lo, score_hi: hi, n } = m.json.scaler;
  const x = -pred;
  if (!(x > t[0])) return lo;
  if (x >= t[n - 1]) return hi;
  let a = 0, b = n - 1; // t[a] < x <= t[b]
  while (b - a > 1) {
    const c = (a + b) >> 1;
    if (t[c] < x) a = c;
    else b = c;
  }
  const frac = (x - t[a]) / (t[b] - t[a]);
  return lo + ((a + frac) * (hi - lo)) / (n - 1);
}

/** 구위 점수 바로 (편의) */
export const predictScores = (m: SimModel, rows: PitchInput[]) => Array.from(predict(m, rows), (p) => score(m, p));

// --- 반응 곡선 ------------------------------------------------------------

/** 반응 곡선 격자 점 수 */
export const CURVE_POINTS = 41;

/** 곡선 대상 변수 = 수치 입력 13개 (num_cols, HAVAA 는 vaa_aa 직접 입력). 투구손은 범주라 곡선 대신 L/R 비교 */
export const curveFeatures = (m: SimModel) => m.json.num_cols;

/** lo..hi 등간격 n점 (끝점 포함) */
export function curveGrid(lo: number, hi: number, n = CURVE_POINTS): number[] {
  return Array.from({ length: n }, (_, i) => (n === 1 ? lo : lo + ((hi - lo) * i) / (n - 1)));
}

export interface ResponseCurve {
  feature: string;
  x: number[];
  pred: Float64Array;
  score: number[];
}

/**
 * 변수 하나만 lo..hi 로 바꾸고 나머지 입력은 base 값 그대로 둔 n행을 배치 forward 1회.
 * 범위는 호출 쪽에서 같은 구종 1–99 분위로 준다 (sim_starts.json). 변수 간 상관은 무시 (다른 입력 고정)
 */
export function responseCurve(m: SimModel, base: PitchInput, feature: string, lo: number, hi: number, n = CURVE_POINTS): ResponseCurve {
  if (!m.json.num_cols.includes(feature)) throw new Error(`반응 곡선 대상이 아닌 변수 : ${feature}`);
  const x = curveGrid(lo, hi, n);
  const rows = x.map((v) => ({ ...base, [feature]: v }));
  const pred = predict(m, rows);
  return { feature, x, pred, score: Array.from(pred, (p) => score(m, p)) };
}
