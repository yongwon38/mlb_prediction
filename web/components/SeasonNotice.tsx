import type { SeasonIndex } from "@/lib/types";

/** 시즌 기간·기준일·out-of-sample 안내 */
export default function SeasonNotice({ index, trainSeason }: { index: SeasonIndex; trainSeason: number }) {
  return (
    <p className="text-xs text-muted -mt-1">
      정규시즌 {index.regularStart} ~ {index.regularEnd} · 데이터 기준일 {index.seasonEnd} · 투수 {index.pitchers.length.toLocaleString()}명 · 정규시즌 {index.pitches.toLocaleString()}구.{" "}
      {index.outOfSample
        ? `${trainSeason} 시즌으로 학습한 모델을 그대로 적용한 out-of-sample 점수입니다.`
        : `모델 학습 시즌입니다. ${index.validStart} 이후는 학습에 쓰지 않은 검증기간이므로, 결과 지표를 엄밀히 보려면 '검증기간만' 필터를 사용하세요.`}
    </p>
  );
}
