// 상품군(제품군) 분류 중앙 모듈
// 5개 상품군은 상호 배타적이며 최우선순위를 가진다: 효자 / 기준미달 / 신규 / 마감 / .
// '.'(점)은 기존 공백에 해당하는 기본군으로, 시트 함수가 조건에 맞는 상품에 부여한다.
// 상태값은 자유 텍스트(콤마 구분)이며 부수 키워드(여름, 겨울, 지재권, 광고중 등)와 공존할 수 있다.
// 따라서 === 정확일치가 아니라 includes 기반 + 우선순위로 분류한다.

export const GROUPS = ['효자', '기준미달', '신규', '마감', '.'];

// status 문자열 → 5개 상품군 중 하나
export function classifyGroup(status) {
  const s = status || '';
  if (s.includes('최종마감') || s.includes('마감대상')) return '마감';
  if (s.includes('신규')) return '신규';
  if (s.includes('효자')) return '효자';
  if (s.includes('기준미달')) return '기준미달';
  return '.'; // 기본군: 공백 / '.' / 부수 키워드만 있는 경우
}

// 상품군별 뱃지 스타일(인라인). global.css에 '.' 클래스가 없어 인라인으로 통일.
const BADGE_STYLES = {
  효자: { background: '#e6f4ea', color: '#137333' },
  기준미달: { background: '#fef7e0', color: '#e37400' },
  신규: { background: '#e8f0fe', color: '#1967d2' },
  마감: { background: '#f1f3f4', color: '#80868b' },
  '.': { background: '#ede7f6', color: '#5e35b1' }, // 기본군 전용(보라) 뱃지
};

export function groupBadgeStyle(group) {
  return BADGE_STYLES[group] || BADGE_STYLES['.'];
}

// status 문자열을 직접 받아 뱃지 스타일 반환
export function statusBadgeStyle(status) {
  return groupBadgeStyle(classifyGroup(status));
}
