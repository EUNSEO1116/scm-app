import { useState, useMemo, useEffect, useRef } from 'react';
import XLSX_STYLE from 'xlsx-js-style';
import { fetchReasons } from '../sheetSync.js';
import { dbStoreGet, dbStoreSet, dbSaveReasons, dbDeleteReason } from '../utils/dbApi';

const SOLDOUT_HISTORY_KEY = 'soldout_history';
const SOLDOUT_REASONS_KEY = 'soldout_reasons_v2';
const EXCLUDE_KEY = 'soldout_exclude_items';

function loadHistory() {
  try { return JSON.parse(localStorage.getItem(SOLDOUT_HISTORY_KEY) || '{}'); } catch { return {}; }
}
function saveHistory(data) {
  localStorage.setItem(SOLDOUT_HISTORY_KEY, JSON.stringify(data));
  dbStoreSet('soldout_history', data).catch(() => {});
}
function loadReasons() {
  try { return JSON.parse(localStorage.getItem(SOLDOUT_REASONS_KEY) || '{}'); } catch { return {}; }
}
function saveReasons(data) {
  localStorage.setItem(SOLDOUT_REASONS_KEY, JSON.stringify(data));
  dbStoreSet('soldout_reasons_obj', data).catch(() => {});
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

// history를 flat 배열로 변환 (각 항목에 uid 부여)
function flattenHistory(hist) {
  const records = [];
  let uid = 0;
  for (const [barcode, entries] of Object.entries(hist)) {
    for (let i = 0; i < entries.length; i++) {
      records.push({ uid: uid++, barcode, origIdx: i, ...entries[i] });
    }
  }
  records.sort((a, b) => b.date.localeCompare(a.date));
  return records;
}

// flat 배열을 다시 history 객체로 변환
function unflattenRecords(records) {
  const hist = {};
  for (const r of records) {
    if (!hist[r.barcode]) hist[r.barcode] = [];
    hist[r.barcode].push({ reason: r.reason, date: r.date, productName: r.productName || '', optionName: r.optionName || '' });
  }
  return hist;
}

// history 객체를 DB 저장용 items 배열로 변환
function historyToItems(hist, reasons) {
  const items = [];
  for (const [barcode, entries] of Object.entries(hist)) {
    for (const e of entries) {
      items.push({ barcode, reason: e.reason, date: e.date, productName: e.productName || '', optionName: e.optionName || '' });
    }
  }
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
  const [editingUid, setEditingUid] = useState(null);
  const [editDate, setEditDate] = useState('');
  const [excludeTarget, setExcludeTarget] = useState(null);
  const [excludeEndDate, setExcludeEndDate] = useState('');
  const [selected, setSelected] = useState(new Set()); // barcode 기반
  const [editingReasonUid, setEditingReasonUid] = useState(null);
  const [editReasonText, setEditReasonText] = useState('');

  useEffect(() => {
    (async () => {
      try {
        // DB 제네릭 스토어에서 로드 (DB 우선)
        const dbHistory = await dbStoreGet('soldout_history');
        if (dbHistory && Object.keys(dbHistory).length > 0) {
          localStorage.setItem(SOLDOUT_HISTORY_KEY, JSON.stringify(dbHistory));
          setHistory(dbHistory);
          // reasons도 DB에서 동기화
          const dbReasons = await dbStoreGet('soldout_reasons_obj');
          if (dbReasons) localStorage.setItem(SOLDOUT_REASONS_KEY, JSON.stringify(dbReasons));
          return;
        }
        // 폴백: dedicated API에서 마이그레이션
        const data = await fetchReasons();
        if (data?.history) {
          localStorage.setItem(SOLDOUT_HISTORY_KEY, JSON.stringify(data.history));
          setHistory(data.history);
          dbStoreSet('soldout_history', data.history).catch(() => {});
          if (data.reasons) {
            localStorage.setItem(SOLDOUT_REASONS_KEY, JSON.stringify(data.reasons));
            dbStoreSet('soldout_reasons_obj', data.reasons).catch(() => {});
          }
        }
      } catch {}
    })();
  }, []);

  const allRecords = useMemo(() => flattenHistory(history), [history]);

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

  const { monthCount, halfYearCount } = useMemo(() => {
    const now = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const halfStart = now.getMonth() < 6
      ? `${now.getFullYear()}-01`
      : `${now.getFullYear()}-07`;
    const monthBarcodes = new Set();
    const halfBarcodes = new Set();
    for (const [barcode, entries] of Object.entries(history)) {
      for (const e of entries) {
        if (e.date && e.date.startsWith(thisMonth)) monthBarcodes.add(barcode);
        if (e.date && e.date >= halfStart) halfBarcodes.add(barcode);
      }
    }
    return { monthCount: monthBarcodes.size, halfYearCount: halfBarcodes.size };
  }, [history]);

  // 변경된 바코드만 DB에서 삭제 후 재삽입
  const syncToDb = async (newHistory, changedBarcodes) => {
    const reasons = loadReasons();
    for (const barcode of Object.keys(reasons)) {
      if (!newHistory[barcode] || newHistory[barcode].length === 0) {
        delete reasons[barcode];
      } else {
        const last = newHistory[barcode][newHistory[barcode].length - 1];
        reasons[barcode] = { reason: last.reason, date: last.date };
      }
    }
    saveReasons(reasons);

    for (const barcode of changedBarcodes) {
      // 해당 바코드의 기존 DB 기록 전부 삭제 (DELETE는 1건씩이므로 반복)
      for (let i = 0; i < 20; i++) {
        const ok = await dbDeleteReason(barcode);
        if (!ok) break;
      }
      // 남은 기록 다시 삽입
      const entries = newHistory[barcode] || [];
      if (entries.length > 0) {
        const items = entries.map(e => ({
          barcode, reason: e.reason, date: e.date,
          productName: e.productName || '', optionName: e.optionName || '',
        }));
        await dbSaveReasons(items);
      }
    }
  };

  const deleteSelected = () => {
    if (selected.size === 0) return;
    if (!confirm(`선택한 ${selected.size}개 품목의 품절 기록을 전부 삭제하시겠습니까?`)) return;

    const newHistory = JSON.parse(JSON.stringify(history));
    for (const barcode of selected) {
      delete newHistory[barcode];
    }

    setHistory(newHistory);
    saveHistory(newHistory);
    syncToDb(newHistory, selected);
    setSelected(new Set());
  };

  const updateDate = (uid) => {
    if (!editDate) return;
    const record = allRecords.find(r => r.uid === uid);
    if (!record) return;

    const newHistory = JSON.parse(JSON.stringify(history));
    newHistory[record.barcode][record.origIdx].date = editDate;

    setHistory(newHistory);
    saveHistory(newHistory);
    syncToDb(newHistory, [record.barcode]);
    setEditingUid(null);
    setEditDate('');
  };

  const updateReason = (uid) => {
    if (!editReasonText.trim()) return;
    const record = allRecords.find(r => r.uid === uid);
    if (!record) return;

    const newHistory = JSON.parse(JSON.stringify(history));
    newHistory[record.barcode][record.origIdx].reason = editReasonText.trim();

    setHistory(newHistory);
    saveHistory(newHistory);
    syncToDb(newHistory, [record.barcode]);
    setEditingReasonUid(null);
    setEditReasonText('');
  };

  const toggleSelect = (barcode) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(barcode)) next.delete(barcode);
      else next.add(barcode);
      return next;
    });
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

  const handleExport = () => {
    if (allRecords.length === 0) return;
    const wb = XLSX_STYLE.utils.book_new();
    const baseFont = { name: 'Arial', sz: 10 };
    const baseAlign = { horizontal: 'center', vertical: 'center' };
    const wsData = [['바코드', '상품명', '옵션명', '품절일', '사유']];
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
            {selected.size}개 품목 삭제
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <input
                type="checkbox"
                checked={selected.has(barcode)}
                onChange={() => toggleSelect(barcode)}
                style={{ cursor: 'pointer', accentColor: '#d93025', width: 16, height: 16 }}
              />
              <div>
                <h2 style={{ fontSize: 14, fontWeight: 600 }}>{info.productName}</h2>
                <span style={{ fontSize: 12, color: '#666' }}>{info.optionName} · {barcode}</span>
              </div>
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
            {info.entries.map((e, i) => (
              <div key={e.uid} style={{
                display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0',
                borderBottom: i < info.entries.length - 1 ? '1px solid #f0f0f0' : 'none',
              }}>
                {editingUid === e.uid ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input type="date" value={editDate} onChange={ev => setEditDate(ev.target.value)}
                      style={{ fontSize: 11, padding: '2px 4px', border: '1px solid #ddd', borderRadius: 4 }} />
                    <button className="btn btn-primary btn-sm" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => updateDate(e.uid)}>저장</button>
                    <button className="btn btn-outline btn-sm" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => setEditingUid(null)}>취소</button>
                  </div>
                ) : (
                  <span style={{ fontSize: 12, color: '#999', minWidth: 80, cursor: 'pointer' }}
                    onClick={() => { setEditingUid(e.uid); setEditDate(e.date); }}
                    title="클릭하여 날짜 수정"
                  >{e.date} ✏️</span>
                )}
                {editingReasonUid === e.uid ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <input type="text" value={editReasonText} onChange={ev => setEditReasonText(ev.target.value)}
                      onKeyDown={ev => { if (ev.key === 'Enter') updateReason(e.uid); if (ev.key === 'Escape') setEditingReasonUid(null); }}
                      style={{ fontSize: 11, padding: '2px 8px', border: '1px solid #ddd', borderRadius: 4, minWidth: 120 }}
                      autoFocus />
                    <button className="btn btn-primary btn-sm" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => updateReason(e.uid)}>저장</button>
                    <button className="btn btn-outline btn-sm" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => setEditingReasonUid(null)}>취소</button>
                  </div>
                ) : (
                  <span style={{ fontSize: 12, background: '#f3eef8', color: '#7c4dbd', borderRadius: 4, padding: '2px 8px', cursor: 'pointer' }}
                    onClick={() => { setEditingReasonUid(e.uid); setEditReasonText(e.reason); }}
                    title="클릭하여 사유 수정"
                  >
                    {e.reason}
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}

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
