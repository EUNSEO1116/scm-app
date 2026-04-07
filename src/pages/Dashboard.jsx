import { useState, useMemo, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';
import './FbcCalculator.css';

const MONTHS_KR = ['1월', '2월', '3월', '4월', '5월', '6월', '7월', '8월', '9월', '10월', '11월', '12월'];

function formatWon(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return Number(n).toLocaleString('ko-KR') + '원';
}

function parseDate(str) {
  if (!str) return null;
  // e.g. "2025. 3. 10." or "2025-03-10"
  const m = str.match(/(\d{4})[.\-/\s]+(\d{1,2})[.\-/\s]+(\d{1,2})/);
  if (!m) return null;
  return new Date(parseInt(m[1]), parseInt(m[2]) - 1, parseInt(m[3]));
}

function loadHistory() {
  try {
    return JSON.parse(localStorage.getItem('fbc_savings_history') || '[]');
  } catch {
    return [];
  }
}

function saveHistory(history) {
  localStorage.setItem('fbc_savings_history', JSON.stringify(history));
  dbStoreSet('fbc_savings', history).catch(() => {});
}

const PALLET_WORK_COST = 35000;
const DELIVERY_COST_PER_BOX = 5000;

// ─── Detail Modal (비용 비교 결과 레이아웃) ──────────────────────────────────────
function DetailModal({ record, onClose }) {
  if (!record) return null;
  const d = record.detail || {};
  const normal = d.normal || {};
  const fbc = d.fbc || {};
  const diff = record.savings || 0;

  return (
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-content" style={{ maxWidth: 720 }}>
        <div className="modal-header">
          <h3>{record.bundleName}</h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 12, color: '#5f6368' }}>{record.date} · {record.fileName}</span>
            <button className="modal-close" onClick={onClose}>✕</button>
          </div>
        </div>
        <div className="modal-body" style={{ padding: 0 }}>
          {/* Savings banner */}
          <div className={`savings-banner ${diff >= 0 ? 'fbc-wins' : 'normal-wins'}`} style={{ borderRadius: 0 }}>
            <div>
              <div className="banner-label">
                {diff >= 0 ? '✅ FBC가 더 저렴합니다' : '⚠️ 일반배송이 더 저렴합니다'}
              </div>
              <div className="banner-amount">
                {diff >= 0 ? '절감 ' : '추가 '}{formatWon(Math.abs(diff))}
              </div>
              {record.normalTotal > 0 && (
                <div className="banner-pct">
                  {Math.abs(Math.round(diff / record.normalTotal * 100))}% 차이
                </div>
              )}
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 13, color: '#5f6368' }}>
                박스 {(record.totalBoxes || 0).toLocaleString()}개 / CBM {record.totalCbm ? Number(record.totalCbm).toFixed(2) : '-'} ㎥
              </div>
            </div>
          </div>

          {/* Cost cards */}
          <div style={{ padding: '20px' }}>
            <div className="result-container">
              <div className={`result-card${diff < 0 ? ' winner' : ''}`}>
                <div className="result-card-header normal-header">
                  <span className="result-card-title">일반 배송</span>
                  {diff < 0 && <span className="winner-badge">✓ 절약</span>}
                </div>
                <div className="result-card-body">
                  {normal.truckName && (
                    <div className="cost-row">
                      <span className="cost-label">차량 ({normal.truckName})</span>
                      <span className="cost-value">{formatWon(normal.truckCost)}</span>
                    </div>
                  )}
                  {normal.deliveryCost != null && (
                    <div className="cost-row">
                      <span className="cost-label">배송비 ({(record.totalBoxes || 0)}박스 × {formatWon(DELIVERY_COST_PER_BOX)})</span>
                      <span className="cost-value">{formatWon(normal.deliveryCost)}</span>
                    </div>
                  )}
                  <div className="cost-row total-row">
                    <span className="cost-label">합계</span>
                    <span className="cost-value">{formatWon(normal.total || record.normalTotal)}</span>
                  </div>
                </div>
              </div>

              <div className={`result-card${diff >= 0 ? ' winner' : ''}`}>
                <div className="result-card-header fbc-header">
                  <span className="result-card-title">FBC 배송</span>
                  {diff >= 0 && <span className="winner-badge">✓ 절약</span>}
                </div>
                <div className="result-card-body">
                  {fbc.totalPallets != null && (
                    <div className="cost-row">
                      <span className="cost-label">밀크런 ({fbc.totalPallets}파레트)</span>
                      <span className="cost-value">{formatWon(fbc.milkrunCost)}</span>
                    </div>
                  )}
                  {fbc.palletWorkCost != null && (
                    <div className="cost-row">
                      <span className="cost-label">파레트 작업비 ({fbc.totalPallets} × {formatWon(PALLET_WORK_COST)})</span>
                      <span className="cost-value">{formatWon(fbc.palletWorkCost)}</span>
                    </div>
                  )}
                  <div className="cost-row total-row">
                    <span className="cost-label">합계</span>
                    <span className="cost-value">{formatWon(fbc.total || record.fbcTotal)}</span>
                  </div>
                </div>
              </div>
            </div>

            {/* Pallet detail table */}
            {fbc.palletDetails?.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div className="cost-section-title" style={{ marginBottom: 8 }}>파레트 상세</div>
                <div className="table-wrapper">
                  <table className="pallet-detail-table">
                    <thead>
                      <tr>
                        <th>구분</th>
                        <th className="num">박스 수</th>
                        <th className="num">파레트 수</th>
                      </tr>
                    </thead>
                    <tbody>
                      {fbc.palletDetails.map((pd, i) => (
                        <tr key={i}>
                          <td>{pd.key}</td>
                          <td className="num">{pd.boxes}</td>
                          <td className="num">{pd.pallets}</td>
                        </tr>
                      ))}
                      <tr style={{ fontWeight: 700, borderTop: '2px solid #e0e0e0' }}>
                        <td>합계</td>
                        <td className="num">{fbc.palletDetails.reduce((s, pd) => s + pd.boxes, 0)}</td>
                        <td className="num">{fbc.totalPallets}</td>
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Dashboard ────────────────────────────────────────────────────────────────
export default function Dashboard() {
  const [history, setHistory] = useState(loadHistory);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [searchQuery, setSearchQuery] = useState('');
  const [collapsedMonths, setCollapsedMonths] = useState(new Set());
  const [detailModal, setDetailModal] = useState(null);
  const [hoveredBar, setHoveredBar] = useState(null);
  const chartRef = useRef();

  const refresh = () => setHistory(loadHistory());

  // DB에서 초기 데이터 로드
  useEffect(() => {
    dbStoreGet('fbc_savings').then(data => {
      if (data && Array.isArray(data) && data.length > 0) {
        localStorage.setItem('fbc_savings_history', JSON.stringify(data));
        setHistory(data);
      }
    }).catch(() => {});
  }, []);

  // ── Stats ──────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = history.reduce((s, r) => s + (r.savings || 0), 0);
    const fileSet = new Set(history.map(r => r.fileName));
    const now = new Date();
    const thisMonth = history.filter(r => {
      const d = parseDate(r.date);
      return d && d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
    const monthSavings = thisMonth.reduce((s, r) => s + (r.savings || 0), 0);
    const avgSavings = history.length ? Math.round(total / history.length) : 0;
    const totalBoxes = history.reduce((s, r) => s + (r.totalBoxes || 0), 0);
    const fbcWins = history.filter(r => (r.savings || 0) > 0).length;
    const winRate = history.length ? Math.round(fbcWins / history.length * 100) : 0;
    return {
      total, fileCount: fileSet.size, recordCount: history.length,
      monthSavings, monthCount: thisMonth.length,
      avgSavings, totalBoxes,
      fbcWins, winRate,
      currentMonthLabel: MONTHS_KR[now.getMonth()],
    };
  }, [history]);

  // ── Monthly chart data ─────────────────────────────────────────────────────
  const monthlyData = useMemo(() => {
    const buckets = Array.from({ length: 12 }, (_, i) => ({
      month: i,
      label: MONTHS_KR[i],
      savings: 0,
      count: 0,
    }));
    for (const r of history) {
      const d = parseDate(r.date);
      if (d && d.getFullYear() === selectedYear) {
        buckets[d.getMonth()].savings += r.savings || 0;
        buckets[d.getMonth()].count++;
      }
    }
    const maxAbs = Math.max(...buckets.map(b => Math.abs(b.savings)), 1);
    return buckets.map(b => ({ ...b, height: Math.round((Math.abs(b.savings) / maxAbs) * 120) }));
  }, [history, selectedYear]);

  // ── Filtered & grouped ─────────────────────────────────────────────────────
  const filtered = useMemo(() => {
    if (!searchQuery.trim()) return history;
    const q = searchQuery.toLowerCase();
    return history.filter(r =>
      (r.fileName || '').toLowerCase().includes(q) ||
      (r.bundleName || '').toLowerCase().includes(q)
    );
  }, [history, searchQuery]);

  const monthGroups = useMemo(() => {
    const map = {};
    for (const r of filtered) {
      const d = parseDate(r.date);
      const key = d
        ? `${d.getFullYear()}년 ${MONTHS_KR[d.getMonth()]}`
        : '날짜 미상';
      if (!map[key]) map[key] = { label: key, records: [], savings: 0, boxes: 0 };
      map[key].records.push(r);
      map[key].savings += r.savings || 0;
      map[key].boxes += r.totalBoxes || 0;
    }
    return Object.values(map).reverse();
  }, [filtered]);

  const toggleMonth = (key) => {
    setCollapsedMonths(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const deleteRecord = (id) => {
    const updated = history.filter(r => r.id !== id);
    saveHistory(updated);
    setHistory(updated);
  };

  const clearAll = () => {
    if (!window.confirm('모든 기록을 삭제하시겠습니까?')) return;
    saveHistory([]);
    setHistory([]);
  };

  const exportAll = () => {
    if (!history.length) return;
    const rows = history.map(r => ({
      날짜: r.date,
      파일명: r.fileName,
      묶음: r.bundleName,
      박스수: r.totalBoxes,
      CBM: r.totalCbm,
      일반비용: r.normalTotal,
      FBC비용: r.fbcTotal,
      절감액: r.savings,
      절감률: r.normalTotal ? Math.round(r.savings / r.normalTotal * 100) + '%' : '-',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'FBC절감내역');
    XLSX.writeFile(wb, `FBC절감_전체_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const exportMonth = (group) => {
    const rows = group.records.map(r => ({
      날짜: r.date,
      파일명: r.fileName,
      묶음: r.bundleName,
      박스수: r.totalBoxes,
      CBM: r.totalCbm,
      일반비용: r.normalTotal,
      FBC비용: r.fbcTotal,
      절감액: r.savings,
      절감률: r.normalTotal ? Math.round(r.savings / r.normalTotal * 100) + '%' : '-',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, group.label);
    XLSX.writeFile(wb, `FBC절감_${group.label}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div>
      {/* Stats */}
      <div className="dashboard-stats">
        <div className="stat-card primary">
          <div className="stat-label">총 누적 절감액</div>
          <div className="stat-value">{Math.round(stats.total / 10000).toLocaleString()}만원</div>
          <div className="stat-sub">파일 {stats.fileCount}개 / 기록 {stats.recordCount}건</div>
        </div>
        <div className="stat-card green">
          <div className="stat-label">{stats.currentMonthLabel} 절감액</div>
          <div className="stat-value">{Math.round(stats.monthSavings / 10000).toLocaleString()}만원</div>
          <div className="stat-sub">{stats.monthCount}건</div>
        </div>
        <div className="stat-card orange">
          <div className="stat-label">건당 평균 절감</div>
          <div className="stat-value">{Math.round(stats.avgSavings / 10000).toLocaleString()}만원</div>
          <div className="stat-sub">총 {stats.totalBoxes.toLocaleString()}박스</div>
        </div>
        <div className="stat-card purple">
          <div className="stat-label">FBC 승률</div>
          <div className="stat-value">{stats.winRate}%</div>
          <div className="stat-sub">FBC 유리 {stats.fbcWins}건 / 전체 {stats.recordCount}건</div>
        </div>
      </div>

      {/* Monthly bar chart */}
      <div className="chart-section">
        <div className="chart-header">
          <h2>월별 절감액</h2>
          <div className="year-selector">
            <button className="year-btn" onClick={() => setSelectedYear(y => y - 1)}>◀</button>
            <span className="year-display">{selectedYear}</span>
            <button className="year-btn" onClick={() => setSelectedYear(y => y + 1)}>▶</button>
          </div>
        </div>
        <div className="month-chart" ref={chartRef}>
          {monthlyData.map((bar) => (
            <div
              key={bar.month}
              className="month-bar-wrap"
              onMouseEnter={() => setHoveredBar(bar.month)}
              onMouseLeave={() => setHoveredBar(null)}
            >
              {hoveredBar === bar.month && bar.count > 0 && (
                <div className="bar-tooltip">
                  {bar.label}: {formatWon(bar.savings)}<br />
                  {bar.count}건
                </div>
              )}
              <div
                className={`month-bar ${bar.savings > 0 ? 'positive' : bar.savings < 0 ? 'negative' : 'empty'}`}
                style={{ height: bar.count > 0 ? bar.height + 'px' : '8px' }}
              />
              <span className="month-label">{bar.label}</span>
              {bar.count > 0 && (
                <span className="month-bar-amount">
                  {bar.savings >= 0 ? '+' : ''}{Math.round(bar.savings / 10000)}만
                </span>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* History table */}
      <div className="history-section">
        <div className="history-toolbar">
          <input
            className="history-search"
            placeholder="파일명 또는 묶음명으로 검색..."
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
          />
          <button className="export-btn primary" onClick={exportAll}>
            📥 전체 내보내기
          </button>
          <button className="export-btn danger" onClick={clearAll}>
            🗑️ 전체 삭제
          </button>
          <button className="export-btn" onClick={refresh}>
            🔄 새로고침
          </button>
        </div>

        {monthGroups.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">📊</div>
            <p>저장된 기록이 없습니다.<br />FBC 계산기에서 비용 비교를 실행하면 자동으로 저장됩니다.</p>
          </div>
        ) : (
          monthGroups.map(group => {
            const isCollapsed = collapsedMonths.has(group.label);
            return (
              <div className="month-group" key={group.label}>
                <div className="month-group-header" onClick={() => toggleMonth(group.label)}>
                  <div className="month-group-title">
                    <span className="month-group-name">{group.label}</span>
                    <div className="month-group-stats">
                      <span className="month-stat"><strong>{group.records.length}건</strong></span>
                      <span className="month-stat">
                        절감 <strong className={group.savings >= 0 ? 'text-success' : 'text-danger'}>
                          {formatWon(group.savings)}
                        </strong>
                      </span>
                      <span className="month-stat">박스 <strong>{group.boxes.toLocaleString()}</strong></span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button
                      className="export-btn"
                      style={{ padding: '4px 10px', fontSize: 12 }}
                      onClick={e => { e.stopPropagation(); exportMonth(group); }}
                    >
                      📥 내보내기
                    </button>
                    <span className={`month-group-toggle${!isCollapsed ? ' open' : ''}`}>▲</span>
                  </div>
                </div>

                {!isCollapsed && (
                  <div className="table-wrapper" style={{ overflow: 'auto' }}>
                    <table className="history-table">
                      <thead>
                        <tr>
                          <th>날짜</th>
                          <th>파일명</th>
                          <th>묶음</th>
                          <th className="num">박스수</th>
                          <th className="num">CBM</th>
                          <th className="num">일반비용</th>
                          <th className="num">FBC비용</th>
                          <th className="num">절감액</th>
                          <th className="num">절감률</th>
                          <th>보기</th>
                          <th>삭제</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.records.map(r => {
                          const pct = r.normalTotal ? Math.round(r.savings / r.normalTotal * 100) : 0;
                          return (
                            <tr key={r.id}>
                              <td style={{ whiteSpace: 'nowrap', fontSize: 12 }}>{r.date}</td>
                              <td style={{ fontSize: 12, maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.fileName}>
                                {r.fileName}
                              </td>
                              <td>{r.bundleName}</td>
                              <td className="num">{(r.totalBoxes || 0).toLocaleString()}</td>
                              <td className="num">{r.totalCbm ? Number(r.totalCbm).toFixed(2) : '-'}</td>
                              <td className="num">{formatWon(r.normalTotal)}</td>
                              <td className="num">{formatWon(r.fbcTotal)}</td>
                              <td className={`num ${r.savings >= 0 ? 'savings-positive' : 'savings-negative'}`}>
                                {r.savings >= 0 ? '+' : ''}{formatWon(r.savings)}
                              </td>
                              <td className="num">
                                <span className={`pct-badge ${pct >= 0 ? 'positive' : 'negative'}`}>
                                  {pct >= 0 ? '+' : ''}{pct}%
                                </span>
                              </td>
                              <td>
                                <button className="view-btn" onClick={() => setDetailModal(r)}>보기</button>
                              </td>
                              <td>
                                <button className="delete-btn" onClick={() => deleteRecord(r.id)}>삭제</button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {detailModal && (
        <DetailModal record={detailModal} onClose={() => setDetailModal(null)} />
      )}
    </div>
  );
}
