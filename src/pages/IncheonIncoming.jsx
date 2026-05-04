import { useState, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import XLSX_STYLE from 'xlsx-js-style';
import { dbStoreGet } from '../utils/dbApi';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`;
const CSV_BARCODE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('쿠팡바코드')}`;
const CSV_SPECIAL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('특별 관리 상품')}`;

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

function safeNum(v) {
  if (!v || v === '-') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

export default function IncheonIncoming() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [data, setData] = useState(null); // { items: [{barcode, productName, optionName, incomingQty, center}] }
  const [oneTimeMap, setOneTimeMap] = useState({}); // barcode → 기타(1회성) 존재 여부
  const [vocNames, setVocNames] = useState([]); // VOC 상품명 키워드 목록
  const [orderFile, setOrderFile] = useState(null); // 주문목록 파일명
  const [orderMap, setOrderMap] = useState({}); // key: "상품명||옵션명" → 합산 주문수량
  const [waitBarcodes, setWaitBarcodes] = useState(new Set()); // 대기필요 바코드 목록
  const [waitInput, setWaitInput] = useState('');
  const [showWaitInput, setShowWaitInput] = useState(false);
  const orderFileRef = useRef();

  // 1) 스프레드시트에서 재고 입고 데이터 가져오기
  const fetchData = useCallback(async () => {
    setLoading(true);
    setStatus('스프레드시트 데이터 가져오는 중...');
    try {
      const [calcRes, barcodeRes, specialRes, impData] = await Promise.all([
        fetch(TSV_CALC), fetch(CSV_BARCODE), fetch(CSV_SPECIAL),
        dbStoreGet('improvement_items').catch(() => null)
      ]);

      // 쿠팡바코드 시트: barcode(col5) → center(col11)
      const centerMap = {};
      if (barcodeRes.ok) {
        const csv = await barcodeRes.text();
        const rows = parseCSV(csv);
        for (let i = 1; i < rows.length; i++) {
          const cols = rows[i];
          const barcode = (cols[5] || '').trim();
          const center = (cols[11] || '').trim();
          if (barcode) centerMap[barcode] = center;
        }
      }

      // 특별 관리 상품 시트: barcode(col0) → 기타(1회성)(col8)
      // 헤더 셀에 줄바꿈이 포함되어 parseCSV가 여러 행으로 분리하므로,
      // 바코드 형식(S+숫자)으로 실제 데이터 행만 필터링
      const specialOneTimeMap = {};
      if (specialRes.ok) {
        const csv = await specialRes.text();
        const rows = parseCSV(csv);
        for (let i = 0; i < rows.length; i++) {
          const cols = rows[i];
          const barcode = (cols[0] || '').trim();
          const oneTime = (cols[8] || '').trim();
          if (/^S\d+$/.test(barcode) && oneTime) specialOneTimeMap[barcode] = true;
        }
      }
      setOneTimeMap(specialOneTimeMap);

      // VOC: 상품개선 DB에서 CSV·VOC 유형 + 시작전/처리중
      const newVocNames = [];
      if (Array.isArray(impData)) {
        for (const item of impData) {
          if (item.type === 'CSV·VOC' && (item.status === '시작전' || item.status === '처리중') && item.productName) {
            newVocNames.push(item.productName);
          }
        }
      }
      setVocNames(newVocNames);

      // 재고 계산기 시트: P열(cols[15]) = (1) 재고 입고
      const items = [];
      if (calcRes.ok) {
        const tsv = await calcRes.text();
        const lines = tsv.split('\n').filter(l => l.trim());
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split('\t');
          const barcode = (cols[2] || '').trim();
          const productName = (cols[3] || '').trim();
          const optionName = (cols[4] || '').trim();
          const incomingQty = safeNum(cols[15]); // P열 = (1) 재고 입고

          if (!barcode || incomingQty <= 0) continue;

          items.push({
            barcode,
            productName,
            optionName,
            displayName: `${productName}, ${optionName}`,
            incomingQty,
            center: centerMap[barcode] || '',
          });
        }
      }

      setData({ items });
      setStatus('');
    } catch (err) {
      setStatus('오류: ' + err.message);
    }
    setLoading(false);
  }, []);

  // 2) 주문목록 엑셀 업로드 처리
  const processOrderFile = useCallback(async (file) => {
    if (!file) return;
    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });
      const newOrderMap = {};

      for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        for (let i = 1; i < rows.length; i++) {
          const row = rows[i];
          const qty = safeNum(row[3]);      // D열 (0-indexed: 3) 주문수량
          const name = String(row[4] || '').trim();  // E열 상품명
          const option = String(row[5] || '').trim(); // F열 옵션명
          if (!name || qty <= 0) continue;
          const key = `${name}||${option}`;
          newOrderMap[key] = (newOrderMap[key] || 0) + qty;
        }
      }

      setOrderMap(newOrderMap);
      setOrderFile(file.name);
    } catch (err) {
      alert('주문목록 파일 처리 오류: ' + err.message);
    }
  }, []);

  // 3) 대기필요 바코드 추가
  const addWaitBarcodes = useCallback(() => {
    const lines = waitInput.split(/[\n\r,\t]+/).map(s => s.trim()).filter(Boolean);
    if (lines.length === 0) return;
    setWaitBarcodes(prev => {
      const next = new Set(prev);
      lines.forEach(b => next.add(b));
      return next;
    });
    setWaitInput('');
    setShowWaitInput(false);
  }, [waitInput]);

  // VOC 체크 (상품명 키워드 매칭)
  const isVoc = (productName) => {
    if (!productName || vocNames.length === 0) return false;
    return vocNames.some(keyword => productName.includes(keyword));
  };

  // 비고 생성
  const getRemark = (item) => {
    const remarks = [];
    // 윙 발송 체크
    const key = `${item.productName}||${item.optionName}`;
    if (orderMap[key]) {
      remarks.push(`${orderMap[key]}개 윙 발송`);
    }
    // VOC 체크
    if (isVoc(item.productName)) {
      remarks.push('VOC');
    }
    // 특별관리 체크
    if (oneTimeMap[item.barcode]) {
      remarks.push('특별관리');
    }
    // 대기필요 체크
    if (waitBarcodes.has(item.barcode)) {
      remarks.push('대기필요');
    }
    return remarks.join(', ');
  };

  // 4) 엑셀 다운로드
  const handleExport = () => {
    if (!data) return;
    const wb = XLSX_STYLE.utils.book_new();

    const headerRow = ['쿠팡바코드', '상품명', '재고 입고 수량', '입고 센터', '비고'];
    const wsData = [headerRow];

    for (const item of data.items) {
      wsData.push([
        item.barcode,
        item.displayName,
        item.incomingQty,
        item.center,
        getRemark(item),
      ]);
    }

    const ws = XLSX_STYLE.utils.aoa_to_sheet(wsData);

    // 스타일 적용
    const baseFont = { name: 'Arial', sz: 10 };
    const baseAlign = { horizontal: 'center', vertical: 'center' };
    const borderThin = {
      top: { style: 'thin', color: { rgb: 'FFD0D0D0' } },
      bottom: { style: 'thin', color: { rgb: 'FFD0D0D0' } },
      left: { style: 'thin', color: { rgb: 'FFD0D0D0' } },
      right: { style: 'thin', color: { rgb: 'FFD0D0D0' } },
    };

    const range = XLSX_STYLE.utils.decode_range(ws['!ref']);
    for (let r = range.s.r; r <= range.e.r; r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const ref = XLSX_STYLE.utils.encode_cell({ r, c });
        if (!ws[ref]) ws[ref] = { v: '', t: 's' };

        if (r === 0) {
          // 헤더
          ws[ref].s = {
            font: { ...baseFont, bold: true, color: { rgb: 'FFFFFFFF' } },
            fill: { patternType: 'solid', fgColor: { rgb: 'FF1A73E8' } },
            border: borderThin,
            alignment: { ...baseAlign },
          };
        } else {
          // 수량 열은 숫자 타입
          if (c === 2) {
            ws[ref].v = Number(ws[ref].v) || 0;
            ws[ref].t = 'n';
          }
          ws[ref].s = {
            font: { ...baseFont },
            border: borderThin,
            alignment: c === 1 ? { horizontal: 'left', vertical: 'center' } : { ...baseAlign },
          };
        }
      }
    }

    ws['!cols'] = [
      { wch: 16 },  // 쿠팡바코드
      { wch: 55 },  // 상품명
      { wch: 14 },  // 재고 입고 수량
      { wch: 14 },  // 입고 센터
      { wch: 18 },  // 비고
    ];

    XLSX_STYLE.utils.book_append_sheet(wb, ws, '인천입고신청');

    const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    XLSX_STYLE.writeFile(wb, `인천입고신청_${today}.xlsx`);
  };

  const totalQty = data ? data.items.reduce((s, i) => s + i.incomingQty, 0) : 0;

  return (
    <div>
      {/* 데이터 미로드 상태 */}
      {!data && !loading && (
        <div className="card" style={{ textAlign: 'center', padding: 60 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>🚢</div>
          <h2 style={{ marginBottom: 8 }}>인천입고신청</h2>
          <p style={{ color: '#666', marginBottom: 24 }}>스프레드시트에서 재고 입고 데이터를 가져옵니다</p>
          <button className="btn btn-primary" onClick={fetchData} style={{ fontSize: 15, padding: '10px 32px' }}>
            데이터 가져오기
          </button>
        </div>
      )}

      {loading && (
        <div className="loading" style={{ padding: 40, flexDirection: 'column', gap: 8 }}>
          <div className="spinner" />
          <p>{status}</p>
        </div>
      )}

      {/* 결과 */}
      {data && (
        <div>
          {/* 상단 요약 */}
          <div className="stats-grid" style={{ marginBottom: 16 }}>
            <div className="stat-card" style={{ padding: 20, background: '#1a73e8', color: '#fff' }}>
              <div className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>입고 품목</div>
              <div className="value" style={{ color: '#fff', fontSize: 32 }}>
                {data.items.length}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>건</span>
              </div>
            </div>
            <div className="stat-card" style={{ padding: 20 }}>
              <div className="label">총 입고 수량</div>
              <div className="value" style={{ fontSize: 32 }}>
                {totalQty.toLocaleString()}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>개</span>
              </div>
            </div>
            <div className="stat-card" style={{ padding: 20 }}>
              <div className="label">윙 발송 매칭</div>
              <div className="value" style={{ fontSize: 32, color: Object.keys(orderMap).length > 0 ? '#1a73e8' : '#999' }}>
                {orderFile ? data.items.filter(item => orderMap[`${item.productName}||${item.optionName}`]).length : '-'}
                {orderFile && <span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>건</span>}
              </div>
              <div className="sub" style={{ fontSize: 11, color: '#999' }}>{orderFile || '주문목록 미업로드'}</div>
            </div>
            <div className="stat-card" style={{ padding: 20 }}>
              <div className="label">대기필요</div>
              <div className="value" style={{ fontSize: 32, color: waitBarcodes.size > 0 ? '#e65100' : '#999' }}>
                {waitBarcodes.size > 0 ? data.items.filter(item => waitBarcodes.has(item.barcode)).length : '-'}
                {waitBarcodes.size > 0 && <span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>건</span>}
              </div>
              <div className="sub" style={{ fontSize: 11, color: '#999' }}>등록 바코드: {waitBarcodes.size}개</div>
            </div>
          </div>

          {/* 액션 버튼 바 */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-body">
              <div className="filter-bar" style={{ flexWrap: 'wrap', gap: 8 }}>
                <button className="btn btn-primary btn-sm" onClick={handleExport}>
                  📥 엑셀 다운로드
                </button>
                <button className="btn btn-outline btn-sm" onClick={() => orderFileRef.current?.click()}>
                  📋 주문목록 업로드 {orderFile && '✓'}
                </button>
                <input
                  ref={orderFileRef}
                  type="file"
                  accept=".xlsx,.xls"
                  onChange={e => processOrderFile(e.target.files?.[0])}
                  style={{ display: 'none' }}
                />
                <button
                  className={`btn btn-sm ${showWaitInput ? 'btn-primary' : 'btn-outline'}`}
                  onClick={() => setShowWaitInput(!showWaitInput)}
                >
                  ⏳ 대기필요 등록 {waitBarcodes.size > 0 && `(${waitBarcodes.size})`}
                </button>
                <div style={{ flex: 1 }} />
                <button className="btn btn-outline btn-sm" onClick={fetchData}>🔄 새로고침</button>
              </div>
            </div>
          </div>

          {/* 대기필요 입력 영역 */}
          {showWaitInput && (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header">
                <h2 style={{ fontSize: 14, fontWeight: 600 }}>대기필요 바코드 등록</h2>
                {waitBarcodes.size > 0 && (
                  <button
                    className="btn btn-outline btn-sm"
                    style={{ fontSize: 11, color: '#d32f2f' }}
                    onClick={() => setWaitBarcodes(new Set())}
                  >
                    전체 삭제
                  </button>
                )}
              </div>
              <div className="card-body">
                <p style={{ fontSize: 12, color: '#666', marginBottom: 8 }}>
                  바코드를 복사하여 붙여넣기 하세요. (줄바꿈, 쉼표, 탭으로 구분)
                </p>
                <textarea
                  value={waitInput}
                  onChange={e => setWaitInput(e.target.value)}
                  placeholder="바코드를 붙여넣기..."
                  style={{
                    width: '100%', minHeight: 80, padding: 10, border: '1px solid #ddd',
                    borderRadius: 6, fontSize: 13, fontFamily: 'monospace', resize: 'vertical',
                    boxSizing: 'border-box',
                  }}
                />
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={addWaitBarcodes}>등록</button>
                  <button className="btn btn-outline btn-sm" onClick={() => { setShowWaitInput(false); setWaitInput(''); }}>취소</button>
                </div>
                {waitBarcodes.size > 0 && (
                  <div style={{ marginTop: 12, fontSize: 12, color: '#666' }}>
                    <strong>등록된 바코드 ({waitBarcodes.size}개):</strong>
                    <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {[...waitBarcodes].map(b => (
                        <span
                          key={b}
                          style={{
                            display: 'inline-flex', alignItems: 'center', gap: 4,
                            background: '#fff3e0', padding: '2px 8px', borderRadius: 4, fontSize: 11,
                          }}
                        >
                          {b}
                          <span
                            style={{ cursor: 'pointer', color: '#d32f2f', fontWeight: 700 }}
                            onClick={() => setWaitBarcodes(prev => { const n = new Set(prev); n.delete(b); return n; })}
                          >×</span>
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* 데이터 테이블 */}
          <div className="card">
            <div className="card-header">
              <h2 style={{ fontSize: 15, fontWeight: 600 }}>재고 입고 목록</h2>
              <span style={{ fontSize: 12, color: '#666' }}>{data.items.length}건</span>
            </div>
            <div className="card-body" style={{ padding: 0 }}>
              <div className="table-wrapper" style={{ maxHeight: 600, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 40 }}>No</th>
                      <th>쿠팡바코드</th>
                      <th>상품명</th>
                      <th className="num">입고 수량</th>
                      <th>입고 센터</th>
                      <th>비고</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item, i) => {
                      const remark = getRemark(item);
                      const hasWing = orderMap[`${item.productName}||${item.optionName}`];
                      const hasVoc = isVoc(item.productName);
                      const hasOneTime = oneTimeMap[item.barcode];
                      const hasWait = waitBarcodes.has(item.barcode);
                      return (
                        <tr key={i}>
                          <td style={{ color: '#999', fontSize: 11 }}>{i + 1}</td>
                          <td style={{ fontSize: 12, fontFamily: 'monospace' }}>{item.barcode}</td>
                          <td style={{ fontSize: 12, maxWidth: 350, overflow: 'hidden', textOverflow: 'ellipsis', textAlign: 'left' }}>
                            {item.displayName}
                          </td>
                          <td className="num" style={{ fontWeight: 600 }}>{item.incomingQty.toLocaleString()}</td>
                          <td style={{ fontSize: 12 }}>{item.center || '-'}</td>
                          <td style={{ fontSize: 12 }}>
                            {hasWing && (
                              <span style={{
                                background: '#e8f0fe', color: '#1a73e8', padding: '2px 6px',
                                borderRadius: 4, fontSize: 11, fontWeight: 600, marginRight: 4,
                              }}>
                                {orderMap[`${item.productName}||${item.optionName}`]}개 윙 발송
                              </span>
                            )}
                            {hasVoc && (
                              <span style={{
                                background: '#fce4ec', color: '#c62828', padding: '2px 6px',
                                borderRadius: 4, fontSize: 11, fontWeight: 600, marginRight: 4,
                              }}>
                                VOC
                              </span>
                            )}
                            {hasOneTime && (
                              <span style={{
                                background: '#f3e5f5', color: '#7b1fa2', padding: '2px 6px',
                                borderRadius: 4, fontSize: 11, fontWeight: 600, marginRight: 4,
                              }}>
                                특별관리
                              </span>
                            )}
                            {hasWait && (
                              <span style={{
                                background: '#fff3e0', color: '#e65100', padding: '2px 6px',
                                borderRadius: 4, fontSize: 11, fontWeight: 600,
                              }}>
                                대기필요
                              </span>
                            )}
                            {!remark && '-'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
