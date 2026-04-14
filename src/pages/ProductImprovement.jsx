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
const SUPPLY_TYPES = ['재수배', '업체문제'];
const IMPROVE_TYPES = ['상품문제', 'CSV·VOC'];

// 감시 목록: 등록 시 시트에 없던 바코드 (시트에 나타나면 알림)
const IMP_WATCH_KEY = 'imp_watch_barcodes';
const IMP_PENDING_ALERTS_KEY = 'imp_pending_sync_alerts';
function loadWatch() {
  try { return JSON.parse(localStorage.getItem(IMP_WATCH_KEY) || '[]'); } catch { return []; }
}
function saveWatch(list) {
  localStorage.setItem(IMP_WATCH_KEY, JSON.stringify(list));
}
function loadImpPendingAlerts() {
  try { return JSON.parse(localStorage.getItem(IMP_PENDING_ALERTS_KEY) || '[]'); } catch { return []; }
}
function saveImpPendingAlerts(alerts) {
  localStorage.setItem(IMP_PENDING_ALERTS_KEY, JSON.stringify(alerts));
}

export default function ProductImprovement() {
  // 특별관리 품목 목록 (자동완성용)
  const [productList, setProductList] = useState([]);
  const [productLoading, setProductLoading] = useState(true);
  const [syncAlerts, setSyncAlerts] = useState([]);

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

        // 상품개선 항목 중 특별관리 시트에 미등록인 바코드 감지
        const sheetBarcodes = new Set(results.map(r => r.barcode));
        const savedAlerts = loadImpPendingAlerts();
        setSyncAlerts(savedAlerts);
      } catch { /* 실패해도 수동 입력 가능 */ }
      setProductLoading(false);
    })();
  }, []);

  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [filterStatus, setFilterStatus] = useState('all');
  const [filterType, setFilterType] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [cardFilter, setCardFilter] = useState(null);

  const emptyForm = { status: '시작전', type: '재등록', productName: '', barcode: '', issue: '', startDate: new Date().toISOString().slice(0, 10), endDate: '', urls: ['', '', ''] };
  const [form, setForm] = useState(emptyForm);
  const [productSearch, setProductSearch] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [expandedId, setExpandedId] = useState(null);
  const [editingId, setEditingId] = useState(null);
  const [formImages, setFormImages] = useState([]);
  const formFileRef = useRef(null);

  const [timelineInput, setTimelineInput] = useState({});

  const [impImages, setImpImages] = useState({});
  const [impImgModal, setImpImgModal] = useState(null);
  const [impImgModalImages, setImpImgModalImages] = useState([]);
  const [impImgLoading, setImpImgLoading] = useState(false);
  const impFileRef = useRef(null);

  const [excelDownloading, setExcelDownloading] = useState(false);
  const [zipDownloading, setZipDownloading] = useState(false);

  // localStorage + DB 이중 저장 (DB 화이트리스트 등록 전까지 localStorage가 주 저장소)
  useEffect(() => {
    // localStorage에서 먼저 로드
    try {
      const localItems = JSON.parse(localStorage.getItem('improvement_items') || 'null');
      if (Array.isArray(localItems) && localItems.length > 0) setItems(localItems);
      const localImgs = JSON.parse(localStorage.getItem('improvement_images') || 'null');
      if (localImgs && typeof localImgs === 'object') setImpImages(localImgs);
    } catch { /* ignore */ }
    // DB에서도 시도 (성공하면 병합)
    Promise.all([
      dbStoreGet('improvement_items'),
      dbStoreGet('improvement_images'),
    ]).then(([dbItems, dbImgs]) => {
      if (Array.isArray(dbItems) && dbItems.length > 0) {
        // DB 데이터가 있으면 localStorage와 병합 (id 기준 중복 제거)
        setItems(prev => {
          const ids = new Set(prev.map(i => i.id));
          const merged = [...prev, ...dbItems.filter(i => !ids.has(i.id))];
          localStorage.setItem('improvement_items', JSON.stringify(merged));
          return merged;
        });
      }
      if (dbImgs && typeof dbImgs === 'object' && Object.keys(dbImgs).length > 0) {
        setImpImages(prev => {
          const merged = { ...prev, ...dbImgs };
          localStorage.setItem('improvement_images', JSON.stringify(merged));
          return merged;
        });
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
    setLoaded(true);
  }, []);

  // 감시 목록 바코드가 시트에 나타나면 알림 (적용완료 누를 때까지 영구 유지)
  useEffect(() => {
    if (!loaded || productLoading || productList.length === 0) return;
    const sheetBarcodes = new Set(productList.map(p => p.barcode));
    const watch = loadWatch();
    // 감시 목록 중 시트에 등록된 것 → 알림
    const newAlerts = watch.filter(w => sheetBarcodes.has(w.barcode));
    // 기존 영구 알림에 새로 감지된 것 추가
    const saved = loadImpPendingAlerts();
    const savedSet = new Set(saved.map(a => a.barcode));
    let updated = [...saved];
    for (const item of newAlerts) {
      if (!savedSet.has(item.barcode)) {
        updated.push({ ...item, detectedDate: new Date().toISOString().slice(0, 10) });
      }
    }
    saveImpPendingAlerts(updated);
    setSyncAlerts(updated);
  }, [loaded, productLoading, productList]);

  const dismissAlert = (barcode) => {
    // 적용완료: 영구 알림에서 제거 + 감시 목록에서도 제거
    const updatedAlerts = syncAlerts.filter(a => a.barcode !== barcode);
    saveImpPendingAlerts(updatedAlerts);
    setSyncAlerts(updatedAlerts);
    saveWatch(loadWatch().filter(w => w.barcode !== barcode));
  };

  const saveItems = useCallback((updated) => {
    setItems(updated);
    localStorage.setItem('improvement_items', JSON.stringify(updated));
    dbStoreSet('improvement_items', updated).catch(() => {});
  }, []);

  const saveImagesDb = useCallback((updated) => {
    setImpImages(updated);
    localStorage.setItem('improvement_images', JSON.stringify(updated));
    dbStoreSet('improvement_images', updated).catch(() => {});
  }, []);

  const suggestions = useMemo(() => {
    if (!productSearch || productSearch.length < 1) return [];
    const q = productSearch.toLowerCase();
    return productList.filter(p =>
      p.productName.toLowerCase().includes(q) || p.barcode.toLowerCase().includes(q)
    ).slice(0, 15);
  }, [productSearch, productList]);

  const filtered = useMemo(() => {
    let rows = items;
    if (cardFilter === 'supply_wait') rows = rows.filter(r => SUPPLY_TYPES.includes(r.type) && r.status === '시작전');
    else if (cardFilter === 'supply_ing') rows = rows.filter(r => SUPPLY_TYPES.includes(r.type) && r.status === '처리중');
    else if (cardFilter === 'improve_wait') rows = rows.filter(r => IMPROVE_TYPES.includes(r.type) && r.status === '시작전');
    else if (cardFilter === 'improve_ing') rows = rows.filter(r => IMPROVE_TYPES.includes(r.type) && r.status === '처리중');
    else if (cardFilter === 'done') rows = rows.filter(r => r.status === '완료');
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
  }, [items, cardFilter, filterStatus, filterType, searchQuery]);

  const handleAdd = async () => {
    if (!form.productName.trim() && !form.barcode.trim()) return;
    const itemId = Date.now().toString();
    const newItem = {
      ...form,
      id: itemId,
      urls: (form.urls || []).filter(u => u.trim()),
      timeline: form.issue ? [{ date: new Date().toISOString().slice(0, 16).replace('T', ' '), text: form.issue }] : [],
      createdAt: new Date().toISOString(),
    };
    saveItems([newItem, ...items]);

    // 바코드가 시트에 없으면 감시 목록에 추가
    if (newItem.barcode) {
      const sheetBarcodes = new Set(productList.map(p => p.barcode));
      if (!sheetBarcodes.has(newItem.barcode)) {
        const watch = loadWatch();
        if (!watch.some(w => w.barcode === newItem.barcode)) {
          saveWatch([...watch, { barcode: newItem.barcode, productName: newItem.productName, type: newItem.type }]);
        }
      }
    }

    if (formImages.length > 0) {
      const updated = { ...impImages, [itemId]: formImages };
      saveImagesDb(updated);
    }

    setForm(emptyForm);
    setFormImages([]);
    setProductSearch('');
    setShowForm(false);
  };

  const handleEdit = (item) => {
    setEditingId(item.id);
    setForm({
      status: item.status,
      type: item.type,
      productName: item.productName || '',
      barcode: item.barcode || '',
      issue: '',
      startDate: item.startDate || '',
      endDate: item.endDate || '',
      urls: [...(item.urls || []), '', '', ''].slice(0, 3),
    });
    setProductSearch(item.productName || '');
    setFormImages(impImages[item.id] || []);
    setShowForm(true);
  };

  const handleUpdate = async () => {
    if (!editingId) return;
    if (!form.productName.trim() && !form.barcode.trim()) return;
    const updated = items.map(i => {
      if (i.id !== editingId) return i;
      return {
        ...i,
        status: form.status,
        type: form.type,
        productName: form.productName,
        barcode: form.barcode,
        startDate: form.startDate,
        endDate: form.endDate,
        urls: (form.urls || []).filter(u => u.trim()),
      };
    });
    saveItems(updated);

    // 이미지 업데이트
    const updatedImg = { ...impImages };
    if (formImages.length > 0) {
      updatedImg[editingId] = formImages;
    } else {
      delete updatedImg[editingId];
    }
    saveImagesDb(updatedImg);

    setEditingId(null);
    setForm(emptyForm);
    setFormImages([]);
    setProductSearch('');
    setShowForm(false);
  };

  const handleFormImgAdd = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    const remaining = 5 - formImages.length;
    if (remaining <= 0) return;
    const toAdd = files.slice(0, remaining);
    const resized = await Promise.all(toAdd.map(f => resizeImage(f)));
    setFormImages(prev => [...prev, ...resized]);
    if (formFileRef.current) formFileRef.current.value = '';
  };

  const handleFormImgPaste = async (e) => {
    const pasteItems = Array.from(e.clipboardData?.items || []);
    const imageFiles = pasteItems.filter(i => i.type.startsWith('image/')).map(i => i.getAsFile()).filter(Boolean);
    if (!imageFiles.length) return;
    e.preventDefault();
    const remaining = 5 - formImages.length;
    if (remaining <= 0) return;
    const toAdd = imageFiles.slice(0, remaining);
    const resized = await Promise.all(toAdd.map(f => resizeImage(f)));
    setFormImages(prev => [...prev, ...resized]);
  };

  const handleDelete = (id) => {
    if (!confirm('삭제하시겠습니까?')) return;
    saveItems(items.filter(i => i.id !== id));
    const updatedImg = { ...impImages };
    delete updatedImg[id];
    saveImagesDb(updatedImg);
  };

  const handleStatusChange = (id, status) => {
    const updated = items.map(i => {
      if (i.id !== id) return i;
      const upd = { ...i, status };
      if (status === '완료' && !upd.endDate) upd.endDate = new Date().toISOString().slice(0, 10);
      return upd;
    });
    saveItems(updated);
  };

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

  const handleDeleteTimeline = (itemId, timelineIdx) => {
    const updated = items.map(i => {
      if (i.id !== itemId) return i;
      return { ...i, timeline: i.timeline.filter((_, idx) => idx !== timelineIdx) };
    });
    saveItems(updated);
  };

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

  const cardCounts = useMemo(() => {
    let supplyWait = 0, supplyIng = 0, improveWait = 0, improveIng = 0, done = 0;
    items.forEach(i => {
      if (i.status === '완료') { done++; return; }
      const isSupply = SUPPLY_TYPES.includes(i.type);
      const isImprove = IMPROVE_TYPES.includes(i.type);
      if (isSupply && i.status === '시작전') supplyWait++;
      else if (isSupply && i.status === '처리중') supplyIng++;
      else if (isImprove && i.status === '시작전') improveWait++;
      else if (isImprove && i.status === '처리중') improveIng++;
    });
    return { supplyWait, supplyIng, improveWait, improveIng, done };
  }, [items]);

  if (!loaded || productLoading) {
    return (
      <div className="loading" style={{ padding: 80, flexDirection: 'column', gap: 12 }}>
        <div className="spinner" />
        <p>상품개선 데이터를 불러오는 중...</p>
      </div>
    );
  }

  return (
    <div>
      {/* 특별관리 미등록 알림 */}
      {syncAlerts.length > 0 && (
        <div style={{ marginBottom: 16, background: '#fff3e0', border: '1px solid #ffb74d', borderRadius: 12, padding: 16 }}>
          <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 8, color: '#e65100' }}>
            📢 스프레드시트에 새로 등록된 상품이 있습니다 ({syncAlerts.length}건) — 확인 후 적용완료를 눌러주세요
          </div>
          {syncAlerts.map(item => (
            <div key={item.barcode} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', borderBottom: '1px solid #ffe0b2' }}>
              <span style={{ fontSize: 12, fontFamily: 'monospace', color: '#333' }}>{item.barcode}</span>
              <span style={{ fontSize: 12, color: '#666', flex: 1 }}>{item.productName}{item.type ? ` · ${item.type}` : ''}</span>
              <button className="btn btn-primary btn-sm" style={{ fontSize: 10, padding: '2px 8px' }} onClick={() => dismissAlert(item.barcode)}>
                적용 완료
              </button>
            </div>
          ))}
        </div>
      )}

      {/* 요약 카드 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 16 }}>
        {[
          { key: null, label: '전체', sub: `${productList.length}품목`, count: items.length, color: '#1a73e8' },
          { key: 'supply_wait', label: '수배 대기', sub: '재수배·업체문제', count: cardCounts.supplyWait, color: '#6a1b9a' },
          { key: 'supply_ing', label: '수배 진행중', sub: '재수배·업체문제', count: cardCounts.supplyIng, color: '#ab47bc' },
          { key: 'improve_wait', label: '개선 대기', sub: '상품문제·CS/VOC', count: cardCounts.improveWait, color: '#e65100' },
          { key: 'improve_ing', label: '개선 진행중', sub: '상품문제·CS/VOC', count: cardCounts.improveIng, color: '#fb8c00' },
          { key: 'done', label: '완료', sub: '전체', count: cardCounts.done, color: '#43a047' },
        ].map(c => (
          <div key={c.key ?? 'all'} onClick={() => setCardFilter(prev => prev === c.key ? null : c.key)}
            style={{
              background: '#fff', border: '1px solid #e0e0e0', borderRadius: 10, padding: '12px 10px', textAlign: 'center',
              cursor: 'pointer', transition: 'all 0.15s',
              outline: cardFilter === c.key ? `2px solid ${c.color}` : 'none',
            }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: c.color }}>{c.count}</div>
            <div style={{ fontSize: 12, fontWeight: 600, color: '#333', marginTop: 2 }}>{c.label}</div>
            <div style={{ fontSize: 10, color: '#999', marginTop: 1 }}>{c.sub}</div>
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
            <button className="btn btn-outline" onClick={() => { setSearchQuery(''); setFilterStatus('all'); setFilterType('all'); setCardFilter(null); }}>초기화</button>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
              <button className="btn btn-outline" onClick={handleExcelDownload} disabled={excelDownloading || !items.length} style={{ fontSize: 13 }}>
                {excelDownloading ? '다운로드 중...' : `엑셀 다운로드 (${items.length})`}
              </button>
              <button className="btn btn-outline" onClick={handlePhotoZipDownload} disabled={zipDownloading || imgCount === 0} style={{ fontSize: 13 }}>
                {zipDownloading ? '다운로드 중...' : `사진 다운로드 (${imgCount})`}
              </button>
              <button className="btn btn-primary" onClick={() => { setShowForm(!showForm); setForm(emptyForm); setProductSearch(''); setEditingId(null); setFormImages([]); }}>
                {showForm ? '닫기' : '+ 새 항목'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 신규 등록 폼 */}
      {showForm && (
        <div className="card" style={{ marginBottom: 16, border: `2px solid ${editingId ? '#fb8c00' : '#1a73e8'}` }}>
          <div className="card-header"><h2 style={{ fontSize: 14, fontWeight: 600 }}>{editingId ? '상품개선 항목 수정' : '새 상품개선 항목 등록'}</h2></div>
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
            {!editingId && (
              <div style={{ marginBottom: 12 }}>
                <label style={{ fontSize: 11, color: '#666', display: 'block', marginBottom: 4 }}>초기 이슈 내용</label>
                <textarea className="search-input" value={form.issue} onChange={e => setForm(p => ({ ...p, issue: e.target.value }))}
                  placeholder="이슈 내용을 입력하세요..." rows={3}
                  style={{ width: '100%', minWidth: 'auto', resize: 'vertical', fontFamily: 'inherit', lineHeight: 1.5 }} />
              </div>
            )}
            <div style={{ marginBottom: 12 }}>
              <label style={{ fontSize: 11, color: '#666', display: 'block', marginBottom: 4 }}>참고 URL (최대 3개)</label>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {(form.urls || ['', '', '']).map((url, idx) => (
                  <input key={idx} className="search-input" value={url} placeholder={`URL ${idx + 1}`}
                    onChange={e => { const u = [...(form.urls || ['', '', ''])]; u[idx] = e.target.value; setForm(p => ({ ...p, urls: u })); }}
                    style={{ width: '100%', minWidth: 'auto', fontSize: 12 }} />
                ))}
              </div>
            </div>
            <div style={{ marginBottom: 12 }} onPaste={handleFormImgPaste}>
              <label style={{ fontSize: 11, color: '#666', display: 'block', marginBottom: 4 }}>첨부 사진 (최대 5장)</label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                {formImages.map((src, idx) => (
                  <div key={idx} style={{ position: 'relative', border: '1px solid #e0e0e0', borderRadius: 6, overflow: 'hidden' }}>
                    <img src={src} alt={`첨부 ${idx + 1}`} style={{ width: 80, height: 80, objectFit: 'cover', display: 'block' }} />
                    <span onClick={() => setFormImages(prev => prev.filter((_, i) => i !== idx))}
                      style={{ position: 'absolute', top: 2, right: 2, background: 'rgba(0,0,0,0.6)', color: '#fff', borderRadius: '50%', width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 11 }}>✕</span>
                  </div>
                ))}
                {formImages.length < 5 && (
                  <div>
                    <input ref={formFileRef} type="file" accept="image/*" multiple onChange={handleFormImgAdd} style={{ display: 'none' }} />
                    <button type="button" className="btn btn-outline btn-sm" onClick={() => formFileRef.current?.click()} style={{ fontSize: 11, padding: '4px 10px' }}>
                      + 사진 ({formImages.length}/5)
                    </button>
                  </div>
                )}
              </div>
              {formImages.length < 5 && <div style={{ fontSize: 10, color: '#aaa', marginTop: 4 }}>이 영역에서 Ctrl+V로 붙여넣기 가능</div>}
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline" onClick={() => { setShowForm(false); setForm(emptyForm); setFormImages([]); setProductSearch(''); setEditingId(null); }}>취소</button>
              <button className="btn btn-primary" onClick={editingId ? handleUpdate : handleAdd} disabled={!form.productName.trim() && !form.barcode.trim()}>{editingId ? '수정 완료' : '등록'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 항목 리스트 */}
      {filtered.length === 0 ? (
        <div className="card">
          <div className="card-body" style={{ textAlign: 'center', padding: 48, color: '#999' }}>
            {items.length === 0 ? '등록된 상품개선 항목이 없습니다. [+ 새 항목] 버튼으로 추가하세요.' : '필터 조건에 맞는 항목이 없습니다.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((item) => {
            const imgArr = impImages[item.id] || [];
            const isOpen = expandedId === item.id;
            return (
              <div key={item.id} className="card" style={{ borderLeft: `4px solid ${STATUS_COLORS[item.status]}` }}>
                {/* 접힌 헤더 - 항상 표시 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', cursor: 'pointer', flexWrap: 'wrap' }}
                  onClick={() => setExpandedId(prev => prev === item.id ? null : item.id)}>
                  <span style={{ fontSize: 14, color: '#999', transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>&#9654;</span>
                  <select value={item.status} onChange={e => { e.stopPropagation(); handleStatusChange(item.id, e.target.value); }}
                    onClick={e => e.stopPropagation()}
                    style={{ padding: '2px 6px', fontSize: 11, fontWeight: 600, border: `2px solid ${STATUS_COLORS[item.status]}`, borderRadius: 5, color: STATUS_COLORS[item.status], background: '#fff', cursor: 'pointer' }}>
                    {IMP_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <span style={{ padding: '2px 8px', fontSize: 10, fontWeight: 600, borderRadius: 10, color: '#fff', background: TYPE_COLORS[item.type] || '#666' }}>{item.type}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>{item.productName || '-'}</span>
                  <span style={{ fontSize: 11, color: '#999' }}>{item.startDate}</span>
                  {(item.timeline || []).length > 0 && <span style={{ fontSize: 10, color: '#aaa', background: '#f0f0f0', padding: '1px 6px', borderRadius: 8 }}>{item.timeline.length}건</span>}
                  {imgArr.length > 0 && <span style={{ fontSize: 12 }}>📷{imgArr.length}</span>}
                  {(item.urls || []).length > 0 && <span style={{ fontSize: 12 }}>🔗{item.urls.length}</span>}
                </div>

                {/* 펼친 상세 */}
                {isOpen && (
                  <div className="card-body" style={{ padding: '0 16px 16px', borderTop: '1px solid #f0f0f0' }}>
                    {/* 상세 정보 */}
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 0', flexWrap: 'wrap' }}>
                      {item.barcode && <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#888', background: '#f5f5f5', padding: '2px 8px', borderRadius: 4 }}>{item.barcode}</span>}
                      {item.endDate && <span style={{ fontSize: 11, color: '#999' }}>종료: {item.endDate}</span>}
                      <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                        <button className="btn btn-outline btn-sm" onClick={() => openImpImgModal(item.id)} style={{ fontSize: 11, padding: '3px 10px' }}>
                          📷 사진 ({imgArr.length}/5)
                        </button>
                        <span style={{ cursor: 'pointer', fontSize: 13, color: '#1a73e8', padding: '3px 6px' }} onClick={() => handleEdit(item)} title="수정">수정</span>
                        <span style={{ cursor: 'pointer', fontSize: 13, color: '#d93025', padding: '3px 6px' }} onClick={() => handleDelete(item.id)} title="삭제">삭제</span>
                      </div>
                    </div>

                    {/* URL 목록 */}
                    {(item.urls || []).length > 0 && (
                      <div style={{ marginBottom: 12 }}>
                        {item.urls.map((url, idx) => (
                          <div key={idx} style={{ fontSize: 12, marginBottom: 2 }}>
                            <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: '#1a73e8', wordBreak: 'break-all' }}>{url}</a>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* 타임라인 */}
                    <div style={{ marginLeft: 8, borderLeft: '2px solid #e0e0e0', paddingLeft: 16 }}>
                      {(item.timeline || []).map((entry, tIdx) => (
                        <div key={tIdx} style={{ position: 'relative', marginBottom: 10 }}>
                          <div style={{ position: 'absolute', left: -22, top: 4, width: 10, height: 10, borderRadius: '50%', background: tIdx === (item.timeline.length - 1) ? '#1a73e8' : '#bdbdbd' }} />
                          <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                            <span style={{ fontSize: 11, color: '#999', whiteSpace: 'nowrap', minWidth: 100 }}>{entry.date}</span>
                            <span style={{ fontSize: 13, color: '#333', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>{entry.text}</span>
                            <span style={{ fontSize: 11, color: '#ccc', cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => handleDeleteTimeline(item.id, tIdx)}>삭제</span>
                          </div>
                        </div>
                      ))}
                      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', position: 'relative' }}>
                        <div style={{ position: 'absolute', left: -22, top: 8, width: 10, height: 10, borderRadius: '50%', border: '2px solid #bdbdbd', background: '#fff' }} />
                        <textarea className="search-input" placeholder="진행 상황 추가..."
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
