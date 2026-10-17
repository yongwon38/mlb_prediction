"use client";
import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// 구위 모델 선택 (lgbm = LightGBM v4 웹 기본, hof = HOF-Net-R 실험 모델)
// URL ?model=hof 로 유지되고(ctxHref 가 자동으로 붙임), 바뀌면 각 페이지가 해당 모델 데이터를 다시 읽는다
// ---------------------------------------------------------------------------
export type ModelId = "lgbm" | "hof";
export const DEFAULT_MODEL: ModelId = "lgbm";

/** 투수 파일의 대체 모델 필드 접두사 (export_web_data.ALT_FIELD) : 점수 s -> sh, 기여 c0 -> h0 */
export const MODEL_FIELD: Record<ModelId, string> = { lgbm: "", hof: "h" };

/** 집계 파일 접미사 : index.json / index.hof.json */
export const modelSuffix = (m: ModelId) => (m === DEFAULT_MODEL ? "" : `.${m}`);

export const parseModel = (v: string | null): ModelId => (v === "hof" ? "hof" : DEFAULT_MODEL);

let model: ModelId = DEFAULT_MODEL;
const listeners = new Set<() => void>();

export const getModel = () => model;

export function setModel(m: ModelId) {
  if (m === model) return;
  model = m;
  listeners.forEach((l) => l());
}

export function useModel(): ModelId {
  return useSyncExternalStore(
    (l) => (listeners.add(l), () => listeners.delete(l)),
    () => model,
    () => DEFAULT_MODEL,
  );
}
