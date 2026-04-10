import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import * as XLSX from 'xlsx';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const TSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('특별 관리 상품')}`;

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
        cell += ch; // 줄바꿈 포함 그대로 담김
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


const LOCAL_SPECIAL_KEY = 'local_special_items';

function loadLocalSpecial() {
  try { return JSON.parse(localStorage.getItem(LOCAL_SPECIAL_KEY) || '[]'); } catch { return []; }
}
function saveLocalSpecial(list) {
  localStorage.setItem(LOCAL_SPECIAL_KEY, JSON.stringify(list));
  dbStoreSet('issue_special_items', list).catch(() => {});
}

const PENDING_ALERTS_KEY = 'pending_sync_alerts';

function loadPendingAlerts() {
  try { return JSON.parse(localStorage.getItem(PENDING_ALERTS_KEY) || '[]'); } catch { return []; }
}
function savePendingAlerts(list) {
  localStorage.setItem(PENDING_ALERTS_KEY, JSON.stringify(list));
}

function resizeImage(file, maxDim = 800) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', 0.7));
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

const IMP_TYPES = ['재등록', '재수배', '업체문제', '상품문제', 'CSV·VOC'];
const IMP_STATUSES = ['시작전', '처리중', '완료'];
const STATUS_COLORS = { '시작전': '#9e9e9e', '처리중': '#fb8c00', '완료': '#43a047' };
const TYPE_COLORS = { '재등록': '#1565c0', '재수배': '#6a1b9a', '업체문제': '#c62828', '상품문제': '#e65100', 'CSV·VOC': '#00695c' };

function ImprovementTab({ productList }) {
  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState(null);
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  // 신규 항목 폼
  const emptyForm = { status: '시작전', type: '재등록', productName: '', barcode: '', issue: '', startDate: new Date().toISOString().slice(0, 10), endDate: '' };
  const [form, setForm] = useState(emptyForm);
  const [productSearch, setProductSearch] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  // 타임라인 입력
  const [timelineInput, setTimelineInput] = useState({});

  // 첨부 이미지
  const [impImages, setImpImages] = useState({});
  const [impImgModal, setImpImgModal] = useState(null);
  const [impImgModalImages, setImpImgModalImages] = useState([]);
  const [impImgLoading, setImpImgLoading] = useState(false);
  const impFileRef = useRef(null);

  // 다운로드 상태
  const [excelDownloading, setExcelDownloading] = useState(false);
  const [zipDownloading, setZipDownloading] = useState(false);

  // DB 로드
  useEffect(() => {
    Promise.all([
      dbStoreGet('improvement_items'),
      dbStoreGet('improvement_images'),
    ]).then(([itemsData, imgData]) => {
      if (Array.isArray(itemsData)) setItems(itemsData);
      if (imgData && typeof imgData === 'object') setImpImages(imgData);
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const saveItems = useCallback((updated) => {
    setItems(updated);
    dbStoreSet('improvement_items', updated).catch(() => {});
  }, []);

  const saveImagesDb = useCallback((updated) => {
    setImpImages(updated);
    dbStoreSet('improvement_images', updated).catch(() => {});
  }, []);

  // 상품명 자동완성 목록 (특별관리 탭 품목 기반)
  const suggestions = useMemo(() => {
    if (!productSearch || productSearch.length < 1) return [];
    const q = productSearch.toLowerCase();
    return productList.filter(p =>
      p.productName.toLowerCase().includes(q) || p.barcode.toLowerCase().includes(q)
    ).slice(0, 15);
  }, [productSearch, productList]);

  // 필터링
  const filtered = useMemo(() => {
    let rows = items;
    if (filterStatus !== 'all') rows = rows.filter(r => r.status === filterStatus);
    if (filterType !== 'all') rows = rows.filter(r => r.type === filterType);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter(r =>
        (r.productName || '').toLowerCase().includes(q) ||
        (r.barcode || '').toLowerCase().includes(q) ||
        (r.issue || '').toLowerCase().includes(q)
      );
    }
    return rows;
  }, [items, filterStatus, filterType, searchQuery]);

  // 항목 추가
  const handleAdd = () => {
    if (!form.productName.trim() && !form.barcode.trim()) return;
    const newItem = {
      ...form,
      id: Date.now().toString(),
      timeline: form.issue ? [{ date: new Date().toISOString().slice(0, 16).replace('T', ' '), text: form.issue }] : [],
      createdAt: new Date().toISOString(),
    };
    saveItems([newItem, ...items]);
    setForm(emptyForm);
    setProductSearch('');
    setShowForm(false);
  };

  // 항목 삭제
  const handleDelete = (id) => {
    if (!confirm('삭제하시겠습니까?')) return;
    saveItems(items.filter(i => i.id !== id));
    const updatedImg = { ...impImages };
    delete updatedImg[id];
    saveImagesDb(updatedImg);
  };

  // 상태 변경
  const handleStatusChange = (id, status) => {
    const updated = items.map(i => {
      if (i.id !== id) return i;
      const upd = { ...i, status };
      if (status === '완료' && !upd.endDate) upd.endDate = new Date().toISOString().slice(0, 10);
      return upd;
    });
    saveItems(updated);
  };

  // 타임라인 추가
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

  // 타임라인 항목 삭제
  const handleDeleteTimeline = (itemId, timelineIdx) => {
    const updated = items.map(i => {
      if (i.id !== itemId) return i;
      return { ...i, timeline: i.timeline.filter((_, idx) => idx !== timelineIdx) };
    });
    saveItems(updated);
  };

  // 이미지 모달
  const openImpImgModal = async (itemId) => {
    setImpImgModal(itemId);
    setImpImgLoading(true);
    try {
      const allData = await dbStoreGet('improvement_images');
      const imgs = (allData && allData[itemId]) ? allData[itemId] : [];
      setImpImgModalImages(Array.isArray(imgs) ? imgs : []);
    } catch { setImpImgModalImages([]); }
    setImpImgLoading(false);
  };

  const saveImpImages = async (itemId, images) => {
    setImpImgModalImages(images);
    let allData = { ...impImages };
    if (images.length > 0) { allData[itemId] = images; } else { delete allData[itemId]; }
    saveImagesDb(allData);
  };

  const handleImpImgAdd = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || !impImgModal) return;
    const remaining = 5 - impImgModalImages.length;
    if (remaining <= 0) return;
    const toAdd = files.slice(0, remaining);
    const resized = await Promise.all(toAdd.map(f => resizeImage(f)));
    await saveImpImages(impImgModal, [...impImgModalImages, ...resized]);
    if (impFileRef.current) impFileRef.current.value = '';
  };

  const handleImpImgPaste = async (e) => {
    if (!impImgModal) return;
    const pasteItems = Array.from(e.clipboardData?.items || []);
    const imageFiles = pasteItems.filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
    if (!imageFiles.length) return;
    e.preventDefault();
    const remaining = 5 - impImgModalImages.length;
    if (remaining <= 0) return;
    const toAdd = imageFiles.slice(0, remaining);
    const resized = await Promise.all(toAdd.map(f => resizeImage(f)));
    await saveImpImages(impImgModal, [...impImgModalImages, ...resized]);
  };

  const handleImpImgDelete = async (idx) => {
    if (!impImgModal) return;
    await saveImpImages(impImgModal, impImgModalImages.filter((_, i) => i !== idx));
  };

  // 엑셀 다운로드
  const handleExcelDownload = () => {
    if (excelDownloading || !items.length) return;
    setExcelDownloading(true);
    try {
      const rows = items.map((item, i) => ({
        '번호': i + 1,
        '상태': item.status,
        '유형': item.type,
        '상품명': item.productName,
        '바코드': item.barcode,
        '발생일': item.startDate,
        '종료일': item.endDate || '',
        '이슈/진행상황': (item.timeline || []).map(t => `[${t.date}] ${t.text}`).join('\n'),
        '첨부파일수': (impImages[item.id] || []).length,
      }));
      const ws = XLSX.utils.json_to_sheet(rows);
      // 열 너비 설정
      ws['!cols'] = [
        { wch: 5 }, { wch: 8 }, { wch: 10 }, { wch: 30 }, { wch: 16 },
        { wch: 12 }, { wch: 12 }, { wch: 60 }, { wch: 10 },
      ];
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '상품개선');
      XLSX.writeFile(wb, `상품개선_${new Date().toISOString().slice(0, 10)}.xlsx`);
    } catch (e) {
      console.error('엑셀 다운로드 실패:', e);
      alert('엑셀 다운로드 중 오류가 발생했습니다.');
    }
    setExcelDownloading(false);
  };

  // 사진 ZIP 다운로드
  const handlePhotoZipDownload = async () => {
    if (zipDownloading) return;
    setZipDownloading(true);
    try {
      const allImg = await dbStoreGet('improvement_images');
      if (!allImg || Object.keys(allImg).length === 0) {
        alert('다운로드할 사진이 없습니다.');
        setZipDownloading(false);
        return;
      }
      const idToName = {};
      items.forEach(i => { idToName[i.id] = i.productName || i.barcode || i.id; });

      const zip = new JSZip();
      const usedNames = {};

      for (const [itemId, images] of Object.entries(allImg)) {
        if (!Array.isArray(images) || images.length === 0) continue;
        let folderName = (idToName[itemId] || itemId).replace(/[\\/:*?"<>|]/g, '_').trim();
        if (usedNames[folderName]) { usedNames[folderName]++; folderName = `${folderName}_${usedNames[folderName]}`; }
        else { usedNames[folderName] = 1; }
        const folder = zip.folder(folderName);
        images.forEach((base64Str, idx) => {
          const match = base64Str.match(/^data:image\/(\w+);base64,(.+)$/);
          if (match) {
            const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
            folder.file(`사진${idx + 1}.${ext}`, match[2], { base64: true });
          }
        });
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      saveAs(blob, `상품개선_사진_${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (e) {
      console.error('사진 ZIP 다운로드 실패:', e);
      alert('다운로드 중 오류가 발생했습니다.');
    }
    setZipDownloading(false);
  };

  // 상품명 선택
  const selectProduct = (product) => {
    setForm(prev => ({ ...prev, productName: product.productName, barcode: product.barcode }));
    setProductSearch(product.productName);
    setShowSuggestions(false);
  };

  const imgCount = useMemo(() => {
    let c = 0;
    Object.values(impImages).forEach(arr => { if (Array.isArray(arr)) c += arr.length; });
    return c;
  }, [impImages]);

  const statusCounts = useMemo(() => {
    const c = { '시작전': 0, '처리중': 0, '완료': 0 };
    items.forEach(i => { if (c[i.status] !== undefined) c[i.status]++; });
    return c;
  }, [items]);

  if (!loaded) return <div className="loading" style={{ padding: 40 }}><div className="spinner" /></div>;

  return (
    <div>
      {/* 요약 카드 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>
        <div style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 10, padding: '14px 18px', textAlign: 'center' }}>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#1a73e8' }}>{items.length}</div>
          <div style={{ fontSize: 12, color: '#666' }}>전체 ({productList.length}품목)</div>
        </div>
        {IMP_STATUSES.map(s => (
          <div key={s} style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 10, padding: '14px 18px', textAlign: 'center', cursor: 'pointer', outline: filterStatus === s ? `2px solid ${STATUS_COLORS[s]}` : 'none' }}
            onClick={() => setFilterStatus(prev => prev === s ? 'all' : s)}>
            <div style={{ fontSize: 22, fontWeight: 700, color: STATUS_COLORS[s] }}>{statusCounts[s]}</div>
            <div style={{ fontSize: 12, color: '#666' }}>{s}</div>
          </div>
        ))}
      </div>

      {/* 툴바 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className="filter-bar" style={{ flexWrap: 'wrap', gap: 8 }}>
            <input className="search-input" placeholder="상품명, 바코드, 이슈 검색..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} style={{ maxWidth: 240 }} />
            <select className="filter-select" value={filterType} onChange={e => setFilterType(e.target.value)}>
              <option value="all">전체 유형</option>
              {IMP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="filter-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="all">전체 상태</option>
              {IMP_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="btn btn-outline" onClick={() => { setSearchQuery(''); setFilterStatus('all'); setFilterType('all'); }}>초기화</button>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn btn-outline" onClick={handleExcelDownload} disabled={excelDownloading || !items.length} style={{ fontSize: 13 }}>
                {excelDownloading ? '다운로드 중...' : `엑셀 다운로드 (${items.length})`}
              </button>
              <button className="btn btn-outline" onClick={handlePhotoZipDownload} disabled={zipDownloading || imgCount === 0} style={{ fontSize: 13 }}>
                {zipDownloading ? '다운로드 중...' : `사진 다운로드 (${imgCount})`}
              </button>
              <button className="btn btn-primary" onClick={() => { setShowForm(!showForm); setEditId(null); setForm(emptyForm); setProductSearch(''); }}>
                {showForm ? '닫기' : '+ 새 항목'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 신규 등록 폼 */}
      {showForm && (
        <div className="card" style={{ marginBottom: 16, border: '2px solid #1a73e8' }}>
          <div className="card-header"><h2 style={{ fontSize: 14, fontWeight: 600 }}>새 상품개선 항목 등록</h2></div>
          <div className="card-body">
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 12, marginBottom: 12 }}>
              <div>
                <label style={{ fontSize: 11, color: '#666', display: 'block', marginBottom: 4 }}>유형 *</label>
                <select className="filter-select" value={form.type} onChange={e => setForm(p => ({ ...p, type: e.target.value }))} style={{ width: '100%' }}>
                  {IMP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#666', display: 'block', marginBottom: 4 }}>상태</label>
                <select className="filter-select" value={form.status} onChange={e => setForm(p => ({ ...p, status: e.target.value }))} style={{ width: '100%' }}>
                  {IMP_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#666', display: 'block', marginBottom: 4 }}>발생일</label>
                <input type="date" className="search-input" value={form.startDate} onChange={e => setForm(p => ({ ...p, startDate: e.target.value }))} style={{ width: '100%', minWidth: 'auto' }} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#666', display: 'block', marginBottom: 4 }}>종료일</label>
                <input type="date" className="search-input" value={form.endDate} onChange={e => setForm(p => ({ ...p, endDate: e.target.value }))} style={{ width: '100%', minWidth: 'auto' }} />
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 12, marginBottom: 12 }}>
              <div style={{ position: 'relative' }}>
                <label style={{ fontSize: 11, color: '#666', display: 'block', marginBottom: 4 }}>상품명 * (검색하여 선택)</label>
                <input className="search-input" placeholder="상품명 또는 바코드로 검색..." value={productSearch}
                  onChange={e => { setProductSearch(e.target.value); setShowSuggestions(true); setForm(p => ({ ...p, productName: e.target.value, barcode: '' })); }}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                  style={{ width: '100%', minWidth: 'auto' }} />
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
                <label style={{ fontSize: 11, color: '#666', display: 'block', marginBottom: 4 }}>바코드</label>
                <input className="search-input" value={form.barcode} onChange={e => setForm(p => ({ ...p, barcode: e.target.value }))} style={{ width: '100%', minWidth: 'auto' }} placeholder="자동 입력 또는 직접 입력" />
              </div>
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: '#666', display: 'block', marginBottom: 4 }}>초기 이슈 내용</label>
              <textarea className="search-input" value={form.issue} onChange={e => setForm(p => ({ ...p, issue: e.target.value }))}
                placeholder="이슈 내용을 입력하세요..." rows={3}
                style={{ width: '100%', minWidth: 'auto', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline" onClick={() => { setShowForm(false); setForm(emptyForm); setProductSearch(''); }}>취소</button>
              <button className="btn btn-primary" onClick={handleAdd} disabled={!form.productName.trim() && !form.barcode.trim()}>등록</button>
            </div>
          </div>
        </div>
      )}

      {/* 항목 리스트 (카드형) */}
      {filtered.length === 0 ? (
        <div className="card">
          <div className="card-body" style={{ textAlign: 'center', padding: 48, color: '#999' }}>
            {items.length === 0 ? '등록된 상품개선 항목이 없습니다. [+ 새 항목] 버튼으로 추가하세요.' : '필터 조건에 맞는 항목이 없습니다.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map((item) => {
            const imgArr = impImages[item.id] || [];
            return (
              <div key={item.id} className="card" style={{ borderLeft: `4px solid ${STATUS_COLORS[item.status]}` }}>
                <div className="card-body" style={{ padding: 16 }}>
                  {/* 헤더 행 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                    <select value={item.status} onChange={e => handleStatusChange(item.id, e.target.value)}
                      style={{ padding: '3px 8px', fontSize: 12, fontWeight: 600, border: `2px solid ${STATUS_COLORS[item.status]}`, borderRadius: 6, color: STATUS_COLORS[item.status], background: '#fff', cursor: 'pointer' }}>
                      {IMP_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                    <span style={{ padding: '3px 10px', fontSize: 11, fontWeight: 600, borderRadius: 12, color: '#fff', background: TYPE_COLORS[item.type] || '#666' }}>{item.type}</span>
                    <span style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>{item.productName || '-'}</span>
                    {item.barcode && <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#888', background: '#f5f5f5', padding: '2px 8px', borderRadius: 4 }}>{item.barcode}</span>}
                    <span style={{ fontSize: 11, color: '#999' }}>{item.startDate}{item.endDate ? ` ~ ${item.endDate}` : ''}</span>
                    <span style={{ cursor: 'pointer', fontSize: 16, opacity: imgArr.length ? 1 : 0.4 }} onClick={() => openImpImgModal(item.id)} title="첨부 자료">
                      {imgArr.length ? `📎${imgArr.length}` : '📎'}
                    </span>
                    <span style={{ cursor: 'pointer', fontSize: 14, color: '#d93025' }} onClick={() => handleDelete(item.id)} title="삭제">✕</span>
                  </div>

                  {/* 타임라인 */}
                  <div style={{ marginLeft: 8, borderLeft: '2px solid #e0e0e0', paddingLeft: 16 }}>
                    {(item.timeline || []).map((entry, tIdx) => (
                      <div key={tIdx} style={{ position: 'relative', marginBottom: 12, paddingBottom: 4 }}>
                        <div style={{ position: 'absolute', left: -22, top: 4, width: 10, height: 10, borderRadius: '50%', background: tIdx === (item.timeline.length - 1) ? '#1a73e8' : '#bdbdbd' }} />
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                          <span style={{ fontSize: 11, color: '#999', whiteSpace: 'nowrap', minWidth: 100 }}>{entry.date}</span>
                          <span style={{ fontSize: 13, color: '#333', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>{entry.text}</span>
                          <span style={{ fontSize: 11, color: '#ccc', cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => handleDeleteTimeline(item.id, tIdx)} title="삭제">삭제</span>
                        </div>
                      </div>
                    ))}
                    {/* 타임라인 추가 입력 */}
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', position: 'relative' }}>
                      <div style={{ position: 'absolute', left: -22, top: 8, width: 10, height: 10, borderRadius: '50%', border: '2px solid #bdbdbd', background: '#fff' }} />
                      <textarea
                        className="search-input"
                        placeholder="진행 상황 추가..."
                        value={timelineInput[item.id] || ''}
                        onChange={e => setTimelineInput(prev => ({ ...prev, [item.id]: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddTimeline(item.id); } }}
                        rows={1}
                        style={{ flex: 1, minWidth: 'auto', resize: 'vertical', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5 }}
                      />
                      <button className="btn btn-primary btn-sm" onClick={() => handleAddTimeline(item.id)} style={{ fontSize: 11, padding: '4px 12px', whiteSpace: 'nowrap', marginTop: 2 }}>추가</button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* 이미지 모달 */}
      {impImgModal && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setImpImgModal(null)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, minWidth: 400, maxWidth: 600, maxHeight: '80vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()} onPaste={handleImpImgPaste} tabIndex={0}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div style={{ fontWeight: 600, fontSize: 15 }}>첨부 자료</div>
              <span style={{ cursor: 'pointer', fontSize: 20, color: '#999' }} onClick={() => setImpImgModal(null)}>✕</span>
            </div>
            {impImgLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>불러오는 중...</div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                  {impImgModalImages.map((src, idx) => (
                    <div key={idx} style={{ position: 'relative', border: '1px solid #e0e0e0', borderRadius: 8, overflow: 'hidden' }}>
                      <img src={src} alt={`첨부 ${idx + 1}`} style={{ width: 160, height: 160, objectFit: 'cover', display: 'block' }} />
                      <span onClick={() => handleImpImgDelete(idx)}
                        style={{ position: 'absolute', top: 4, right: 4, background: 'rgba(0,0,0,0.6)', color: '#fff', borderRadius: '50%', width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 13 }}>✕</span>
                    </div>
                  ))}
                  {impImgModalImages.length === 0 && <div style={{ color: '#999', fontSize: 13, padding: 20 }}>등록된 첨부 자료가 없습니다</div>}
                </div>
                {impImgModalImages.length < 5 && (
                  <div>
                    <input ref={impFileRef} type="file" accept="image/*" multiple onChange={handleImpImgAdd} style={{ display: 'none' }} />
                    <button className="btn btn-primary btn-sm" onClick={() => impFileRef.current?.click()} style={{ fontSize: 13 }}>
                      + 사진 추가 ({impImgModalImages.length}/5)
                    </button>
                    <div style={{ fontSize: 11, color: '#aaa', marginTop: 8 }}>Ctrl+V로 클립보드 이미지 붙여넣기 가능</div>
                  </div>
                )}
                {impImgModalImages.length >= 5 && <div style={{ fontSize: 12, color: '#999' }}>최대 5장까지 등록 가능합니다</div>}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function IssueManagement() {
  const [activeTab, setActiveTab] = useState('special'); // 'special' | 'improvement'
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [localItems, setLocalItems] = useState(loadLocalSpecial);
  const [showAddForm, setShowAddForm] = useState(false);

  // DB에서 초기 데이터 로드
  useEffect(() => {
    dbStoreGet('issue_special_items').then(data => {
      if (data && Array.isArray(data) && data.length > 0) {
        localStorage.setItem(LOCAL_SPECIAL_KEY, JSON.stringify(data));
        setLocalItems(data);
      }
    }).catch(() => {});
  }, []);
  const [newItem, setNewItem] = useState({ barcode: '', oneTime: '', orderUnit: '', sewing: '', fbcItem: '', priceNote: '', memo: '' });
  const [syncAlerts, setSyncAlerts] = useState(loadPendingAlerts);
  const [expandedCell, setExpandedCell] = useState(null);

  // 이미지 관련 상태
  const [imgModal, setImgModal] = useState(null); // { barcode, productName }
  const [imgModalImages, setImgModalImages] = useState([]);
  const [imgLoading, setImgLoading] = useState(false);
  const [imgCounts, setImgCounts] = useState({}); // { barcode: count }
  const fileInputRef = useRef(null);

  // 전체 이미지 카운트 로드
  useEffect(() => {
    dbStoreGet('issue_img_counts').then(data => {
      if (data && typeof data === 'object') setImgCounts(data);
    }).catch(() => {});
  }, []);

  const openImgModal = async (barcode, productName) => {
    setImgModal({ barcode, productName });
    setImgLoading(true);
    try {
      const allData = await dbStoreGet('issue_img_data');
      const imgs = (allData && allData[barcode]) ? allData[barcode] : [];
      setImgModalImages(Array.isArray(imgs) ? imgs : []);
    } catch { setImgModalImages([]); }
    setImgLoading(false);
  };

  const saveImages = async (barcode, images) => {
    setImgModalImages(images);
    // 전체 이미지 데이터를 하나의 저장소에 저장
    let allData = {};
    try { const d = await dbStoreGet('issue_img_data'); if (d && typeof d === 'object') allData = d; } catch {}
    if (images.length > 0) { allData[barcode] = images; } else { delete allData[barcode]; }
    await dbStoreSet('issue_img_data', allData);
    const newCounts = { ...imgCounts, [barcode]: images.length };
    if (images.length === 0) delete newCounts[barcode];
    setImgCounts(newCounts);
    await dbStoreSet('issue_img_counts', newCounts);
  };

  const handleImgAdd = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length || !imgModal) return;
    const remaining = 3 - imgModalImages.length;
    if (remaining <= 0) return;
    const toAdd = files.slice(0, remaining);
    const resized = await Promise.all(toAdd.map(f => resizeImage(f)));
    await saveImages(imgModal.barcode, [...imgModalImages, ...resized]);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleImgPaste = async (e) => {
    if (!imgModal) return;
    const items = Array.from(e.clipboardData?.items || []);
    const imageFiles = items.filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
    if (!imageFiles.length) return;
    e.preventDefault();
    const remaining = 3 - imgModalImages.length;
    if (remaining <= 0) return;
    const toAdd = imageFiles.slice(0, remaining);
    const resized = await Promise.all(toAdd.map(f => resizeImage(f)));
    await saveImages(imgModal.barcode, [...imgModalImages, ...resized]);
  };

  const handleImgDelete = async (idx) => {
    if (!imgModal) return;
    const updated = imgModalImages.filter((_, i) => i !== idx);
    await saveImages(imgModal.barcode, updated);
  };

  const [imgDownloading, setImgDownloading] = useState(false);

  const handleDownloadAllImages = async () => {
    if (imgDownloading) return;
    setImgDownloading(true);
    try {
      const allData = await dbStoreGet('issue_img_data');
      if (!allData || typeof allData !== 'object' || Object.keys(allData).length === 0) {
        alert('다운로드할 사진이 없습니다.');
        setImgDownloading(false);
        return;
      }

      // 바코드 → 상품명 매핑 (data에서)
      const barcodeToName = {};
      if (data) {
        data.forEach(r => { barcodeToName[r.barcode] = r.productName || r.barcode; });
      }

      const zip = new JSZip();
      const usedNames = {};

      for (const [barcode, images] of Object.entries(allData)) {
        if (!Array.isArray(images) || images.length === 0) continue;

        // 폴더명: 상품명 (없으면 바코드), 파일시스템 안전하게 변환
        let folderName = (barcodeToName[barcode] || barcode).replace(/[\\/:*?"<>|]/g, '_').trim();
        // 동일 상품명 중복 방지
        if (usedNames[folderName]) {
          usedNames[folderName]++;
          folderName = `${folderName}_${usedNames[folderName]}`;
        } else {
          usedNames[folderName] = 1;
        }

        const folder = zip.folder(folderName);
        images.forEach((base64Str, idx) => {
          // data:image/jpeg;base64,... → 순수 base64 추출
          const match = base64Str.match(/^data:image\/(\w+);base64,(.+)$/);
          if (match) {
            const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
            folder.file(`사진${idx + 1}.${ext}`, match[2], { base64: true });
          }
        });
      }

      const blob = await zip.generateAsync({ type: 'blob' });
      saveAs(blob, `이슈관리_사진_${new Date().toISOString().slice(0, 10)}.zip`);
    } catch (e) {
      console.error('이미지 다운로드 실패:', e);
      alert('다운로드 중 오류가 발생했습니다.');
    }
    setImgDownloading(false);
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(TSV_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // CSV 파싱
      const lines = parseCSV(text);
      if (lines.length < 2) throw new Error('데이터가 없습니다');

      const results = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i];
        const barcode = (cols[0] || '').trim();       // A: 바코드
        const productName = (cols[1] || '').trim();   // B: 등록상품명
        const optionName = (cols[2] || '').trim();     // C: 옵션명
        const note = (cols[3] || '').trim();           // D: 비고
        const orderUnit = (cols[4] || '').trim();      // E: 발주단위
        const sewing = (cols[5] || '').trim();         // F: 봉제여부
        const fbcItem = (cols[6] || '').trim();        // G: FBC품목
        const priceNote = (cols[7] || '').trim();      // H: 가격 협의
        const oneTime = (cols[8] || '').trim();        // I: 기타(1회성)
        const memo = (cols[9] || '').trim();           // J: 메모용(포장사이즈,포장스타일)

        if (!barcode && !productName) continue;

        const brand = productName.split(' ')[0] || '';

        results.push({
          id: i, barcode, productName, optionName, brand, note,
          orderUnit, sewing, fbcItem, priceNote, oneTime, memo,
        });
      }
      setData(results);

      // 동기화 알림: localStorage에 있는데 스프레드시트에도 바코드가 존재하면 알림 등록
      const sheetBarcodes = new Set(results.map(r => r.barcode));
      const local = loadLocalSpecial();
      const newAlerts = local.filter(item => sheetBarcodes.has(item.barcode));

      // 새로 감지된 항목을 영구 알림 목록에 추가 (적용완료 누를 때까지 유지)
      const saved = loadPendingAlerts();
      const savedBarcodes = new Set(saved.map(a => a.barcode));
      let updated = [...saved];
      for (const item of newAlerts) {
        if (!savedBarcodes.has(item.barcode)) {
          updated.push({ ...item, detectedDate: new Date().toISOString().slice(0, 10) });
        }
      }
      savePendingAlerts(updated);
      setSyncAlerts(updated);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // 브랜드 목록
  const brands = useMemo(() => {
    if (!data) return [];
    const s = new Set();
    data.forEach(r => { if (r.brand) s.add(r.brand); });
    return [...s].sort();
  }, [data]);

  const [brandFilter, setBrandFilter] = useState('all');

  const filtered = useMemo(() => {
    if (!data) return [];
    let rows = data;

    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        r.productName.toLowerCase().includes(q) ||
        r.barcode.toLowerCase().includes(q) ||
        r.optionName.toLowerCase().includes(q) ||
        r.note.toLowerCase().includes(q)
      );
    }

    if (brandFilter !== 'all') {
      rows = rows.filter(r => r.brand === brandFilter);
    }

    if (sortKey) {
      rows = [...rows].sort((a, b) => {
        let va = a[sortKey], vb = b[sortKey];
        if (typeof va === 'string') va = va.toLowerCase();
        if (typeof vb === 'string') vb = vb.toLowerCase();
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return rows;
  }, [data, search, brandFilter, sortKey, sortDir]);

  const addLocalItem = () => {
    if (!newItem.barcode.trim()) return;
    const updated = [...localItems, { ...newItem, barcode: newItem.barcode.trim(), addedDate: new Date().toISOString().slice(0, 10) }];
    setLocalItems(updated);
    saveLocalSpecial(updated);
    setNewItem({ barcode: '', oneTime: '', orderUnit: '', sewing: '', fbcItem: '', priceNote: '', memo: '' });
    setShowAddForm(false);
  };

  const deleteLocalItem = (barcode) => {
    const updated = localItems.filter(i => i.barcode !== barcode);
    setLocalItems(updated);
    saveLocalSpecial(updated);
    setSyncAlerts(prev => prev.filter(a => a.barcode !== barcode));
  };

  const dismissAlert = (barcode) => {
    // 적용 완료: 영구 알림 목록에서 제거 + 미등록 항목에서도 제거
    const updatedAlerts = syncAlerts.filter(a => a.barcode !== barcode);
    savePendingAlerts(updatedAlerts);
    setSyncAlerts(updatedAlerts);
    deleteLocalItem(barcode);
  };

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const SortIcon = ({ col }) => (
    <span className="sort-icon">
      {sortKey === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );

  if (loading && !data) {
    return (
      <div className="loading" style={{ padding: 80, flexDirection: 'column', gap: 12 }}>
        <div className="spinner" />
        <p>특별 관리 상품을 불러오는 중...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" style={{ margin: 24 }}>
        <div className="card-body" style={{ textAlign: 'center', padding: 40 }}>
          <p style={{ color: '#d93025', marginBottom: 12 }}>데이터 로드 실패: {error}</p>
          <button className="btn btn-primary" onClick={fetchData}>다시 시도</button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div>
      {/* 탭 네비게이션 */}
      <div style={{ display: 'flex', gap: 0, marginBottom: 20, borderBottom: '2px solid #e0e0e0' }}>
        <button
          onClick={() => setActiveTab('special')}
          style={{
            padding: '10px 24px', fontSize: 14, fontWeight: activeTab === 'special' ? 700 : 400,
            border: 'none', borderBottom: activeTab === 'special' ? '3px solid #1a73e8' : '3px solid transparent',
            background: activeTab === 'special' ? '#e8f0fe' : 'transparent',
            color: activeTab === 'special' ? '#1a73e8' : '#5f6368',
            cursor: 'pointer', borderRadius: '8px 8px 0 0', transition: 'all 0.2s',
          }}
        >
          특별관리
        </button>
        <button
          onClick={() => setActiveTab('improvement')}
          style={{
            padding: '10px 24px', fontSize: 14, fontWeight: activeTab === 'improvement' ? 700 : 400,
            border: 'none', borderBottom: activeTab === 'improvement' ? '3px solid #1a73e8' : '3px solid transparent',
            background: activeTab === 'improvement' ? '#e8f0fe' : 'transparent',
            color: activeTab === 'improvement' ? '#1a73e8' : '#5f6368',
            cursor: 'pointer', borderRadius: '8px 8px 0 0', transition: 'all 0.2s',
          }}
        >
          상품개선
        </button>
      </div>

      {/* 특별관리 탭 */}
      {activeTab === 'special' && <>
      {/* 동기화 알림 */}
      {syncAlerts.length > 0 && (
        <div style={{ marginBottom: 16, background: '#fff3e0', border: '1px solid #ffb74d', borderRadius: 12, padding: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8, color: '#e65100' }}>
            📢 스프레드시트에 적어주세요 ({syncAlerts.length}건) — 적용완료 누를 때까지 유지됩니다
          </div>
          {syncAlerts.map(item => (
            <div key={item.barcode} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderBottom: '1px solid #ffe0b2' }}>
              <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#333' }}>{item.barcode}</span>
              <div style={{ flex: 1, fontSize: 12, color: '#666' }}>
                {[
                  item.oneTime && `기타: ${item.oneTime}`,
                  item.sewing && `봉제: ${item.sewing}`,
                  item.orderUnit && `발주단위: ${item.orderUnit}`,
                  item.fbcItem && `FBC: ${item.fbcItem}`,
                  item.priceNote && `가격: ${item.priceNote}`,
                  item.memo && `메모: ${item.memo}`,
                ].filter(Boolean).join(' · ')}
              </div>
              <button className="btn btn-primary btn-sm" style={{ fontSize: 10, padding: '2px 8px' }} onClick={() => dismissAlert(item.barcode)}>
                적용 완료
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 로컬 저장 항목 + 추가 버튼 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h2 style={{ fontSize: 15, fontWeight: 600 }}>미등록 특별관리 항목</h2>
          <button className="btn btn-primary btn-sm" onClick={() => setShowAddForm(!showAddForm)}>
            {showAddForm ? '닫기' : '+ 항목 추가'}
          </button>
        </div>
        {showAddForm && (
          <div className="card-body" style={{ borderBottom: '1px solid #e0e0e0' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 10, marginBottom: 10 }}>
              <div>
                <label style={{ fontSize: 11, color: '#666' }}>바코드 *</label>
                <input className="search-input" style={{ minWidth: 'auto', width: '100%' }} value={newItem.barcode}
                  onChange={e => setNewItem(p => ({ ...p, barcode: e.target.value }))} placeholder="S00..." />
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#666' }}>기타(1회성)</label>
                <input className="search-input" style={{ minWidth: 'auto', width: '100%' }} value={newItem.oneTime}
                  onChange={e => setNewItem(p => ({ ...p, oneTime: e.target.value }))} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#666' }}>봉제여부</label>
                <input className="search-input" style={{ minWidth: 'auto', width: '100%' }} value={newItem.sewing}
                  onChange={e => setNewItem(p => ({ ...p, sewing: e.target.value }))} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#666' }}>발주단위</label>
                <input className="search-input" style={{ minWidth: 'auto', width: '100%' }} value={newItem.orderUnit}
                  onChange={e => setNewItem(p => ({ ...p, orderUnit: e.target.value }))} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#666' }}>FBC품목</label>
                <input className="search-input" style={{ minWidth: 'auto', width: '100%' }} value={newItem.fbcItem}
                  onChange={e => setNewItem(p => ({ ...p, fbcItem: e.target.value }))} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#666' }}>가격 협의</label>
                <input className="search-input" style={{ minWidth: 'auto', width: '100%' }} value={newItem.priceNote}
                  onChange={e => setNewItem(p => ({ ...p, priceNote: e.target.value }))} />
              </div>
              <div>
                <label style={{ fontSize: 11, color: '#666' }}>메모용</label>
                <input className="search-input" style={{ minWidth: 'auto', width: '100%' }} value={newItem.memo}
                  onChange={e => setNewItem(p => ({ ...p, memo: e.target.value }))} />
              </div>
              <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                <button className="btn btn-primary btn-sm" onClick={addLocalItem} style={{ width: '100%' }}>저장</button>
              </div>
            </div>
          </div>
        )}
        {localItems.length > 0 && (
          <div className="card-body" style={{ padding: 0 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>바코드</th><th>기타(1회성)</th><th>봉제</th><th>발주단위</th><th>FBC</th><th>가격</th><th>메모</th><th>등록일</th><th></th>
                </tr>
              </thead>
              <tbody>
                {localItems.map((item, i) => (
                  <tr key={i} style={{ background: syncAlerts.some(a => a.barcode === item.barcode) ? '#fff3e0' : '' }}>
                    <td style={{ fontSize: 11, fontFamily: 'monospace' }}>{item.barcode}</td>
                    <td style={{ fontSize: 11 }}>{item.oneTime || '-'}</td>
                    <td style={{ fontSize: 11 }}>{item.sewing || '-'}</td>
                    <td style={{ fontSize: 11 }}>{item.orderUnit || '-'}</td>
                    <td style={{ fontSize: 11 }}>{item.fbcItem || '-'}</td>
                    <td style={{ fontSize: 11 }}>{item.priceNote || '-'}</td>
                    <td style={{ fontSize: 11 }}>{item.memo || '-'}</td>
                    <td style={{ fontSize: 11, color: '#999' }}>{item.addedDate}</td>
                    <td><span style={{ fontSize: 10, color: '#d93025', cursor: 'pointer' }} onClick={() => deleteLocalItem(item.barcode)}>삭제</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className="filter-bar">
            <input
              className="search-input"
              placeholder="상품명, 바코드, CN비고 검색..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ maxWidth: 300 }}
            />
            <select
              className="filter-select"
              value={brandFilter}
              onChange={e => setBrandFilter(e.target.value)}
            >
              <option value="all">전체 브랜드</option>
              {brands.map(b => <option key={b} value={b}>{b}</option>)}
            </select>
            <button className="btn btn-outline" onClick={() => { setSearch(''); setBrandFilter('all'); }}>
              초기화
            </button>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#5f6368' }}>{filtered.length} / {data.length}개</span>
              <button className="btn btn-primary" onClick={fetchData} style={{ padding: '6px 12px', fontSize: 13 }}>
                🔄 새로고침
              </button>
              <button
                className="btn btn-outline"
                onClick={handleDownloadAllImages}
                disabled={imgDownloading || !Object.keys(imgCounts).length}
                style={{ padding: '6px 12px', fontSize: 13 }}
              >
                {imgDownloading ? '⏳ 다운로드 중...' : `📥 사진 다운로드 (${Object.keys(imgCounts).length})`}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="data-table supplies-table" style={{ tableLayout: 'fixed', width: '100%' }}>
              <colgroup>
                <col style={{ width: 36 }} />
                <col style={{ width: 130 }} />
                <col style={{ width: 300 }} />
                <col style={{ width: 90 }} />
                <col style={{ width: 350 }} />
                <col style={{ width: 150 }} />
                <col style={{ width: 40 }} />
                <col style={{ width: 40 }} />
                <col style={{ width: 180 }} />
                <col style={{ width: 250 }} />
                <col style={{ width: 250 }} />
                <col style={{ width: 60 }} />
              </colgroup>
              <thead>
                <tr>
                  <th>#</th>
                  <th onClick={() => handleSort('barcode')} className={sortKey === 'barcode' ? 'sorted' : ''}>
                    바코드<SortIcon col="barcode" />
                  </th>
                  <th onClick={() => handleSort('productName')} className={sortKey === 'productName' ? 'sorted' : ''}>
                    상품명<SortIcon col="productName" />
                  </th>
                  <th onClick={() => handleSort('optionName')} className={sortKey === 'optionName' ? 'sorted' : ''}>
                    옵션명<SortIcon col="optionName" />
                  </th>
                  <th onClick={() => handleSort('note')} className={sortKey === 'note' ? 'sorted' : ''}>
                    비고<SortIcon col="note" />
                  </th>
                  <th onClick={() => handleSort('orderUnit')} className={sortKey === 'orderUnit' ? 'sorted' : ''}>
                    발주단위<SortIcon col="orderUnit" />
                  </th>
                  <th onClick={() => handleSort('sewing')} className={sortKey === 'sewing' ? 'sorted' : ''}>
                    봉제<SortIcon col="sewing" />
                  </th>
                  <th onClick={() => handleSort('fbcItem')} className={sortKey === 'fbcItem' ? 'sorted' : ''}>
                    FBC<SortIcon col="fbcItem" />
                  </th>
                  <th onClick={() => handleSort('priceNote')} className={sortKey === 'priceNote' ? 'sorted' : ''}>
                    가격협의<SortIcon col="priceNote" />
                  </th>
                  <th onClick={() => handleSort('oneTime')} className={sortKey === 'oneTime' ? 'sorted' : ''}>
                    기타(1회성)<SortIcon col="oneTime" />
                  </th>
                  <th>메모</th>
                  <th>사진</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => {
                  const cellStyle = (col, maxW) => {
                    const key = `${r.id}-${col}`;
                    const isExpanded = expandedCell === key;
                    return {
                      fontSize: 12, maxWidth: maxW, cursor: 'pointer',
                      overflow: isExpanded ? 'visible' : 'hidden',
                      textOverflow: isExpanded ? 'unset' : 'ellipsis',
                      whiteSpace: isExpanded ? 'pre-wrap' : 'nowrap',
                      wordBreak: isExpanded ? 'break-all' : 'normal',
                    };
                  };
                  const toggle = (col) => {
                    const key = `${r.id}-${col}`;
                    setExpandedCell(prev => prev === key ? null : key);
                  };
                  return (
                    <tr key={r.id}>
                      <td className="num">{i + 1}</td>
                      <td style={{ fontSize: 11, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.barcode}</td>
                      <td style={{ fontSize: 12, whiteSpace: 'normal', wordBreak: 'break-word' }}>{r.productName || '-'}</td>
                      <td style={cellStyle('opt', 100)} onClick={() => toggle('opt')}>{r.optionName || '-'}</td>
                      <td style={cellStyle('note', 300)} onClick={() => toggle('note')}>{r.note || '-'}</td>
                      <td className="num" style={{ fontSize: 12 }}>{r.orderUnit || '-'}</td>
                      <td className="num" style={{ fontSize: 12 }}>{r.sewing || '-'}</td>
                      <td className="num" style={{ fontSize: 12 }}>{r.fbcItem || '-'}</td>
                      <td style={cellStyle('price', 90)} onClick={() => toggle('price')}>{r.priceNote || '-'}</td>
                      <td style={cellStyle('one', 140)} onClick={() => toggle('one')}>{r.oneTime || '-'}</td>
                      <td style={cellStyle('memo', 140)} onClick={() => toggle('memo')}>{r.memo || '-'}</td>
                      <td style={{ textAlign: 'center' }}>
                        <span
                          style={{ cursor: 'pointer', fontSize: 14, opacity: imgCounts[r.barcode] ? 1 : 0.4 }}
                          onClick={() => openImgModal(r.barcode, r.productName)}
                          title="사진 관리"
                        >
                          {imgCounts[r.barcode] ? `📷${imgCounts[r.barcode]}` : '📷'}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 이미지 모달 */}
      {imgModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.5)', zIndex: 9999,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }} onClick={() => setImgModal(null)}>
          <div style={{
            background: '#fff', borderRadius: 12, padding: 24, minWidth: 400, maxWidth: 600,
            maxHeight: '80vh', overflow: 'auto',
          }} onClick={e => e.stopPropagation()} onPaste={handleImgPaste} tabIndex={0}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 15 }}>상품 사진 관리</div>
                <div style={{ fontSize: 12, color: '#666', marginTop: 2 }}>
                  {imgModal.barcode} · {imgModal.productName || ''}
                </div>
              </div>
              <span style={{ cursor: 'pointer', fontSize: 20, color: '#999' }} onClick={() => setImgModal(null)}>✕</span>
            </div>

            {imgLoading ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#999' }}>불러오는 중...</div>
            ) : (
              <>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
                  {imgModalImages.map((src, idx) => (
                    <div key={idx} style={{ position: 'relative', border: '1px solid #e0e0e0', borderRadius: 8, overflow: 'hidden' }}>
                      <img src={src} alt={`사진 ${idx + 1}`} style={{ width: 160, height: 160, objectFit: 'cover', display: 'block' }} />
                      <span
                        onClick={() => handleImgDelete(idx)}
                        style={{
                          position: 'absolute', top: 4, right: 4,
                          background: 'rgba(0,0,0,0.6)', color: '#fff', borderRadius: '50%',
                          width: 22, height: 22, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          cursor: 'pointer', fontSize: 13,
                        }}
                      >✕</span>
                    </div>
                  ))}
                  {imgModalImages.length === 0 && (
                    <div style={{ color: '#999', fontSize: 13, padding: 20 }}>등록된 사진이 없습니다</div>
                  )}
                </div>

                {imgModalImages.length < 3 && (
                  <div>
                    <input
                      ref={fileInputRef}
                      type="file"
                      accept="image/*"
                      multiple
                      onChange={handleImgAdd}
                      style={{ display: 'none' }}
                    />
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={() => fileInputRef.current?.click()}
                      style={{ fontSize: 13 }}
                    >
                      + 사진 추가 ({imgModalImages.length}/3)
                    </button>
                  </div>
                )}
                {imgModalImages.length < 3 && (
                  <div style={{ fontSize: 11, color: '#aaa', marginTop: 8 }}>Ctrl+V로 클립보드 이미지 붙여넣기 가능</div>
                )}
                {imgModalImages.length >= 3 && (
                  <div style={{ fontSize: 12, color: '#999' }}>최대 3장까지 등록 가능합니다</div>
                )}
              </>
            )}
          </div>
        </div>
      )}
      </>}

      {/* 상품개선 탭 */}
      {activeTab === 'improvement' && (
        <ImprovementTab productList={data || []} />
      )}
    </div>
  );
}
