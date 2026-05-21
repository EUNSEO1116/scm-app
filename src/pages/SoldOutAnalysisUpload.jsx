import { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { dbStoreSet, dbStoreGet } from '../utils/dbApi';

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

export default function SoldOutAnalysisUpload() {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const [targetDate, setTargetDate] = useState(keyToDateInput(todayKey()));
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

      const ok = await dbStoreSet(`soldout_analysis_${dateKey}`, {
        uploadedAt: targetD.toISOString(),
        fileName: file.name,
        count: items.length,
        items,
      });

      if (ok) {
        const isToday = dateKey === todayKey();
        const label = isToday ? '오늘' : keyToDisplay(dateKey);
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

      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(40px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
