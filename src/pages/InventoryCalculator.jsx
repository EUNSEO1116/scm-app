import { useState, useMemo, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const GID_CALCULATOR = '1349677364';
const GID_DATA_INPUT = '0';
const TSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=${GID_CALCULATOR}`;
const TSV_DATA_INPUT = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=${GID_DATA_INPUT}`;

const ALERT_CONFIG = {
  '긴급':     { emoji: '🚨', cls: 'emergency', label: '긴급' },
  '잠재긴급': { emoji: '🚨', cls: 'emergency', label: '잠재긴급' },
  '과잉주의': { emoji: '🔶', cls: 'warning',   label: '과잉주의' },
  '과잉재고': { emoji: '📦', cls: 'excess',    label: '과잉재고' },
  '정상':     { emoji: '✅', cls: 'normal',    label: '정상' },
  '판매없음': { emoji: '—',  cls: 'no-sales',  label: '판매없음' },
};

const EXCLUDE_KEYWORDS = ['최종마감', '품질확인서', '마감대상'];
const EXCLUDE_ITEMS_KEY = 'soldout_exclude_items';

function isExcluded(r) {
  if (EXCLUDE_KEYWORDS.some(kw => (r.status || '').includes(kw))) return true;
  try {
    const items = JSON.parse(localStorage.getItem(EXCLUDE_ITEMS_KEY) || '[]');
    const today = new Date().toISOString().slice(0, 10);
    return items.some(item => {
      if (item.endDate && item.endDate < today) return false;
      return (item.barcode && item.barcode === r.barcode) ||
             (item.optionId && item.optionId === r.optionId);
    });
  } catch { return false; }
}

function isEmergency(r) {
  if (r.avg3d <= 0) return false;
  return r.totalStock < r.avg3d * 14;
}

function isNeedOrder(r) {
  if (r.weeksTotalStock === null || isNaN(r.weeksTotalStock)) return false;
  return r.weeksTotalStock < 6;
}

function isNormal(r) {
  if (r.weeksTotalStock === null || isNaN(r.weeksTotalStock)) return false;
  return r.weeksTotalStock >= 6 && r.weeksTotalStock < 9;
}

function isExcess(r) {
  if (r.weeksTotalStock === null || isNaN(r.weeksTotalStock)) return false;
  return r.weeksTotalStock >= 9;
}

function fmt(n) {
  if (n === null || n === undefined || n === '' || n === '-') return '-';
  const num = Number(n);
  if (isNaN(num)) return n;
  return num.toLocaleString('ko-KR');
}

function fmtDec(n, d = 1) {
  if (n === null || n === undefined || n === '' || n === '-') return '-';
  const num = Number(n);
  if (isNaN(num)) return '-';
  return num.toFixed(d);
}

function safeNum(v) {
  if (v === '' || v === '-' || v === undefined || v === null) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function parseDataInputTsv(tsv) {
  // 데이터 입력 시트에서 옵션ID → 상품등급 매핑 생성
  const lines = tsv.split('\n').filter(l => l.trim());
  const map = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const optionId = (cols[2] || '').trim(); // col3 = 옵션 ID
    const grade = (cols[6] || '').trim();     // col7 = 상품등급
    if (optionId && grade) {
      map[optionId] = grade;
    }
  }
  return map;
}

function parseTsv(tsv, statusMap) {
  const lines = tsv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const headers = lines[0].split('\t');
  const results = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (!cols[1] && !cols[2]) continue; // skip empty rows

    const optionId = cols[1] || '';
    const barcode = cols[2] || '';
    const productName = cols[3] || '';
    const optionName = cols[4] || '';
    // 상태: 재고 계산기 시트 값 우선, 없으면 데이터 입력 시트의 상품등급 사용
    const rawStatus = cols[5] || '';
    const status = rawStatus || (statusMap && statusMap[optionId]) || '';
    const stock = safeNum(cols[6]);
    const incoming = safeNum(cols[7]);    // 그로스 입고예정
    const ipgo = safeNum(cols[8]);        // 입고
    const bhStock = safeNum(cols[9]);     // 박스히어로
    const fbcShipment = safeNum(cols[10]);
    const normalShipment = safeNum(cols[11]);
    const fbcOrder = safeNum(cols[12]);
    const normalOrder = safeNum(cols[13]);
    const totalStock = safeNum(cols[14]);
    const orderUnit = cols[17] || '';
    const orderQty3d = safeNum(cols[18]);
    const orderQty7d = safeNum(cols[19]);
    const orderQty30d = safeNum(cols[20]);
    const weeksStockOnly = cols[21] !== '' ? Number(cols[21]) : null;
    const weeksTotalStock = cols[22] !== '' ? Number(cols[22]) : null;
    const weeksAfterOrder = cols[23] !== '' ? Number(cols[23]) : null;
    const trendNew = cols[24] || '';
    const trend30v7 = cols[25] || '';
    const avg3d = safeNum(cols[26]);
    const recommendation = cols[27] || '';
    const safeStock3d = safeNum(cols[28]);
    const safeStock7d = safeNum(cols[29]);
    const safeStock30d = safeNum(cols[30]);
    const leadTime = safeNum(cols[31]) || 30;
    const seasonIndex = safeNum(cols[32]) || 1;
    const alert = (cols[33] || '').trim();

    // 입고예정 + 입고 합산 표시용
    const incomingTotal = incoming + ipgo;
    const hasIncoming = incoming > 0;
    const hasIpgo = ipgo > 0;

    results.push({
      optionId, barcode, productName, optionName, status,
      stock, incoming, ipgo, incomingTotal, hasIncoming, hasIpgo,
      bhStock, fbcShipment, normalShipment, fbcOrder, normalOrder,
      totalStock, orderUnit,
      orderQty3d, orderQty7d, orderQty30d,
      weeksStockOnly, weeksTotalStock, weeksAfterOrder,
      trendNew, trend30v7, avg3d, recommendation,
      safeStock3d, safeStock7d, safeStock30d,
      leadTime, seasonIndex, alert,
    });
  }

  return results;
}

export default function InventoryCalculator() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [search, setSearch] = useState('');
  const [alertFilter, setAlertFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [quickFilter, setQuickFilter] = useState(null); // 'emergency'|'needOrder'|'normal'|'excess'|null

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [calcRes, dataRes] = await Promise.all([
        fetch(TSV_URL),
        fetch(TSV_DATA_INPUT),
      ]);
      if (!calcRes.ok) throw new Error(`재고 계산기 시트 HTTP ${calcRes.status}`);
      const calcTsv = await calcRes.text();
      // 데이터 입력 시트에서 상품등급 매핑 (실패해도 무시)
      let statusMap = {};
      if (dataRes.ok) {
        const dataTsv = await dataRes.text();
        statusMap = parseDataInputTsv(dataTsv);
      }
      const result = parseTsv(calcTsv, statusMap);
      setData(result);
      setLastUpdated(new Date());
    } catch (err) {
      setError('스프레드시트를 불러오지 못했습니다: ' + err.message);
    }
    setLoading(false);
  }, []);

  // 최초 로드
  useEffect(() => { fetchData(); }, [fetchData]);

  // Derived: unique statuses, alert counts
  const { statuses, alertCounts } = useMemo(() => {
    if (!data) return { statuses: [], alertCounts: {} };
    const s = new Set();
    const counts = {};
    data.forEach(r => {
      if (r.status) s.add(r.status);
      const alertKey = Object.keys(ALERT_CONFIG).find(k => r.alert.includes(k)) || '판매없음';
      counts[alertKey] = (counts[alertKey] || 0) + 1;
    });
    return { statuses: [...s].sort(), alertCounts: counts };
  }, [data]);

  // Filtering + sorting
  const filtered = useMemo(() => {
    if (!data) return [];
    let rows = data;

    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        r.productName.toLowerCase().includes(q) ||
        r.optionName.toLowerCase().includes(q) ||
        r.barcode.toLowerCase().includes(q)
      );
    }

    if (quickFilter === 'emergency') {
      rows = rows.filter(r => !isExcluded(r) && isEmergency(r));
    } else if (quickFilter === 'needOrder') {
      rows = rows.filter(r => !isExcluded(r) && !isEmergency(r) && isNeedOrder(r));
    } else if (quickFilter === 'normal') {
      rows = rows.filter(r => isNormal(r));
    } else if (quickFilter === 'excess') {
      rows = rows.filter(r => isExcess(r));
    } else if (quickFilter === 'noSales') {
      rows = rows.filter(r => r.alert.includes('판매없음'));
    }

    if (alertFilter !== 'all') {
      rows = rows.filter(r => r.alert.includes(alertFilter));
    }

    if (statusFilter !== 'all') {
      rows = rows.filter(r => r.status === statusFilter);
    }

    if (sortKey) {
      rows = [...rows].sort((a, b) => {
        let va = a[sortKey], vb = b[sortKey];
        if (typeof va === 'string') va = va.toLowerCase();
        if (typeof vb === 'string') vb = vb.toLowerCase();
        if (va === null || va === undefined) va = '';
        if (vb === null || vb === undefined) vb = '';
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return rows;
  }, [data, search, quickFilter, alertFilter, statusFilter, sortKey, sortDir]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const SortIcon = ({ col }) => (
    <span className="sort-icon">
      {sortKey === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );

  // Export to Excel
  const handleExport = () => {
    if (!filtered.length) return;
    const exportData = filtered.map(r => ({
      '옵션ID': r.optionId,
      '쿠팡바코드': r.barcode,
      '상품명': r.productName,
      '옵션명': r.optionName,
      '상태': r.status,
      '쿠팡재고': r.stock,
      '입고(합산)': r.incomingTotal,
      '그로스입고예정': r.incoming,
      '입고': r.ipgo,
      '박스히어로': r.bhStock,
      '총재고': r.totalStock,
      '발주량(3일)': r.orderQty3d,
      '발주량(7일)': r.orderQty7d,
      '발주량(30일)': r.orderQty30d,
      '예상판매주(쿠팡)': r.weeksStockOnly !== null ? Number(fmtDec(r.weeksStockOnly)) : '-',
      '예상판매주(총재고)': r.weeksTotalStock !== null ? Number(fmtDec(r.weeksTotalStock)) : '-',
      '3일평균판매': r.avg3d,
      '안전재고(7일)': r.safeStock7d,
      '리드타임': r.leadTime,
      '알림': r.alert,
    }));
    const ws = XLSX.utils.json_to_sheet(exportData);
    const newWb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(newWb, ws, '재고계산기');
    XLSX.writeFile(newWb, `재고계산기_${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  // Stats
  const stats = useMemo(() => {
    if (!data) return null;
    const totalProducts = data.length;
    const emergency = data.filter(r => !isExcluded(r) && isEmergency(r)).length;
    const needOrder = data.filter(r => !isExcluded(r) && !isEmergency(r) && isNeedOrder(r)).length;
    const normal = data.filter(r => isNormal(r)).length;
    const excess = data.filter(r => isExcess(r)).length;
    const noSales = data.filter(r => r.alert.includes('판매없음')).length;
    return { emergency, excess, normal, totalProducts, needOrder, noSales };
  }, [data]);

  // Loading / error states
  if (loading && !data) {
    return (
      <div className="loading" style={{ padding: 80, flexDirection: 'column', gap: 12 }}>
        <div className="spinner" />
        <p>스프레드시트에서 데이터를 불러오는 중...</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="card">
        <div className="card-body" style={{ textAlign: 'center', padding: 60 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h3 style={{ marginBottom: 8 }}>{error}</h3>
          <p style={{ color: '#5f6368', marginBottom: 20 }}>스프레드시트가 공개 설정인지 확인해주세요.</p>
          <button className="btn btn-primary" onClick={fetchData}>다시 시도</button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div>
      {/* Stats */}
      <div className="stats-grid">
        <div
          className={`stat-card info clickable${quickFilter === null ? ' selected' : ''}`}
          onClick={() => setQuickFilter(null)}
        >
          <div className="label">전체 상품</div>
          <div className="value">{fmt(stats.totalProducts)}</div>
          <div className="sub">
            {lastUpdated && `${lastUpdated.toLocaleTimeString('ko-KR')} 기준`}
          </div>
        </div>
        <div
          className={`stat-card danger clickable${quickFilter === 'emergency' ? ' selected' : ''}`}
          onClick={() => setQuickFilter(quickFilter === 'emergency' ? null : 'emergency')}
        >
          <div className="label">긴급</div>
          <div className="value">{fmt(stats.emergency)}</div>
          <div className="sub">총재고 14일치 미만 (판매0 제외)</div>
        </div>
        <div
          className={`stat-card warning clickable${quickFilter === 'needOrder' ? ' selected' : ''}`}
          onClick={() => setQuickFilter(quickFilter === 'needOrder' ? null : 'needOrder')}
        >
          <div className="label">발주 필요</div>
          <div className="value">{fmt(stats.needOrder)}</div>
          <div className="sub">예상판매주 6주 미만</div>
        </div>
        <div
          className={`stat-card success clickable${quickFilter === 'normal' ? ' selected' : ''}`}
          onClick={() => setQuickFilter(quickFilter === 'normal' ? null : 'normal')}
        >
          <div className="label">정상</div>
          <div className="value">{fmt(stats.normal)}</div>
          <div className="sub">예상판매주 6~9주</div>
        </div>
        <div
          className={`stat-card clickable${quickFilter === 'excess' ? ' selected' : ''}`}
          style={{ background: quickFilter === 'excess' ? '#d4e5ff' : '#f0f7ff' }}
          onClick={() => setQuickFilter(quickFilter === 'excess' ? null : 'excess')}
        >
          <div className="label">과잉 재고</div>
          <div className="value" style={{ color: '#1967d2' }}>{fmt(stats.excess)}</div>
          <div className="sub">예상판매주 9주 이상</div>
        </div>
        <div
          className={`stat-card clickable${quickFilter === 'noSales' ? ' selected' : ''}`}
          style={{ background: quickFilter === 'noSales' ? '#e0e0e0' : '#f5f5f5' }}
          onClick={() => setQuickFilter(quickFilter === 'noSales' ? null : 'noSales')}
        >
          <div className="label">판매없음</div>
          <div className="value" style={{ color: '#999' }}>{fmt(stats.noSales)}</div>
          <div className="sub">판매 데이터 없음</div>
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className="filter-bar">
            <input
              className="search-input"
              placeholder="상품명, 옵션명, 바코드 검색..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <select className="filter-select" value={alertFilter} onChange={e => setAlertFilter(e.target.value)}>
              <option value="all">전체 알림</option>
              {Object.keys(ALERT_CONFIG).map(k => (
                <option key={k} value={k}>
                  {ALERT_CONFIG[k].emoji} {k} ({alertCounts[k] || 0})
                </option>
              ))}
            </select>
            <select className="filter-select" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="all">전체 상태</option>
              {statuses.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="btn btn-outline btn-sm" onClick={() => { setSearch(''); setAlertFilter('all'); setStatusFilter('all'); }}>
              초기화
            </button>
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 13, color: '#5f6368' }}>{fmt(filtered.length)}개 상품</span>
            <button className="btn btn-primary btn-sm" onClick={handleExport}>
              📥 엑셀 다운로드
            </button>
            <button className="btn btn-outline btn-sm" onClick={fetchData} disabled={loading}>
              {loading ? '새로고침 중...' : '🔄 새로고침'}
            </button>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="table-wrapper" style={{ maxHeight: 'calc(100vh - 340px)', overflowY: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th onClick={() => handleSort('alert')} className={sortKey === 'alert' ? 'sorted' : ''}>
                알림<SortIcon col="alert" />
              </th>
              <th onClick={() => handleSort('barcode')} className={sortKey === 'barcode' ? 'sorted' : ''}>
                바코드<SortIcon col="barcode" />
              </th>
              <th onClick={() => handleSort('productName')} className={sortKey === 'productName' ? 'sorted' : ''} style={{ maxWidth: 250 }}>
                상품명<SortIcon col="productName" />
              </th>
              <th onClick={() => handleSort('optionName')} className={sortKey === 'optionName' ? 'sorted' : ''}>
                옵션명<SortIcon col="optionName" />
              </th>
              <th onClick={() => handleSort('status')} className={sortKey === 'status' ? 'sorted' : ''}>
                상태<SortIcon col="status" />
              </th>
              <th onClick={() => handleSort('stock')} className={sortKey === 'stock' ? 'sorted' : ''}>
                쿠팡재고<SortIcon col="stock" />
              </th>
              <th onClick={() => handleSort('incomingTotal')} className={sortKey === 'incomingTotal' ? 'sorted' : ''}>
                입고<SortIcon col="incomingTotal" />
              </th>
              <th onClick={() => handleSort('bhStock')} className={sortKey === 'bhStock' ? 'sorted' : ''}>
                박스히어로<SortIcon col="bhStock" />
              </th>
              <th onClick={() => handleSort('totalStock')} className={sortKey === 'totalStock' ? 'sorted' : ''}>
                총재고<SortIcon col="totalStock" />
              </th>
              <th onClick={() => handleSort('avg3d')} className={sortKey === 'avg3d' ? 'sorted' : ''}>
                3일평균<SortIcon col="avg3d" />
              </th>
              <th onClick={() => handleSort('orderQty3d')} className={sortKey === 'orderQty3d' ? 'sorted' : ''}>
                발주량(3일)<SortIcon col="orderQty3d" />
              </th>
              <th onClick={() => handleSort('orderQty7d')} className={sortKey === 'orderQty7d' ? 'sorted' : ''}>
                발주량(7일)<SortIcon col="orderQty7d" />
              </th>
              <th onClick={() => handleSort('orderQty30d')} className={sortKey === 'orderQty30d' ? 'sorted' : ''}>
                발주량(30일)<SortIcon col="orderQty30d" />
              </th>
              <th onClick={() => handleSort('weeksStockOnly')} className={sortKey === 'weeksStockOnly' ? 'sorted' : ''}>
                예상판매주(쿠팡)<SortIcon col="weeksStockOnly" />
              </th>
              <th onClick={() => handleSort('weeksTotalStock')} className={sortKey === 'weeksTotalStock' ? 'sorted' : ''}>
                예상판매주(총재고)<SortIcon col="weeksTotalStock" />
              </th>
              <th onClick={() => handleSort('safeStock7d')} className={sortKey === 'safeStock7d' ? 'sorted' : ''}>
                안전재고<SortIcon col="safeStock7d" />
              </th>
              <th onClick={() => handleSort('leadTime')} className={sortKey === 'leadTime' ? 'sorted' : ''}>
                리드타임<SortIcon col="leadTime" />
              </th>
              <th onClick={() => handleSort('seasonIndex')} className={sortKey === 'seasonIndex' ? 'sorted' : ''}>
                시즌지수<SortIcon col="seasonIndex" />
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const alertKey = Object.keys(ALERT_CONFIG).find(k => r.alert.includes(k)) || '판매없음';
              const ac = ALERT_CONFIG[alertKey];
              const rowCls = (r.alert.includes('긴급')) ? 'row-emergency' :
                             (r.alert.includes('과잉재고')) ? 'row-excess' : '';
              return (
                <tr key={r.optionId + '-' + i} className={rowCls}>
                  <td className="num">{i + 1}</td>
                  <td>
                    <span className={`alert-badge ${ac.cls}`}>
                      {ac.emoji} {ac.label}
                    </span>
                  </td>
                  <td style={{ fontSize: 11, color: '#666' }}>{r.barcode}</td>
                  <td style={{ maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.productName}>
                    {r.productName}
                  </td>
                  <td>{r.optionName}</td>
                  <td>
                    {r.status && <span className={`status-badge ${r.status}`}>{r.status}</span>}
                  </td>
                  <td className="num">{fmt(r.stock)}</td>
                  <td className="num">
                    {r.hasIncoming && r.hasIpgo ? (
                      <span className="tooltip-trigger">
                        <strong>{fmt(r.incomingTotal)}</strong>
                        <span className="tooltip">입고예정 {fmt(r.incoming)} + 입고 {fmt(r.ipgo)}</span>
                      </span>
                    ) : r.hasIncoming ? (
                      fmt(r.incoming)
                    ) : r.hasIpgo ? (
                      fmt(r.ipgo)
                    ) : '-'}
                  </td>
                  <td className="num">{r.bhStock ? fmt(r.bhStock) : '-'}</td>
                  <td className="num" style={{ fontWeight: 600 }}>{fmt(r.totalStock)}</td>
                  <td className="num">{r.avg3d > 0 ? fmtDec(r.avg3d) : '-'}</td>
                  <td className={`num ${r.orderQty3d > 0 ? 'text-danger' : ''}`}>
                    {fmt(r.orderQty3d)}
                  </td>
                  <td className={`num ${r.orderQty7d > 0 ? 'text-danger' : ''}`} style={{ fontWeight: r.orderQty7d > 0 ? 600 : 400 }}>
                    {fmt(r.orderQty7d)}
                  </td>
                  <td className="num">{fmt(r.orderQty30d)}</td>
                  <td className="num">
                    {r.weeksStockOnly !== null && !isNaN(r.weeksStockOnly) ? fmtDec(r.weeksStockOnly) + '주' : '-'}
                  </td>
                  <td className="num">
                    {r.weeksTotalStock !== null && !isNaN(r.weeksTotalStock) ? fmtDec(r.weeksTotalStock) + '주' : '-'}
                  </td>
                  <td className="num">{fmt(r.safeStock7d)}</td>
                  <td className="num">{r.leadTime}일</td>
                  <td className="num">{r.seasonIndex}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
