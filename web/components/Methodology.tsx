/** 모델 설명 (모든 페이지 하단 공통) */
export default function Methodology() {
  return (
    <details className="card p-4 text-xs text-ink-2 leading-relaxed">
      <summary className="cursor-pointer font-semibold text-ink text-sm">모델 설명 — 구위(Stuff) 20–80</summary>
      <ol className="list-decimal pl-5 mt-2 flex flex-col gap-1">
        <li>타구방향·타구속도·발사각·공격각도로 타구 결과(아웃/1루타/2·3루타/홈런)를 예측 (RandomForest).</li>
        <li>예측 기대값을 Gamma → Beta 변환해 0–1 타구질 score 로 만듦. 헛스윙은 0 (루킹 삼진은 학습에서 제외).</li>
        <li>
          투구 물리량(구속, 무브먼트, 릴리스, 익스텐션, 회전수·축, 팔각도, 홈플레이트 진입각 VAA·HAA, 주 패스트볼 대비 차이 등)으로 타구질 score 를 예측 (LGBM).{" "}
          <b>로케이션·카운트·타자 정보는 쓰지 않음</b> — 같은 공이면 어디에 던지든 같은 구위.
        </li>
        <li>예측값을 학습기간 분포 기준 정규분위수로 바꿔 50 + 10z (20–80) 스케일로 표시. 50 = 리그 평균 투구.</li>
        <li>존에서 크게 벗어난 볼(Savant Waste 존)과 사구는 구위 점수를 매기지 않고 위치만 표시.</li>
      </ol>
      <p className="mt-2 text-muted">
        데이터 : Statcast (pybaseball). 모델 학습·리그 기준값은 정규시즌, 화면에는 시범경기·포스트시즌 투구도 같은 모델로 점수를 매겨 표시(경기 유형 선택). 존 높이는 타자별 존(sz_top/sz_bot)으로 1.5–3.5ft 에 정규화. 타구 위치는 Statcast hc_x/hc_y 를 피트로 환산(외야 펜스는 330–400ft 근사).
        &lsquo;구위 구간&rsquo; 선택은 투구 로케이션·타구 분포에만 적용된다.
      </p>
    </details>
  );
}
