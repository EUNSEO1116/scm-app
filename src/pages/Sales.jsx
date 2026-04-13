import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { fetchCautionItems, saveCautionItem, deleteCautionItem } from '../sheetSync.js';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi.js';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const CSV_DAILY = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('일일 판매량')}`;
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`;

// CSV indices:
// 0=empty, 1=barcode, 2=S-code, 3=product name, 4=option name, 5=status,
// 6=6일전, 7=5일전, 8=4일전, 9=3일전, 10=2일전, 11=1일전, 12=정렬금지(total), 13=리뷰갯수(6일)

function parseCsvRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { result.push(current); current = ''; }
      else current += ch;
    }
  }
  result.push(current);
  return result;
}

function safeNum(v) {
  if (v === '' || v === '-' || v === undefined || v === null) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function fmt(n) {
  if (n === null || n === undefined || n === '' || n === '-') return '-';
  const num = Number(n);
  if (isNaN(num)) return String(n);
  return num.toLocaleString('ko-KR');
}

function fmtDec(n, d = 1) {
  if (n === null || n === undefined || isNaN(Number(n))) return '-';
  return Number(n).toFixed(d);
}

// Map a value [0..max] to a green tint background
function greenTint(val, maxVal) {
  if (!maxVal || val <= 0) return undefined;
  const ratio = Math.min(val / maxVal, 1);
  // 0 = white, max = #a8d5b5 (soft green)
  const r = Math.round(255 - ratio * (255 - 168));
  const g = Math.round(255 - ratio * (255 - 213));
  const b = Math.round(255 - ratio * (255 - 181));
  return `rgb(${r},${g},${b})`;
}

// Surge criteria:
// status === '신규' AND curr >= 4 AND (curr >= avg(6일전~2일전)*2 OR curr >= max(6일전~2일전)+3)
function isSurge(row) {
  if (row.status !== '신규') return false;
  const curr = row.d1; // 1일전
  if (curr < 4) return false;
  const prevDays = [row.d6, row.d5, row.d4, row.d3, row.d2]; // 6일전~2일전
  const avg = prevDays.reduce((a, b) => a + b, 0) / prevDays.length;
  const max = Math.max(...prevDays);
  return (avg > 0 && curr >= avg * 2) || curr >= max + 3;
}

// Sort icon component
function SortIcon({ col, sortKey, sortDir }) {
  if (sortKey !== col) return <span className="sort-icon">↕</span>;
  return <span className="sort-icon">{sortDir === 'asc' ? '↑' : '↓'}</span>;
}

// Mini bar chart for surge cards (6 days)
function MiniBar({ days }) {
  const maxVal = Math.max(...days, 1);
  const labels = ['6일전', '5일전', '4일전', '3일전', '2일전', '1일전'];
  return (
    <div style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 36 }}>
      {days.map((v, i) => {
        const h = Math.max(2, Math.round((v / maxVal) * 32));
        const isLast = i === days.length - 1;
        return (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
            <div
              title={`${labels[i]}: ${v}`}
              style={{
                width: 16,
                height: h,
                background: isLast ? '#e65100' : '#90caf9',
                borderRadius: '2px 2px 0 0',
                transition: 'height 0.2s',
              }}
            />
            <span style={{ fontSize: 9, color: '#888', lineHeight: 1 }}>{v}</span>
          </div>
        );
      })}
    </div>
  );
}

// Trend indicator for table rows
function TrendIndicator({ d1, d2, d3, d4, d5, d6 }) {
  const prevAvg = (d2 + d3 + d4 + d5 + d6) / 5;
  if (prevAvg === 0 && d1 === 0) return <span style={{ color: '#ccc' }}>—</span>;
  if (prevAvg === 0 && d1 > 0) return <span style={{ color: '#1e8e3e', fontWeight: 700 }}>↑ 신규</span>;
  const ratio = d1 / prevAvg;
  if (ratio >= 2) return <span style={{ color: '#c5221f', fontWeight: 700 }}>↑↑ {fmtDec(ratio)}x</span>;
  if (ratio >= 1.3) return <span style={{ color: '#e65100', fontWeight: 600 }}>↑ {fmtDec(ratio)}x</span>;
  if (ratio <= 0.5 && d1 === 0) return <span style={{ color: '#80868b' }}>↓ 0</span>;
  if (ratio <= 0.5) return <span style={{ color: '#1967d2' }}>↓ {fmtDec(ratio)}x</span>;
  if (ratio <= 0.7) return <span style={{ color: '#1a73e8' }}>↓ {fmtDec(ratio)}x</span>;
  return <span style={{ color: '#5f6368' }}>→ {fmtDec(ratio)}x</span>;
}

export default function Sales() {
  const location = useLocation();
  const surgeRef = useRef(null);

  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortKey, setSortKey] = useState('total');
  const [sortDir, setSortDir] = useState('desc');
  const [cautionSet, setCautionSet] = useState(new Set());
  const [memos, setMemos] = useState({});
  const [editingMemo, setEditingMemo] = useState(null);
  const [memoInput, setMemoInput] = useState('');
  const memoInputRef = useRef(null);

  // Check for ?tab=surge
  const tabParam = useMemo(() => {
    const params = new URLSearchParams(location.search);
    return params.get('tab');
  }, [location.search]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, calcRes] = await Promise.all([fetch(CSV_DAILY), fetch(TSV_CALC)]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const csv = await res.text();
      const lines = csv.split('\n').filter(l => l.trim());
      if (lines.length < 2) throw new Error('데이터가 없습니다');

      // 재고계산기에서 쿠팡바코드→총재고 매핑
      const stockMap = {};
      if (calcRes.ok) {
        const tsv = await calcRes.text();
        const calcLines = tsv.split('\n').filter(l => l.trim());
        for (let i = 1; i < calcLines.length; i++) {
          const cols = calcLines[i].split('\t');
          const bc = (cols[1] || '').trim();   // cols[1] = 쿠팡바코드
          if (bc) stockMap[bc] = safeNum(cols[14]); // cols[14] = 총재고
        }
      }

      const parsed = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvRow(lines[i]);
        if (cols.length < 12) continue;
        const barcode = (cols[1] || '').trim();
        const scode = (cols[2] || '').trim();
        const productName = (cols[3] || '').trim();
        const optionName = (cols[4] || '').trim();
        const status = (cols[5] || '').trim();
        if (!productName && !barcode) continue;

        const d6 = safeNum(cols[6]);
        const d5 = safeNum(cols[7]);
        const d4 = safeNum(cols[8]);
        const d3 = safeNum(cols[9]);
        const d2 = safeNum(cols[10]);
        const d1 = safeNum(cols[11]);
        const total = safeNum(cols[12]);
        const reviews = safeNum(cols[13]);
        const totalStock = stockMap[barcode] || 0;

        parsed.push({ barcode, scode, productName, optionName, status, d6, d5, d4, d3, d2, d1, total, reviews, totalStock });
      }
      setRows(parsed);
      setLastUpdated(new Date());
    } catch (e) {
      setError(e.message || '데이터를 불러오지 못했습니다');
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // 주의 품목 시트에서 로드
  useEffect(() => {
    fetchCautionItems().then(set => setCautionSet(set));
  }, []);

  // 메모 로드
  useEffect(() => {
    dbStoreGet('sales_memos').then(data => {
      if (data && typeof data === 'object') setMemos(data);
    });
  }, []);

  const saveMemo = useCallback((barcode, text) => {
    const trimmed = (text || '').trim();
    setMemos(prev => {
      const next = { ...prev };
      if (trimmed) next[barcode] = trimmed;
      else delete next[barcode];
      dbStoreSet('sales_memos', next);
      return next;
    });
  }, []);

  const startEditMemo = (barcode) => {
    setEditingMemo(barcode);
    setMemoInput(memos[barcode] || '');
    setTimeout(() => memoInputRef.current?.focus(), 0);
  };

  const commitMemo = () => {
    if (editingMemo) {
      saveMemo(editingMemo, memoInput);
      setEditingMemo(null);
      setMemoInput('');
    }
  };

  const toggleCaution = (row) => {
    const bc = row.barcode;
    const next = new Set(cautionSet);
    if (next.has(bc)) {
      next.delete(bc);
      deleteCautionItem(bc);
    } else {
      next.add(bc);
      saveCautionItem(bc, row.productName, row.optionName);
    }
    setCautionSet(next);
  };

  // Auto-scroll to surge section if ?tab=surge
  useEffect(() => {
    if (tabParam === 'surge' && surgeRef.current && !loading && rows.length > 0) {
      setTimeout(() => {
        surgeRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 300);
    }
  }, [tabParam, loading, rows.length]);

  // Stats
  const stats = useMemo(() => {
    if (!rows.length) return { total: 0, todaySales: 0, yesterdaySales: 0, avgDaily: 0, diff: 0, diffPct: 0 };
    const total = rows.length;
    const todaySales = rows.reduce((s, r) => s + r.d1, 0);
    const yesterdaySales = rows.reduce((s, r) => s + r.d2, 0);
    const diff = todaySales - yesterdaySales;
    const diffPct = yesterdaySales > 0 ? (diff / yesterdaySales) * 100 : 0;
    // 6일 평균: sum of all (d1+d2+d3+d4+d5+d6) / 6
    const totalAll6 = rows.reduce((s, r) => s + r.d1 + r.d2 + r.d3 + r.d4 + r.d5 + r.d6, 0);
    const avgDaily = totalAll6 / 6;
    return { total, todaySales, yesterdaySales, diff, diffPct, avgDaily };
  }, [rows]);

  // Surge items
  const surgeItems = useMemo(() => {
    return rows
      .filter(isSurge)
      .map(r => {
        const prevDays = [r.d6, r.d5, r.d4, r.d3, r.d2];
        const avg = prevDays.reduce((a, b) => a + b, 0) / prevDays.length;
        const max = Math.max(...prevDays);
        return { ...r, avg: Math.round(avg * 10) / 10, max, diff: r.d1 - Math.round(avg) };
      })
      .sort((a, b) => b.diff - a.diff);
  }, [rows]);

  // Status options
  const statusOptions = useMemo(() => {
    const set = new Set(rows.map(r => r.status).filter(Boolean));
    return ['all', ...Array.from(set).sort()];
  }, [rows]);

  // Max values for color coding
  const maxDayVal = useMemo(() => {
    if (!rows.length) return 1;
    return Math.max(1, ...rows.flatMap(r => [r.d6, r.d5, r.d4, r.d3, r.d2, r.d1]));
  }, [rows]);

  // Filtered + sorted rows
  const filtered = useMemo(() => {
    let list = rows;

    if (statusFilter === '주의') {
      list = list.filter(r => cautionSet.has(r.barcode));
    } else if (statusFilter !== 'all') {
      list = list.filter(r => r.status === statusFilter);
    }

    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(r =>
        r.productName.toLowerCase().includes(q) ||
        r.optionName.toLowerCase().includes(q) ||
        r.barcode.toLowerCase().includes(q) ||
        r.scode.toLowerCase().includes(q)
      );
    }

    list = [...list].sort((a, b) => {
      let va = a[sortKey];
      let vb = b[sortKey];
      if (typeof va === 'string') va = va.toLowerCase();
      if (typeof vb === 'string') vb = vb.toLowerCase();
      if (va < vb) return sortDir === 'asc' ? -1 : 1;
      if (va > vb) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });

    return list;
  }, [rows, search, statusFilter, sortKey, sortDir, cautionSet]);

  function handleSort(key) {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  }

  const sortProps = { sortKey, sortDir };

  return (
    <div>
      <div>
        {/* Error */}
        {error && (
          <div style={{
            background: '#fce8e6', color: '#c5221f', border: '1px solid #f5c6c3',
            borderRadius: 10, padding: '12px 16px', marginBottom: 20, fontSize: 14,
          }}>
            ⚠️ {error}
            <button
              onClick={fetchData}
              style={{ marginLeft: 12, background: 'none', border: 'none', color: '#c5221f', cursor: 'pointer', textDecoration: 'underline', fontSize: 13 }}
            >
              다시 시도
            </button>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && !rows.length && (
          <div className="loading">
            <div className="spinner" />
            데이터를 불러오는 중...
          </div>
        )}

        {/* Surge Alert Section */}
        <div
          ref={surgeRef}
          id="surge-section"
          style={{
            marginBottom: 24,
            scrollMarginTop: 80,
          }}
        >
          <div
            className="card"
            style={{
              border: surgeItems.length > 0 ? '2px solid #ff8c00' : '1px solid var(--border)',
              background: surgeItems.length > 0 ? '#fffaf4' : '#fff',
            }}
          >
            <div className="card-header" style={{ background: surgeItems.length > 0 ? '#fff3e0' : undefined }}>
              <h2 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                🚀 신규 판매 급증
                {surgeItems.length > 0 && (
                  <span style={{
                    background: '#ff8c00', color: '#fff', fontSize: 12, fontWeight: 700,
                    padding: '2px 10px', borderRadius: 12,
                  }}>
                    {surgeItems.length}건
                  </span>
                )}
              </h2>
              <span style={{ fontSize: 12, color: '#5f6368' }}>
                신규 상품 중 1일전 판매량이 이전 5일 평균의 2배 이상 or 최대값+3 이상
              </span>
            </div>
            <div className="card-body">
              {surgeItems.length === 0 ? (
                <div style={{ textAlign: 'center', padding: '20px 0', color: '#aaa', fontSize: 14 }}>
                  {loading ? '로딩 중...' : '현재 급증 품목이 없습니다'}
                </div>
              ) : (
                <div style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                  gap: 14,
                }}>
                  {surgeItems.map((item, i) => (
                    <div
                      key={item.barcode || i}
                      style={{
                        background: '#fff',
                        border: '1.5px solid #f5dbb8',
                        borderRadius: 12,
                        padding: '14px 16px',
                        boxShadow: '0 1px 4px rgba(230,81,0,0.08)',
                      }}
                    >
                      <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 2, lineHeight: 1.3 }}>
                        {item.productName}
                      </div>
                      <div style={{ fontSize: 11, color: '#5f6368', marginBottom: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {item.optionName || '—'}
                      </div>
                      <MiniBar days={[item.d6, item.d5, item.d4, item.d3, item.d2, item.d1]} />
                      <div style={{ marginTop: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <span style={{ fontSize: 12, color: '#5f6368' }}>
                          평균 {item.avg}개 → <strong style={{ color: '#e65100' }}>{item.d1}개</strong>
                        </span>
                        <span style={{
                          fontSize: 12, fontWeight: 700, color: '#fff',
                          background: '#e65100', borderRadius: 8, padding: '2px 8px',
                        }}>
                          +{item.diff}개 급증
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Main Table */}
        <div className="card">
          <div className="card-header">
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <h2>일별 판매 현황</h2>
              {lastUpdated && (
                <span style={{ fontSize: 12, color: '#999' }}>{lastUpdated.toLocaleTimeString('ko-KR')} 기준</span>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 13, color: '#5f6368' }}>{fmt(filtered.length)}개 상품</span>
              <button className="btn btn-outline btn-sm" onClick={fetchData} disabled={loading}>
                {loading ? '로딩...' : '🔄 새로고침'}
              </button>
            </div>
          </div>
          <div className="card-body" style={{ paddingBottom: 0 }}>
            {/* Filter Bar */}
            <div className="filter-bar">
              <input
                className="search-input"
                type="text"
                placeholder="상품명, 옵션명, 바코드 검색..."
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
              <select
                className="filter-select"
                value={statusFilter}
                onChange={e => setStatusFilter(e.target.value)}
              >
                {statusOptions.map(s => (
                  <option key={s} value={s}>{s === 'all' ? '전체 상태' : s}</option>
                ))}
                <option value="주의">⚠️ 주의 품목 ({cautionSet.size})</option>
              </select>
              {(search || statusFilter !== 'all') && (
                <button
                  className="btn btn-outline btn-sm"
                  onClick={() => { setSearch(''); setStatusFilter('all'); }}
                >
                  초기화
                </button>
              )}
              <div style={{ flex: 1 }} />
              <span style={{ fontSize: 12, color: '#5f6368' }}>
                색상: 셀 판매량이 높을수록 진한 녹색
              </span>
            </div>
          </div>

          <div className="table-wrapper" style={{ maxHeight: 'calc(100vh - 420px)', overflowY: 'auto', borderRadius: 0 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th onClick={() => handleSort('status')} className={sortKey === 'status' ? 'sorted' : ''}>
                    상태<SortIcon col="status" {...sortProps} />
                  </th>
                  <th style={{ minWidth: 50, textAlign: 'center' }}>메모</th>
                  <th onClick={() => handleSort('barcode')} className={sortKey === 'barcode' ? 'sorted' : ''}>
                    바코드<SortIcon col="barcode" {...sortProps} />
                  </th>
                  <th onClick={() => handleSort('productName')} className={sortKey === 'productName' ? 'sorted' : ''} style={{ maxWidth: 220, minWidth: 140 }}>
                    상품명<SortIcon col="productName" {...sortProps} />
                  </th>
                  <th onClick={() => handleSort('optionName')} className={sortKey === 'optionName' ? 'sorted' : ''}>
                    옵션명<SortIcon col="optionName" {...sortProps} />
                  </th>
                  <th className={`num ${sortKey === 'totalStock' ? 'sorted' : ''}`} onClick={() => handleSort('totalStock')}>
                    총재고<SortIcon col="totalStock" {...sortProps} />
                  </th>
                  <th className={`num ${sortKey === 'd6' ? 'sorted' : ''}`} onClick={() => handleSort('d6')}>
                    6일전<SortIcon col="d6" {...sortProps} />
                  </th>
                  <th className={`num ${sortKey === 'd5' ? 'sorted' : ''}`} onClick={() => handleSort('d5')}>
                    5일전<SortIcon col="d5" {...sortProps} />
                  </th>
                  <th className={`num ${sortKey === 'd4' ? 'sorted' : ''}`} onClick={() => handleSort('d4')}>
                    4일전<SortIcon col="d4" {...sortProps} />
                  </th>
                  <th className={`num ${sortKey === 'd3' ? 'sorted' : ''}`} onClick={() => handleSort('d3')}>
                    3일전<SortIcon col="d3" {...sortProps} />
                  </th>
                  <th className={`num ${sortKey === 'd2' ? 'sorted' : ''}`} onClick={() => handleSort('d2')}>
                    2일전<SortIcon col="d2" {...sortProps} />
                  </th>
                  <th className={`num ${sortKey === 'd1' ? 'sorted' : ''}`} onClick={() => handleSort('d1')}>
                    1일전<SortIcon col="d1" {...sortProps} />
                  </th>
                  <th className={`num ${sortKey === 'total' ? 'sorted' : ''}`} onClick={() => handleSort('total')}>
                    합계<SortIcon col="total" {...sortProps} />
                  </th>
                  <th className={`num ${sortKey === 'reviews' ? 'sorted' : ''}`} onClick={() => handleSort('reviews')}>
                    리뷰(6일)<SortIcon col="reviews" {...sortProps} />
                  </th>
                  <th className="center" style={{ minWidth: 80 }}>추세</th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 && !loading && (
                  <tr>
                    <td colSpan={15} style={{ textAlign: 'center', padding: '32px', color: '#aaa' }}>
                      {rows.length === 0 ? '데이터가 없습니다' : '검색 결과가 없습니다'}
                    </td>
                  </tr>
                )}
                {filtered.map((r, i) => {
                  const dayVals = [r.d6, r.d5, r.d4, r.d3, r.d2, r.d1];
                  return (
                    <tr key={r.barcode || i}>
                      <td>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          <span className={`status-badge ${r.status}`} style={
                            !['효자', '기준미달', '최종마감', '신규'].includes(r.status)
                              ? { background: '#f1f3f4', color: '#5f6368' }
                              : undefined
                          }>
                            {r.status || '—'}
                          </span>
                          {cautionSet.has(r.barcode) && (
                            <span style={{
                              background: '#fff3e0', color: '#e65100', border: '1px solid #ffcc80',
                              fontSize: 11, fontWeight: 600, padding: '1px 7px', borderRadius: 6,
                            }}>주의</span>
                          )}
                        </div>
                      </td>
                      <td style={{ textAlign: 'center', position: 'relative', minWidth: 50 }}>
                        {editingMemo === r.barcode ? (
                          <input
                            ref={memoInputRef}
                            value={memoInput}
                            onChange={e => setMemoInput(e.target.value)}
                            onBlur={commitMemo}
                            onKeyDown={e => { if (e.key === 'Enter') commitMemo(); if (e.key === 'Escape') { setEditingMemo(null); setMemoInput(''); } }}
                            style={{
                              width: 120, fontSize: 12, padding: '3px 6px',
                              border: '1.5px solid #1a73e8', borderRadius: 4, outline: 'none',
                            }}
                            placeholder="메모 입력..."
                          />
                        ) : (
                          <span
                            onClick={() => startEditMemo(r.barcode)}
                            title={memos[r.barcode] || '클릭하여 메모 추가'}
                            style={{
                              cursor: 'pointer',
                              fontSize: 14,
                              opacity: memos[r.barcode] ? 1 : 0.3,
                            }}
                          >
                            {memos[r.barcode] ? '📝' : '✏️'}
                          </span>
                        )}
                        {memos[r.barcode] && editingMemo !== r.barcode && (
                          <div className="memo-tooltip" style={{
                            position: 'absolute', bottom: '100%', left: '50%', transform: 'translateX(-50%)',
                            background: '#333', color: '#fff', fontSize: 12, padding: '6px 10px',
                            borderRadius: 6, whiteSpace: 'pre-wrap', maxWidth: 220, zIndex: 100,
                            pointerEvents: 'none', opacity: 0, transition: 'opacity 0.15s',
                            boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
                          }}>
                            {memos[r.barcode]}
                          </div>
                        )}
                      </td>
                      <td style={{ fontSize: 11, color: '#5f6368' }}>{r.barcode || '—'}</td>
                      <td
                        onClick={() => toggleCaution(r)}
                        style={{
                          maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          cursor: 'pointer', userSelect: 'none',
                          background: cautionSet.has(r.barcode) ? '#fff3e0' : undefined,
                          color: cautionSet.has(r.barcode) ? '#e65100' : undefined,
                          fontWeight: cautionSet.has(r.barcode) ? 600 : undefined,
                        }}
                        title={cautionSet.has(r.barcode) ? '클릭하여 주의 해제' : '클릭하여 주의 품목으로 지정'}
                      >
                        {cautionSet.has(r.barcode) && '⚠️ '}{r.productName}
                      </td>
                      <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: '#5f6368', fontSize: 12 }}>
                        {r.optionName || '—'}
                      </td>
                      <td className="num" style={{ fontWeight: 500 }}>
                        {r.totalStock > 0 ? fmt(r.totalStock) : <span style={{ color: '#ccc' }}>0</span>}
                      </td>
                      {dayVals.map((v, j) => (
                        <td
                          key={j}
                          className="num"
                          style={{ background: greenTint(v, maxDayVal), fontWeight: v > 0 ? 500 : undefined }}
                        >
                          {v > 0 ? fmt(v) : <span style={{ color: '#ccc' }}>0</span>}
                        </td>
                      ))}
                      <td className="num" style={{ fontWeight: 600 }}>{r.total > 0 ? fmt(r.total) : <span style={{ color: '#ccc' }}>0</span>}</td>
                      <td className="num">{r.reviews > 0 ? fmt(r.reviews) : <span style={{ color: '#ccc' }}>—</span>}</td>
                      <td className="center" style={{ fontSize: 11 }}>
                        <TrendIndicator d1={r.d1} d2={r.d2} d3={r.d3} d4={r.d4} d5={r.d5} d6={r.d6} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
