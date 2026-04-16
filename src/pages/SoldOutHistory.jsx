import { useState, useMemo, useEffect } from 'react';
import XLSX_STYLE from 'xlsx-js-style';
import { fetchReasons, saveReasons as dbSyncReasons } from '../sheetSync.js';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

const SOLDOUT_HISTORY_KEY = 'soldout_history';
const SOLDOUT_REASONS_KEY = 'soldout_reasons_v2';
const EXCLUDE_KEY = 'soldout_exclude_items';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(SOLDOUT_HISTORY_KEY) || '{}'); } catch { return {}; }
}
function saveHistory(data) {
  localStorage.setItem(SOLDOUT_HISTORY_KEY, JSON.stringify(data));
}
function loadReasons() {
  try { return JSON.parse(localStorage.getItem(SOLDOUT_REASONS_KEY) || '{}'); } catch { return {}; }
}
function saveReasons(data) {
  localStorage.setItem(SOLDOUT_REASONS_KEY, JSON.stringify(data));
}
function loadExcludes() {
  try { return JSON.parse(localStorage.getItem(EXCLUDE_KEY) || '[]'); } catch { return []; }
}
function saveExcludes(list) {
  localStorage.setItem(EXCLUDE_KEY, JSON.stringify(list));
  dbStoreSet('soldout_exclude', list).catch(() => {});
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// history 객체를 DB 저장용 items 배열로 변환
function historyToItems(hist, reasons) {
  const items = [];
  for (const [barcode, entries] of Object.entries(hist)) {
    for (const e of entries) {
      items.push({ barcode, reason: e.reason, date: e.date, productName: e.productName || '', optionName: e.optionName || '' });
    }
  }
  // reasons에만 있고 history에 없는 것도 포함
  for (const [barcode, info] of Object.entries(reasons)) {
    if (!hist[barcode] || hist[barcode].length === 0) {
      items.push({ barcode, reason: info.reason, date: info.date, productName: '', optionName: '' });
    }
  }
  return items;
}

export default function SoldOutHistory() {
  const [search, setSearch] = useState('');
  const [history, setHistory] = useState(loadHistory);
  const [editingKey, setEditingKey] = useState(null);
  const [editDate, setEditDate] = useState('');
  const [excludeTarget, setExcludeTarget] = useState(null);
  const [excludeEndDate, setExcludeEndDate] = useState('');
  const [selected, setSelected] = useState(new Set()); // 체크박스 선택: "barcode-index"
  const [editingReason, setEditingReason] = useState(null); // 사유 수정 중: "barcode-index"
  const [editReasonText, setEditReasonText] = useState('');

  // DB에서 품절 기록 동기화
  useEffect(() => {
    fetchReasons().then(data => {
      if (data && data.history) {
        setHistory(loadHistory());
      }
    });
  }, []);

  const updateDate = (barcode, index) => {
    if (!editDate) return;
    const updated = { ...history };
    updated[barcode][index].date = editDate;
    setHistory(updated);
    saveHistory(updated);
    if (index === updated[barcode].length - 1) {
      const reasons = loadReasons();
      if (reasons[barcode]) {
        reasons[barcode].date = editDate;
        saveReasons(reasons);
      }
    }
    // DB 동기화
    dbSyncReasons(historyToItems(updated, loadReasons())).catch(() => {});
    setEditingKey(null);
    setEditDate('');
  };

  const updateReason = (barcode, index) => {
    if (!editReasonText.trim()) return;
    const updated = { ...history };
    updated[barcode][index].reason = editReasonText.trim();
    setHistory(updated);
    saveHistory(updated);
    // reasons(현재 사유)도 업데이트 - 마지막 기록이면
    if (index === updated[barcode].length - 1) {
      const reasons = loadReasons();
      if (reasons[barcode]) {
        reasons[barcode].reason = editReasonText.trim();
        saveReasons(reasons);
      }
    }
    // DB 동기화
    dbSyncReasons(historyToItems(updated, loadReasons())).catch(() => {});
    setEditingReason(null);
    setEditReasonText('');
  };

  const toggleSelect = (key) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const deleteSelected = () => {
    if (selected.size === 0) return;
    if (!confirm(`선택한 ${selected.size}건을 삭제하시겠습니까?`)) return;

    const updated = { ...history };
    const reasons = loadReasons();

    // "barcode-index" 를 barcode별로 그룹화하고, 큰 index부터 삭제
    const deleteMap = {};
    for (const key of selected) {
      const lastDash = key.lastIndexOf('-');
      const barcode = key.substring(0, lastDash);
      const idx = parseInt(key.substring(lastDash + 1));
      if (!deleteMap[barcode]) deleteMap[barcode] = [];
      deleteMap[barcode].push(idx);
    }

    for (const [barcode, indices] of Object.entries(deleteMap)) {
      if (!updated[barcode]) continue;
      // 큰 인덱스부터 삭제해야 인덱스 안 밀림
      indices.sort((a, b) => b - a);
      for (const idx of indices) {
        updated[barcode].splice(idx, 1);
      }
      // 전부 삭제됐으면 바코드 자체 제거
      if (updated[barcode].length === 0) {
        delete updated[barcode];
        delete reasons[barcode];
      } else {
        // 마지막 기록으로 reasons 업데이트
        const last = updated[barcode][updated[barcode].length - 1];
        if (reasons[barcode]) {
          reasons[barcode] = { reason: last.reason, date: last.date };
        }
      }
    }

    setHistory(updated);
    saveHistory(updated);
    saveReasons(reasons);
    setSelected(new Set());

    // DB 동기화
    dbSyncReasons(historyToItems(updated, reasons)).catch(() => {});
  };

  const moveToExclude = () => {
    if (!excludeTarget || !excludeEndDate) return;
    const excludes = loadExcludes();
    if (!excludes.some(e => e.barcode === excludeTarget.barcode)) {
      excludes.push({
        barcode: excludeTarget.barcode,
        productName: excludeTarget.productName,
        optionName: excludeTarget.optionName,
        reason: excludeTarget.reason,
        endDate: excludeEndDate,
        addedDate: todayStr(),
      });
      saveExcludes(excludes);
    }
    setExcludeTarget(null);
    setExcludeEndDate('');
  };

  const allRecords = useMemo(() => {
    const records = [];
    for (const [barcode, entries] of Object.entries(history)) {
      for (let idx = 0; idx < entries.length; idx++) {
        records.push({ barcode, _origIdx: idx, ...entries[idx] });
      }
    }
    records.sort((a, b) => b.date.localeCompare(a.date));
    return records;
  }, [history]);

  const filtered = useMemo(() => {
    if (!search) return allRecords;
    const q = search.toLowerCase();
    return allRecords.filter(r =>
      r.barcode.toLowerCase().includes(q) ||
      r.productName.toLowerCase().includes(q) ||
      r.optionName.toLowerCase().includes(q) ||
      r.reason.toLowerCase().includes(q)
    );
  }, [allRecords, search]);

  const grouped = useMemo(() => {
    const map = {};
    for (const r of filtered) {
      if (!map[r.barcode]) map[r.barcode] = { productName: r.productName, optionName: r.optionName, entries: [] };
      map[r.barcode].entries.push(r);
    }
    return Object.entries(map);
  }, [filtered]);

  const excludedBarcodes = useMemo(() => {
    const ex = loadExcludes();
    return new Set(ex.map(e => e.barcode));
  }, [excludeTarget]);

  // 이번달 / 반기 품절 품목 수
  const { monthCount, halfYearCount } = useMemo(() => {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const halfStart = now.getMonth() < 6
      ? `${now.getFullYear()}-01`
      : `${now.getFullYear()}-07`;
    const halfStr = halfStart;
    const monthBarcodes = new Set();
    const halfBarcodes = new Set();
    for (const [barcode, entries] of Object.entries(history)) {
      for (const e of entries) {
        if (e.date && e.date.startsWith(thisMonth)) monthBarcodes.add(barcode);
        if (e.date && e.date >= halfStr) halfBarcodes.add(barcode);
      }
    }
    return { monthCount: monthBarcodes.size, halfYearCount: halfBarcodes.size };
  }, [history]);

  const handleExport = () => {
    if (allRecords.length === 0) return;
    const wb = XLSX_STYLE.utils.book_new();
    const baseFont = { name: 'Arial', sz: 10 };
    const baseAlign = { horizontal: 'center', vertical: 'center' };

    const wsData = [
      ['바코드', '상품명', '옵션명', '품절일', '사유'],
    ];
    for (const r of allRecords) {
      wsData.push([r.barcode, r.productName, r.optionName, r.date, r.reason]);
    }

    const ws = XLSX_STYLE.utils.aoa_to_sheet(wsData);
    const range = XLSX_STYLE.utils.decode_range(ws['!ref']);
    for (let ri = range.s.r; ri <= range.e.r; ri++) {
      for (let ci = range.s.c; ci <= range.e.c; ci++) {
        const ref = XLSX_STYLE.utils.encode_cell({ r: ri, c: ci });
        if (!ws[ref]) ws[ref] = { v: '', t: 's' };
        if (ws[ref].t === 'n') { ws[ref].v = String(ws[ref].v); ws[ref].t = 's'; }
        ws[ref].s = {
          font: { ...baseFont, ...(ri === 0 ? { bold: true } : {}) },
          alignment: { ...baseAlign },
        };
      }
    }
    ws['!cols'] = [{ wch: 18 }, { wch: 45 }, { wch: 20 }, { wch: 12 }, { wch: 25 }];
    XLSX_STYLE.utils.book_append_sheet(wb, ws, '품절 기록');
    XLSX_STYLE.writeFile(wb, `품절기록_${todayStr()}.xlsx`);
  };

  return (
    <div>
      <div className="stats-grid" style={{ marginBottom: 16 }}>
        <div className="stat-card warning" style={{ padding: 16 }}>
          <div className="label">이번달 품절 품목</div>
          <div className="value">{monthCount}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>개</span></div>
        </div>
        <div className="stat-card info" style={{ padding: 16 }}>
          <div className="label">반기 누적 품목</div>
          <div className="value">{halfYearCount}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>개</span></div>
        </div>
      </div>

      <div className="filter-bar" style={{ marginBottom: 16 }}>
        <input
          className="search-input"
          placeholder="바코드, 상품명, 사유 검색..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div style={{ flex: 1 }} />
        {selected.size > 0 && (
          <button className="btn btn-sm" style={{ background: '#d93025', color: '#fff', marginRight: 8 }} onClick={deleteSelected}>
            {selected.size}건 삭제
          </button>
        )}
        <span style={{ fontSize: 13, color: '#666' }}>{filtered.length}건</span>
        <button className="btn btn-primary btn-sm" onClick={handleExport}>📥 엑셀 다운로드</button>
      </div>

      {grouped.length === 0 ? (
        <div className="placeholder-page">
          <div className="icon">📝</div>
          <h2>품절 기록 없음</h2>
          <p>품절 현황에서 사유를 입력하면 이곳에 누적됩니다</p>
        </div>
      ) : grouped.map(([barcode, info]) => (
        <div className="card" key={barcode} style={{ marginBottom: 12 }}>
          <div className="card-header">
            <div>
              <h2 style={{ fontSize: 14, fontWeight: 600 }}>{info.productName}</h2>
              <span style={{ fontSize: 12, color: '#666' }}>{info.optionName} · {barcode}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: '#999' }}>{info.entries.length}건</span>
              {excludedBarcodes.has(barcode) ? (
                <span style={{ fontSize: 10, background: '#f1f3f4', color: '#80868b', borderRadius: 4, padding: '2px 8px' }}>제외 등록됨</span>
              ) : (
                <button
                  className="btn btn-outline btn-sm"
                  style={{ fontSize: 10, padding: '2px 8px' }}
                  onClick={() => {
                    const latest = info.entries[0];
                    setExcludeTarget({ barcode, productName: info.productName, optionName: info.optionName, reason: latest?.reason || '' });
                    setExcludeEndDate('');
                  }}
                >🚫 제외 품목으로</button>
              )}
            </div>
          </div>
          <div className="card-body" style={{ padding: '8px 20px 12px' }}>
            {info.entries.map((e, i) => {
              const origIdx = e._origIdx;
              const selectKey = `${barcode}-${origIdx}`;
              const reasonKey = `${barcode}-${origIdx}`;
              return (
                <div key={i} style={{
                  display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0',
                  borderBottom: i < info.entries.length - 1 ? '1px solid #f0f0f0' : 'none',
                }}>
                  <input
                    type="checkbox"
                    checked={selected.has(selectKey)}
                    onChange={() => toggleSelect(selectKey)}
                    style={{ cursor: 'pointer', accentColor: '#d93025' }}
                  />
                  {editingKey === selectKey ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input type="date" value={editDate} onChange={ev => setEditDate(ev.target.value)}
                        style={{ fontSize: 11, padding: '2px 4px', border: '1px solid #ddd', borderRadius: 4 }} />
                      <button className="btn btn-primary btn-sm" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => updateDate(barcode, origIdx)}>저장</button>
                      <button className="btn btn-outline btn-sm" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => setEditingKey(null)}>취소</button>
                    </div>
                  ) : (
                    <span style={{ fontSize: 12, color: '#999', minWidth: 80, cursor: 'pointer' }}
                      onClick={() => { setEditingKey(selectKey); setEditDate(e.date); }}
                      title="클릭하여 날짜 수정"
                    >{e.date} ✏️</span>
                  )}
                  {editingReason === reasonKey ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <input type="text" value={editReasonText} onChange={ev => setEditReasonText(ev.target.value)}
                        onKeyDown={ev => { if (ev.key === 'Enter') updateReason(barcode, origIdx); if (ev.key === 'Escape') setEditingReason(null); }}
                        style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #ddd', borderRadius: 4, minWidth: 120 }}
                        autoFocus />
                      <button className="btn btn-primary btn-sm" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => updateReason(barcode, origIdx)}>저장</button>
                      <button className="btn btn-outline btn-sm" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => setEditingReason(null)}>취소</button>
                    </div>
                  ) : (
                    <span style={{ fontSize: 12, background: '#f3eef8', color: '#7c4dbd', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
                      onClick={() => { setEditingReason(reasonKey); setEditReasonText(e.reason); }}
                      title="클릭하여 사유 수정"
                    >
                      {e.reason}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}

      {/* 제외 품목 종료일 선택 모달 */}
      {excludeTarget && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setExcludeTarget(null)}
        >
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, minWidth: 380, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: 12, fontSize: 16 }}>🚫 제외 품목 등록</h3>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              <strong>{excludeTarget.productName}</strong>
              <div style={{ fontSize: 12, color: '#666' }}>{excludeTarget.optionName} · {excludeTarget.barcode}</div>
            </div>
            <div style={{ fontSize: 12, marginBottom: 12 }}>
              사유: <span style={{ background: '#f3eef8', color: '#7c4dbd', borderRadius: 4, padding: '1px 6px' }}>{excludeTarget.reason}</span>
            </div>
            <div style={{ marginBottom: 16 }}>
              <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>제외 종료일</label>
              <input
                type="date"
                value={excludeEndDate}
                onChange={e => setExcludeEndDate(e.target.value)}
                style={{ fontSize: 13, padding: '8px 12px', border: '1px solid #ddd', borderRadius: 8, width: '100%' }}
                autoFocus
              />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline btn-sm" onClick={() => setExcludeTarget(null)}>취소</button>
              <button className="btn btn-primary btn-sm" onClick={moveToExclude} disabled={!excludeEndDate}>제외 등록</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
