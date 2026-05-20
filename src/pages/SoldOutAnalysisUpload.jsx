import { useState, useRef } from 'react';
import * as XLSX from 'xlsx';
import { dbStoreSet, dbStoreGet } from '../utils/dbApi';

const todayKey = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

function dateToKey(d) {
  return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`;
}

function keyToDisplay(k) {
  return `${k.slice(0,4)}-${k.slice(4,6)}-${k.slice(6,8)}`;
}

// 파일명에서 "N일전" 파싱 → 해당 날짜 키 반환, 없으면 오늘
function parseDateFromFileName(fileName) {
  const m = fileName.match(/(\d+)일전/);
  if (m) {
    const daysAgo = parseInt(m[1]);
    const d = new Date();
    d.setDate(d.getDate() - daysAgo);
    return dateToKey(d);
  }
  return todayKey();
}

// 임시 기능 만료일 (2026-05-20까지만)
const TEMP_FEATURE_DEADLINE = '20260520';

export default function SoldOutAnalysisUpload() {
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [toast, setToast] = useState(null);
  const [lastResult, setLastResult] = useState(null);
  const fileRef = useRef(null);
  const pastFileRef = useRef(null);
  const [pastDaysAgo, setPastDaysAgo] = useState(1);

  const showToast = (type, title, message) => {
    setToast({ type, title, message });
    setTimeout(() => setToast(null), 4000);
  };

  const parseExcel = async (file, overrideDate) => {
    setUploading(true);
    try {
      const targetDate = overrideDate || todayKey();
      const existing = await dbStoreGet(`soldout_analysis_${targetDate}`);
      if (existing) {
        const ok = window.confirm(`${keyToDisplay(targetDate)} 데이터가 이미 있습니다. 덮어쓰시겠습니까?`);
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
      };

      const missing = Object.entries(colIdx).filter(([, v]) => v === -1);
      if (missing.length > 0) {
        showToast('error', '업로드 실패', `필수 컬럼을 찾을 수 없습니다: ${missing.map(([k]) => k).join(', ')}`);
        setUploading(false);
        return;
      }

      const items = [];
      for (let i = 2; i < rows.length; i++) {
        const r = rows[i];
        if (!r || !r[colIdx.optionId]) continue;
        items.push({
          optionId: String(r[colIdx.optionId] || ''),
          productName: String(r[colIdx.productName] || ''),
          optionName: String(r[colIdx.optionName] || ''),
          coupangStock: Number(r[colIdx.coupangStock]) || 0,
          salesQty: Number(r[colIdx.salesQty]) || 0,
        });
      }

      if (items.length === 0) {
        showToast('error', '업로드 실패', '유효한 데이터가 없습니다.');
        setUploading(false);
        return;
      }

      const targetD = new Date(
        parseInt(targetDate.slice(0,4)),
        parseInt(targetDate.slice(4,6)) - 1,
        parseInt(targetDate.slice(6,8))
      );

      const ok = await dbStoreSet(`soldout_analysis_${targetDate}`, {
        uploadedAt: targetD.toISOString(),
        fileName: file.name,
        count: items.length,
        items,
      });

      if (ok) {
        const isToday = targetDate === todayKey();
        const label = isToday ? '오늘' : keyToDisplay(targetDate);
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

  const handleFile = (file, overrideDate) => {
    if (!file) return;
    if (!file.name.match(/\.xlsx?$/i)) {
      showToast('error', '파일 오류', '.xlsx 파일만 업로드 가능합니다.');
      return;
    }
    parseExcel(file, overrideDate);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragging(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const showTempFeature = todayKey() <= TEMP_FEATURE_DEADLINE;

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

      {/* 업로드 영역 */}
      <div className="card" style={{ padding: 32 }}>
        <h3 style={{ fontSize: 18, fontWeight: 700, marginBottom: 8 }}>매출 데이터 업로드</h3>
        <p style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 24 }}>
          빅셀 로켓그로스 매출분석 엑셀 파일을 업로드하세요. 하루 1회 업로드하면 자동으로 날짜별 기록됩니다.
        </p>

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

      {/* 임시: 과거 날짜 업로드 (2026-05-20까지만) */}
      {showTempFeature && (
        <div className="card" style={{ padding: 20, marginTop: 20 }}>
          <h3 style={{ fontSize: 15, fontWeight: 700, marginBottom: 8, color: '#e65100' }}>과거 데이터 업로드 (임시)</h3>
          <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 12 }}>
            날짜를 선택하고 해당 날짜의 엑셀을 업로드하세요. 7일전~1일전까지 순서대로 올려주세요.
          </p>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
            <select
              value={pastDaysAgo}
              onChange={e => setPastDaysAgo(Number(e.target.value))}
              style={{ padding: '8px 12px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 13, fontWeight: 600 }}
            >
              {[7,6,5,4,3,2,1].map(n => {
                const d = new Date(); d.setDate(d.getDate() - n);
                return <option key={n} value={n}>{n}일전 ({keyToDisplay(dateToKey(d))})</option>;
              })}
            </select>
            <input
              ref={pastFileRef}
              type="file"
              accept=".xlsx,.xls"
              style={{ display: 'none' }}
              onChange={(e) => {
                const d = new Date(); d.setDate(d.getDate() - pastDaysAgo);
                handleFile(e.target.files[0], dateToKey(d));
                e.target.value = '';
              }}
            />
            <button
              onClick={() => pastFileRef.current?.click()}
              disabled={uploading}
              className="btn btn-primary btn-sm"
              style={{ padding: '8px 16px' }}
            >{uploading ? '업로드 중...' : '파일 선택 & 업로드'}</button>
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(40px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
