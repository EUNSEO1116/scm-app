import { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { dbStoreSet, dbStoreGet } from '../utils/dbApi';
import { ensureUploadSoldoutCache } from '../utils/soldoutCache';

const todayKey = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const CSV_BARCODE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('쿠팡바코드')}`;

function parseCsvRow(line) {
  const result = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) { if (ch === '"' && line[i+1] === '"') { current += '"'; i++; } else if (ch === '"') inQuotes = false; else current += ch; }
    else { if (ch === '"') inQuotes = true; else if (ch === ',') { result.push(current); current = ''; } else current += ch; }
  }
  result.push(current); return result;
}

function keyToDisplay(k) {
  return `${k.slice(0,4)}-${k.slice(4,6)}-${k.slice(6,8)}`;
}

// 'YYYY-MM-DD' → 'YYYYMMDD'
function dateInputToKey(str) {
  return str.replace(/-/g, '');
}

// 'YYYYMMDD' → 'YYYY-MM-DD'
function keyToDateInput(k) {
  return `${k.slice(0,4)}-${k.slice(4,6)}-${k.slice(6,8)}`;
}

// Date 객체 → 'YYYYMMDD' (로컬 기준, 타임존 시프트 방지)
function dateToKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// 시작일~종료일(포함) 사이 모든 날짜의 'YYYYMMDD' 키 배열 (로컬 기준)
function enumerateDateKeys(startInput, endInput) {
  const [sy, sm, sd] = startInput.split('-').map(Number);
  const [ey, em, ed] = endInput.split('-').map(Number);
  const cur = new Date(sy, sm - 1, sd);
  const end = new Date(ey, em - 1, ed);
  const keys = [];
  while (cur <= end) {
    keys.push(dateToKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return keys;
}

// 엑셀 내보내기 컬럼 순서 및 매핑
const EXPORT_HEADERS = ['날짜', '옵션ID', '상품명', '옵션명', '바코드', '상태', '쿠팡재고', '판매수량', '매출', '순이익금'];
function itemToRow(dateDisplay, it) {
  return {
    '날짜': dateDisplay,
    '옵션ID': it.optionId,
    '상품명': it.productName,
    '옵션명': it.optionName,
    '바코드': it.barcode,
    '상태': it.status,
    '쿠팡재고': it.coupangStock,
    '판매수량': it.salesQty,
    '매출': it.revenue,
    '순이익금': it.netProfit,
  };
}

export default function SoldOutAnalysisUpload() {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [resetting, setResetting] = useState(false);
  const [toast, setToast] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [targetDate, setTargetDate] = useState(keyToDateInput(todayKey()));
  const [dlMode, setDlMode] = useState('single'); // 'single' | 'range'
  const [dlDate, setDlDate] = useState(keyToDateInput(todayKey()));
  const [dlStart, setDlStart] = useState(keyToDateInput(todayKey()));
  const [dlEnd, setDlEnd] = useState(keyToDateInput(todayKey()));
  const [downloading, setDownloading] = useState(false);
  const fileRef = useRef(null);

  const showToast = (type, title, message) => {
    setToast({ type, title, message });
    setTimeout(() => setToast(null), 4000);
  };

  const parseExcel = async (file) => {
    setUploading(true);
    try {
      const dateKey = dateInputToKey(targetDate);
      const existing = await dbStoreGet(`soldout_analysis_${dateKey}`);
      if (existing) {
        const ok = window.confirm(`${keyToDisplay(dateKey)} 데이터가 이미 있습니다. 덮어쓰시겠습니까?`);
        if (!ok) { setUploading(false); return; }
      }

      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });

      const header = rows[0];
      const colIdx = {
        optionId: header.indexOf('옵션ID'),
        productName: header.indexOf('상품명'),
        optionName: header.indexOf('옵션명'),
        coupangStock: header.indexOf('쿠팡재고'),
        salesQty: header.indexOf('판매수량'),
        revenue: header.indexOf('매출'),
        netProfit: header.indexOf('순이익금'),
      };

      const missing = Object.entries(colIdx).filter(([k, v]) => v === -1 && k !== 'revenue' && k !== 'netProfit');
      if (missing.length > 0) {
        showToast('error', '업로드 실패', `필수 컬럼을 찾을 수 없습니다: ${missing.map(([k]) => k).join(', ')}`);
        setUploading(false);
        return;
      }

      // 스프레드시트에서 상태 매칭 (스냅샷)
      let bcMap = {};
      try {
        const bcRes = await fetch(CSV_BARCODE);
        const bcCsv = await bcRes.text();
        const bcLines = bcCsv.split('\n').filter(l => l.trim());
        for (let i = 1; i < bcLines.length; i++) {
          const c = parseCsvRow(bcLines[i]);
          const oid = (c[1]||'').trim();
          if (oid) bcMap[oid] = { status: (c[9]||'').trim(), barcode: (c[5]||'').trim() };
        }
      } catch (e) { console.warn('바코드 시트 로드 실패, 상태 없이 저장합니다', e); }

      const items = [];
      for (let i = 2; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[colIdx.optionId]) continue;
        const oid = String(r[colIdx.optionId] || '');
        const bc = bcMap[oid];
        items.push({
          optionId: oid,
          productName: String(r[colIdx.productName] || ''),
          optionName: String(r[colIdx.optionName] || ''),
          coupangStock: Number(r[colIdx.coupangStock]) || 0,
          salesQty: Number(r[colIdx.salesQty]) || 0,
          revenue: colIdx.revenue >= 0 ? Number(r[colIdx.revenue]) || 0 : 0,
          netProfit: colIdx.netProfit >= 0 ? Number(r[colIdx.netProfit]) || 0 : 0,
          status: bc?.status || '',
          barcode: bc?.barcode || '',
        });
      }

      if (items.length === 0) {
        showToast('error', '업로드 실패', '유효한 데이터가 없습니다.');
        setUploading(false);
        return;
      }

      const targetD = new Date(
        parseInt(dateKey.slice(0,4)),
        parseInt(dateKey.slice(4,6)) - 1,
        parseInt(dateKey.slice(6,8))
      );

      const isToday = dateKey === todayKey();
      const dateLabel = isToday ? '오늘' : keyToDisplay(dateKey);
      const ok = await dbStoreSet(`soldout_analysis_${dateKey}`, {
        uploadedAt: targetD.toISOString(),
        fileName: file.name,
        count: items.length,
        items,
      }, { logDesc: `품절 데이터 업로드: ${dateLabel} (${file.name}, ${items.length}개 품목)` });

      if (ok) {
        const isToday = dateKey === todayKey();
        const label = isToday ? '오늘' : keyToDisplay(dateKey);
        // 업로드 직후 1회 품절 계산해 캐시 저장 (정식 분석 캐시가 있으면 보존)
        // → 이후 기간 집계/엑셀은 저장된 캐시를 읽어 재계산하지 않음
        await ensureUploadSoldoutCache(dateKey, { force: true }).catch(() => null);
        setLastResult({ date: label, count: items.length });
        showToast('success', '업로드 완료', `${label} - ${items.length.toLocaleString()}개 품목 저장`);
      } else {
        showToast('error', '저장 실패', 'DB 저장 중 오류가 발생했습니다.');
      }
    } catch (e) {
      console.error(e);
      showToast('error', '업로드 실패', '엑셀 파일을 읽는 중 오류가 발생했습니다.');
    }
    setUploading(false);
  };

  const handleReset = async () => {
    const dateKey = dateInputToKey(targetDate);
    const label = dateKey === todayKey() ? '오늘' : keyToDisplay(dateKey);
    const ok = window.confirm(
      `${label} (${keyToDisplay(dateKey)}) 품절현황 데이터를 초기화합니다.\n\n` +
      `- 업로드한 엑셀 데이터 삭제\n` +
      `- 분석 캐시 삭제 (품절현황 업데이트 버튼 다시 활성화)\n` +
      `- 해당 날짜 품절률 스냅샷 제거\n\n` +
      `계속하시겠습니까?`
    );
    if (!ok) return;
    setResetting(true);
    try {
      await dbStoreSet(`soldout_analysis_${dateKey}`, null, { logDesc: `품절 데이터 초기화: ${label}` });
      await dbStoreSet(`soldout_analysis_cached_${dateKey}`, null, { skipLog: true });
      const snaps = await dbStoreGet('soldout_analysis_rate_snapshots') || {};
      if (snaps[dateKey]) { delete snaps[dateKey]; await dbStoreSet('soldout_analysis_rate_snapshots', snaps, { skipLog: true }); }
      setLastResult(null);
      showToast('success', '초기화 완료', `${label} 데이터/캐시를 비웠습니다. 다시 업로드 → 업데이트 하세요.`);
    } catch (e) {
      console.error(e);
      showToast('error', '초기화 실패', 'DB 초기화 중 오류가 발생했습니다.');
    }
    setResetting(false);
  };

  const handleDownload = async () => {
    // 다운로드 대상 날짜 키 목록 결정
    let keys;
    let fname;
    if (dlMode === 'single') {
      const k = dateInputToKey(dlDate);
      keys = [k];
      fname = `품절데이터_${keyToDisplay(k)}.xlsx`;
    } else {
      if (dlStart > dlEnd) {
        showToast('error', '다운로드 실패', '시작일이 종료일보다 늦습니다.');
        return;
      }
      keys = enumerateDateKeys(dlStart, dlEnd);
      fname = `품절데이터_${keyToDisplay(dateInputToKey(dlStart))}~${keyToDisplay(dateInputToKey(dlEnd))}.xlsx`;
    }

    setDownloading(true);
    try {
      const wb = XLSX.utils.book_new();
      let foundDates = 0;
      let totalRows = 0;
      for (const k of keys) {
        const data = await dbStoreGet(`soldout_analysis_${k}`);
        if (data && Array.isArray(data.items) && data.items.length) {
          foundDates++;
          const rows = data.items.map(it => itemToRow(keyToDisplay(k), it));
          totalRows += rows.length;
          const ws = XLSX.utils.json_to_sheet(rows, { header: EXPORT_HEADERS });
          XLSX.utils.book_append_sheet(wb, ws, keyToDisplay(k));
        }
      }

      if (foundDates === 0) {
        showToast('error', '다운로드 실패', `해당 ${dlMode === 'single' ? '날짜' : '기간'}에 저장된 데이터가 없습니다.`);
        setDownloading(false);
        return;
      }

      XLSX.writeFile(wb, fname);
      const sheetInfo = dlMode === 'single' ? `${totalRows.toLocaleString()}행` : `${foundDates}개 시트 · ${totalRows.toLocaleString()}행`;
      showToast('success', '다운로드 완료', `${sheetInfo} 저장`);
    } catch (e) {
      console.error(e);
      showToast('error', '다운로드 실패', '엑셀 생성 중 오류가 발생했습니다.');
    }
    setDownloading(false);
  };

  const handleFile = (file) => {
    if (!file) return;
    if (!file.name.match(/\.xlsx?$/i)) {
      showToast('error', '파일 오류', '.xlsx 파일만 업로드 가능합니다.');
      return;
    }
    parseExcel(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const isToday = targetDate === keyToDateInput(todayKey());

  return (
    <div style={{ maxWidth: 640, margin: '0 auto' }}>
      {toast && (
        <div style={{
          position: 'fixed', top: 32, right: 32, zIndex: 9999,
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '16px 20px', borderRadius: 12,
          background: toast.type === 'success' ? '#e6f4ea' : '#fce8e6',
          border: `1px solid ${toast.type === 'success' ? '#1e8e3e' : '#d93025'}`,
          boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
          animation: 'slideIn 0.3s ease',
          minWidth: 300, maxWidth: 420,
        }}>
          <div style={{
            width: 36, height: 36, borderRadius: '50%',
            background: toast.type === 'success' ? '#1e8e3e' : '#d93025',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
          }}>
            {toast.type === 'success' ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg>
            )}
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 15, color: toast.type === 'success' ? '#1e8e3e' : '#d93025' }}>
              {toast.title}
            </div>
            <div style={{ fontSize: 13, color: '#333', marginTop: 2 }}>{toast.message}</div>
          </div>
        </div>
      )}

      <div className="card" style={{ padding: 32 }}>
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>매출 데이터 업로드</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24 }}>
          빅셀 로켓그로스 매출분석 엑셀 파일을 업로드하세요. 날짜를 선택하면 해당 날짜 데이터로 저장됩니다.
        </p>

        {/* 날짜 선택 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
          <label style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>업로드 날짜</label>
          <input
            type="date"
            value={targetDate}
            max={keyToDateInput(todayKey())}
            onChange={e => setTargetDate(e.target.value)}
            style={{
              padding: '8px 12px', borderRadius: 8,
              border: '1px solid var(--border)', fontSize: 14, fontWeight: 600,
              color: isToday ? 'var(--text)' : '#1a73e8',
            }}
          />
          {!isToday && (
            <span style={{ fontSize: 13, color: '#1a73e8', fontWeight: 600 }}>
              ← {keyToDisplay(dateInputToKey(targetDate))} 데이터로 저장됩니다
            </span>
          )}
          <div style={{ flex: 1 }} />
          <button
            onClick={handleReset}
            disabled={resetting || uploading}
            style={{
              padding: '8px 14px', borderRadius: 8,
              border: '1px solid #d93025', background: '#fff',
              color: '#d93025', fontSize: 13, fontWeight: 600,
              cursor: resetting ? 'default' : 'pointer', whiteSpace: 'nowrap',
            }}
          >
            {resetting ? '초기화 중...' : '🗑 데이터/캐시 초기화'}
          </button>
        </div>

        <div
          onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileRef.current?.click()}
          style={{
            border: `2px dashed ${dragging ? 'var(--primary)' : 'var(--border)'}`,
            borderRadius: 12,
            padding: '48px 24px',
            textAlign: 'center',
            cursor: 'pointer',
            background: dragging ? 'var(--primary-light)' : '#fafbfc',
            transition: 'all 0.2s',
          }}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            style={{ display: 'none' }}
            onChange={(e) => { handleFile(e.target.files[0]); e.target.value = ''; }}
          />
          {uploading ? (
            <>
              <div style={{ fontSize: 40, marginBottom: 12 }}>⏳</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--primary)' }}>업로드 중...</div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
              <div style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>
                엑셀 파일을 드래그하거나 클릭하여 선택
              </div>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginTop: 6 }}>
                .xlsx 파일만 지원 (빅셀 로켓그로스 매출분석)
              </div>
            </>
          )}
        </div>

        <div style={{
          marginTop: 20, padding: '12px 16px', borderRadius: 8,
          background: '#f0f4ff', fontSize: 13, color: '#555',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ fontSize: 16 }}>💡</span>
          추출 항목: 옵션ID, 상품명, 옵션명, 쿠팡재고, 판매수량
        </div>

        {lastResult && (
          <div style={{ marginTop: 12, padding: '10px 16px', borderRadius: 8, background: '#e6f4ea', fontSize: 13, color: '#1e8e3e', fontWeight: 600 }}>
            {lastResult.date} - {lastResult.count.toLocaleString()}개 품목 저장 완료
          </div>
        )}
      </div>

      {/* 저장된 데이터 엑셀 다운로드 */}
      <div className="card" style={{ padding: 32, marginTop: 24 }}>
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>저장된 데이터 엑셀 다운로드</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24 }}>
          DB에 저장된 품절 데이터를 엑셀로 내려받습니다. 단일 날짜 또는 기간을 선택하세요.
        </p>

        {/* 모드 선택 */}
        <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
          {[['single', '단일 날짜'], ['range', '기간 설정']].map(([mode, label]) => {
            const active = dlMode === mode;
            return (
              <button
                key={mode}
                onClick={() => setDlMode(mode)}
                style={{
                  padding: '8px 18px', borderRadius: 8,
                  border: `1px solid ${active ? 'var(--primary)' : 'var(--border)'}`,
                  background: active ? 'var(--primary)' : '#fff',
                  color: active ? '#fff' : 'var(--text)',
                  fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}
              >
                {label}
              </button>
            );
          })}
        </div>

        {/* 날짜 입력 */}
        {dlMode === 'single' ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20 }}>
            <label style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>날짜</label>
            <input
              type="date"
              value={dlDate}
              max={keyToDateInput(todayKey())}
              onChange={e => setDlDate(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, fontWeight: 600 }}
            />
          </div>
        ) : (
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, flexWrap: 'wrap' }}>
            <label style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>시작일</label>
            <input
              type="date"
              value={dlStart}
              max={keyToDateInput(todayKey())}
              onChange={e => setDlStart(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, fontWeight: 600 }}
            />
            <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>~</span>
            <label style={{ fontSize: 14, fontWeight: 600, color: 'var(--text)' }}>종료일</label>
            <input
              type="date"
              value={dlEnd}
              max={keyToDateInput(todayKey())}
              onChange={e => setDlEnd(e.target.value)}
              style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 14, fontWeight: 600 }}
            />
          </div>
        )}

        <button
          onClick={handleDownload}
          disabled={downloading}
          style={{
            padding: '10px 20px', borderRadius: 8, border: 'none',
            background: downloading ? '#9aa0a6' : '#1e8e3e', color: '#fff',
            fontSize: 14, fontWeight: 700, cursor: downloading ? 'default' : 'pointer',
          }}
        >
          {downloading ? '다운로드 중...' : '⬇ 엑셀 다운로드'}
        </button>

        <div style={{
          marginTop: 20, padding: '12px 16px', borderRadius: 8,
          background: '#f0f4ff', fontSize: 13, color: '#555',
          display: 'flex', alignItems: 'center', gap: 8,
        }}>
          <span style={{ fontSize: 16 }}>💡</span>
          기간 다운로드 시 날짜별로 시트가 분리되어 하나의 엑셀 파일로 저장됩니다.
        </div>
      </div>

      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(40px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
