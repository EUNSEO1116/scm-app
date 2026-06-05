import React, { useState, useEffect, useMemo } from 'react';
import { dbStoreGet } from '../utils/dbApi';

const DB_KEY = 'cn_settlement_data';
const BRAND_KEY = 'cn_brand_mapping';
const EXCLUDE_CODES = ['BS'];

const DEFAULT_BRANDS = [
  { code: 'SH', name: '생활기준' },
  { code: 'S', name: '어리플' },
  { code: 'I', name: '일상포인트' },
  { code: 'I2', name: '일상포인트' },
  { code: 'M', name: '일상포인트' },
  { code: 'HM', name: '하루모음' },
  { code: 'HM2', name: '하루모음' },
  { code: 'B', name: '로즈바운드' },
  { code: 'O', name: '원데이홈' },
  { code: 'T', name: '토글리' },
  { code: 'L', name: '리빙스타일' },
  { code: 'P', name: '펄빈' },
  { code: 'E', name: '타플벨' },
];

function extractBrandCode(orderNo) {
  if (!orderNo) return null;
  const parts = orderNo.split('-');
  if (parts.length < 2 || parts[0] !== 'AE') return null;
  return parts[1];
}

function isNewProduct(orderNo) {
  if (!orderNo) return false;
  return orderNo.split('-').some(p => p.toUpperCase() === 'NEW');
}

function aggregateByBrand(record, brandMap) {
  const rate = record.exchangeRate;
  const result = {};
  for (const tx of record.transactions) {
    const code = extractBrandCode(tx.orderNo);
    if (!code || EXCLUDE_CODES.includes(code.toUpperCase())) continue;
    const brandName = brandMap[code] || `미분류(${code})`;
    if (!result[brandName]) result[brandName] = { existing: 0, new: 0, extraCost: 0 };
    const krw = Math.round(tx.amount * rate);
    if (tx.type === '추가비용') result[brandName].extraCost += krw;
    else if (tx.type === '오더 지불') {
      if (isNewProduct(tx.orderNo)) result[brandName].new += krw;
      else result[brandName].existing += krw;
    } else if (tx.type === '환불') {
      if (isNewProduct(tx.orderNo)) result[brandName].new -= krw;
      else result[brandName].existing -= krw;
    }
  }
  return result;
}

function getEndDate(record) {
  const dates = record.transactions.map(t => t.date).filter(Boolean).sort();
  const last = dates[dates.length - 1];
  if (!last) return null;
  return new Date(last + 'T00:00:00');
}

function getWeekOfMonth(date) {
  return Math.ceil(date.getDate() / 7);
}

function getMonthNum(date) {
  return date.getMonth() + 1;
}

function getMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function getDateRange(record) {
  if (record.dateLabel) return record.dateLabel.replace(' 발주내역', '');
  return record.fileName;
}

// 금액 포맷: ₩1,234,567
function fmtKrw(val) {
  if (val === 0) return '';
  const prefix = val < 0 ? '-' : '';
  return `${prefix}₩${Math.abs(val).toLocaleString()}`;
}

const S = {
  table: {
    width: '100%', borderCollapse: 'collapse', fontSize: 13,
  },
  th: {
    padding: '10px 12px', textAlign: 'center', fontWeight: 500, fontSize: 12,
    color: '#666', borderBottom: '1px solid #eee', whiteSpace: 'nowrap',
    background: '#fafbfc',
  },
  thSub: {
    padding: '4px 10px', textAlign: 'right', fontSize: 10, fontWeight: 500,
    color: '#999', borderBottom: '2px solid #eee', background: '#fafbfc',
    whiteSpace: 'nowrap',
  },
  td: {
    padding: '11px 12px', textAlign: 'right', borderBottom: '1px solid #f2f2f2',
    whiteSpace: 'nowrap', fontSize: 13,
  },
  weekTd: {
    padding: '11px 12px', textAlign: 'left', borderBottom: '1px solid #f2f2f2',
    fontWeight: 600, fontSize: 13, color: '#333', whiteSpace: 'nowrap',
  },
  dateTd: {
    padding: '11px 12px', textAlign: 'center', borderBottom: '1px solid #f2f2f2',
    fontSize: 13, color: '#555', whiteSpace: 'nowrap',
  },
  totalRow: {
    background: '#fafbfc', fontWeight: 700, borderTop: '2px solid #ddd',
  },
  green: { color: '#0a8a4a', fontWeight: 600 },
  blue: { color: '#1565c0', fontWeight: 600 },
  red: { color: '#d14', fontWeight: 600 },
};

export default function CnSettlementDashboard() {
  const [uploads, setUploads] = useState([]);
  const [brandMappings, setBrandMappings] = useState(DEFAULT_BRANDS);
  const [search, setSearch] = useState('');
  const [expandedMonths, setExpandedMonths] = useState({});
  const [allExpanded, setAllExpanded] = useState(false);

  useEffect(() => {
    dbStoreGet(DB_KEY).then(data => {
      if (data && Array.isArray(data)) setUploads(data);
    });
    dbStoreGet(BRAND_KEY).then(data => {
      if (data && Array.isArray(data) && data.length > 0) setBrandMappings(data);
    });
  }, []);

  const brandMap = {};
  for (const b of brandMappings) brandMap[b.code] = b.name;

  const { monthGroups, allBrands, currentMonthKey } = useMemo(() => {
    const carryOver = {};
    const processed = uploads.map(record => {
      const agg = aggregateByBrand(record, brandMap);
      const carried = {};
      for (const brand of Object.keys(carryOver)) {
        if (carryOver[brand].existing >= 0 && carryOver[brand].new >= 0) continue;
        if (!agg[brand]) agg[brand] = { existing: 0, new: 0, extraCost: 0 };
        if (carryOver[brand].existing < 0) {
          carried[brand] = carried[brand] || { existing: 0, new: 0 };
          carried[brand].existing = carryOver[brand].existing;
          agg[brand].existing += carryOver[brand].existing;
          carryOver[brand].existing = 0;
        }
        if (carryOver[brand].new < 0) {
          carried[brand] = carried[brand] || { existing: 0, new: 0 };
          carried[brand].new = carryOver[brand].new;
          agg[brand].new += carryOver[brand].new;
          carryOver[brand].new = 0;
        }
      }
      for (const brand of Object.keys(agg)) {
        if (agg[brand].existing < 0 || agg[brand].new < 0) {
          if (!carryOver[brand]) carryOver[brand] = { existing: 0, new: 0 };
          if (agg[brand].existing < 0) carryOver[brand].existing += agg[brand].existing;
          if (agg[brand].new < 0) carryOver[brand].new += agg[brand].new;
        }
      }
      return { record, agg, carried };
    });

    const brandSet = new Set();
    processed.forEach(({ agg }) => Object.keys(agg).forEach(b => brandSet.add(b)));
    const allBrands = [...brandSet].sort();

    const groups = {};
    processed.forEach(item => {
      const endDate = getEndDate(item.record);
      if (!endDate) return;
      const mk = getMonthKey(endDate);
      if (!groups[mk]) groups[mk] = { key: mk, month: getMonthNum(endDate), rows: [] };
      groups[mk].rows.push({
        ...item, endDate,
        week: getWeekOfMonth(endDate),
        dateRange: getDateRange(item.record),
      });
    });
    Object.values(groups).forEach(g => g.rows.sort((a, b) => b.endDate - a.endDate));

    const now = new Date();
    return { monthGroups: groups, allBrands, currentMonthKey: getMonthKey(now) };
  }, [uploads, brandMappings]);

  const sortedMonthKeys = Object.keys(monthGroups).sort((a, b) => b.localeCompare(a));

  const filteredKeys = search.trim()
    ? sortedMonthKeys.filter(mk => {
        const g = monthGroups[mk];
        const q = search.trim().toLowerCase();
        if (String(g.month).includes(q)) return true;
        return g.rows.some(r => r.dateRange.toLowerCase().includes(q) ||
          Object.keys(r.agg).some(b => b.toLowerCase().includes(q)));
      })
    : sortedMonthKeys;

  const isExpanded = (mk) => {
    if (allExpanded) return true;
    if (expandedMonths[mk] !== undefined) return expandedMonths[mk];
    return mk === currentMonthKey;
  };

  const toggleMonth = (mk) => {
    if (allExpanded) setAllExpanded(false);
    setExpandedMonths(prev => ({ ...prev, [mk]: !isExpanded(mk) }));
  };

  const toggleAll = () => {
    const next = !allExpanded;
    setAllExpanded(next);
    if (!next) {
      const reset = {};
      sortedMonthKeys.forEach(mk => { reset[mk] = mk === currentMonthKey; });
      setExpandedMonths(reset);
    }
  };

  const renderTable = (rows, monthNum) => {
    // 월 합계 계산
    const monthTotals = {};
    allBrands.forEach(b => { monthTotals[b] = { existing: 0, new: 0 }; });
    let grandExisting = 0, grandNew = 0;
    rows.forEach(({ agg }) => {
      allBrands.forEach(b => {
        if (agg[b]) {
          monthTotals[b].existing += agg[b].existing;
          monthTotals[b].new += agg[b].new;
          grandExisting += agg[b].existing;
          grandNew += agg[b].new;
        }
      });
    });

    return (
      <div style={{ overflowX: 'auto' }}>
        <table style={S.table}>
          <thead>
            <tr>
              <th style={{ ...S.th, textAlign: 'left', minWidth: 90 }}>주차</th>
              <th style={{ ...S.th, minWidth: 90 }}>기간</th>
              {allBrands.map(b => (
                <th key={b} colSpan={2} style={{ ...S.th, borderLeft: '1px solid #eee' }}>{b}</th>
              ))}
              <th colSpan={2} style={{ ...S.th, borderLeft: '2px solid #ccc', fontWeight: 700, color: '#333' }}>합계</th>
            </tr>
            <tr>
              <th style={S.thSub}></th>
              <th style={S.thSub}></th>
              {allBrands.map(b => (
                <React.Fragment key={b}>
                  <th style={{ ...S.thSub, borderLeft: '1px solid #eee' }}>기존</th>
                  <th style={S.thSub}>신규</th>
                </React.Fragment>
              ))}
              <th style={{ ...S.thSub, borderLeft: '2px solid #ccc' }}>기존</th>
              <th style={S.thSub}>신규</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ record, agg, week, dateRange }) => {
              let totalExisting = 0, totalNew = 0;
              allBrands.forEach(b => {
                if (agg[b]) { totalExisting += agg[b].existing; totalNew += agg[b].new; }
              });
              return (
                <tr key={record.id} style={{ transition: 'background 0.15s' }}
                  onMouseEnter={e => e.currentTarget.style.background = '#f8faff'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={S.weekTd}>{monthNum}월 {week}주차</td>
                  <td style={S.dateTd}>{dateRange}</td>
                  {allBrands.map(b => {
                    const d = agg[b];
                    const ex = d ? d.existing : 0;
                    const nw = d ? d.new : 0;
                    return (
                      <React.Fragment key={b}>
                        <td style={{ ...S.td, borderLeft: '1px solid #f2f2f2' }}>
                          {ex !== 0 ? (
                            <span style={ex < 0 ? S.red : S.green}>{fmtKrw(ex)}</span>
                          ) : <span style={{ color: '#ddd' }}>—</span>}
                        </td>
                        <td style={S.td}>
                          {nw !== 0 ? (
                            <span style={nw < 0 ? S.red : S.blue}>{fmtKrw(nw)}</span>
                          ) : <span style={{ color: '#ddd' }}>—</span>}
                        </td>
                      </React.Fragment>
                    );
                  })}
                  <td style={{ ...S.td, borderLeft: '2px solid #e0e0e0', fontWeight: 700 }}>
                    {totalExisting !== 0 ? (
                      <span style={totalExisting < 0 ? S.red : S.green}>{fmtKrw(totalExisting)}</span>
                    ) : <span style={{ color: '#ddd' }}>—</span>}
                  </td>
                  <td style={{ ...S.td, fontWeight: 700 }}>
                    {totalNew !== 0 ? (
                      <span style={totalNew < 0 ? S.red : S.blue}>{fmtKrw(totalNew)}</span>
                    ) : <span style={{ color: '#ddd' }}>—</span>}
                  </td>
                </tr>
              );
            })}
            {/* 합계 행 */}
            <tr style={S.totalRow}>
              <td style={{ ...S.weekTd, background: '#fafbfc' }}>합계</td>
              <td style={{ ...S.dateTd, background: '#fafbfc' }}></td>
              {allBrands.map(b => (
                <React.Fragment key={b}>
                  <td style={{ ...S.td, background: '#fafbfc', borderLeft: '1px solid #f2f2f2' }}>
                    {monthTotals[b].existing !== 0 ? (
                      <span style={monthTotals[b].existing < 0 ? S.red : S.green}>{fmtKrw(monthTotals[b].existing)}</span>
                    ) : <span style={{ color: '#ddd' }}>—</span>}
                  </td>
                  <td style={{ ...S.td, background: '#fafbfc' }}>
                    {monthTotals[b].new !== 0 ? (
                      <span style={monthTotals[b].new < 0 ? S.red : S.blue}>{fmtKrw(monthTotals[b].new)}</span>
                    ) : <span style={{ color: '#ddd' }}>—</span>}
                  </td>
                </React.Fragment>
              ))}
              <td style={{ ...S.td, background: '#fafbfc', borderLeft: '2px solid #e0e0e0', fontSize: 14 }}>
                <span style={grandExisting < 0 ? S.red : S.green}>{fmtKrw(grandExisting)}</span>
              </td>
              <td style={{ ...S.td, background: '#fafbfc', fontSize: 14 }}>
                <span style={grandNew < 0 ? S.red : S.blue}>{fmtKrw(grandNew)}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    );
  };

  return (
    <div>
      {/* 상단 바 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="월, 날짜, 브랜드명 검색..."
          style={{
            width: 280, padding: '7px 14px',
            border: '1px solid var(--border)', borderRadius: 8,
            fontSize: 13, outline: 'none',
          }}
          onFocus={(e) => e.target.style.borderColor = 'var(--primary)'}
          onBlur={(e) => e.target.style.borderColor = 'var(--border)'}
        />
        <button
          className="btn btn-outline btn-sm"
          onClick={toggleAll}
          style={{ fontSize: 12 }}
        >
          {allExpanded ? '전체 접기' : '전체 펼치기'}
        </button>
      </div>

      {filteredKeys.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>
          {uploads.length === 0 ? '거래 데이터를 먼저 업로드해 주세요' : '검색 결과가 없습니다'}
        </div>
      ) : (
        filteredKeys.map(mk => {
          const group = monthGroups[mk];
          const expanded = isExpanded(mk);
          const isCurrent = mk === currentMonthKey;

          return (
            <div key={mk} style={{
              background: '#fff', borderRadius: 10, marginBottom: 16,
              border: isCurrent ? '2px solid var(--primary)' : '1px solid #eee',
              boxShadow: isCurrent ? '0 2px 12px rgba(26,115,232,0.08)' : '0 1px 4px rgba(0,0,0,0.04)',
              overflow: 'hidden',
            }}>
              {/* 월 헤더 */}
              <div
                style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  padding: '14px 20px', cursor: 'pointer',
                  borderBottom: expanded ? '1px solid #eee' : 'none',
                  background: isCurrent ? '#f8faff' : '#fff',
                }}
                onClick={() => toggleMonth(mk)}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span style={{
                    display: 'inline-block', width: 4, height: 18, borderRadius: 2,
                    background: isCurrent ? 'var(--primary)' : '#ccc',
                  }}></span>
                  <span style={{ fontSize: 15, fontWeight: 700, color: '#222' }}>
                    {group.month}월 발주 현황
                  </span>
                  {isCurrent && (
                    <span style={{
                      fontSize: 10, fontWeight: 600, background: 'var(--primary)', color: '#fff',
                      padding: '2px 8px', borderRadius: 10, marginLeft: 4,
                    }}>이번 달</span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  <span style={{ fontSize: 12, color: '#999' }}>{group.rows.length}주</span>
                  <span style={{
                    fontSize: 11, color: '#999', transition: 'transform 0.2s',
                    transform: expanded ? 'rotate(90deg)' : 'rotate(0deg)',
                  }}>&#9654;</span>
                </div>
              </div>

              {expanded && renderTable(group.rows, group.month)}
            </div>
          );
        })
      )}
    </div>
  );
}
