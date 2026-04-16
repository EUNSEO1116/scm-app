import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
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
async function loadPendingAlertsFromDB() {
  try {
    const dbData = await dbStoreGet('pending_sync_alerts');
    if (dbData && Array.isArray(dbData)) {
      localStorage.setItem(PENDING_ALERTS_KEY, JSON.stringify(dbData));
      return dbData;
    }
  } catch {}
  return loadPendingAlerts();
}
function savePendingAlerts(list) {
  localStorage.setItem(PENDING_ALERTS_KEY, JSON.stringify(list));
  dbStoreSet('pending_sync_alerts', list).catch(() => {});
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

export default function IssueManagement() {
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
      if (data && Array.isArray(data)) {
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
      const saved = await loadPendingAlertsFromDB();
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
    </div>
  );
}
