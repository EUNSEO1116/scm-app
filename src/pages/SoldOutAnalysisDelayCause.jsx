import { useState, useMemo, useEffect, useCallback } from 'react';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const TSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('특별 관리 상품')}`;

const STORE_KEY = 'delay_cause_items';

const REASON_STATUSES = ['확인중', '작업지연', '업체발송지연', '재수배지연(SCM귀책)', '조치지연(SCM귀책)'];
const REASON_COLORS = {
  '확인중': '#9e9e9e',
  '작업지연': '#fb8c00',
  '업체발송지연': '#c62828',
  '재수배지연(SCM귀책)': '#6a1b9a',
  '조치지연(SCM귀책)': '#1565c0',
};

// 접힌 카드 한 줄 컬럼 정의 (헤더/각 행 공통 → 세로 정렬 유지)
const COLS = '22px 92px minmax(130px,1.4fr) minmax(90px,1fr) 112px 116px 106px 106px 106px 74px minmax(130px,1.2fr) 46px';
const HEADERS = ['', '사유상태', '상품명', '옵션명', '바코드', '발주번호', '발주일', '확인일', '품절일', '대기수량', '자세한 사유', ''];
const ROW_MIN_WIDTH = 1160;

function parseCSV(text) {
  const result = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else {
        cell += ch;
      }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(c => c)) result.push(row);
        row = [];
      } else { cell += ch; }
    }
  }
  row.push(cell);
  if (row.some(c => c)) result.push(row);
  return result;
}

// 발주번호에서 날짜 형식(YYMMDD) 추출 → 'YYYY-MM-DD'
// 예) 'AE-I-260529' / 'AE-I-2605292' → '2026-05-29'
function parseOrderDate(orderNo) {
  if (!orderNo) return '';
  const runs = String(orderNo).match(/\d+/g) || [];
  for (const run of runs) {
    if (run.length < 6) continue;
    const six = run.slice(0, 6);
    const mm = +six.slice(2, 4);
    const dd = +six.slice(4, 6);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `20${six.slice(0, 2)}-${six.slice(2, 4)}-${six.slice(4, 6)}`;
    }
  }
  return '';
}

const emptyForm = {
  barcode: '',
  productName: '',
  optionName: '',
  orderNo: '',
  orderDate: '',
  confirmDate: new Date().toISOString().slice(0, 10),
  shipEtaDate: '',
  releaseReqDate: '',
  qty: '',
  soldoutDate: '',
  reasonStatus: '확인중',
  reasonDetail: '',
};

export default function SoldOutAnalysisDelayCause() {
  // 상품 자동완성 (특별 관리 상품 시트 — 상품개선과 동일)
  const [productList, setProductList] = useState([]);
  const [productLoading, setProductLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(TSV_URL);
        if (!res.ok) throw new Error();
        const text = await res.text();
        const lines = parseCSV(text);
        const results = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i];
          const barcode = (cols[0] || '').trim();
          const productName = (cols[1] || '').trim();
          const optionName = (cols[2] || '').trim();
          if (!barcode && !productName) continue;
          results.push({ barcode, productName, optionName });
        }
        setProductList(results);
      } catch { /* 실패해도 수동 입력 가능 */ }
      setProductLoading(false);
    })();
  }, []);

  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [productSearch, setProductSearch] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [filterReason, setFilterReason] = useState('all');
  const [expandedId, setExpandedId] = useState(null);

  const [timelineInput, setTimelineInput] = useState({});
  const [editingTL, setEditingTL] = useState(null); // { itemId, idx }
  const [editingTLText, setEditingTLText] = useState('');

  const [editingCell, setEditingCell] = useState(null); // { id, field }
  const [editValue, setEditValue] = useState('');

  const [dbSyncFailed, setDbSyncFailed] = useState(false);

  // localStorage + DB 이중 저장/로드
  useEffect(() => {
    let localItems = null;
    try {
      localItems = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (Array.isArray(localItems) && localItems.length > 0) setItems(localItems);
    } catch { /* ignore */ }
    dbStoreGet(STORE_KEY).then((dbItems) => {
      if (Array.isArray(dbItems) && Array.isArray(localItems)) {
        if (localItems.length > dbItems.length) {
          setItems(localItems);
          dbStoreSet(STORE_KEY, localItems, { skipLog: true });
        } else {
          setItems(dbItems);
          localStorage.setItem(STORE_KEY, JSON.stringify(dbItems));
        }
      } else if (Array.isArray(dbItems)) {
        setItems(dbItems);
        localStorage.setItem(STORE_KEY, JSON.stringify(dbItems));
      } else if (Array.isArray(localItems) && localItems.length > 0) {
        dbStoreSet(STORE_KEY, localItems, { skipLog: true });
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const dbSaveWithRetry = useCallback(async (data) => {
    for (let i = 0; i < 3; i++) {
      const ok = await dbStoreSet(STORE_KEY, data, { logDesc: '보충 지연 원인 관리 수정' });
      if (ok) { setDbSyncFailed(false); return true; }
      await new Promise(r => setTimeout(r, 1000));
    }
    setDbSyncFailed(true);
    return false;
  }, []);

  const saveItems = useCallback((updated) => {
    setItems(updated);
    localStorage.setItem(STORE_KEY, JSON.stringify(updated));
    dbSaveWithRetry(updated);
  }, [dbSaveWithRetry]);

  const suggestions = useMemo(() => {
    if (!productSearch || productSearch.length < 1) return [];
    const q = productSearch.toLowerCase();
    return productList.filter(p =>
      p.productName.toLowerCase().includes(q) || p.barcode.toLowerCase().includes(q)
    ).slice(0, 15);
  }, [productSearch, productList]);

  const selectProduct = (product) => {
    setForm(prev => ({ ...prev, productName: product.productName, barcode: product.barcode, optionName: product.optionName || '' }));
    setProductSearch(product.productName);
    setShowSuggestions(false);
  };

  const filtered = useMemo(() => {
    let rows = items;
    if (filterReason !== 'all') rows = rows.filter(r => r.reasonStatus === filterReason);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter(r =>
        (r.productName || '').toLowerCase().includes(q) ||
        (r.optionName || '').toLowerCase().includes(q) ||
        (r.barcode || '').toLowerCase().includes(q) ||
        (r.orderNo || '').toLowerCase().includes(q) ||
        (r.reasonDetail || '').toLowerCase().includes(q)
      );
    }
    return rows;
  }, [items, filterReason, searchQuery]);

  const canSubmit = form.barcode.trim() && form.confirmDate && String(form.qty).trim();

  const resetForm = () => {
    setForm(emptyForm);
    setProductSearch('');
    setShowForm(false);
  };

  const handleAdd = () => {
    if (!canSubmit) return;
    const newItem = {
      ...form,
      id: Date.now().toString(),
      timeline: [],
      createdAt: new Date().toISOString(),
    };
    saveItems([newItem, ...items]);
    resetForm();
  };

  const handleDelete = (id) => {
    if (!confirm('삭제하시겠습니까?')) return;
    saveItems(items.filter(i => i.id !== id));
  };

  // 셀 인라인 수정
  const updateField = (id, field, value) => {
    saveItems(items.map(i => i.id === id ? { ...i, [field]: value } : i));
  };
  const startEdit = (id, field, val) => { setEditingCell({ id, field }); setEditValue(val ?? ''); };
  const commitEdit = () => {
    if (!editingCell) return;
    updateField(editingCell.id, editingCell.field, editValue);
    setEditingCell(null);
    setEditValue('');
  };

  // 타임라인
  const handleAddTimeline = (id) => {
    const text = (timelineInput[id] || '').trim();
    if (!text) return;
    const updated = items.map(i => {
      if (i.id !== id) return i;
      return { ...i, timeline: [...(i.timeline || []), { date: new Date().toISOString().slice(0, 16).replace('T', ' '), text }] };
    });
    saveItems(updated);
    setTimelineInput(prev => ({ ...prev, [id]: '' }));
  };
  const handleDeleteTimeline = (itemId, idx) => {
    if (!confirm('이 기록을 삭제하시겠습니까?')) return;
    saveItems(items.map(i => i.id === itemId ? { ...i, timeline: i.timeline.filter((_, k) => k !== idx) } : i));
  };
  const startEditTimeline = (itemId, idx, text) => { setEditingTL({ itemId, idx }); setEditingTLText(text); };
  const saveEditTimeline = () => {
    if (!editingTL) return;
    const text = editingTLText.trim();
    if (!text) { setEditingTL(null); return; }
    const { itemId, idx } = editingTL;
    saveItems(items.map(i => i.id === itemId ? { ...i, timeline: i.timeline.map((t, k) => k === idx ? { ...t, text } : t) } : i));
    setEditingTL(null);
    setEditingTLText('');
  };

  if (!loaded || productLoading) {
    return (
      <div className="loading" style={{ padding: 80, flexDirection: 'column', gap: 12 }}>
        <div className="spinner" />
        <p>보충 지연 원인 데이터를 불러오는 중...</p>
      </div>
    );
  }

  const labelStyle = { fontSize: 11, color: '#666', display: 'block', marginBottom: 4 };
  const reqLabelStyle = { fontSize: 11, color: '#d93025', fontWeight: 700, display: 'block', marginBottom: 4 };
  const inputStyle = { width: '100%', minWidth: 'auto' };
  const reqInputStyle = { ...inputStyle, border: '1.5px solid #e57373', background: '#fff7f7' };
  const cellText = { fontSize: 12, color: '#333', cursor: 'pointer', borderBottom: '1px dashed #d5d5d5', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', display: 'block', paddingBottom: 1 };
  const cellInput = { width: '100%', minWidth: 'auto', fontSize: 12, padding: '2px 4px', height: 26, boxSizing: 'border-box' };

  // 클릭하여 수정되는 셀
  const renderCell = (item, field, type, big) => {
    if (field === 'reasonStatus') {
      const c = REASON_COLORS[item.reasonStatus] || '#9e9e9e';
      return (
        <select value={item.reasonStatus || '확인중'} onChange={e => updateField(item.id, 'reasonStatus', e.target.value)}
          onClick={e => e.stopPropagation()}
          style={{ padding: '2px 4px', fontSize: 10, fontWeight: 600, border: `1.5px solid ${c}`, borderRadius: 5, color: c, background: '#fff', cursor: 'pointer', maxWidth: '100%' }}>
          {REASON_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      );
    }
    const editing = editingCell && editingCell.id === item.id && editingCell.field === field;
    if (editing) {
      const inputType = type === 'date' ? 'date' : type === 'number' ? 'number' : 'text';
      return (
        <input type={inputType} className="search-input" value={editValue}
          onChange={e => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitEdit(); } else if (e.key === 'Escape') { setEditingCell(null); } }}
          ref={el => { if (el) { el.focus(); if (type === 'date') { try { el.showPicker && el.showPicker(); } catch { /* ignore */ } } } }}
          style={{ ...cellInput, fontSize: big ? 13 : 12 }} />
      );
    }
    const raw = item[field];
    const empty = (raw ?? '') === '';
    return (
      <span onClick={e => { e.stopPropagation(); startEdit(item.id, field, raw); }}
        title="클릭하여 수정"
        style={{ ...cellText, fontSize: big ? 13 : 12, color: empty ? '#bbb' : '#333' }}>
        {empty ? '-' : raw}
      </span>
    );
  };

  return (
    <div>
      {dbSyncFailed && (
        <div style={{ marginBottom: 16, background: '#ffebee', border: '1px solid #ef5350', borderRadius: 12, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: '#c62828' }}>
            DB 저장 실패 — 현재 로컬에만 저장됨. 다른 컴퓨터에서 보이지 않을 수 있습니다.
          </span>
          <button className="btn btn-sm" style={{ fontSize: 12, background: '#c62828', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px' }}
            onClick={() => dbSaveWithRetry(items)}>재시도</button>
        </div>
      )}

      {/* 툴바 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className="filter-bar" style={{ flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <input className="search-input" placeholder="상품명, 옵션명, 바코드, 발주번호, 사유 검색..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} style={{ maxWidth: 280 }} />
            <div style={{ position: 'relative', display: 'inline-block' }}>
              <select value={filterReason} onChange={e => setFilterReason(e.target.value)}
                style={{
                  appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none',
                  padding: '8px 34px 8px 14px', fontSize: 13, fontWeight: 500, color: '#333',
                  border: '1px solid #d8dce0', borderRadius: 10, background: '#fff', cursor: 'pointer',
                  outline: 'none', boxShadow: '0 1px 2px rgba(0,0,0,0.04)', minWidth: 130,
                }}>
                <option value="all">전체 사유</option>
                {REASON_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <span style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', fontSize: 10, color: '#888' }}>▼</span>
            </div>
            <button className="btn btn-outline" onClick={() => { setSearchQuery(''); setFilterReason('all'); }}>초기화</button>
            <div style={{ marginLeft: 'auto' }}>
              <button className="btn btn-primary" onClick={() => { if (showForm) { resetForm(); } else { setForm(emptyForm); setProductSearch(''); setShowForm(true); } }}>
                {showForm ? '닫기' : '+ 새 항목'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 등록 폼 */}
      {showForm && (
        <div className="card" style={{ marginBottom: 16, border: '2px solid #1a73e8' }}>
          <div className="card-header">
            <h2 style={{ fontSize: 14, fontWeight: 600 }}>새 보충 지연 항목 등록</h2>
          </div>
          <div className="card-body">
            <div style={{ fontSize: 11, color: '#d93025', fontWeight: 600, marginBottom: 10 }}>* 표시는 필수 입력 항목입니다</div>
            {/* 상품 검색 */}
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div style={{ position: 'relative' }}>
                <label style={reqLabelStyle}>상품 * (상품명·바코드 검색)</label>
                <input className="search-input" placeholder="상품명 또는 바코드로 검색..." value={productSearch}
                  onChange={e => { setProductSearch(e.target.value); setShowSuggestions(true); setForm(p => ({ ...p, productName: e.target.value, barcode: '', optionName: '' })); }}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                  style={reqInputStyle} />
                {showSuggestions && suggestions.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #ddd', borderRadius: 8, maxHeight: 200, overflow: 'auto', zIndex: 100, boxShadow: '0 4px 12px rgba(0,0,0,0.15)' }}>
                    {suggestions.map((p, idx) => (
                      <div key={idx} style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f0f0f0', fontSize: 12 }}
                        onMouseDown={() => selectProduct(p)}>
                        <div style={{ fontWeight: 500 }}>{p.productName}</div>
                        <div style={{ color: '#999', fontSize: 11, fontFamily: 'monospace' }}>{p.barcode}{p.optionName ? ` · ${p.optionName}` : ''}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label style={reqLabelStyle}>바코드 *</label>
                <input className="search-input" value={form.barcode} onChange={e => setForm(p => ({ ...p, barcode: e.target.value }))} style={reqInputStyle} placeholder="자동/직접 입력" />
              </div>
              <div>
                <label style={labelStyle}>옵션명</label>
                <input className="search-input" value={form.optionName} onChange={e => setForm(p => ({ ...p, optionName: e.target.value }))} style={inputStyle} placeholder="자동/직접 입력" />
              </div>
            </div>

            {/* 발주 정보 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={labelStyle}>발주번호</label>
                <input className="search-input" value={form.orderNo}
                  onChange={e => { const v = e.target.value; setForm(p => ({ ...p, orderNo: v, orderDate: parseOrderDate(v) || p.orderDate })); }}
                  style={inputStyle} placeholder="예: AE-I-260529" />
              </div>
              <div>
                <label style={labelStyle}>발주일 (발주번호 자동 인식)</label>
                <input type="date" className="search-input" value={form.orderDate} onChange={e => setForm(p => ({ ...p, orderDate: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={reqLabelStyle}>확인일 *</label>
                <input type="date" className="search-input" value={form.confirmDate} onChange={e => setForm(p => ({ ...p, confirmDate: e.target.value }))} style={reqInputStyle} />
              </div>
            </div>

            {/* 일정/수량 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={labelStyle}>발송예정일</label>
                <input type="date" className="search-input" value={form.shipEtaDate} onChange={e => setForm(p => ({ ...p, shipEtaDate: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>출고요청일(예상일)</label>
                <input type="date" className="search-input" value={form.releaseReqDate} onChange={e => setForm(p => ({ ...p, releaseReqDate: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>품절일</label>
                <input type="date" className="search-input" value={form.soldoutDate} onChange={e => setForm(p => ({ ...p, soldoutDate: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={reqLabelStyle}>대기수량(발주수량) *</label>
                <input type="number" className="search-input" value={form.qty} onChange={e => setForm(p => ({ ...p, qty: e.target.value }))} style={reqInputStyle} placeholder="수량" />
              </div>
            </div>

            {/* 사유 */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={labelStyle}>사유 상태</label>
                <select className="filter-select" value={form.reasonStatus} onChange={e => setForm(p => ({ ...p, reasonStatus: e.target.value }))} style={{ width: '100%' }}>
                  {REASON_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label style={labelStyle}>자세한 사유</label>
                <input className="search-input" value={form.reasonDetail} onChange={e => setForm(p => ({ ...p, reasonDetail: e.target.value }))} style={inputStyle} placeholder="자세한 사유를 입력하세요..." />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline" onClick={resetForm}>취소</button>
              <button className="btn btn-primary" onClick={handleAdd} disabled={!canSubmit}>등록</button>
            </div>
          </div>
        </div>
      )}

      {/* 목록 */}
      {filtered.length === 0 ? (
        <div className="card">
          <div className="card-body" style={{ textAlign: 'center', padding: 48, color: '#999' }}>
            {items.length === 0 ? '등록된 항목이 없습니다. [+ 새 항목] 버튼으로 추가하세요.' : '검색/필터 조건에 맞는 항목이 없습니다.'}
          </div>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: ROW_MIN_WIDTH }}>
            {/* 컬럼 헤더 */}
            <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 8, alignItems: 'center', padding: '8px 14px', fontSize: 11, fontWeight: 600, color: '#888', letterSpacing: '0.2px' }}>
              {HEADERS.map((h, i) => <div key={i}>{h}</div>)}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {filtered.map((item) => {
                const isOpen = expandedId === item.id;
                const color = REASON_COLORS[item.reasonStatus] || '#9e9e9e';
                return (
                  <div key={item.id} className="card" style={{ borderLeft: `4px solid ${color}` }}>
                    {/* 한 줄 요약 */}
                    <div style={{ display: 'grid', gridTemplateColumns: COLS, gap: 8, alignItems: 'center', padding: '10px 14px' }}>
                      <span onClick={() => setExpandedId(prev => prev === item.id ? null : item.id)}
                        title="조치 내용 열기/닫기"
                        style={{ fontSize: 14, color: '#999', cursor: 'pointer', transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)', display: 'inline-block' }}>&#9654;</span>
                      {renderCell(item, 'reasonStatus')}
                      {renderCell(item, 'productName', 'text')}
                      {renderCell(item, 'optionName', 'text')}
                      {renderCell(item, 'barcode', 'text')}
                      {renderCell(item, 'orderNo', 'text')}
                      {renderCell(item, 'orderDate', 'date')}
                      {renderCell(item, 'confirmDate', 'date')}
                      {renderCell(item, 'soldoutDate', 'date')}
                      {renderCell(item, 'qty', 'number')}
                      {renderCell(item, 'reasonDetail', 'text')}
                      <span onClick={() => handleDelete(item.id)} title="삭제"
                        style={{ fontSize: 12, color: '#d93025', cursor: 'pointer', textAlign: 'center' }}>삭제</span>
                    </div>

                    {/* 펼침: 발송예정일/출고요청일 + 조치 내용 */}
                    {isOpen && (
                      <div style={{ padding: '4px 16px 16px 40px', borderTop: '1px solid #f0f0f0' }}>
                        <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', padding: '12px 0' }}>
                          <div>
                            <div style={{ fontSize: 11, color: '#999', marginBottom: 3 }}>발송예정일</div>
                            <div style={{ maxWidth: 160 }}>{renderCell(item, 'shipEtaDate', 'date', true)}</div>
                          </div>
                          <div>
                            <div style={{ fontSize: 11, color: '#999', marginBottom: 3 }}>출고요청일(예상일)</div>
                            <div style={{ maxWidth: 160 }}>{renderCell(item, 'releaseReqDate', 'date', true)}</div>
                          </div>
                        </div>

                        <div style={{ fontSize: 12, fontWeight: 600, color: '#555', margin: '4px 0 10px' }}>조치 내용</div>
                        <div style={{ marginLeft: 8, borderLeft: '2px solid #e0e0e0', paddingLeft: 16 }}>
                          {(item.timeline || []).map((entry, tIdx) => {
                            const editing = editingTL && editingTL.itemId === item.id && editingTL.idx === tIdx;
                            return (
                              <div key={tIdx} style={{ position: 'relative', marginBottom: 10 }}>
                                <div style={{ position: 'absolute', left: -22, top: 4, width: 10, height: 10, borderRadius: '50%', background: tIdx === (item.timeline.length - 1) ? '#1a73e8' : '#bdbdbd' }} />
                                {editing ? (
                                  <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                                    <span style={{ fontSize: 11, color: '#999', whiteSpace: 'nowrap', minWidth: 100, marginTop: 6 }}>{entry.date}</span>
                                    <textarea className="search-input" value={editingTLText} onChange={e => setEditingTLText(e.target.value)}
                                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEditTimeline(); } }}
                                      rows={1} style={{ flex: 1, minWidth: 'auto', resize: 'vertical', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5 }} />
                                    <button className="btn btn-primary btn-sm" onClick={saveEditTimeline} style={{ fontSize: 11, padding: '4px 10px', whiteSpace: 'nowrap' }}>저장</button>
                                    <button className="btn btn-outline btn-sm" onClick={() => setEditingTL(null)} style={{ fontSize: 11, padding: '4px 10px', whiteSpace: 'nowrap' }}>취소</button>
                                  </div>
                                ) : (
                                  <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                                    <span style={{ fontSize: 11, color: '#999', whiteSpace: 'nowrap', minWidth: 100 }}>{entry.date}</span>
                                    <span style={{ fontSize: 13, color: '#333', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>{entry.text}</span>
                                    <span style={{ fontSize: 11, color: '#1a73e8', cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => startEditTimeline(item.id, tIdx, entry.text)}>수정</span>
                                    <span style={{ fontSize: 11, color: '#ccc', cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => handleDeleteTimeline(item.id, tIdx)}>삭제</span>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', position: 'relative' }}>
                            <div style={{ position: 'absolute', left: -22, top: 8, width: 10, height: 10, borderRadius: '50%', border: '2px solid #bdbdbd', background: '#fff' }} />
                            <textarea className="search-input" placeholder="조치한 내용 추가..."
                              value={timelineInput[item.id] || ''}
                              onChange={e => setTimelineInput(prev => ({ ...prev, [item.id]: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddTimeline(item.id); } }}
                              rows={1} style={{ flex: 1, minWidth: 'auto', resize: 'vertical', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5 }} />
                            <button className="btn btn-primary btn-sm" onClick={() => handleAddTimeline(item.id)} style={{ fontSize: 11, padding: '4px 12px', whiteSpace: 'nowrap', marginTop: 2 }}>추가</button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
