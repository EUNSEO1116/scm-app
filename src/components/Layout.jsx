import { NavLink, useLocation } from 'react-router-dom';
import { useState, useRef, useEffect } from 'react';

const navItems = [
  { id: 'inventory', label: '재고관리', icon: 'inventory', children: [
    { label: '재고 계산기', path: '/inventory' },
    { label: '입고신청', path: '/inventory/incoming' },
    { label: '발주신청', path: '/inventory/order' },
    { label: '발주장부', path: '/inventory/orderbook' },
    { label: '인천입고신청', path: '/inventory/incheon' },
    { label: '마감 상품', path: '/inventory/closed' },
  ]},
  { id: 'sales', label: '매출관리', path: '/sales', icon: 'sales' },
  { id: 'soldout-analysis', label: '품절 분석', icon: 'soldoutAnalysis', children: [
    { label: '(NEW)품절 현황', path: '/soldout-analysis' },
    { label: '데이터 기록', path: '/soldout-analysis/history' },
    { label: '(NEW)제외품목관리', path: '/soldout-analysis/exclude' },
    { label: '(NEW)월 품절률', path: '/soldout-analysis/rate' },
    { label: '데이터 업로드', path: '/soldout-analysis/upload' },
  ]},
  { id: 'issue', label: '이슈관리', icon: 'issue', children: [
    { label: '특별관리', path: '/issue' },
    { label: '상품개선', path: '/issue/improvement' },
  ]},
  { id: 'supplies', label: '부자재관리', icon: 'supplies', children: [
    { label: '부자재 목록', path: '/supplies' },
    { label: '부자재 발주', path: '/supplies/order' },
  ]},
  { id: 'fbc', label: 'FBC관리', icon: 'fbc', children: [
    { label: 'FBC 비용 계산기', path: '/fbc' },
    { label: '절감 대시보드', path: '/dashboard' },
    { label: 'FBC 품목', path: '/fbc/items' },
    { label: 'FBC 사전계산기', path: '/fbc/pallet' },
  ]},
];

const bottomNavItems = [
  { id: 'cn-settlement', label: 'CN 결산', icon: 'cnSettlement', children: [
    { label: '거래 데이터 업로드', path: '/cn-settlement/upload' },
    { label: '결산 대시보드', path: '/cn-settlement/dashboard' },
    { label: '결산 기록', path: '/cn-settlement/history' },
  ]},
  { id: 'soldout', label: '품절관리', icon: 'soldout', children: [
    { label: '품절 현황', path: '/soldout' },
    { label: '월별 품절률', path: '/soldout/rate' },
    { label: '제외 품목 관리', path: '/soldout/exclude' },
    { label: '품절 기록', path: '/soldout/history' },
  ]},
];

const icons = {
  inventory: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4"/></svg>,
  fbc: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/><path d="M7 8h2m4 0h4M7 12h4m4 0h2"/></svg>,
  sales: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/></svg>,
  soldout: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18.36 6.64A9 9 0 015.64 18.36M5.64 5.64A9 9 0 0118.36 18.36"/><line x1="1" y1="1" x2="23" y2="23"/></svg>,
  issue: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>,
  soldoutAnalysis: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 21H3V3"/><path d="M21 7l-5 5-4-4-3 3"/><circle cx="21" cy="7" r="1.5"/><circle cx="16" cy="12" r="1.5"/><circle cx="12" cy="8" r="1.5"/><circle cx="9" cy="11" r="1.5"/></svg>,
  supplies: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 003 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0021 16z"/></svg>,
  cnSettlement: <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 7h6m-6 4h6m-4 4h4M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z"/></svg>,
};

const pageTitles = {
  '/': 'ARIPPLE SCM',
  '/inventory': '재고 계산기',
  '/inventory/incoming': '입고신청',
  '/inventory/order': '발주신청',
  '/inventory/orderbook': '발주장부',
  '/inventory/incheon': '인천입고신청',
  '/inventory/closed': '마감 상품',
  '/fbc': 'FBC 비용 계산기',
  '/dashboard': '절감 대시보드',
  '/fbc/items': 'FBC 품목',
  '/fbc/pallet': 'FBC 사전계산기',
  '/sales': '매출관리',
  '/soldout': '품절 현황',
  '/soldout/rate': '월별 품절률',
  '/soldout/exclude': '제외 품목 관리',
  '/soldout/history': '품절 기록',
  '/issue': '특별관리',
  '/issue/improvement': '상품개선',
  '/soldout-analysis': '(NEW)품절 현황',
  '/soldout-analysis/history': '데이터 기록',
  '/soldout-analysis/exclude': '(NEW)제외품목관리',
  '/soldout-analysis/rate': '(NEW)월 품절률',
  '/soldout-analysis/upload': '데이터 업로드',
  '/supplies': '부자재 목록',
  '/supplies/order': '부자재 발주',
  '/cn-settlement/upload': '거래 데이터 업로드',
  '/cn-settlement/dashboard': '결산 대시보드',
  '/cn-settlement/history': '결산 기록',
};

export default function Layout({ children }) {
  const location = useLocation();
  const title = pageTitles[location.pathname] || 'ARIPPLE SCM';
  const [openMenu, setOpenMenu] = useState(null);
  const navRef = useRef(null);

  // 하위 메뉴 경로에 있으면 자동으로 펼치기
  useEffect(() => {
    for (const item of navItems) {
      if (item.children?.some(c => c.path === location.pathname)) {
        setOpenMenu(item.id);
        return;
      }
    }
  }, [location.pathname]);

  // 사이드바 외부 클릭시 닫기
  useEffect(() => {
    const handler = (e) => {
      if (navRef.current && !navRef.current.contains(e.target)) {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const isHome = location.pathname === '/';

  return (
    <div className="app-layout">
      <aside className="sidebar">
        <div
          className={`sidebar-logo${isHome ? ' active' : ''}`}
          onClick={() => window.location.href = '/'}
          style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <img src="/logo.jpg" alt="ARIPPLE" style={{ width: 28, height: 28, borderRadius: 6 }} />
          ARIPPLE SCM
        </div>
        <nav className="sidebar-nav" ref={navRef} style={{ display: 'flex', flexDirection: 'column', flex: 1 }}>
          <div>
            {navItems.map(item => (
              item.children ? (
                <div key={item.id} className="nav-group">
                  <div
                    className="nav-item"
                    onClick={() => setOpenMenu(openMenu === item.id ? null : item.id)}
                  >
                    {icons[item.icon]}
                    <span style={{ flex: 1 }}>{item.label}</span>
                    <svg
                      viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                      style={{
                        width: 14, height: 14,
                        transition: 'transform 0.2s',
                        transform: openMenu === item.id ? 'rotate(180deg)' : 'rotate(0deg)',
                      }}
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </div>
                  {openMenu === item.id && (
                    <div className="sub-menu">
                      {item.children.map(child => (
                        <NavLink
                          key={child.path}
                          to={child.path}
                          end
                          className={({ isActive }) => `sub-item ${isActive ? 'active' : ''}`}
                        >
                          {child.label}
                        </NavLink>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <NavLink
                  key={item.id}
                  to={item.path}
                  className={({ isActive }) =>
                    `nav-item ${isActive ? 'active' : ''}`
                  }
                >
                  {icons[item.icon]}
                  {item.label}
                </NavLink>
              )
            ))}
          </div>
          <div style={{ marginTop: 'auto', borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 8 }}>
            {bottomNavItems.map(item => (
              <div key={item.id} className="nav-group">
                <div
                  className="nav-item"
                  style={{ opacity: 0.5 }}
                  onClick={() => setOpenMenu(openMenu === item.id ? null : item.id)}
                >
                  {icons[item.icon]}
                  <span style={{ flex: 1 }}>{item.label}</span>
                  <svg
                    viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
                    style={{
                      width: 14, height: 14,
                      transition: 'transform 0.2s',
                      transform: openMenu === item.id ? 'rotate(180deg)' : 'rotate(0deg)',
                    }}
                  >
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </div>
                {openMenu === item.id && (
                  <div className="sub-menu">
                    {item.children.map(child => (
                      <NavLink
                        key={child.path}
                        to={child.path}
                        end
                        className={({ isActive }) => `sub-item ${isActive ? 'active' : ''}`}
                      >
                        {child.label}
                      </NavLink>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </nav>
      </aside>
      <main className="main-content">
        <header className="page-header">
          <h1>{title}</h1>
          <div style={{ fontSize: 13, color: '#5f6368' }}>
            {new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' })}
          </div>
        </header>
        <div className="page-body">
          {children}
        </div>
      </main>
    </div>
  );
}
