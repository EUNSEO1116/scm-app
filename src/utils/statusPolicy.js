// 상태(status) 키워드 통합 정책 — 제외키워드 + 상품군 정렬 우선순위의 '유일한 원천'.
// 상태값은 스프레드시트에서 부여되는 자유 텍스트(콤마 구분)이며 부수 키워드가 공존한다.
// 키워드만 통일(원천 일원화)하고, 기능별 제외 '집합'은 의도대로 분리해 각 기능 동작은 유지한다.
// 스프레드시트에 새 키워드가 생겨도 정렬/뱃지가 깨지지 않도록 미분류 키워드는 최하위로 자동 처리한다.

// ── 1. 상품군 정렬 우선순위 (전 기능 공통) ─────────────────────────────
// G1은 상호배타(한 상품에 최대 1개). G2~G6은 한 상품에 중복 가능 → 그룹 순서대로 앞에서 뒤로 나열.
export const STATUS_GROUPS = [
  { id: 1, exclusive: true, keywords: ['효자', '신규', '기준미달', '최종마감', '마감대상', '덤핑', '반출'] },
  { id: 2, keywords: ['품질확인서', '지재권'] },
  { id: 3, keywords: ['여유구매', '광고중', '4,4,8,8'] },
  { id: 4, keywords: ['시즌ON', '시즌OFF'] },
  { id: 5, keywords: ['봄', '여름', '겨울'] },
  { id: 6, keywords: ['FBC'] },
];
const UNCLASSIFIED_GROUP = 99; // 미분류(신규 스프레드시트 키워드) → 최하위 자동

// 토큰 하나가 속한 그룹 id (못 찾으면 최하위). FBC는 대소문자 무시.
function tokenGroupId(token) {
  const t = (token || '').trim();
  if (!t) return UNCLASSIFIED_GROUP;
  const low = t.toLowerCase();
  for (const g of STATUS_GROUPS) {
    for (const kw of g.keywords) {
      if (kw === 'FBC') { if (low.includes('fbc')) return g.id; }
      else if (t.includes(kw)) return g.id;
    }
  }
  return UNCLASSIFIED_GROUP;
}

// 상태 문자열 → 우선순위대로 정렬된 토큰 배열 (콤마 구분, 안정 정렬: 같은 그룹은 원래 순서 유지)
export function sortStatusKeywords(status) {
  const tokens = (status || '').split(',').map((s) => s.trim()).filter(Boolean);
  return tokens
    .map((tok, i) => ({ tok, i, g: tokenGroupId(tok) }))
    .sort((a, b) => a.g - b.g || a.i - b.i)
    .map((x) => x.tok);
}

// 표시용: 우선순위대로 재정렬된 상태 문자열. 토큰이 없으면 원본 그대로.
export function sortStatusText(status) {
  const arr = sortStatusKeywords(status);
  return arr.length ? arr.join(', ') : (status || '');
}

// ── 2. 기능별 제외키워드 (한 곳에서 관리 / 기능별 집합은 의도대로 분리) ──
// 품절현황: 발주를 안 하는(=품절로 볼 수 없는) 등급 제외. 시즌OFF 포함(발주 제외=품절 제외).
//   ※ 시즌ON은 '절대' 미포함 — 발주를 더 하는 등급이므로 품절로 정상 집계돼야 함.
//   ※ 바(bare) '시즌' 금지. 반드시 '시즌OFF'만 정확 매칭.
export const SOLDOUT_EXCLUDE = ['최종마감', '품질확인서', '마감대상', '덤핑', '반출', '지재권', '시즌OFF'];
// 발주추천/재고/예측: 발주 대상 제외 등급. 시즌OFF는 별도 ×0 처리하므로 집합엔 넣지 않는다.
export const ORDER_EXCLUDE = ['최종마감', '품질확인서', '마감대상', '덤핑', '반출'];
// 판매급증 탐지 제외 등급.
export const SURGE_EXCLUDE = ['최종마감', '품질확인서', '마감대상', '덤핑', '반출', '지재권'];

// status가 집합 중 하나라도 포함? (includes 기반 — '시즌OFF'/'시즌ON'은 각각 정확히 매칭됨)
export function includesAnyKeyword(status, keywords) {
  if (!status) return false;
  return keywords.some((kw) => status.includes(kw));
}
export const shouldExcludeSoldout = (s) => includesAnyKeyword(s, SOLDOUT_EXCLUDE);
export const shouldExcludeOrder = (s) => includesAnyKeyword(s, ORDER_EXCLUDE);
export const shouldExcludeSurge = (s) => includesAnyKeyword(s, SURGE_EXCLUDE);

// ── 3. 시즌 키워드 (발주추천 ×배수 판정) — ON을 먼저 판정 ──
export const isSeasonOn = (s) => !!s && s.includes('시즌ON');
export const isSeasonOff = (s) => !!s && !isSeasonOn(s) && s.includes('시즌OFF');

// ── 4. 룰 버전 (제외집합 변경 시 자동 변동 → 수동 bump 폐지) ──
function hashStrings(arr) {
  const str = arr.join('|');
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
export const SOLDOUT_RULE_VERSION = hashStrings(SOLDOUT_EXCLUDE);
