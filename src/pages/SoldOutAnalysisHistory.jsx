import { useState, useEffect, useMemo } from 'react';
import { dbStoreGet } from '../utils/dbApi';

const EXCLUDE_KEYWORDS = ['최종마감', '품질확인서', '마감대상', '덤핑'];
function shouldExclude(s) { return s ? EXCLUDE_KEYWORDS.some(kw => s.includes(kw)) : false; }
function todayStr() { return new Date().toISOString().slice(0, 10).replace(/-/g, ''); }
function dateToKey(d) { return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
function keyToDisplay(k) { return `${k.slice(0,4)}-${k.slice(4,6)}-${k.slice(6,8)}`; }
function fmt(n) { if (n == null) return '-'; return Number(n).toLocaleString('ko-KR'); }

const calBtnStyle = { width: 28, height: 28, borderRadius: 6, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12 };

const COLUMNS = [
  { key: 'index', label: 'No', width: '3%', align: 'center', sortable: false },
  { key: 'status', label: '상태', width: '5%', align: 'center', sortable: true },
  { key: 'optionId', label: '옵션ID', width: '7%', align: 'left', sortable: true },
  { key: 'barcode', label: '바코드', width: '7%', align: 'left', sortable: true },
  { key: 'productName', label: '상품명', width: '20%', align: 'left', sortable: true },
  { key: 'optionName', label: '옵션명', width: '12%', align: 'left', sortable: true },
  { key: 'coupangStock', label: '쿠팡재고', width: '10%', align: 'right', sortable: true },
  { key: 'salesQty', label: '오늘 판매수량', width: '10%', align: 'right', sortable: true },
  { key: 'revenue', label: '오늘 매출', width: '13%', align: 'right', sortable: true },
  { key: 'netProfit', label: '오늘 순이익금', width: '13%', align: 'right', sortable: true },
];

export default function SoldOutAnalysisHistory() {
  const [viewingDate, setViewingDate] = useState(todayStr());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [showCalendar, setShowCalendar] = useState(false);
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState('revenue');
  const [sortDir, setSortDir] = useState('desc');
  const [statusFilter, setStatusFilter] = useState('전체');

  const loadData = async (dateKey) => {
    setLoading(true);
    const result = await dbStoreGet(`soldout_analysis_${dateKey}`);
    setData(result);
    setLoading(false);
  };

  useEffect(() => { loadData(todayStr()); }, []);

  const handleSort = (key) => {
    if (sortKey === key) {
      if (sortDir === 'asc') setSortDir('desc');
      else { setSortKey(null); setSortDir('asc'); } // 3번째 클릭: 정렬 해제
    } else {
      setSortKey(key); setSortDir('asc');
    }
  };

  // 제외 키워드 필터링 + 검색 + 정렬
  const filteredItems = useMemo(() => {
    if (!data?.items) return [];
    let items = data.items.filter(it => !shouldExclude(it.status) && !(it.optionName || '').includes('반품') && !(it.productName || '').includes('바디스윗'));
    if (statusFilter === '신규') items = items.filter(it => (it.status || '').includes('신규'));
    else if (statusFilter === '효자') items = items.filter(it => it.status === '효자');
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      items = items.filter(it =>
        it.productName?.toLowerCase().includes(q) ||
        it.optionName?.toLowerCase().includes(q) ||
        it.optionId?.toLowerCase().includes(q) ||
        it.barcode?.toLowerCase().includes(q)
      );
    }
    if (sortKey) {
      items = [...items].sort((a, b) => {
        let va = a[sortKey] ?? '', vb = b[sortKey] ?? '';
        if (typeof va === 'number' && typeof vb === 'number') {
          return sortDir === 'asc' ? va - vb : vb - va;
        }
        va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
        return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      });
    }
    return items;
  }, [data, search, sortKey, sortDir, statusFilter]);

  const totalCount = filteredItems.length;
  const totalNetProfit = useMemo(() => {
    if (!data?.items) return 0;
    let items = data.items.filter(it => !(it.productName || '').includes('바디스윗'));
    if (statusFilter === '신규') items = items.filter(it => (it.status || '').includes('신규'));
    else if (statusFilter === '효자') items = items.filter(it => it.status === '효자');
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      items = items.filter(it => it.productName?.toLowerCase().includes(q) || it.optionName?.toLowerCase().includes(q) || it.optionId?.toLowerCase().includes(q) || it.barcode?.toLowerCase().includes(q));
    }
    return items.reduce((s, it) => s + (it.netProfit || 0), 0);
  }, [data, statusFilter, search]);

  // 달력
  const calYear = calendarDate.getFullYear(), calMonth = calendarDate.getMonth();
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const calendarDays = useMemo(() => { const d = []; for (let i = 0; i < firstDay; i++) d.push(null); for (let i = 1; i <= daysInMonth; i++) d.push(i); return d; }, [firstDay, daysInMonth]);
  const todayKey = todayStr();

  const handleCalendarDateClick = async (day) => {
    if (!day) return;
    const key = dateToKey(new Date(calYear, calMonth, day));
    setViewingDate(key);
    setShowCalendar(false);
    await loadData(key);
  };

  const goToToday = async () => {
    setViewingDate(todayStr());
    await loadData(todayStr());
  };

  const sortArrow = (key) => {
    if (sortKey !== key) return <span style={{ color: '#ccc', marginLeft: 2 }}>↕</span>;
    return <span style={{ color: 'var(--primary)', marginLeft: 2 }}>{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  if (loading) return <div style={{ textAlign: 'center', padding: 80, color: 'var(--text-secondary)' }}><div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>불러오는 중...</div>;

  return (
    <div>
      {/* 필터 바 */}
      <div className="card" style={{ marginBottom: 16, position: 'relative', overflow: 'visible' }}>
        <div className="card-body">
          <div className="filter-bar">
            <span style={{ fontSize: 14, fontWeight: 700 }}>
              {keyToDisplay(viewingDate)}
              {viewingDate === todayKey && <span style={{ fontSize: 12, color: 'var(--primary)', marginLeft: 6 }}>오늘</span>}
            </span>
            {data && <>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)', background: '#f1f3f4', padding: '2px 8px', borderRadius: 4 }}>{fmt(totalCount)}개</span>
              <span style={{ margin: '0 2px', color: 'var(--border)' }}>|</span>
              {['전체', '신규', '효자'].map(s => (
                <button key={s} onClick={() => setStatusFilter(s)} className={`filter-btn${statusFilter === s ? ' active' : ''}`} style={{ fontSize: 12, padding: '2px 10px' }}>{s}</button>
              ))}
              <span style={{ fontSize: 12, fontWeight: 700, padding: '3px 10px', borderRadius: 6, background: totalNetProfit >= 0 ? '#e8f0fe' : '#fce8e6', color: totalNetProfit >= 0 ? '#1a73e8' : '#c5221f' }}>
                순이익 합계 {fmt(totalNetProfit)}원
              </span>
            </>}
            <div style={{ flex: 1 }} />
            <input
              type="text"
              placeholder="검색"
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ padding: '5px 10px', borderRadius: 6, border: '1px solid var(--border)', fontSize: 12, width: 160 }}
            />
            <button onClick={() => setShowCalendar(!showCalendar)} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)', background: showCalendar ? 'var(--primary)' : '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={showCalendar ? '#fff' : '#555'} strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            </button>
          </div>
        </div>

        {showCalendar && (
          <>
            <div onClick={() => setShowCalendar(false)} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }} />
            <div style={{ position: 'absolute', top: '100%', right: 20, marginTop: 8, zIndex: 1000, background: '#fff', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', border: '1px solid var(--border)', width: 340, padding: 20, animation: 'fadeIn 0.15s ease' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <button onClick={() => setCalendarDate(new Date(calYear, calMonth - 1, 1))} style={calBtnStyle}>◀</button>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{calYear}년 {calMonth+1}월</span>
                <button onClick={() => setCalendarDate(new Date(calYear, calMonth + 1, 1))} style={calBtnStyle}>▶</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center' }}>
                {['일','월','화','수','목','금','토'].map(d => <div key={d} style={{ padding: 6, fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>{d}</div>)}
                {calendarDays.map((day, idx) => {
                  if (!day) return <div key={`e${idx}`} />;
                  const key = dateToKey(new Date(calYear, calMonth, day));
                  const isToday = key === todayKey, isSel = key === viewingDate;
                  return <div key={key} onClick={() => handleCalendarDateClick(day)} style={{ padding: '8px 2px', borderRadius: 8, cursor: 'pointer', fontSize: 13, background: isSel ? 'var(--primary)' : isToday ? 'var(--primary-light)' : 'transparent', color: isSel ? '#fff' : isToday ? 'var(--primary)' : 'var(--text)', fontWeight: isToday || isSel ? 700 : 400, border: isToday && !isSel ? '2px solid var(--primary)' : '2px solid transparent' }}
                    onMouseOver={e => { if (!isSel) e.currentTarget.style.background = '#f1f3f4'; }}
                    onMouseOut={e => { if (!isSel) e.currentTarget.style.background = isToday ? 'var(--primary-light)' : 'transparent'; }}
                  >{day}</div>;
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {/* 데이터 없을 때 */}
      {!data && (
        <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>📊</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{keyToDisplay(viewingDate)} 업로드 데이터가 없습니다</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>데이터 업로드 메뉴에서 해당 날짜의 엑셀을 먼저 업로드해주세요.</div>
          {viewingDate !== todayStr() && (
            <button onClick={goToToday} style={{ marginTop: 12, padding: '6px 16px', borderRadius: 6, border: '1px solid var(--primary)', background: '#fff', color: 'var(--primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>오늘로 돌아가기</button>
          )}
        </div>
      )}

      {/* 테이블 */}
      {data && (
        <div className="card" style={{ padding: 0 }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', tableLayout: 'fixed', borderCollapse: 'collapse', fontSize: 12, lineHeight: 1.4 }}>
              <thead>
                <tr style={{ background: '#f8f9fa', borderBottom: '2px solid #dee2e6' }}>
                  {COLUMNS.map(col => (
                    <th key={col.key}
                      onClick={col.sortable ? () => handleSort(col.key) : undefined}
                      style={{
                        width: col.width, padding: '8px 6px', textAlign: col.align,
                        fontSize: 11, fontWeight: 700, color: '#555',
                        borderRight: '1px solid #eee',
                        cursor: col.sortable ? 'pointer' : 'default',
                        userSelect: 'none', whiteSpace: 'nowrap',
                      }}
                    >
                      {col.label}{col.sortable && sortArrow(col.key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredItems.length === 0 ? (
                  <tr><td colSpan={10} style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>
                    {search ? '검색 결과가 없습니다' : '표시할 데이터가 없습니다'}
                  </td></tr>
                ) : filteredItems.map((r, i) => (
                  <tr key={r.optionId + i} style={{ borderBottom: '1px solid #f0f0f0' }}
                    onMouseOver={e => e.currentTarget.style.background = '#f8f9fb'}
                    onMouseOut={e => e.currentTarget.style.background = ''}
                  >
                    <td style={{ padding: '5px 6px', textAlign: 'center', fontSize: 10, color: '#aaa', borderRight: '1px solid #f0f0f0' }}>{i + 1}</td>
                    <td style={{ padding: '5px 6px', textAlign: 'center', borderRight: '1px solid #f0f0f0' }}>
                      {r.status ? (
                        <span style={{
                          fontSize: 10, padding: '1px 5px', borderRadius: 4, fontWeight: 600,
                          background: r.status === '효자' ? '#e6f4ea' : r.status?.includes('신규') ? '#fff3e0' : '#f5f5f5',
                          color: r.status === '효자' ? '#1e8e3e' : r.status?.includes('신규') ? '#e65100' : '#888',
                        }}>{r.status}</span>
                      ) : <span style={{ color: '#ddd', fontSize: 10 }}>-</span>}
                    </td>
                    <td style={{ padding: '5px 6px', fontSize: 10, color: '#888', borderRight: '1px solid #f0f0f0' }}>{r.optionId}</td>
                    <td style={{ padding: '5px 6px', fontSize: 10, color: '#888', borderRight: '1px solid #f0f0f0' }}>{r.barcode || '-'}</td>
                    <td style={{ padding: '5px 6px', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderRight: '1px solid #f0f0f0' }} title={r.productName}>{r.productName}</td>
                    <td style={{ padding: '5px 6px', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', borderRight: '1px solid #f0f0f0' }}>{r.optionName}</td>
                    <td style={{ padding: '5px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: r.coupangStock === 0 ? '#c5221f' : '', fontWeight: r.coupangStock === 0 ? 700 : 400, borderRight: '1px solid #f0f0f0' }}>{fmt(r.coupangStock)}</td>
                    <td style={{ padding: '5px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', borderRight: '1px solid #f0f0f0' }}>{fmt(r.salesQty)}</td>
                    <td style={{ padding: '5px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', borderRight: '1px solid #f0f0f0', color: (r.netProfit || 0) >= 50000 ? '#1a73e8' : '', fontWeight: (r.netProfit || 0) >= 50000 ? 700 : 400 }}>{fmt(r.revenue)}</td>
                    <td style={{ padding: '5px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: (r.netProfit || 0) < 0 ? '#c5221f' : '' }}>{fmt(r.netProfit)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 10, color: '#aaa', padding: '6px 8px', borderTop: '1px solid #eee' }}>
            최종마감·품질확인서·마감대상·덤핑 제외 | 업로드 시점 상태 스냅샷 기준
          </div>
        </div>
      )}
    </div>
  );
}
