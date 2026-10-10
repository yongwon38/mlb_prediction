// 서버 컴포넌트(layout)에서 쓰므로 "use client" 모듈과 분리

export const LANG_KEY = "lang";

/** 첫 렌더 전에 언어를 정한다 : ?lang= -> 저장된 선택 -> 브라우저 언어 (ko* 면 한국어, 그 외 영어).
 *  정적 HTML 은 한국어로 그려져 있으므로 영어면 하이드레이션이 끝날 때까지 화면을 가린다 (최대 3초) */
export const LANG_INIT_SCRIPT = `(function(){try{var h=document.documentElement,q=new URLSearchParams(location.search).get('lang'),l=(q==='en'||q==='ko')?q:null;
if(l){try{localStorage.setItem('${LANG_KEY}',l)}catch(e){}}else{try{l=localStorage.getItem('${LANG_KEY}')}catch(e){}}
if(l!=='en'&&l!=='ko'){l=(navigator.language||'').toLowerCase().indexOf('ko')===0?'ko':'en'}
h.setAttribute('data-lang',l);h.lang=l;if(l!=='ko'){h.classList.add('lang-pending');setTimeout(function(){h.classList.remove('lang-pending')},3000)}}catch(e){}})();`;
