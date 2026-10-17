"use client";
import { useT } from "@/lib/i18n";
import { useModel } from "@/lib/model";

/** 모델 설명 (모든 페이지 하단 공통). 3단계 설명은 선택한 구위 모델 기준 */
export default function Methodology() {
  const m = useT().methodology;
  const model = useModel();
  return (
    <details className="card p-4 text-xs text-ink-2 leading-relaxed">
      <summary className="cursor-pointer font-semibold text-ink text-sm">{m.summary}</summary>
      <ol className="list-decimal pl-5 mt-2 flex flex-col gap-1">
        <li>{m.s1}</li>
        <li>{m.s2}</li>
        <li>
          {model === "hof" ? m.s3aHof : m.s3a} <b>{m.s3b}</b> {m.s3c}
        </li>
        <li>{m.s4}</li>
        <li>{m.s5}</li>
      </ol>
      <p className="mt-2 text-muted">{m.note}</p>
    </details>
  );
}
