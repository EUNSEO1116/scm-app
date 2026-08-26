import { useState, useEffect, useMemo, useRef } from 'react';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

const REMARKET_KEY = 'soldout_remarket_events';

function keyToDisplay(k) {
  if (!k || k.length < 8) return k || '-';
  return `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;
}
function fmtDec(n, d = 1) { const num = Number(n); return isNaN(num) ? '-' : num.toFixed(d); }

function SortableTh({ label, sortKey, sort, onSort }) {
  const active = sort.key === sortKey;
  const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
  return (
    <th
      style={{ textAlign: 'center', cursor: 'pointer', userSelect: 'none', color: active ? '#1a73e8' : undefined }}
      onClick={() => onSort(sortKey)}
      title="클릭하여 정렬"
    >
      {label}<span style={{ fontSize: 10, color: active ? '#1a73e8' : '#bbb' }}>{arrow || ' ⇅'}</span>
    </th>
  );
}

const TABS = [
  { id: 'pending', label: '미조치', color: '#d93025', desc: '재입고되어 마케팅 검토가 필요한 상품' },
  { id: 'done', label: '재마케팅 완료', color: '#1e8e3e', desc: '재마케팅을 진행한 상품' },
  { id: 'held', label: '보류(안 함)', color: '#80868b', desc: '마케팅 가치가 낮아 진행하지 않는 상품' },
];

export default function SoldOutRemarket() {
  const [events, setEvents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState('pending');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(new Set());
  const [toast, setToast] = useState(null);
  const [sort, setSort] = useState({ key: null, dir: 'asc' });
  const dragRef = useRef({ active: false, mode: 'select' });

  const showToast = (type, title, msg) => { setToast({ type, title, message: msg }); setTimeout(() => setToast(null), 3000); };

  useEffect(() => {
    let alive = true;
    (async () => {
      const data = await dbStoreGet(REMARKET_KEY).catch(() => null);
      if (alive) { setEvents(Array.isArray(data) ? data : []); setLoading(false); }
    })();
    return () => { alive = false; };
  }, []);

  useEffect(() => { setSelected(new Set()); setSort({ key: null, dir: 'asc' }); }, [tab]);

  const toggleSort = (key) => setSort(prev =>
    prev.key === key
      ? (prev.dir === 'asc' ? { key, dir: 'desc' } : { key: null, dir: 'asc' })
      : { key, dir: 'asc' });

  const counts = useMemo(() => {
    const c = { pending: 0, done: 0, held: 0 };
    for (const e of events) if (c[e.status] !== undefined) c[e.status]++;
    return c;
  }, [events]);

  const rows = useMemo(() => {
    let list = events.filter(e => e.status === tab);
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(e =>
        (e.productName || '').toLowerCase().includes(q) ||
        (e.optionName || '').toLowerCase().includes(q) ||
        (e.barcode || '').toLowerCase().includes(q) ||
        (e.reason || '').toLowerCase().includes(q)
      );
    }
    if (sort.key) {
      const numCols = { days: true, avg3d: true };
      const mul = sort.dir === 'asc' ? 1 : -1;
      return [...list].sort((a, b) => {
        let cmp;
        if (numCols[sort.key]) {
          cmp = (Number(a[sort.key]) || 0) - (Number(b[sort.key]) || 0);
        } else {
          cmp = String(a[sort.key] || '').localeCompare(String(b[sort.key] || ''), 'ko');
        }
        return cmp * mul;
      });
    }
    // 기본값: 최근 해결 먼저, 그 안에서 판매량(마케팅 우선순위) 높은 순
    return [...list].sort((a, b) => {
      const d = (b.resolvedDate || '').localeCompare(a.resolvedDate || '');
      if (d !== 0) return d;
      return (b.avg3d || 0) - (a.avg3d || 0);
    });
  }, [events, tab, search, sort]);

  const applyStatus = async (keys, status) => {
    const keySet = keys instanceof Set ? keys : new Set(keys);
    if (keySet.size === 0) return;
    const now = new Date().toISOString();
    const next = events.map(e => keySet.has(e.key)
      ? { ...e, status, actedAt: status === 'pending' ? null : now }
      : e);
    setEvents(next);
    setSelected(new Set());
    const label = status === 'done' ? '재마케팅 완료' : status === 'held' ? '보류' : '미조치로 이동';
    await dbStoreSet(REMARKET_KEY, next, { logDesc: `(NEW)재마케팅 ${label} ${keySet.size}건` }).catch(() => {});
    showToast('success', '처리 완료', `${keySet.size}건 ${label}`);
  };
  const updateStatus = (key, status) => applyStatus([key], status);

  const toggleSelect = (key) => setSelected(prev => {
    const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n;
  });

  // 마우스 드래그 다중선택
  const applyDrag = (key) => setSelected(prev => {
    const n = new Set(prev);
    if (dragRef.current.mode === 'select') n.add(key); else n.delete(key);
    return n;
  });
  const startDrag = (key) => {
    dragRef.current = { active: true, mode: selected.has(key) ? 'deselect' : 'select' };
    applyDrag(key);
  };
  useEffect(() => {
    const up = () => { dragRef.current.active = false; };
    window.addEventListener('mouseup', up);
    return () => window.removeEventListener('mouseup', up);
  }, []);
  const toggleAll = () => setSelected(prev => {
    const allKeys = rows.map(r => r.key);
    const allSelected = allKeys.length > 0 && allKeys.every(k => prev.has(k));
    return allSelected ? new Set() : new Set(allKeys);
  });

  const activeTab = TABS.find(t => t.id === tab);

  return (
    <div>
      {toast && (
        <div style={{ position: 'fixed', top: 32, right: 32, zIndex: 9999, display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px', borderRadius: 12, background: toast.type === 'success' ? '#e6f4ea' : '#fce8e6', border: `1px solid ${toast.type === 'success' ? '#1e8e3e' : '#d93025'}`, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', minWidth: 260 }}>
          <div style={{ fontSize: 13 }}>
            <div style={{ fontWeight: 700 }}>{toast.title}</div>
            <div style={{ color: '#5f6368' }}>{toast.message}</div>
          </div>
        </div>
      )}

      {/* 탭 = 상태별 카운트 */}
      <div className="stats-grid" style={{ marginBottom: 16 }}>
        {TABS.map(t => (
          <div
            key={t.id}
            className="stat-card clickable"
            style={{ cursor: 'pointer', textAlign: 'center', border: tab === t.id ? `2px solid ${t.color}` : '2px solid transparent' }}
            onClick={() => setTab(t.id)}
          >
            <div className="label">{t.label}</div>
            <div className="value" style={{ color: t.color }}>{counts[t.id]}</div>
            <div className="sub">{t.id === 'pending' ? '검토 필요' : '건'}</div>
          </div>
        ))}
      </div>

      {/* 검색 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className="filter-bar" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderRadius: 10, background: '#eef4ff', border: '1px solid #c7dbff', color: '#1a56db', fontSize: 12.5, fontWeight: 600, whiteSpace: 'nowrap' }}>
              <span style={{ fontSize: 10.5, background: '#1a56db', color: '#fff', borderRadius: 5, padding: '2px 7px', fontWeight: 700, letterSpacing: 0.5 }}>TIP</span>
              체크박스를 누른 채 위·아래로 드래그하면 여러 건을 한 번에 선택할 수 있어요
            </div>
            {selected.size > 0 && (
              tab === 'pending' ? (
                <>
                  <button className="btn btn-sm" style={{ background: '#1e8e3e', color: '#fff' }} onClick={() => applyStatus(selected, 'done')}>선택 {selected.size}건 재마케팅 완료</button>
                  <button className="btn btn-outline btn-sm" onClick={() => applyStatus(selected, 'held')}>선택 {selected.size}건 보류</button>
                </>
              ) : (
                <button className="btn btn-outline btn-sm" onClick={() => applyStatus(selected, 'pending')}>선택 {selected.size}건 미조치로</button>
              )
            )}
            <div style={{ flex: 1, textAlign: 'center', fontSize: 12.5, color: '#5f6368', lineHeight: 1.5, minWidth: 0 }}>
              {activeTab.desc} · 품절되었다가 재입고된 상품은 판매량 회복이 더디므로 재마케팅 대상으로 관리합니다.
            </div>
            <span style={{ fontSize: 13, color: '#5f6368', whiteSpace: 'nowrap' }}>{rows.length}건</span>
            <input
              className="search-input"
              placeholder="상품명, 옵션명, 바코드, 사유 검색..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ width: 380, maxWidth: '40%' }}
            />
          </div>
        </div>
      </div>

      {loading ? (
        <div className="loading" style={{ padding: 60, textAlign: 'center' }}>불러오는 중...</div>
      ) : rows.length === 0 ? (
        <div className="placeholder-page" style={{ textAlign: 'center' }}>
          <div className="icon">📭</div>
          <h2>{activeTab.label} 항목 없음</h2>
          <p>{tab === 'pending' ? '품절현황 업데이트 시 재입고된 상품이 자동으로 이곳에 표시됩니다' : '해당 상태의 상품이 없습니다'}</p>
        </div>
      ) : (
        <div className="table-wrapper" style={{ maxHeight: 'calc(100vh - 360px)', overflowY: 'auto' }}>
          <table className="data-table">
            <thead>
              <tr>
                <th style={{ width: 36, textAlign: 'center' }}>
                  <input
                    type="checkbox"
                    checked={rows.length > 0 && rows.every(r => selected.has(r.key))}
                    onChange={toggleAll}
                    style={{ cursor: 'pointer' }}
                  />
                </th>
                <th style={{ width: 40, textAlign: 'center' }}>#</th>
                <SortableTh label="상품명" sortKey="productName" sort={sort} onSort={toggleSort} />
                <SortableTh label="옵션명" sortKey="optionName" sort={sort} onSort={toggleSort} />
                <SortableTh label="바코드" sortKey="barcode" sort={sort} onSort={toggleSort} />
                <SortableTh label="품절일" sortKey="soldoutStart" sort={sort} onSort={toggleSort} />
                <SortableTh label="해결일" sortKey="resolvedDate" sort={sort} onSort={toggleSort} />
                <SortableTh label="품절기간" sortKey="days" sort={sort} onSort={toggleSort} />
                <SortableTh label="평균판매" sortKey="avg3d" sort={sort} onSort={toggleSort} />
                <SortableTh label="품절사유" sortKey="reason" sort={sort} onSort={toggleSort} />
                <th style={{ textAlign: 'center', width: 200 }}>조치</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((e, i) => (
                <tr key={e.key} style={selected.has(e.key) ? { background: '#e8f0fe' } : {}}>
                  <td
                    style={{ textAlign: 'center', cursor: 'pointer', userSelect: 'none' }}
                    onMouseDown={(ev) => { ev.preventDefault(); startDrag(e.key); }}
                    onMouseEnter={() => { if (dragRef.current.active) applyDrag(e.key); }}
                  >
                    <input type="checkbox" checked={selected.has(e.key)} readOnly style={{ cursor: 'pointer', pointerEvents: 'none' }} />
                  </td>
                  <td style={{ textAlign: 'center' }}>{i + 1}</td>
                  <td style={{ textAlign: 'center', maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={e.productName}>{e.productName || '-'}</td>
                  <td style={{ textAlign: 'center' }}>{e.optionName || '-'}</td>
                  <td style={{ textAlign: 'center', fontSize: 12, color: '#666' }}>{e.barcode || '-'}</td>
                  <td style={{ textAlign: 'center', fontSize: 12 }}>{keyToDisplay(e.soldoutStart)}</td>
                  <td style={{ textAlign: 'center', fontSize: 12, color: '#1a73e8', fontWeight: 600 }}>{keyToDisplay(e.resolvedDate)}</td>
                  <td style={{ textAlign: 'center', fontWeight: 600, color: (e.days || 0) >= 7 ? '#d93025' : '#333' }}>{e.days || 1}일</td>
                  <td style={{ textAlign: 'center' }}>{e.avg3d > 0 ? fmtDec(e.avg3d) : '-'}</td>
                  <td style={{ textAlign: 'center', fontSize: 12 }}>
                    {e.reason
                      ? <span style={{ background: '#f3eef8', color: '#7c4dbd', borderRadius: 4, padding: '2px 8px' }}>{e.reason}</span>
                      : <span style={{ color: '#ccc' }}>-</span>}
                  </td>
                  <td style={{ textAlign: 'center' }}>
                    {tab === 'pending' ? (
                      <div style={{ display: 'flex', gap: 6, justifyContent: 'center' }}>
                        <button className="btn btn-sm" style={{ background: '#1e8e3e', color: '#fff' }} onClick={() => updateStatus(e.key, 'done')}>재마케팅 완료</button>
                        <button className="btn btn-outline btn-sm" onClick={() => updateStatus(e.key, 'held')}>보류</button>
                      </div>
                    ) : (
                      <button className="btn btn-outline btn-sm" onClick={() => updateStatus(e.key, 'pending')}>미조치로</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
