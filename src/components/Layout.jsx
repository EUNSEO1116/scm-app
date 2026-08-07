import { NavLink, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { getSurgeForDisplay } from '../utils/salesSurge.js';

const navItems = [
  { id: 'inventory', label: '재고관리', children: [
    { label: '재고 계산기', path: '/inventory' },
    { label: '입고신청', path: '/inventory/incoming' },
    { label: '발주추천', path: '/inventory/recommend' },
    { label: '발주신청', path: '/inventory/order' },
    { label: '발주장부', path: '/inventory/orderbook' },
    { label: '인천입고신청', path: '/inventory/incheon' },
  ]},
  { id: 'sales', label: '매출관리', badge: 'surge', children: [
    { label: '매출관리', path: '/sales', badge: 'surge' },
    { label: '수요예측', path: '/sales/forecast' },
    { label: '* 일일 매출 순위', path: '/soldout-analysis/history' },
  ]},
  { id: 'soldout-analysis', label: '품절분석', children: [
    { label: '* 품절현황', path: '/soldout-analysis' },
    { label: '제외품목관리', path: '/soldout-analysis/exclude' },
    { label: '월 품절률', path: '/soldout-analysis/rate' },
    { label: '보충 지연 원인 관리', path: '/soldout-analysis/delay-cause' },
    { label: '데이터 업로드', path: '/soldout-analysis/upload' },
  ]},
  { id: 'issue', label: '품질관리', children: [
    { label: '특별관리', path: '/issue' },
    { label: '* 상품개선', path: '/issue/improvement' },
    { label: '인증관리', path: '/issue/certification' },
  ]},
  { id: 'etc', label: '기타관리', children: [
    { section: '부자재관리' },
    { label: '부자재 목록', path: '/supplies' },
    { label: '부자재 발주', path: '/supplies/order' },
    { section: 'FBC관리' },
    { label: 'FBC 비용 계산기', path: '/fbc' },
    { label: '절감 대시보드', path: '/dashboard' },
    { label: 'FBC 품목', path: '/fbc/items' },
    { label: '* FBC 사전계산기', path: '/fbc/pallet' },
  ]},
];

const rightNavItems = [
  { id: 'cn-settlement', label: '* CN 결산', children: [
    { label: '거래 데이터 업로드', path: '/cn-settlement/upload' },
    { label: '결산 대시보드', path: '/cn-settlement/dashboard' },
    { label: '결산 기록', path: '/cn-settlement/history' },
  ]},
];

function Badge({ value }) {
  if (!value) return null;
  return <span className="nav-badge">{value}</span>;
}

function NavGroup({ item, openMenu, setOpenMenu, counts, alignRight }) {
  const location = useLocation();
  const isActive = item.children.some(c => c.path === location.pathname);
  const isOpen = openMenu === item.id;
  const groupBadge = item.badge ? counts[item.badge] : 0;
  return (
    <div
      className="topnav-group"
      onMouseEnter={() => setOpenMenu(item.id)}
      onMouseLeave={() => setOpenMenu(null)}
    >
      <button className={`topnav-item${isActive ? ' active' : ''}${isOpen ? ' open' : ''}`}>
        <span>{item.label}</span>
        <Badge value={groupBadge} />
        <svg className="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {isOpen && (
        <div className={`topnav-dropdown${alignRight ? ' align-right' : ''}`}>
          {item.children.map((child, i) => (
            child.section ? (
              <div key={`sec-${i}`} className="dropdown-section">{child.section}</div>
            ) : (
              <NavLink
                key={child.path}
                to={child.path}
                end
                className={({ isActive }) => `dropdown-item ${isActive ? 'active' : ''}`}
                onClick={() => setOpenMenu(null)}
              >
                <span>{child.label}</span>
                <Badge value={child.badge ? counts[child.badge] : 0} />
              </NavLink>
            )
          ))}
        </div>
      )}
    </div>
  );
}

export default function Layout({ children }) {
  const location = useLocation();
  const [openMenu, setOpenMenu] = useState(null);
  const [surgeCount, setSurgeCount] = useState(0);

  const isHome = location.pathname === '/';

  // 신규 판매 급증 건수 (상단 매출관리 메뉴 뱃지)
  // 품절분석>데이터 업로드(오늘자) 시 저장된 스냅샷을 읽어 표시. 다음 업로드 전까지 유지.
  useEffect(() => {
    let alive = true;
    getSurgeForDisplay().then(snap => {
      if (alive && snap) setSurgeCount(snap.count || 0);
    });
    return () => { alive = false; };
  }, []);

  const counts = { surge: surgeCount };

  return (
    <div className="app-layout">
      <header className="topbar">
        <div
          className={`topbar-logo${isHome ? ' active' : ''}`}
          onClick={() => window.location.href = '/'}
        >
          <span className="topbar-logo-text">APDAY</span>
        </div>

        <nav className="topnav">
          {navItems.map(item => (
            <NavGroup key={item.id} item={item} openMenu={openMenu} setOpenMenu={setOpenMenu} counts={counts} />
          ))}
        </nav>

        <div className="topbar-right">
          <div className="topbar-divider" />
          {rightNavItems.map(item => (
            <NavGroup key={item.id} item={item} openMenu={openMenu} setOpenMenu={setOpenMenu} counts={counts} alignRight />
          ))}
          <div className="topbar-date">
            {new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })}
          </div>
        </div>
      </header>

      <main className="main-content">
        <div className="page-body">
          {children}
        </div>
      </main>
    </div>
  );
}
