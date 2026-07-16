import { useState, useEffect, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

const STORE_KEY = 'certification_items';
const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const CSV_BARCODE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('쿠팡바코드')}`;

// 큰따옴표 처리하는 CSV 파서 (행 배열 반환)
function parseCsvRows(text) {
  const rows = [];
  let row = [];
  let cell = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i++; }
        else inQuotes = false;
      } else cell += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        if (row.some(c => c)) rows.push(row);
        row = [];
      } else cell += ch;
    }
  }
  row.push(cell);
  if (row.some(c => c)) rows.push(row);
  return rows;
}

export default function CertificationManagement() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saveFailed, setSaveFailed] = useState(false);
  const [form, setForm] = useState({ barcode: '', productName: '', hsCode: '' });
  const [sheetBarcodes, setSheetBarcodes] = useState(null); // 쿠팡바코드 시트에 있는 바코드 Set (null = 로딩중)
  const [modalMsg, setModalMsg] = useState(null);
  const fileRef = useRef(null);

  // DB 로드
  useEffect(() => {
    (async () => {
      const data = await dbStoreGet(STORE_KEY);
      if (Array.isArray(data)) setItems(data);
      setLoading(false);
    })();
  }, []);

  // 쿠팡바코드 시트 로드 (검증완료 시 존재 여부 확인용)
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(CSV_BARCODE);
        if (!res.ok) { setSheetBarcodes(new Set()); return; }
        const rows = parseCsvRows(await res.text());
        const set = new Set();
        for (let i = 1; i < rows.length; i++) {
          const bc = (rows[i][5] || '').trim();
          if (bc) set.add(bc);
        }
        setSheetBarcodes(set);
      } catch {
        setSheetBarcodes(new Set());
      }
    })();
  }, []);

  const save = useCallback(async (next) => {
    setItems(next);
    const ok = await dbStoreSet(STORE_KEY, next, { logDesc: '인증관리 상품' });
    setSaveFailed(!ok);
  }, []);

  const canAdd = form.barcode.trim() && form.productName.trim() && form.hsCode.trim();

  const handleAdd = () => {
    const barcode = form.barcode.trim();
    if (!canAdd) return;
    if (items.some(it => it.barcode === barcode)) {
      alert('이미 등록된 쿠팡바코드입니다.');
      return;
    }
    const next = [
      ...items,
      { barcode, productName: form.productName.trim(), hsCode: form.hsCode.trim(), enabled: false },
    ];
    save(next);
    setForm({ barcode: '', productName: '', hsCode: '' });
  };

  const toggleEnabled = (barcode) => {
    const item = items.find(it => it.barcode === barcode);
    if (!item) return;
    // 검증완료(AE-N 해제) 시 → 쿠팡바코드 시트에 없으면 막고 모달 알림
    if (item.enabled) {
      if (sheetBarcodes === null) {
        setModalMsg('쿠팡바코드 시트를 아직 불러오는 중입니다. 잠시 후 다시 시도해주세요.');
        return;
      }
      if (!sheetBarcodes.has(barcode)) {
        setModalMsg(`쿠팡바코드 "${barcode}" 가 쿠팡바코드 시트에 없습니다.\n시트에 먼저 등록한 뒤 검증완료를 진행해주세요.`);
        return;
      }
    }
    save(items.map(it => it.barcode === barcode ? { ...it, enabled: !it.enabled } : it));
  };

  const handleDelete = (barcode) => {
    if (!window.confirm('삭제하시겠습니까?')) return;
    save(items.filter(it => it.barcode !== barcode));
  };

  // 엑셀 템플릿 다운로드
  const handleTemplate = () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ['쿠팡바코드', '등록상품명', 'HSCODE'],
      ['1234567890', '예시 상품명', '3924.90-0000 / EXAMPLE PRODUCT'],
    ]);
    ws['!cols'] = [{ wch: 16 }, { wch: 30 }, { wch: 36 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '인증관리');
    XLSX.writeFile(wb, '인증관리_업로드양식.xlsx');
  };

  // 엑셀 일괄 업로드 (쿠팡바코드 기준, 중복 시 덮어쓰기, 업로드 시 설정 ON)
  const handleUpload = async (e) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
      const header = (rows[0] || []).map(h => String(h || '').trim());
      const bcIdx = header.indexOf('쿠팡바코드');
      const nameIdx = header.indexOf('등록상품명');
      const hsIdx = header.indexOf('HSCODE');
      if (bcIdx === -1) {
        setModalMsg('엑셀에서 "쿠팡바코드" 컬럼을 찾을 수 없습니다.\n헤더가 쿠팡바코드 / 등록상품명 / HSCODE 인지 확인해주세요.');
        return;
      }

      const map = new Map(items.map(it => [it.barcode, it]));
      let added = 0, updated = 0;
      for (let i = 1; i < rows.length; i++) {
        const barcode = String(rows[i][bcIdx] ?? '').trim();
        if (!barcode) continue;
        const productName = nameIdx === -1 ? '' : String(rows[i][nameIdx] ?? '').trim();
        const hsCode = hsIdx === -1 ? '' : String(rows[i][hsIdx] ?? '').trim();
        if (map.has(barcode)) updated++; else added++;
        map.set(barcode, { barcode, productName, hsCode, enabled: true });
      }
      if (added === 0 && updated === 0) {
        setModalMsg('업로드할 데이터가 없습니다.');
        return;
      }
      await save(Array.from(map.values()));
      setModalMsg(`업로드 완료 — 신규 ${added}건, 덮어쓰기 ${updated}건 (모두 설정 ON)`);
    } catch (err) {
      setModalMsg(`업로드 실패: ${err.message}`);
    }
  };

  const enabledCount = items.filter(it => it.enabled).length;

  const cell = { padding: '8px 10px', fontSize: 13, textAlign: 'center', borderBottom: '1px solid #eee' };
  const th = { ...cell, fontWeight: 600, color: '#555', background: '#fafafa', borderBottom: '1px solid #ddd' };
  const input = { padding: '8px 10px', fontSize: 13, border: '1px solid #ccc', borderRadius: 6, textAlign: 'center' };

  return (
    <div>
      <div style={{ textAlign: 'center', fontSize: 10, color: '#bbb', letterSpacing: '0.3px', marginBottom: 12, lineHeight: 1 }}>
        인증관리 · 설정 시 발주신청에서 AE-N 마킹으로 표시 / 검증완료 시 원래 마킹
      </div>

      {saveFailed && (
        <div style={{ marginBottom: 16, background: '#ffebee', border: '1px solid #ef5350', borderRadius: 12, padding: 16, textAlign: 'center' }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: '#c62828' }}>
            DB 저장 실패 — 다시 시도해주세요.
          </span>
        </div>
      )}

      {/* 요약 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 16 }}>
        <div style={{ background: '#e8f0fe', borderRadius: 12, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: '#1a73e8', marginBottom: 4 }}>전체 등록</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#1a73e8' }}>{items.length}</div>
        </div>
        <div style={{ background: '#fff3e0', borderRadius: 12, padding: 16, textAlign: 'center' }}>
          <div style={{ fontSize: 12, color: '#e65100', marginBottom: 4 }}>AE-N 설정</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#e65100' }}>{enabledCount}</div>
        </div>
      </div>

      {/* 엑셀 일괄 업로드 */}
      <div style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 12, padding: 16, marginBottom: 16, textAlign: 'center' }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 4 }}>엑셀 일괄 업로드</div>
        <div style={{ fontSize: 12, color: '#999', marginBottom: 12 }}>
          컬럼: 쿠팡바코드 · 등록상품명 · HSCODE / 쿠팡바코드 기준 덮어쓰기 · 업로드 시 설정 ON
        </div>
        <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={handleUpload} />
        <button className="btn btn-primary" style={{ fontSize: 13, padding: '8px 20px', marginRight: 8 }}
          onClick={() => fileRef.current?.click()}>엑셀 업로드</button>
        <button className="btn btn-sm" style={{ fontSize: 13, padding: '8px 20px', border: '1px solid #1a73e8', borderRadius: 6, color: '#1a73e8', background: '#fff' }}
          onClick={handleTemplate}>템플릿 다운로드</button>
      </div>

      {/* 등록 폼 */}
      <div style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 12, padding: 16, marginBottom: 16 }}>
        <div style={{ fontWeight: 600, fontSize: 14, marginBottom: 12, textAlign: 'center' }}>인증상품 등록 (개별)</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr auto', gap: 10, alignItems: 'center' }}>
          <input style={input} placeholder="쿠팡바코드" value={form.barcode}
            onChange={e => setForm(f => ({ ...f, barcode: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }} />
          <input style={input} placeholder="등록상품명" value={form.productName}
            onChange={e => setForm(f => ({ ...f, productName: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }} />
          <input style={input} placeholder="HSCODE / 영문상품명" value={form.hsCode}
            onChange={e => setForm(f => ({ ...f, hsCode: e.target.value }))}
            onKeyDown={e => { if (e.key === 'Enter') handleAdd(); }} />
          <button className="btn btn-primary" disabled={!canAdd}
            style={{ fontSize: 13, padding: '8px 16px', opacity: canAdd ? 1 : 0.5 }}
            onClick={handleAdd}>등록</button>
        </div>
      </div>

      {/* 리스트 */}
      <div style={{ background: '#fff', border: '1px solid #e0e0e0', borderRadius: 12, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              <th style={{ ...th, width: 48 }}>#</th>
              <th style={th}>쿠팡바코드</th>
              <th style={th}>등록상품명</th>
              <th style={th}>HSCODE / 영문상품명</th>
              <th style={{ ...th, width: 110 }}>상태</th>
              <th style={{ ...th, width: 200 }}>관리</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr><td colSpan={6} style={{ ...cell, padding: 32, color: '#999' }}>불러오는 중…</td></tr>
            ) : items.length === 0 ? (
              <tr><td colSpan={6} style={{ ...cell, padding: 32, color: '#999' }}>등록된 인증상품이 없습니다.</td></tr>
            ) : (
              items.map((it, idx) => (
                <tr key={it.barcode}>
                  <td style={cell}>{idx + 1}</td>
                  <td style={{ ...cell, fontFamily: 'monospace' }}>{it.barcode}</td>
                  <td style={cell}>{it.productName}</td>
                  <td style={cell}>{it.hsCode}</td>
                  <td style={cell}>
                    {it.enabled ? (
                      <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, background: '#fff3e0', color: '#e65100' }}>AE-N</span>
                    ) : (
                      <span style={{ display: 'inline-block', padding: '3px 10px', borderRadius: 12, fontSize: 12, fontWeight: 600, background: '#e8f5e9', color: '#2e7d32' }}>검증완료</span>
                    )}
                  </td>
                  <td style={cell}>
                    <button className="btn btn-sm"
                      style={{ fontSize: 12, padding: '4px 12px', marginRight: 6, border: 'none', borderRadius: 6, color: '#fff', background: it.enabled ? '#2e7d32' : '#e65100' }}
                      onClick={() => toggleEnabled(it.barcode)}>
                      {it.enabled ? '검증완료' : '설정'}
                    </button>
                    <button className="btn btn-sm"
                      style={{ fontSize: 12, padding: '4px 12px', border: '1px solid #e57373', borderRadius: 6, color: '#c62828', background: '#fff' }}
                      onClick={() => handleDelete(it.barcode)}>
                      삭제
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* 검증완료 차단 모달 */}
      {modalMsg && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setModalMsg(null)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 28, maxWidth: 420, width: '90%', textAlign: 'center', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}
            onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>⚠️</div>
            <div style={{ fontSize: 15, color: '#333', lineHeight: 1.6, whiteSpace: 'pre-line', marginBottom: 20 }}>
              {modalMsg}
            </div>
            <button className="btn btn-primary" style={{ fontSize: 14, padding: '8px 28px' }}
              onClick={() => setModalMsg(null)}>확인</button>
          </div>
        </div>
      )}
    </div>
  );
}
