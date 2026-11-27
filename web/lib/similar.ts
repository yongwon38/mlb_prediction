// ---------------------------------------------------------------------------
// 유사 투구 검색 : 시즌 인덱스(data/{season}/similar.json, export_similar.py)에서 투수×구종 코사인 kNN
// 규칙은 export_similar.standardize · search 와 같다 : 차원별 표준화(모집단 표준편차, 0 이면 1, 결측 0) → 단위 벡터 → 내적 → 같은 투수 제외 → 상위 k (동점은 순서대로)
// 공간 : model = HOF-Net-R ZIB 은닉 64 (투구별 값의 평균), input = 모델 입력 13개 평균 + 투구손(우 +1, 좌 −1)
// 의존성 없음 → 브라우저와 Node 패리티 스크립트(scripts/similar_parity.mjs)가 같은 파일을 쓴다
// ---------------------------------------------------------------------------

export type SimSpace = "model" | "input";

export interface SimilarItem {
  id: number;
  name: string;
  hand: string;
  pt: string;
  n: number;
  whiff: number | null;
  stuff: number | null;
}

export interface SimilarIndexJson {
  season: number;
  asOf: string;
  model: string;
  model_sha256: string;
  minN: number;
  inputCols: string[];
  dims: { model: number; input: number };
  items: SimilarItem[];
  vecModel: string; // float16 리틀엔디언 base64 (n × dims.model)
  vecInput: string; // float32 리틀엔디언 base64 (n × dims.input)
}

interface Space {
  dim: number;
  raw: Float64Array; // n × dim 원값
  unit: Float64Array; // n × dim 표준화·단위 벡터
  mu: Float64Array;
  sd: Float64Array;
}

export interface SimilarIndex {
  json: SimilarIndexJson;
  n: number;
  spaces: Record<SimSpace, Space>;
}

export interface Neighbor {
  i: number;
  sim: number;
}

function bytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** IEEE 754 binary16 → number (Float16Array 가 없는 브라우저용) */
function halfToFloat(h: number): number {
  const s = h & 0x8000 ? -1 : 1;
  const e = (h >> 10) & 0x1f;
  const f = h & 0x3ff;
  if (e === 0) return s * f * 2 ** -24;
  if (e === 31) return f ? NaN : s * Infinity;
  return s * (1 + f / 1024) * 2 ** (e - 15);
}

function decode(b64: string, kind: "f16" | "f32"): Float64Array {
  const u8 = bytes(b64);
  const dv = new DataView(u8.buffer);
  const n = kind === "f16" ? u8.length / 2 : u8.length / 4;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = kind === "f16" ? halfToFloat(dv.getUint16(i * 2, true)) : dv.getFloat32(i * 4, true);
  return out;
}

/** 차원별 평균·모집단 표준편차 (결측 제외) */
function stats(raw: Float64Array, n: number, dim: number) {
  const mu = new Float64Array(dim), sd = new Float64Array(dim);
  for (let j = 0; j < dim; j++) {
    let s = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const v = raw[i * dim + j];
      if (!Number.isNaN(v)) {
        s += v;
        c++;
      }
    }
    const m = c ? s / c : 0;
    let ss = 0;
    for (let i = 0; i < n; i++) {
      const v = raw[i * dim + j];
      if (!Number.isNaN(v)) ss += (v - m) ** 2;
    }
    mu[j] = m;
    const v = c ? Math.sqrt(ss / c) : 0;
    sd[j] = v > 0 ? v : 1;
  }
  return { mu, sd };
}

/** 원값 벡터 → 표준화 단위 벡터 (결측 0) */
function toUnit(x: ArrayLike<number>, mu: Float64Array, sd: Float64Array): Float64Array {
  const dim = mu.length;
  const z = new Float64Array(dim);
  let nn = 0;
  for (let j = 0; j < dim; j++) {
    const v = (x[j] - mu[j]) / sd[j];
    z[j] = Number.isNaN(v) ? 0 : v;
    nn += z[j] * z[j];
  }
  const norm = Math.max(Math.sqrt(nn), 1e-12);
  for (let j = 0; j < dim; j++) z[j] /= norm;
  return z;
}

export function loadSimilarIndex(json: SimilarIndexJson): SimilarIndex {
  const n = json.items.length;
  const build = (raw: Float64Array, dim: number): Space => {
    if (raw.length !== n * dim) throw new Error(`similar.json 벡터 크기 불일치 ${raw.length} != ${n}×${dim}`);
    const { mu, sd } = stats(raw, n, dim);
    const unit = new Float64Array(n * dim);
    for (let i = 0; i < n; i++) unit.set(toUnit(raw.subarray(i * dim, (i + 1) * dim), mu, sd), i * dim);
    return { dim, raw, unit, mu, sd };
  };
  return {
    json,
    n,
    spaces: { model: build(decode(json.vecModel, "f16"), json.dims.model), input: build(decode(json.vecInput, "f32"), json.dims.input) },
  };
}

/** 질의 원값 벡터(가상 투구 등)를 그 공간의 단위 벡터로 */
export const queryUnit = (idx: SimilarIndex, space: SimSpace, raw: ArrayLike<number>) => toUnit(raw, idx.spaces[space].mu, idx.spaces[space].sd);

/** 단위 벡터 q 의 코사인 상위 k. excludeId 투수의 구종은 제외 */
export function search(idx: SimilarIndex, space: SimSpace, q: Float64Array, excludeId: number | null, k = 10): Neighbor[] {
  const { unit, dim } = idx.spaces[space];
  const res: Neighbor[] = [];
  for (let i = 0; i < idx.n; i++) {
    if (excludeId !== null && idx.json.items[i].id === excludeId) continue;
    let s = 0;
    for (let j = 0; j < dim; j++) s += unit[i * dim + j] * q[j];
    res.push({ i, sim: s });
  }
  res.sort((a, b) => b.sim - a.sim || a.i - b.i);
  return res.slice(0, k);
}

/** 인덱스 항목 i 의 이웃 (같은 투수 제외) */
export function searchItem(idx: SimilarIndex, space: SimSpace, i: number, k = 10): Neighbor[] {
  const { unit, dim } = idx.spaces[space];
  return search(idx, space, unit.slice(i * dim, (i + 1) * dim), idx.json.items[i].id, k);
}

/** 항목 i 의 입력 원값 (inputCols 순서) */
export function inputRaw(idx: SimilarIndex, i: number): Float64Array {
  const { raw, dim } = idx.spaces.input;
  return raw.slice(i * dim, (i + 1) * dim);
}

export interface InputDiff {
  col: string;
  diff: number; // 이웃 − 질의 (원값 단위)
  z: number; // 표준편차 단위
}

/** 질의 대비 이웃의 입력 차이 중 표준편차 단위로 가장 큰 k개 */
export function inputDiffs(idx: SimilarIndex, query: ArrayLike<number>, i: number, k = 3): InputDiff[] {
  const { sd } = idx.spaces.input;
  const x = inputRaw(idx, i);
  return idx.json.inputCols
    .map((col, j) => ({ col, diff: x[j] - query[j], z: (x[j] - query[j]) / sd[j] }))
    .filter((d) => Number.isFinite(d.z))
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, k);
}

/** 인덱스에서 투수·구종 위치 (없으면 -1) */
export const findItem = (idx: SimilarIndex, id: number, pt: string) => idx.json.items.findIndex((it) => it.id === id && it.pt === pt);
