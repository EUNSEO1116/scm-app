// 전체 페이지 레지스트리 — 도움말 관리에서 "모든 페이지"를 선택할 수 있게 하는 목록.
// key: 튜토리얼 pageKey(고유·불변), path: 라우트, label: 표시명, group: 메뉴 그룹.
// 새 페이지가 생기면 여기에 한 줄 추가하면 관리 페이지·전역 도움말 버튼에 자동 반영됩니다.
export const pageGroups = [
  { group: '재고관리', pages: [
    { key: 'inventory-calculator', path: '/inventory', label: '재고 계산기' },
    { key: 'incoming', path: '/inventory/incoming', label: '입고신청' },
    { key: 'order-recommend', path: '/inventory/recommend', label: '발주추천' },
    { key: 'order-request', path: '/inventory/order', label: '발주신청' },
    { key: 'orderbook', path: '/inventory/orderbook', label: '발주장부' },
    { key: 'incheon', path: '/inventory/incheon', label: '인천입고신청' },
  ]},
  { group: '매출관리', pages: [
    { key: 'sales', path: '/sales', label: '매출관리' },
    { key: 'sales-forecast', path: '/sales/forecast', label: '수요예측' },
    { key: 'sales-ranking', path: '/soldout-analysis/history', label: '일일 매출 순위' },
  ]},
  { group: '품절분석', pages: [
    { key: 'soldout-analysis', path: '/soldout-analysis', label: '품절현황' },
    { key: 'remarket', path: '/soldout-analysis/remarket', label: '재마케팅' },
    { key: 'soldout-exclude', path: '/soldout-analysis/exclude', label: '제외품목관리' },
    { key: 'soldout-rate', path: '/soldout-analysis/rate', label: '월 품절률' },
    { key: 'delay-cause', path: '/soldout-analysis/delay-cause', label: '보충 지연 원인 관리' },
    { key: 'soldout-upload', path: '/soldout-analysis/upload', label: '데이터 업로드' },
  ]},
  { group: '품질관리', pages: [
    { key: 'issue', path: '/issue', label: '특별관리' },
    { key: 'improvement', path: '/issue/improvement', label: '상품개선' },
    { key: 'certification', path: '/issue/certification', label: '인증관리' },
  ]},
  { group: '기타관리', pages: [
    { key: 'supplies', path: '/supplies', label: '부자재 목록' },
    { key: 'supplies-order', path: '/supplies/order', label: '부자재 발주' },
    { key: 'fbc', path: '/fbc', label: 'FBC 비용 계산기' },
    { key: 'dashboard', path: '/dashboard', label: '절감 대시보드' },
    { key: 'fbc-items', path: '/fbc/items', label: 'FBC 품목' },
    { key: 'fbc-pallet', path: '/fbc/pallet', label: 'FBC 사전계산기' },
  ]},
  { group: 'CN 결산', pages: [
    { key: 'cn-upload', path: '/cn-settlement/upload', label: '거래 데이터 업로드' },
    { key: 'cn-dashboard', path: '/cn-settlement/dashboard', label: '결산 대시보드' },
    { key: 'cn-history', path: '/cn-settlement/history', label: '결산 기록' },
  ]},
];

export const allPages = pageGroups.flatMap(g => g.pages.map(p => ({ ...p, group: g.group })));

// 라우트 경로 → pageKey (전역 도움말 버튼이 현재 페이지를 식별)
export const pathToPageKey = Object.fromEntries(allPages.map(p => [p.path, p.key]));

// pageKey → 표시명
export const keyToLabel = Object.fromEntries(allPages.map(p => [p.key, p.label]));
