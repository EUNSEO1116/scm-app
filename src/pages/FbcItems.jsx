import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import XLSX_STYLE from 'xlsx-js-style';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('FBC 품목')}`;
const CSV_ORDER = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('발주장부')}`;

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
  if (!v || v === '-') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

const COL = {
  optionId: 0, barcode: 1, productName: 2, optionName: 3,
  palletQty: 4, boxItemQty: 6, cbm: 7, totalCbm: 8,
  boxSize1: 9, boxSize2: 10, palletBoxLimit: 11, palletBoxLimit2: 12,
};

function parseRow(cols) {
  const barcode = (cols[COL.barcode] || '').trim();
  if (!barcode) return null;
  return {
    optionId: (cols[COL.optionId] || '').trim(),
    barcode,
    productName: (cols[COL.productName] || '').trim(),
    optionName: (cols[COL.optionName] || '').trim(),
    palletQty: safeNum(cols[COL.palletQty]),
    boxItemQty: safeNum(cols[COL.boxItemQty]),
    cbm: (cols[COL.cbm] || '').trim(),
    totalCbm: (cols[COL.totalCbm] || '').trim(),
    boxSize1: (cols[COL.boxSize1] || '').trim(),
    boxSize2: (cols[COL.boxSize2] || '').trim(),
    palletBoxLimit: safeNum(cols[COL.palletBoxLimit]),
    palletBoxLimit2: safeNum(cols[COL.palletBoxLimit2]),
    _updated: false,
  };
}

// 출고내역서에서 SKU별 상자크기, CBM, 박스당수량 추출
function extractFbcInfo(buffer) {
  const wb = XLSX.read(buffer, { type: 'array' });
  const skuMap = {};

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet || !sheet['!ref']) continue;
    const range = XLSX.utils.decode_range(sheet['!ref']);

    // 헤더 찾기
    let headerRow = -1;
    for (let r = range.s.r; r <= Math.min(range.s.r + 4, range.e.r); r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        const val = cell?.v?.toString() || '';
        if (val.includes('상자') || val.includes('번호')) { headerRow = r; break; }
      }
      if (headerRow !== -1) break;
    }
    if (headerRow === -1) continue;

    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const getVal = (c) => sheet[XLSX.utils.encode_cell({ r, c })]?.v;
      const boxNo = getVal(0);
      if (!boxNo && boxNo !== 0) continue;
      const sku = (getVal(2)?.toString() || '').trim();
      if (!sku) continue;
      const productName = (getVal(3)?.toString() || '').trim();
      const qty = Number(getVal(4)) || 0;
      const size = (getVal(5)?.toString() || '').trim().replace(/\s+/g, '');
      const cbm = Number(getVal(6)) || 0;

      if (!skuMap[sku]) skuMap[sku] = { productName, boxes: [], sizes: new Set() };
      skuMap[sku].boxes.push({ qty, size, cbm });
      if (size) skuMap[sku].sizes.add(size);
    }
  }

  // SKU별 집계: 상자크기, CBM(1박스), 박스당수량
  const result = {};
  for (const [sku, info] of Object.entries(skuMap)) {
    const boxCount = info.boxes.length;
    const totalQty = info.boxes.reduce((s, b) => s + b.qty, 0);
    const boxItemQty = boxCount > 0 ? Math.round(totalQty / boxCount) : 0;
    const avgCbm = boxCount > 0 ? info.boxes.reduce((s, b) => s + b.cbm, 0) / boxCount : 0;
    const sizes = [...info.sizes];
    result[sku] = {
      productName: info.productName,
      boxSize1: sizes[0] || '',
      boxSize2: sizes[1] || '',
      cbm: avgCbm > 0 ? avgCbm.toFixed(6) : '',
      boxItemQty,
    };
  }
  return result;
}

export default function FbcItems() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [uploadStatus, setUploadStatus] = useState('');
  const [fbcStatus, setFbcStatus] = useState({ buying: [], working: [], shipping: [] });
  const [activeCard, setActiveCard] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [editMode, setEditMode] = useState(false);
  const [editValues, setEditValues] = useState({});
  const fileRef = useRef();

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, orderRes] = await Promise.all([fetch(CSV_URL), fetch(CSV_ORDER)]);
      if (!res.ok) throw new Error('데이터를 불러올 수 없습니다');
      const csv = await res.text();
      const lines = csv.split('\n').filter(l => l.trim());
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const row = parseRow(parseCsvRow(lines[i]));
        if (row) rows.push(row);
      }
      setData(rows);

      // 발주장부에서 FBC 상태별 행 수집
      if (orderRes.ok) {
        const orderCsv = await orderRes.text();
        const orderLines = orderCsv.split('\n').filter(l => l.trim());
        const buying = [], working = [], shipping = [];
        for (let i = 1; i < orderLines.length; i++) {
          const cols = parseCsvRow(orderLines[i]);
          const category = (cols[5] || '').trim();
          if (category !== 'FBC') continue;
          const cnStatus = (cols[8] || '').trim();
          const shipStatus = (cols[9] || '').trim();
          const item = {
            orderNo: (cols[0] || '').trim(),
            productName: (cols[1] || '').trim(),
            sku: (cols[2] || '').trim(),
            qty: (cols[3] || '').trim(),
            memo: (cols[18] || '').trim(),
          };
          if (cnStatus === '업체발송대기' || (cnStatus.includes('내륙') && cnStatus.includes('운송'))) buying.push(item);
          if (cnStatus.includes('CN 창고도착') || cnStatus.includes('작업 대기') || cnStatus.includes('출고 대기')) working.push(item);
          if (shipStatus.includes('출고완료')) shipping.push(item);
        }
        setFbcStatus({ buying, working, shipping });
      }
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // 출고내역서 업로드 → 기존 데이터에 병합
  const handleUpload = useCallback(async (file) => {
    if (!file || !data) return;
    setUploadStatus('분석 중...');
    try {
      const buffer = await file.arrayBuffer();
      const fbcInfo = extractFbcInfo(buffer);
      const updatedCount = { updated: 0, added: 0 };

      const newData = [...data];
      const existingSkus = new Set(newData.map(r => r.barcode));

      for (const [sku, info] of Object.entries(fbcInfo)) {
        const existing = newData.find(r => r.barcode === sku);
        if (existing) {
          // 기존 품목 업데이트: 출고내역서에서 가져온 값으로 덮어쓰기
          let changed = false;
          if (info.boxSize1) { existing.boxSize1 = info.boxSize1; changed = true; }
          if (info.boxSize2) { existing.boxSize2 = info.boxSize2; changed = true; }
          if (info.cbm) { existing.cbm = info.cbm; changed = true; }
          if (info.boxItemQty) { existing.boxItemQty = info.boxItemQty; changed = true; }
          if (!existing.productName && info.productName) { existing.productName = info.productName; changed = true; }
          if (changed) { existing._updated = true; updatedCount.updated++; }
        } else {
          // 새 품목 추가
          newData.push({
            optionId: '', barcode: sku,
            productName: info.productName, optionName: '',
            palletQty: 0, boxItemQty: info.boxItemQty,
            cbm: info.cbm, totalCbm: '',
            boxSize1: info.boxSize1, boxSize2: info.boxSize2,
            palletBoxLimit: 0, palletBoxLimit2: 0,
            _updated: true,
          });
          updatedCount.added++;
        }
      }

      setData(newData);
      setUploadStatus(`완료: ${updatedCount.updated}개 업데이트, ${updatedCount.added}개 신규 추가`);
      setTimeout(() => setUploadStatus(''), 5000);
    } catch (e) {
      setUploadStatus('오류: ' + e.message);
    }
    if (fileRef.current) fileRef.current.value = '';
  }, [data]);

  const toggleSelect = (barcode) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(barcode) ? next.delete(barcode) : next.add(barcode);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selected.size === filtered.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(filtered.map(r => r.barcode)));
    }
  };

  const openEdit = () => {
    if (selected.size === 0) return;
    setEditValues({ palletQty: '', boxItemQty: '', cbm: '', boxSize1: '', boxSize2: '', palletBoxLimit: '', palletBoxLimit2: '' });
    setEditMode(true);
  };

  const applyEdit = () => {
    if (!data) return;
    const newData = data.map(r => {
      if (!selected.has(r.barcode)) return r;
      const updated = { ...r, _updated: true };
      if (editValues.palletQty !== '') updated.palletQty = safeNum(editValues.palletQty);
      if (editValues.boxItemQty !== '') updated.boxItemQty = safeNum(editValues.boxItemQty);
      if (editValues.cbm !== '') updated.cbm = editValues.cbm;
      if (editValues.boxSize1 !== '') updated.boxSize1 = editValues.boxSize1;
      if (editValues.boxSize2 !== '') updated.boxSize2 = editValues.boxSize2;
      if (editValues.palletBoxLimit !== '') updated.palletBoxLimit = safeNum(editValues.palletBoxLimit);
      if (editValues.palletBoxLimit2 !== '') updated.palletBoxLimit2 = safeNum(editValues.palletBoxLimit2);
      return updated;
    });
    setData(newData);
    setEditMode(false);
    setSelected(new Set());
  };

  // 엑셀 다운로드 (시트에 반영할 수 있도록)
  const handleExport = () => {
    if (!data) return;
    const wb = XLSX_STYLE.utils.book_new();
    const baseFont = { name: 'Arial', sz: 10 };
    const baseAlign = { horizontal: 'center', vertical: 'center' };

    const wsData = [
      ['', '쿠팡바코드', '쿠팡 노출 상품명', '옵션명', '제품 수량', '', '박스당 수량', 'CBM', '총 CBM', '상자 크기1', '상자 크기2', '빠레트 박스제한', '크기2 박스제한'],
    ];

    for (const r of data) {
      wsData.push([
        r.optionId, r.barcode, r.productName, r.optionName,
        r.palletQty || '', '', r.boxItemQty || '', r.cbm || '', r.totalCbm || '',
        r.boxSize1 || '', r.boxSize2 || '',
        r.palletBoxLimit || '', r.palletBoxLimit2 || '',
      ]);
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

    ws['!cols'] = [
      { wch: 14 }, { wch: 18 }, { wch: 45 }, { wch: 20 },
      { wch: 10 }, { wch: 2 }, { wch: 10 }, { wch: 10 }, { wch: 8 },
      { wch: 18 }, { wch: 18 }, { wch: 12 }, { wch: 12 },
    ];

    XLSX_STYLE.utils.book_append_sheet(wb, ws, 'FBC 품목');
    XLSX_STYLE.writeFile(wb, 'FBC_품목.xlsx');
  };

  const filtered = useMemo(() => {
    if (!data) return [];
    let rows = data;
    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        r.barcode.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q) ||
        r.optionName.toLowerCase().includes(q)
      );
    }
    if (sortKey) {
      rows = [...rows].sort((a, b) => {
        const va = a[sortKey] ?? '';
        const vb = b[sortKey] ?? '';
        if (typeof va === 'number' && typeof vb === 'number') return sortDir === 'asc' ? va - vb : vb - va;
        return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va));
      });
    }
    return rows;
  }, [data, search, sortKey, sortDir]);

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const sortIcon = (key) => {
    if (sortKey !== key) return <span className="sort-icon">↕</span>;
    return <span className="sort-icon">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  if (loading) {
    return (
      <div className="loading" style={{ padding: 40, flexDirection: 'column', gap: 8 }}>
        <div className="spinner" />
        <p>FBC 품목 데이터 로딩 중...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <p style={{ color: 'var(--danger)', marginBottom: 12 }}>{error}</p>
        <button className="btn btn-primary" onClick={fetchData}>다시 시도</button>
      </div>
    );
  }

  const columns = [
    { key: 'barcode', label: '쿠팡바코드', width: 150 },
    { key: 'productName', label: '상품명', width: 250 },
    { key: 'optionName', label: '옵션명', width: 150 },
    { key: 'palletQty', label: '1빠레트 물량', width: 90, cls: 'num' },
    { key: 'boxItemQty', label: '박스당 수량', width: 90, cls: 'num' },
    { key: 'cbm', label: 'CBM', width: 80, cls: 'num' },
    { key: 'boxSize1', label: '상자 크기1', width: 130 },
    { key: 'boxSize2', label: '상자 크기2', width: 130 },
    { key: 'palletBoxLimit', label: '빠레트 박스제한', width: 100, cls: 'num' },
    { key: 'palletBoxLimit2', label: '크기2 박스제한', width: 100, cls: 'num' },
  ];

  return (
    <div>
      {/* FBC 진행 현황 */}
      <div className="stats-grid" style={{ marginBottom: 16 }}>
        {[
          { key: 'buying', label: '🛒 구매중', cls: 'warning', sub: '업체발송대기 / 내륙운송중' },
          { key: 'working', label: '🔧 작업중', cls: 'info', sub: 'CN 창고도착 / 작업대기 / 출고대기' },
          { key: 'shipping', label: '🚚 출고중 (입고생성)', cls: 'success', sub: '출고완료 → FBC 입고생성 필요' },
        ].map(c => (
          <div
            key={c.key}
            className={`stat-card ${c.cls} clickable${activeCard === c.key ? ' selected' : ''}`}
            style={{ padding: 16 }}
            onClick={() => setActiveCard(activeCard === c.key ? null : c.key)}
          >
            <div className="label">{c.label}</div>
            <div className="value">{fbcStatus[c.key].length}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>건</span></div>
            <div className="sub">{c.sub}</div>
          </div>
        ))}
        <div className="stat-card" style={{ padding: 16 }}>
          <div className="label">📦 FBC 등록 품목</div>
          <div className="value">{data ? data.length : 0}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>개</span></div>
          <div className="sub">{data ? data.filter(r => r._updated).length : 0}개 업데이트됨</div>
        </div>
      </div>

      {/* 카드 클릭 시 상세 테이블 */}
      {activeCard && fbcStatus[activeCard].length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <h2 style={{ fontSize: 15, fontWeight: 600 }}>
              {activeCard === 'buying' ? '🛒 구매중' : activeCard === 'working' ? '🔧 작업중' : '🚚 출고중 (입고생성)'}
            </h2>
            <span style={{ fontSize: 12, color: '#666' }}>{fbcStatus[activeCard].length}건</span>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <div className="table-wrapper" style={{ maxHeight: 300, overflowY: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ minWidth: 160 }}>발주번호</th>
                    <th style={{ minWidth: 280 }}>품목</th>
                    <th className="num" style={{ minWidth: 60 }}>수량</th>
                    <th style={{ minWidth: 150 }}>메모</th>
                  </tr>
                </thead>
                <tbody>
                  {fbcStatus[activeCard].map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontSize: 12 }}>{r.orderNo}</td>
                      <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.productName}</td>
                      <td className="num">{r.qty}</td>
                      <td style={{ fontSize: 12 }}>{r.memo || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 필터 + 업로드 + 다운로드 */}
      <div className="filter-bar" style={{ marginBottom: 16 }}>
        <input
          className="search-input"
          placeholder="바코드, 상품명, 옵션명 검색..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div style={{ flex: 1 }} />
        {uploadStatus && <span style={{ fontSize: 12, color: uploadStatus.startsWith('오류') ? 'var(--danger)' : 'var(--success)' }}>{uploadStatus}</span>}
        {selected.size > 0 && (
          <button className="btn btn-primary btn-sm" onClick={openEdit}>
            ✏️ {selected.size}개 선택 수정
          </button>
        )}
        <button className="btn btn-outline btn-sm" onClick={() => fileRef.current?.click()}>
          📤 출고내역서 업로드
        </button>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
          onChange={e => handleUpload(e.target.files?.[0])} />
        <button className="btn btn-primary btn-sm" onClick={handleExport}>📥 품목 엑셀 다운로드</button>
        <button className="btn btn-outline btn-sm" onClick={fetchData}>🔄 새로고침</button>
      </div>

      {/* 테이블 */}
      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-wrapper" style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }} onClick={toggleSelectAll}>
                    <input type="checkbox" checked={filtered.length > 0 && selected.size === filtered.length} readOnly style={{ cursor: 'pointer' }} />
                  </th>
                  {columns.map(col => (
                    <th
                      key={col.key}
                      className={`${col.cls || ''} ${sortKey === col.key ? 'sorted' : ''}`}
                      style={{ minWidth: col.width }}
                      onClick={() => handleSort(col.key)}
                    >
                      {col.label}{sortIcon(col.key)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={columns.length + 1} style={{ textAlign: 'center', padding: 40, color: '#999' }}>
                    데이터가 없습니다
                  </td></tr>
                ) : filtered.map((r, i) => (
                  <tr key={i} style={r._updated ? { background: '#e6f4ea' } : selected.has(r.barcode) ? { background: '#e8f0fe' } : {}}>
                    <td style={{ textAlign: 'center' }}>
                      <input type="checkbox" checked={selected.has(r.barcode)} onChange={() => toggleSelect(r.barcode)} style={{ cursor: 'pointer' }} />
                    </td>
                    <td style={{ fontSize: 11, color: '#666' }}>{r.barcode}</td>
                    <td style={{ maxWidth: 250, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.productName}</td>
                    <td>{r.optionName}</td>
                    <td className="num">{r.palletQty || '-'}</td>
                    <td className="num">{r.boxItemQty || '-'}</td>
                    <td className="num">{r.cbm || '-'}</td>
                    <td style={{ fontSize: 12 }}>{r.boxSize1 || '-'}</td>
                    <td style={{ fontSize: 12 }}>{r.boxSize2 || '-'}</td>
                    <td className="num">{r.palletBoxLimit || '-'}</td>
                    <td className="num">{r.palletBoxLimit2 || '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 수정 모달 */}
      {editMode && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
        }} onClick={() => setEditMode(false)}>
          <div style={{
            background: '#fff', borderRadius: 12, padding: 24, minWidth: 400, maxWidth: 500,
            boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
          }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: 16, fontSize: 16 }}>
              {selected.size}개 품목 일괄 수정
            </h3>
            <p style={{ fontSize: 12, color: '#666', marginBottom: 16 }}>빈칸으로 두면 해당 항목은 변경하지 않습니다</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              {[
                { key: 'palletQty', label: '1빠레트 물량' },
                { key: 'boxItemQty', label: '박스당 수량' },
                { key: 'cbm', label: 'CBM' },
                { key: 'boxSize1', label: '상자 크기1' },
                { key: 'boxSize2', label: '상자 크기2' },
                { key: 'palletBoxLimit', label: '빠레트 박스제한' },
                { key: 'palletBoxLimit2', label: '크기2 박스제한' },
              ].map(f => (
                <div key={f.key}>
                  <label style={{ fontSize: 12, color: '#666', display: 'block', marginBottom: 4 }}>{f.label}</label>
                  <input
                    className="search-input"
                    style={{ minWidth: 'auto', width: '100%', padding: '6px 10px' }}
                    value={editValues[f.key]}
                    onChange={e => setEditValues(prev => ({ ...prev, [f.key]: e.target.value }))}
                    placeholder="변경 안 함"
                  />
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline btn-sm" onClick={() => setEditMode(false)}>취소</button>
              <button className="btn btn-primary btn-sm" onClick={applyEdit}>적용</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
