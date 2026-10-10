"use client";
import type { SeasonIndex } from "@/lib/types";
import { useT } from "@/lib/i18n";

/** 시즌 기간·기준일·out-of-sample 안내 */
export default function SeasonNotice({ index, trainSeason }: { index: SeasonIndex; trainSeason: number }) {
  const t = useT().seasonNotice;
  return (
    <p className="text-xs text-muted -mt-1">
      {t.base(index.regularStart, index.regularEnd, index.seasonEnd, index.pitchers.length, index.pitches)}{" "}
      {index.outOfSample ? t.oos(trainSeason) : t.train(index.validStart)}
    </p>
  );
}
