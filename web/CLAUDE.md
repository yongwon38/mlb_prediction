@AGENTS.md

- 화면 문구는 코드에 직접 쓰지 않는다. `lib/i18n/ko.ts`와 `lib/i18n/en.ts`에 같은 키로 두 언어를 함께 추가하고 `useT()`로 쓴다 (en 은 ko 와 같은 타입이라 키가 빠지면 타입 오류)
