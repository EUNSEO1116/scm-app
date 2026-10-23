import { useState, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

const DB_KEY = 'carton_spec_archive';

// 엑셀 출고일자(시리얼 숫자 또는 문자) → 'YYYY-MM-DD'
function toDateStr(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (typeof v === 'number') {
    const d = XLSX.SSF.parse_date_code(v);
    if (!d) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${d.y}-${p(d.m)}-${p(d.d)}`;
  }
  return String(v).trim().slice(0, 10);
}

// '상품명, 옵션1, 옵션2' → 첫 쉼표 기준으로 상품명 / 옵션명 분리
function splitName(full) {
  const s = String(full || '').trim();
  const i = s.indexOf(',');
  if (i === -1) return { productName: s, optionName: '' };
  return { productName: s.slice(0, i).trim(), optionName: s.slice(i + 1).trim() };
}

// 저장된 아카이브(레코드 맵) → 화면/다운로드용 행 배열
function deriveRows(archive) {
  const rows = [];
  for (const sku of Object.keys(archive || {})) {
    const rec = archive[sku];
    if (!rec) continue;
    const confirmed = rec.confirmedMax != null;
    const ev = confirmed ? rec.confirmedEv : rec.pendingEv;
    rows.push({
      sku,
      productName: rec.productName || '',
      optionName: rec.optionName || '',
      status: confirmed ? 'confirmed' : 'pending',
      qty: confirmed ? rec.confirmedMax : rec.pendingMax,
      boxSpec: (ev && ev.boxSpec) || rec.anySpec || '',
      ev: ev || null,
    });
  }
  rows.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'confirmed' ? -1 : 1;
    return (a.productName + a.optionName).localeCompare(b.productName + b.optionName, 'ko');
  });
  return rows;
}

function evidenceText(row) {
  const ev = row.ev;
  if (!ev) return '';
  const base = `${ev.date || '-'} · 발주 ${ev.orderNo || '-'} · 박스 ${ev.boxNo || '-'}`;
  if (row.status === 'confirmed') return `${base} (${ev.qty}입)`;
  if (ev.kind === 'mixed') return `${base} · 다른상품과 혼재(해당상품 합계 ${ev.qty})`;
  return `${base} · 같은상품 여러옵션 혼입(총 ${ev.qty})`;
}

export default function CartonSpec() {
  const [rows, setRows] = useState([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState(null);
  const [filter, setFilter] = useState('all'); // all | confirmed | pending
  const fileRef = useRef();

  useEffect(() => {
    dbStoreGet(DB_KEY).then((data) => {
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        setRows(deriveRows(data));
      }
    });
  }, []);

  const parseExcel = (file) =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          resolve(XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' }));
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('파일 읽기 실패'));
      reader.readAsArrayBuffer(file);
    });

  const processAndSave = async (file) => {
    setUploading(true);
    setMessage(null);
    try {
      const raw = await parseExcel(file);
      if (raw.length < 2) {
        setMessage({ type: 'error', text: '엑셀에 데이터가 없습니다' });
        setUploading(false);
        return;
      }

      const header = raw[0].map((h) => String(h).trim());
      const col = {
        boxNo: header.indexOf('박스번호'),
        orderNo: header.indexOf('발주번호'),
        sku: header.indexOf('SKU'),
        name: header.indexOf('상품명'),
        qty: header.indexOf('수량'),
        shipDate: header.indexOf('출고일자'),
        boxSpec: header.indexOf('박스규격'),
      };
      const required = ['boxNo', 'sku', 'name', 'qty', 'shipDate'];
      const missing = required.filter((k) => col[k] === -1);
      if (missing.length) {
        const map = { boxNo: '박스번호', sku: 'SKU', name: '상품명', qty: '수량', shipDate: '출고일자' };
        setMessage({ type: 'error', text: `엑셀에 필수 컬럼이 없습니다: ${missing.map((k) => map[k]).join(', ')}` });
        setUploading(false);
        return;
      }

      // 1) 라인아이템 파싱
      const items = [];
      for (let i = 1; i < raw.length; i++) {
        const r = raw[i];
        if (!r) continue;
        const boxNo = String(r[col.boxNo] || '').trim();
        const sku = String(r[col.sku] || '').trim();
        if (!boxNo || !sku) continue;
        const { productName, optionName } = splitName(r[col.name]);
        items.push({
          boxNo,
          orderNo: col.orderNo >= 0 ? String(r[col.orderNo] || '').trim() : '',
          sku,
          productName,
          optionName,
          qty: Number(r[col.qty]) || 0,
          date: toDateStr(r[col.shipDate]),
          boxSpec: col.boxSpec >= 0 ? String(r[col.boxSpec] || '').trim() : '',
        });
      }
      if (!items.length) {
        setMessage({ type: 'error', text: '유효한 출고 데이터가 없습니다' });
        setUploading(false);
        return;
      }

      // 2) 상품명별 옵션 로스터(파일 전체 기준) + SKU→이름 맵
      const roster = new Map(); // productName -> Set(sku)
      const skuName = new Map(); // sku -> {productName, optionName}
      for (const it of items) {
        if (!roster.has(it.productName)) roster.set(it.productName, new Set());
        roster.get(it.productName).add(it.sku);
        skuName.set(it.sku, { productName: it.productName, optionName: it.optionName });
      }

      // 3) (박스번호+출고일자) 단위로 묶기
      const boxes = new Map();
      for (const it of items) {
        const k = `${it.boxNo}|${it.date}`;
        if (!boxes.has(k)) boxes.set(k, []);
        boxes.get(k).push(it);
      }

      // 4) 이번 업로드 후보 집계
      const agg = new Map(); // sku -> { confirmed, pending, anySpec }
      const ensure = (sku) => {
        if (!agg.has(sku)) agg.set(sku, { confirmed: null, pending: null, anySpec: '' });
        return agg.get(sku);
      };
      for (const [, list] of boxes) {
        const byProd = new Map();
        for (const it of list) {
          if (!byProd.has(it.productName)) byProd.set(it.productName, []);
          byProd.get(it.productName).push(it);
        }
        const numProducts = byProd.size;
        for (const [prod, pitems] of byProd) {
          const skus = new Set(pitems.map((x) => x.sku));
          const subtotal = pitems.reduce((s, x) => s + x.qty, 0);
          const specItem = pitems.find((x) => x.boxSpec);
          const boxSpec = specItem ? specItem.boxSpec : '';
          const rep = pitems[0];
          const ev = { qty: subtotal, date: rep.date, orderNo: rep.orderNo, boxNo: rep.boxNo, boxSpec };

          if (numProducts === 1 && skus.size === 1) {
            // 단일 상품·단일 옵션이 박스를 독차지 → 확정
            const a = ensure(rep.sku);
            if (!a.confirmed || subtotal > a.confirmed.qty) a.confirmed = ev;
            if (boxSpec && !a.anySpec) a.anySpec = boxSpec;
          } else {
            // 같은상품 여러옵션(multiOption) 또는 다른상품 혼재(mixed) → 미확정
            const kind = numProducts === 1 ? 'multiOption' : 'mixed';
            const opts = roster.get(prod) || new Set();
            for (const sku of opts) {
              const a = ensure(sku);
              if (!a.pending || subtotal > a.pending.qty) a.pending = { ...ev, kind };
              if (boxSpec && !a.anySpec) a.anySpec = boxSpec;
            }
          }
        }
      }

      // 5) 최신 파일 하나로 전체 재계산 → 교체(최신화). 과거 저장분과 병합하지 않음.
      const next = {};
      for (const [sku, a] of agg) {
        const nm = skuName.get(sku) || {};
        next[sku] = {
          sku,
          productName: nm.productName || '',
          optionName: nm.optionName || '',
          confirmedMax: a.confirmed ? a.confirmed.qty : null,
          confirmedEv: a.confirmed || null,
          pendingMax: a.pending ? a.pending.qty : null,
          pendingEv: a.pending || null,
          anySpec: a.anySpec || (a.confirmed && a.confirmed.boxSpec) || (a.pending && a.pending.boxSpec) || '',
        };
      }

      const ok = await dbStoreSet(DB_KEY, next, { logDesc: `카톤 규격 최신화 (${file.name} · SKU ${agg.size}건)` });
      if (ok) {
        const derived = deriveRows(next);
        setRows(derived);
        const conf = derived.filter((r) => r.status === 'confirmed').length;
        setMessage({ type: 'success', text: `반영 완료 · 총 ${derived.length} SKU (확정 ${conf} / 미확정 ${derived.length - conf})` });
      } else {
        setMessage({ type: 'error', text: 'DB 저장 실패. 다시 시도해 주세요.' });
      }
    } catch (err) {
      console.error('카톤 규격 업로드 에러:', err);
      setMessage({ type: 'error', text: `파일 처리 실패: ${err.message}` });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleFile = (file) => {
    if (!file) return;
    if (!file.name.match(/\.xlsx?$/i)) {
      setMessage({ type: 'error', text: '엑셀 파일(.xlsx)만 업로드 가능합니다' });
      return;
    }
    processAndSave(file);
  };

  const handleDownload = () => {
    const out = rows.filter((r) => filter === 'all' || r.status === filter);
    const aoa = [['상태', 'SKU', '상품명', '옵션', '박스규격', '박스입수량', '관련근거']];
    for (const r of out) {
      aoa.push([
        r.status === 'confirmed' ? '확정' : '미확정',
        r.sku,
        r.productName || '',
        r.optionName || '',
        r.boxSpec || '',
        r.qty,
        evidenceText(r),
      ]);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '카톤규격');
    XLSX.writeFile(wb, `카톤규격_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const shown = rows.filter((r) => filter === 'all' || r.status === filter);
  const confCount = rows.filter((r) => r.status === 'confirmed').length;

  const cell = { textAlign: 'center' };

  return (
    <div>
      {/* 업로드 영역 */}
      <div
        className={`upload-area ${isDragOver ? 'drag-over' : ''}`}
        style={{ padding: '36px 24px', opacity: uploading ? 0.6 : 1, marginBottom: 20 }}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragOver(false); handleFile(e.dataTransfer.files[0]); }}
        onClick={() => !uploading && fileRef.current?.click()}
      >
        <input ref={fileRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }} onChange={(e) => handleFile(e.target.files[0])} />
        <div className="icon">{uploading ? '⏳' : '📦'}</div>
        <h3>{uploading ? '처리 중...' : '출고내역서 엑셀 업로드'}</h3>
        <p>엑셀을 드래그하거나 클릭하여 업로드 · 최신값으로 카톤 입수량/규격을 누적 최신화합니다</p>
      </div>

      {message && (
        <div style={{
          padding: '12px 16px', borderRadius: 8, marginBottom: 16,
          background: message.type === 'success' ? '#e8f5e9' : '#ffeef0',
          color: message.type === 'success' ? '#2e7d32' : '#d32f2f',
          fontSize: 14, fontWeight: 500, textAlign: 'center',
        }}>
          {message.type === 'success' ? '✓' : '✕'} {message.text}
        </div>
      )}

      {rows.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2>카톤 규격 아카이브</h2>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <div style={{ display: 'flex', gap: 4 }}>
                {[['all', `전체 ${rows.length}`], ['confirmed', `확정 ${confCount}`], ['pending', `미확정 ${rows.length - confCount}`]].map(([v, label]) => (
                  <button
                    key={v}
                    className="btn btn-sm"
                    onClick={() => setFilter(v)}
                    style={{
                      padding: '6px 12px', borderRadius: 6, cursor: 'pointer', fontSize: 13,
                      border: '1px solid var(--border)',
                      background: filter === v ? 'var(--primary)' : '#fff',
                      color: filter === v ? '#fff' : 'var(--text-secondary)',
                    }}
                  >{label}</button>
                ))}
              </div>
              <button className="btn btn-sm" onClick={handleDownload} style={{ padding: '6px 14px', borderRadius: 6, cursor: 'pointer', fontSize: 13, background: '#2e7d32', color: '#fff', border: 'none' }}>
                ⬇ 엑셀 다운로드
              </button>
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th style={cell}>상태</th>
                  <th style={cell}>SKU</th>
                  <th style={cell}>상품명</th>
                  <th style={cell}>옵션</th>
                  <th style={cell}>박스규격</th>
                  <th style={cell}>박스입수량</th>
                  <th style={cell}>관련근거</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.sku}>
                    <td style={cell}>
                      <span style={{
                        display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 12, fontWeight: 600,
                        background: r.status === 'confirmed' ? '#e8f5e9' : '#fff3e0',
                        color: r.status === 'confirmed' ? '#2e7d32' : '#e65100',
                      }}>{r.status === 'confirmed' ? '확정' : '미확정'}</span>
                    </td>
                    <td style={{ ...cell, fontSize: 12 }}>{r.sku}</td>
                    <td style={cell}>{r.productName}</td>
                    <td style={cell}>{r.optionName}</td>
                    <td style={cell}>{r.boxSpec || '—'}</td>
                    <td style={{ ...cell, fontWeight: 700 }}>
                      {r.qty}{r.status === 'pending' && <span style={{ color: '#e65100', fontWeight: 500, fontSize: 12 }}> (미확정)</span>}
                    </td>
                    <td style={{ ...cell, fontSize: 12, color: 'var(--text-secondary)' }}>{evidenceText(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
