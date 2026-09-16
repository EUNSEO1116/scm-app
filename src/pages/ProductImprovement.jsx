import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';
import { syncImprovementFromSheet } from '../utils/improvementSync';
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

const URL_RE = /(https?:\/\/[^\s]+)/g;

// 문자열 안의 URL을 클릭 링크로 렌더
function linkify(text) {
  const parts = String(text).split(URL_RE);
  return parts.map((part, i) => {
    if (URL_RE.test(part)) {
      URL_RE.lastIndex = 0;
      return <a key={i} href={part} target="_blank" rel="noopener noreferrer" style={{ color: '#1a73e8', wordBreak: 'break-all' }}>{part}</a>;
    }
    return <span key={i}>{part}</span>;
  });
}

// 적용중(I) 또는 뷰어에서 선택한 업체 블록 반환
function pickVendor(item, selectedName) {
  if (!Array.isArray(item.vendors) || item.vendors.length === 0) return null;
  const name = selectedName || item.appliedVendor;
  return item.vendors.find(v => v.name === name) || item.vendors[0];
}

// 감시 목록: 등록 시 시트에 없던 바코드 (시트에 나타나면 알림)
const IMP_WATCH_KEY = 'imp_watch_barcodes';
const IMP_PENDING_ALERTS_KEY = 'imp_pending_sync_alerts';
function loadWatch() {
  try { return JSON.parse(localStorage.getItem(IMP_WATCH_KEY) || '[]'); } catch { return []; }
}
async function loadWatchFromDB() {
  try {
    const dbData = await dbStoreGet('imp_watch_barcodes');
    if (dbData && Array.isArray(dbData)) {
      localStorage.setItem(IMP_WATCH_KEY, JSON.stringify(dbData));
      return dbData;
    }
  } catch {}
  return loadWatch();
}
function saveWatch(list) {
  localStorage.setItem(IMP_WATCH_KEY, JSON.stringify(list));
  dbStoreSet('imp_watch_barcodes', list).catch(() => {});
}
function loadImpPendingAlerts() {
  try { return JSON.parse(localStorage.getItem(IMP_PENDING_ALERTS_KEY) || '[]'); } catch { return []; }
}
async function loadImpPendingAlertsFromDB() {
  try {
    const dbData = await dbStoreGet('imp_pending_sync_alerts');
    if (dbData && Array.isArray(dbData)) {
      localStorage.setItem(IMP_PENDING_ALERTS_KEY, JSON.stringify(dbData));
      return dbData;
    }
  } catch {}
  return loadImpPendingAlerts();
}
function saveImpPendingAlerts(alerts) {
  localStorage.setItem(IMP_PENDING_ALERTS_KEY, JSON.stringify(alerts));
  dbStoreSet('imp_pending_sync_alerts', alerts).catch(() => {});
}

export default function ProductImprovement() {
  // 특별관리 품목 목록 (알림 비교용)
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
        const savedAlerts = await loadImpPendingAlertsFromDB();
        setSyncAlerts(savedAlerts);
      } catch { /* 실패해도 목록만 없을 뿐 */ }
      setProductLoading(false);
    })();
  }, []);

  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [filterStatus, setFilterStatus] = useState('active');
  const [filterType, setFilterType] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [cardFilter, setCardFilter] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const [vendorView, setVendorView] = useState({}); // itemId → 선택 업체명(뷰어)

  const [impImages, setImpImages] = useState({});
  const [impImgModal, setImpImgModal] = useState(null);
  const [impImgModalImages, setImpImgModalImages] = useState([]);
  const [impImgLoading, setImpImgLoading] = useState(false);
  const impFileRef = useRef(null);

  const [excelDownloading, setExcelDownloading] = useState(false);
  const [zipDownloading, setZipDownloading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState('');

  const [dbSyncFailed, setDbSyncFailed] = useState(false);

  // localStorage + DB 이중 로드
  useEffect(() => {
    let localItems = null;
    let localImgs = null;
    try {
      localItems = JSON.parse(localStorage.getItem('improvement_items') || 'null');
      if (Array.isArray(localItems) && localItems.length > 0) setItems(localItems);
      localImgs = JSON.parse(localStorage.getItem('improvement_images') || 'null');
      if (localImgs && typeof localImgs === 'object') setImpImages(localImgs);
    } catch { /* ignore */ }
    Promise.all([
      dbStoreGet('improvement_items'),
      dbStoreGet('improvement_images'),
      dbStoreGet('imp_img_migrated'),
    ]).then(async ([dbItems, legacyImgs, migrated]) => {
      let finalItems = [];
      if (Array.isArray(dbItems) && Array.isArray(localItems)) {
        if (localItems.length > dbItems.length) {
          finalItems = localItems;
          setItems(localItems);
          dbStoreSet('improvement_items', localItems, { skipLog: true });
        } else {
          finalItems = dbItems;
          setItems(dbItems);
          localStorage.setItem('improvement_items', JSON.stringify(dbItems));
        }
      } else if (Array.isArray(dbItems)) {
        finalItems = dbItems;
        setItems(dbItems);
        localStorage.setItem('improvement_items', JSON.stringify(dbItems));
      } else if (Array.isArray(localItems) && localItems.length > 0) {
        finalItems = localItems;
        dbStoreSet('improvement_items', localItems, { skipLog: true });
      }

      setLoaded(true);

      // 이미지: 항목별 개별 저장소에서 백그라운드 재구성
      (async () => {
        const hasLegacy = legacyImgs && typeof legacyImgs === 'object' && Object.keys(legacyImgs).length > 0;
        if (!migrated && hasLegacy) {
          await Promise.all(Object.entries(legacyImgs).map(([id, imgs]) =>
            (Array.isArray(imgs) && imgs.length > 0) ? dbStoreSet(`imp_img_${id}`, imgs, { skipLog: true }) : null
          ));
          dbStoreSet('imp_img_migrated', true, { skipLog: true });
        }
        const ids = finalItems.map(i => i.id).filter(Boolean);
        const entries = await Promise.all(ids.map(async (id) => {
          try { const imgs = await dbStoreGet(`imp_img_${id}`); return [id, Array.isArray(imgs) ? imgs : []]; }
          catch { return [id, []]; }
        }));
        const map = {};
        entries.forEach(([id, imgs]) => { if (imgs.length > 0) map[id] = imgs; });
        const dbHadAny = entries.some(([, imgs]) => imgs.length > 0);
        if (!dbHadAny && localImgs && typeof localImgs === 'object' && Object.keys(localImgs).length > 0) {
          Object.entries(localImgs).forEach(([id, imgs]) => {
            if (Array.isArray(imgs) && imgs.length > 0) map[id] = imgs;
          });
        }
        setImpImages(map);
        localStorage.setItem('improvement_images', JSON.stringify(map));
      })();
    }).catch(() => setLoaded(true));
  }, []);

  // 감시 목록 바코드가 시트에 나타나면 알림 (적용완료 누를 때까지 영구 유지)
  useEffect(() => {
    if (!loaded || productLoading || productList.length === 0) return;
    (async () => {
      const sheetBarcodes = new Set(productList.map(p => p.barcode));
      const watch = await loadWatchFromDB();
      const newAlerts = watch.filter(w => sheetBarcodes.has(w.barcode));
      const saved = await loadImpPendingAlertsFromDB();
      const savedSet = new Set(saved.map(a => a.barcode));
      let updated = [...saved];
      for (const item of newAlerts) {
        if (!savedSet.has(item.barcode)) {
          updated.push({ ...item, detectedDate: new Date().toISOString().slice(0, 10) });
        }
      }
      saveImpPendingAlerts(updated);
      setSyncAlerts(updated);
    })();
  }, [loaded, productLoading, productList]);

  const dismissAlert = (barcode) => {
    const updatedAlerts = syncAlerts.filter(a => a.barcode !== barcode);
    saveImpPendingAlerts(updatedAlerts);
    setSyncAlerts(updatedAlerts);
    saveWatch(loadWatch().filter(w => w.barcode !== barcode));
  };

  const dbSaveWithRetry = useCallback(async (key, data, opts) => {
    for (let i = 0; i < 3; i++) {
      const ok = await dbStoreSet(key, data, opts);
      if (ok) { setDbSyncFailed(false); return true; }
      await new Promise(r => setTimeout(r, 1000));
    }
    setDbSyncFailed(true);
    return false;
  }, []);

  // 항목별 개별 저장 (4.5MB 단일 블롭 한도 회피)
  const persistImpImages = useCallback((itemId, images, fullMap, logDesc) => {
    setImpImages(fullMap);
    localStorage.setItem('improvement_images', JSON.stringify(fullMap));
    dbSaveWithRetry(`imp_img_${itemId}`, images || [], { logDesc: logDesc || '상품개선 이미지 수정' });
  }, [dbSaveWithRetry]);

  const dbSaveAllImpImages = useCallback((map) => {
    Object.entries(map || {}).forEach(([id, imgs]) => {
      if (Array.isArray(imgs) && imgs.length > 0) dbSaveWithRetry(`imp_img_${id}`, imgs, { skipLog: true });
    });
  }, [dbSaveWithRetry]);

  // 시트에서 수동 업데이트
  const handleSync = async () => {
    if (syncing) return;
    setSyncing(true);
    setSyncMsg('');
    try {
      const result = await syncImprovementFromSheet({ logDesc: '상품개선 시트 동기화 (수동)' });
      if (Array.isArray(result.items)) {
        setItems(result.items);
        // 새 항목의 이미지 재구성
        const ids = result.items.map(i => i.id).filter(Boolean);
        const entries = await Promise.all(ids.map(async (id) => {
          try { const imgs = await dbStoreGet(`imp_img_${id}`); return [id, Array.isArray(imgs) ? imgs : []]; }
          catch { return [id, []]; }
        }));
        const map = {};
        entries.forEach(([id, imgs]) => { if (imgs.length > 0) map[id] = imgs; });
        setImpImages(map);
        localStorage.setItem('improvement_images', JSON.stringify(map));
      }
      setSyncMsg(result.ok ? `동기화 완료 · 시트 ${result.count}건 반영` : `시트 ${result.count}건 읽음 (DB 저장 실패 — 재시도 필요)`);
    } catch (e) {
      console.error('상품개선 동기화 실패:', e);
      setSyncMsg('동기화 실패 — 시트를 읽는 중 오류가 발생했습니다.');
    }
    setSyncing(false);
  };

  const filtered = useMemo(() => {
    let rows = items;
    if (cardFilter === 'supply_wait') rows = rows.filter(r => SUPPLY_TYPES.includes(r.type) && r.status === '시작전');
    else if (cardFilter === 'supply_ing') rows = rows.filter(r => SUPPLY_TYPES.includes(r.type) && r.status === '처리중');
    else if (cardFilter === 'improve_wait') rows = rows.filter(r => IMPROVE_TYPES.includes(r.type) && r.status === '시작전');
    else if (cardFilter === 'improve_ing') rows = rows.filter(r => IMPROVE_TYPES.includes(r.type) && r.status === '처리중');
    else if (cardFilter === 'done') rows = rows.filter(r => r.status === '완료');
    if (filterStatus === 'active') rows = rows.filter(r => r.status !== '완료');
    else if (filterStatus !== 'all') rows = rows.filter(r => r.status === filterStatus);
    if (filterType !== 'all') rows = rows.filter(r => r.type === filterType);
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter(r =>
        (r.productName || '').toLowerCase().includes(q) ||
        (r.barcode || '').toLowerCase().includes(q) ||
        (r.optionName || '').toLowerCase().includes(q)
      );
    }
    return rows;
  }, [items, cardFilter, filterStatus, filterType, searchQuery]);

  const openImpImgModal = async (itemId) => {
    setImpImgModal(itemId);
    setImpImgLoading(true);
    const fallback = Array.isArray(impImages[itemId]) ? impImages[itemId] : [];
    try {
      const imgs = await dbStoreGet(`imp_img_${itemId}`);
      setImpImgModalImages(Array.isArray(imgs) ? imgs : fallback);
    } catch { setImpImgModalImages(fallback); }
    setImpImgLoading(false);
  };

  const saveImpImages = async (itemId, images) => {
    setImpImgModalImages(images);
    let allData = { ...impImages };
    if (images.length > 0) { allData[itemId] = images; } else { delete allData[itemId]; }
    persistImpImages(itemId, images, allData);
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
      const rows = items.map((item, i) => {
        let progress;
        if (item.source === 'sheet') {
          const v = pickVendor(item, vendorView[item.id]);
          progress = v?.issue || '';
        } else {
          progress = (item.timeline || []).map(t => `[${t.date}] ${t.text}`).join('\n');
        }
        return {
          '번호': i + 1,
          '상태': item.status,
          '유형': item.type,
          '상품명': item.productName,
          '옵션명': item.optionName || '',
          '바코드': item.barcode,
          '진행상황': progress,
          '첨부파일수': (impImages[item.id] || []).length,
        };
      });
      const ws = XLSX.utils.json_to_sheet(rows);
      ws['!cols'] = [
        { wch: 5 }, { wch: 8 }, { wch: 10 }, { wch: 30 }, { wch: 18 },
        { wch: 16 }, { wch: 60 }, { wch: 10 },
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
      const allImg = impImages;
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
      <div style={{ textAlign: 'center', fontSize: 10, color: '#bbb', letterSpacing: '0.3px', marginBottom: 12, lineHeight: 1 }}>
        입력은 상품개선 스프레드시트에서 · 이 화면은 뷰어(읽기전용) / 유형·상태·바코드·상품명만 연동에 사용
      </div>
      {/* DB 저장 실패 알림 */}
      {dbSyncFailed && (
        <div style={{ marginBottom: 16, background: '#ffebee', border: '1px solid #ef5350', borderRadius: 12, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: '#c62828' }}>
            DB 저장 실패 — 현재 로컬에만 저장됨. 다른 컴퓨터에서 보이지 않을 수 있습니다.
          </span>
          <button className="btn btn-sm" style={{ fontSize: 12, background: '#c62828', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px' }}
            onClick={() => { dbSaveWithRetry('improvement_items', items); dbSaveAllImpImages(impImages); }}>
            재시도
          </button>
        </div>
      )}
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
            <input className="search-input" placeholder="상품명, 바코드, 옵션 검색..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} style={{ maxWidth: 240 }} />
            <select className="filter-select" value={filterType} onChange={e => setFilterType(e.target.value)}>
              <option value="all">전체 유형</option>
              {IMP_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <select className="filter-select" value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="active">진행중 (시작전+처리중)</option>
              <option value="all">전체 상태</option>
              {IMP_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <button className="btn btn-outline" onClick={() => { setSearchQuery(''); setFilterStatus('active'); setFilterType('all'); setCardFilter(null); }}>초기화</button>
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 8, alignItems: 'center' }}>
              {syncMsg && <span style={{ fontSize: 12, color: '#1a73e8' }}>{syncMsg}</span>}
              <button className="btn btn-outline" onClick={handleExcelDownload} disabled={excelDownloading || !items.length} style={{ fontSize: 13 }}>
                {excelDownloading ? '다운로드 중...' : `엑셀 다운로드 (${items.length})`}
              </button>
              <button className="btn btn-outline" onClick={handlePhotoZipDownload} disabled={zipDownloading || imgCount === 0} style={{ fontSize: 13 }}>
                {zipDownloading ? '다운로드 중...' : `사진 다운로드 (${imgCount})`}
              </button>
              <button className="btn btn-primary" onClick={handleSync} disabled={syncing} style={{ fontSize: 13 }}>
                {syncing ? '동기화 중...' : '🔄 시트에서 업데이트'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 항목 리스트 */}
      {filtered.length === 0 ? (
        <div className="card">
          <div className="card-body" style={{ textAlign: 'center', padding: 48, color: '#999' }}>
            {items.length === 0 ? '상품개선 항목이 없습니다. 시트에 유형·상태를 입력한 뒤 [🔄 시트에서 업데이트]를 누르세요.' : '필터 조건에 맞는 항목이 없습니다.'}
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {filtered.map((item) => {
            const imgArr = impImages[item.id] || [];
            const isOpen = expandedId === item.id;
            const isSheet = item.source === 'sheet';
            const vendors = Array.isArray(item.vendors) ? item.vendors : [];
            const selName = vendorView[item.id] || item.appliedVendor || (vendors[0] && vendors[0].name);
            const selVendor = pickVendor(item, selName);
            const timelineLines = isSheet && selVendor && selVendor.issue
              ? selVendor.issue.split('\n').map(s => s.trim()).filter(Boolean)
              : [];
            return (
              <div key={item.id} className="card" style={{ borderLeft: `4px solid ${STATUS_COLORS[item.status] || '#ccc'}` }}>
                {/* 접힌 헤더 */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', cursor: 'pointer', flexWrap: 'wrap' }}
                  onClick={() => setExpandedId(prev => prev === item.id ? null : item.id)}>
                  <span style={{ fontSize: 14, color: '#999', transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)' }}>&#9654;</span>
                  <span style={{ padding: '2px 8px', fontSize: 11, fontWeight: 600, border: `2px solid ${STATUS_COLORS[item.status] || '#ccc'}`, borderRadius: 5, color: STATUS_COLORS[item.status] || '#666', background: '#fff' }}>{item.status}</span>
                  <span style={{ padding: '2px 8px', fontSize: 10, fontWeight: 600, borderRadius: 10, color: '#fff', background: TYPE_COLORS[item.type] || '#666' }}>{item.type}</span>
                  <span style={{ fontSize: 14, fontWeight: 600, flex: 1 }}>
                    {item.productName || '-'}
                    {item.optionName && <span style={{ fontSize: 12, color: '#999', fontWeight: 400 }}> · {item.optionName}</span>}
                  </span>
                  {isSheet && vendors.length > 0 && <span style={{ fontSize: 10, color: '#aaa', background: '#f0f0f0', padding: '1px 6px', borderRadius: 8 }}>🏭 {vendors.length}곳</span>}
                  {!isSheet && (item.timeline || []).length > 0 && <span style={{ fontSize: 10, color: '#aaa', background: '#f0f0f0', padding: '1px 6px', borderRadius: 8 }}>{item.timeline.length}건</span>}
                  {imgArr.length > 0 && <span style={{ fontSize: 12 }}>📷{imgArr.length}</span>}
                </div>

                {/* 펼친 상세 */}
                {isOpen && (
                  <div className="card-body" style={{ padding: '0 16px 16px', borderTop: '1px solid #f0f0f0' }}>
                    <div style={{ display: 'flex', gap: 12, alignItems: 'center', padding: '10px 0', flexWrap: 'wrap' }}>
                      {item.barcode && <span style={{ fontSize: 11, fontFamily: 'monospace', color: '#888', background: '#f5f5f5', padding: '2px 8px', borderRadius: 4 }}>{item.barcode}</span>}
                      {item.cost && <span style={{ fontSize: 11, color: '#999' }}>원가 {item.cost}</span>}
                      {item.sellStatus && <span style={{ fontSize: 11, color: '#999' }}>판매: {item.sellStatus}</span>}
                      <div style={{ marginLeft: 'auto' }}>
                        <button className="btn btn-outline btn-sm" onClick={() => openImpImgModal(item.id)} style={{ fontSize: 11, padding: '3px 10px' }}>
                          📷 사진 ({imgArr.length}/5)
                        </button>
                      </div>
                    </div>

                    {item.commonIssue && (
                      <div style={{ marginBottom: 12, fontSize: 12, color: '#e65100', background: '#fff8f0', border: '1px solid #ffe0b2', borderRadius: 6, padding: '8px 12px' }}>
                        💬 공통이슈: {linkify(item.commonIssue)}
                      </div>
                    )}

                    {isSheet ? (
                      <>
                        {/* 수배처 뷰어 탭 */}
                        {vendors.length > 0 && (
                          <>
                            <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
                              {vendors.map(v => {
                                const active = v.name === selName;
                                const applied = v.name === item.appliedVendor;
                                return (
                                  <button key={v.name}
                                    onClick={() => setVendorView(prev => ({ ...prev, [item.id]: v.name }))}
                                    style={{
                                      fontSize: 11, fontWeight: 600, padding: '4px 10px', borderRadius: 6, cursor: 'pointer',
                                      border: `1px solid ${active ? '#43a047' : '#ddd'}`,
                                      background: active ? '#e8f5e9' : '#fff',
                                      color: active ? '#2e7d32' : '#666',
                                    }}>
                                    {v.name}{applied ? ' ✅적용중' : ''}
                                  </button>
                                );
                              })}
                            </div>

                            {/* 선택 업체 블록 */}
                            {selVendor && (
                              <div style={{ border: `1px solid ${selVendor.name === item.appliedVendor ? '#a5d6a7' : '#e0e0e0'}`, borderRadius: 8, padding: '10px 14px', marginBottom: 12, background: '#fafafa' }}>
                                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6, flexWrap: 'wrap' }}>
                                  <span style={{ fontSize: 12, fontWeight: 700 }}>{selVendor.name}{selVendor.name === item.appliedVendor ? ' ✅적용중' : ''}</span>
                                  {selVendor.leadTime && <span style={{ fontSize: 11, color: '#555', background: '#eef', padding: '1px 8px', borderRadius: 8 }}>리드타임 {selVendor.leadTime}일</span>}
                                  {selVendor.url && <a href={selVendor.url} target="_blank" rel="noopener noreferrer" style={{ fontSize: 11, color: '#1a73e8' }}>🔗 1688 소싱링크</a>}
                                </div>
                                {(selVendor.opt1 || selVendor.opt2) && (
                                  <div style={{ fontSize: 12, color: '#333', marginBottom: 4, whiteSpace: 'pre-wrap' }}>
                                    <span style={{ color: '#999' }}>옵션: </span>{[selVendor.opt1, selVendor.opt2].filter(Boolean).join('  |  ')}
                                  </div>
                                )}
                                {selVendor.note && (
                                  <div style={{ fontSize: 12, color: '#333', whiteSpace: 'pre-wrap' }}>
                                    <span style={{ color: '#999' }}>📝 비고: </span>{selVendor.note}
                                  </div>
                                )}
                              </div>
                            )}
                          </>
                        )}

                        {/* 진행상황 타임라인 (선택 업체 이슈열) */}
                        <div style={{ marginLeft: 8, borderLeft: '2px solid #e0e0e0', paddingLeft: 16 }}>
                          <div style={{ fontSize: 11, color: '#999', marginBottom: 8 }}>진행상황 {selVendor ? `(${selVendor.name})` : ''}</div>
                          {timelineLines.length > 0 ? timelineLines.map((line, idx) => (
                            <div key={idx} style={{ position: 'relative', marginBottom: 10 }}>
                              <div style={{ position: 'absolute', left: -22, top: 4, width: 10, height: 10, borderRadius: '50%', background: idx === (timelineLines.length - 1) ? '#1a73e8' : '#bdbdbd' }} />
                              <span style={{ fontSize: 13, color: '#333', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{linkify(line)}</span>
                            </div>
                          )) : (
                            <div style={{ fontSize: 12, color: '#bbb' }}>기록된 진행상황이 없습니다.</div>
                          )}
                        </div>
                      </>
                    ) : (
                      /* 레거시(수기) 항목 — 읽기전용 */
                      <>
                        {(item.urls || []).length > 0 && (
                          <div style={{ marginBottom: 12 }}>
                            {item.urls.map((url, idx) => (
                              <div key={idx} style={{ fontSize: 12, marginBottom: 2 }}>
                                <a href={url} target="_blank" rel="noopener noreferrer" style={{ color: '#1a73e8', wordBreak: 'break-all' }}>{url}</a>
                              </div>
                            ))}
                          </div>
                        )}
                        <div style={{ marginLeft: 8, borderLeft: '2px solid #e0e0e0', paddingLeft: 16 }}>
                          {(item.timeline || []).map((entry, tIdx) => (
                            <div key={tIdx} style={{ position: 'relative', marginBottom: 10 }}>
                              <div style={{ position: 'absolute', left: -22, top: 4, width: 10, height: 10, borderRadius: '50%', background: tIdx === (item.timeline.length - 1) ? '#1a73e8' : '#bdbdbd' }} />
                              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                                <span style={{ fontSize: 11, color: '#999', whiteSpace: 'nowrap', minWidth: 100 }}>{entry.date}</span>
                                <span style={{ fontSize: 13, color: '#333', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>{entry.text}</span>
                              </div>
                            </div>
                          ))}
                          {(item.timeline || []).length === 0 && <div style={{ fontSize: 12, color: '#bbb' }}>기록된 진행상황이 없습니다.</div>}
                        </div>
                      </>
                    )}
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
