"use client";
import { useSyncExternalStore } from "react";

// ---------------------------------------------------------------------------
// 구위 모델 선택 (lgbm = LightGBM v4, hof = HOF-Net-R)
// 웹 기본은 DEFAULT_MODEL. 기본이 아닌 모델은 URL ?model=.. 로 유지되고(ctxHref 가 자동으로 붙임), 바뀌면 각 페이지가 해당 모델 데이터를 다시 읽는다
// LGBM 으로 되돌리기 : DEFAULT_MODEL = "lgbm", SHOW_MODEL_PICKER = true
// ---------------------------------------------------------------------------
export type ModelId = "lgbm" | "hof";
/** 웹 기본 모델 (2026-11-21 부터 HOF-Net-R) */
export const DEFAULT_MODEL: ModelId = "hof";
/** 상단 모델 선택 버튼·실험 모델 안내 배너 표시. 숨겨도 ?model=lgbm 으로 LGBM 확인 가능 */
export const SHOW_MODEL_PICKER = false;
/** 데이터 파일 기준 모델 (export_web_data.MODEL_VERSION) : 접미사 없는 index.json 등 = lgbm. UI 기본값과 별개 */
export const DATA_BASE_MODEL: ModelId = "lgbm";

/** 투수 파일의 대체 모델 필드 접두사 (export_web_data.ALT_FIELD) : 점수 s -> sh, 기여 c0 -> h0 */
export const MODEL_FIELD: Record<ModelId, string> = { lgbm: "", hof: "h" };

/** 집계 파일 접미사 : index.json / index.hof.json */
export const modelSuffix = (m: ModelId) => (m === DATA_BASE_MODEL ? "" : `.${m}`);

export const parseModel = (v: string | null): ModelId => (v === "hof" || v === "lgbm" ? v : DEFAULT_MODEL);

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
