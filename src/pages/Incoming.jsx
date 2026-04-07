import { useState, useCallback, useRef } from 'react';
import * as XLSX from 'xlsx';
import XLSX_STYLE from 'xlsx-js-style';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const CSV_BARCODE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('쿠팡바코드')}`;
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`;

// 색상
const COLOR_YELLOW = 'FFFFFF00';     // 고양, 시흥
const COLOR_GREEN = 'FFC6EFCE';      // 경기광주, 안성
const COLOR_GRAY = 'FFF2F2F2';       // 박스히어로

const TARGET_WEEKS = 6;

function parseCsvRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { result.push(current); current = ''; }
      else current += ch;
    }
  }
  result.push(current);
  return result;
}

function safeNum(v) {
  if (!v || v === '-') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

function getCenterColor(center) {
  if (!center) return null;
  if (center.includes('고양') || center.includes('시흥')) return COLOR_YELLOW;
  if (center.includes('경기광주') || center.includes('안성')) return COLOR_GREEN;
  return null;
}

function parseDateFromFilename(name) {
  const m = name.match(/(\d{6})/);
  if (!m) return '';
  const d = m[1];
  return `20${d.slice(0,2)}-${d.slice(2,4)}-${d.slice(4,6)}`;
}

export default function Incoming() {
  const [loading, setLoading] = useState(false);
  const [status, setStatus] = useState('');
  const [result, setResult] = useState(null); // { fileName, sheets: [{name, rows, stats}] }
  const [isDragOver, setIsDragOver] = useState(false);
  const fileRef = useRef();

  const processFile = useCallback(async (file) => {
    if (!file) return;
    setLoading(true);
    setStatus('스프레드시트 데이터 가져오는 중...');

    try {
      // 1) Fetch 쿠팡바코드 (바코드→입고센터 매핑) + 재고계산기 (바코드→총재고/예상판매주/avg판매)
      const [barcodeRes, calcRes] = await Promise.all([fetch(CSV_BARCODE), fetch(TSV_CALC)]);

      // 쿠팡바코드: barcode(col6) → center(col12)
      const centerMap = {};
      if (barcodeRes.ok) {
        const csv = await barcodeRes.text();
        const lines = csv.split('\n').filter(l => l.trim());
        for (let i = 1; i < lines.length; i++) {
          const cols = parseCsvRow(lines[i]);
          const barcode = (cols[5] || '').trim();
          const center = (cols[11] || '').trim();
          if (barcode) centerMap[barcode] = center;
        }
      }

      // 재고계산기: barcode(col2) → { stock, incoming, ipgo, weeksCI }
      // col6=쿠팡재고, col7=그로스입고예정, col8=입고, col21=쿠팡재고+입고예정 예상판매주
      const stockMap = {};
      if (calcRes.ok) {
        const tsv = await calcRes.text();
        const lines = tsv.split('\n').filter(l => l.trim());
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i].split('\t');
          const barcode = (cols[2] || '').trim();
          if (!barcode) continue;
          const coupangStock = safeNum(cols[6]);      // 쿠팡재고
          const incoming = safeNum(cols[7]);           // 그로스 입고예정
          const ipgo = safeNum(cols[8]);               // 입고
          const weeksCI = safeNum(cols[21]);           // 쿠팡재고+입고예정 예상판매주
          // 스프레드시트의 예상판매주는 재고+입고예정+입고를 모두 포함하여 계산됨
          const stockAll = coupangStock + incoming + ipgo;
          const weeklySales = weeksCI > 0 ? stockAll / weeksCI : 0;
          stockMap[barcode] = {
            coupangStock,
            incoming,
            ipgo,
            stockAll,
            weeksCI,
            weeklySales,
          };
        }
      }

      setStatus('엑셀 파일 분석 중...');

      // 2) Read uploaded Excel
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: 'array' });

      const sheetsResult = [];

      for (const sheetName of wb.SheetNames) {
        const ws = wb.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (data.length < 3) continue;

        // 같은 바코드의 출고수량 합산 (이 시트 내)
        const skuQtyMap = {};
        for (let i = 2; i < data.length; i++) {
          const row = data[i];
          const sku = String(row[2] || '').trim();
          const qty = safeNum(row[4]);
          if (!sku || sku === '총합계') continue;
          skuQtyMap[sku] = (skuQtyMap[sku] || 0) + qty;
        }

        // 각 바코드별로 센터 결정 + 쿠팡입고 vs 박스히어로 판단
        // 기준: (쿠팡재고 + 입고예정 + 투입수량)이 6주가 되는 만큼만 쿠팡
        const skuDecisionMap = {};
        for (const [sku, totalQty] of Object.entries(skuQtyMap)) {
          const center = centerMap[sku] || '';
          const stock = stockMap[sku] || { coupangStock: 0, incoming: 0, ipgo: 0, stockAll: 0, weeksCI: 0, weeklySales: 0 };
          const weeklySales = stock.weeklySales;

          if (weeklySales <= 0) {
            // 판매량 없으면 무조건 박스히어로
            skuDecisionMap[sku] = { center, qty: totalQty, coupangQty: 0, boxheroQty: totalQty };
            continue;
          }

          // 6주 맞추려면 필요한 총 재고
          const targetStock = TARGET_WEEKS * weeklySales;
          const needed = Math.max(0, Math.ceil(targetStock - stock.stockAll));
          const coupangQty = Math.min(needed, totalQty);

          skuDecisionMap[sku] = {
            center,
            qty: totalQty,
            coupangQty,
            boxheroQty: totalQty - coupangQty,
          }
        }

        // 원본 Row 0 (브랜드코드), Row 1 (헤더) 보존
        const brandCode = data[0] || [];
        const headerRow = data[1] || [];

        // 우측 요약 테이블 보존 (col 7~10: 빈칸, SKU, 라벨명, 합계)
        // 우측 요약: col8=SKU, col9=라벨명, col10=합계 (col7은 빈 구분열이라 스킵)
        const rightSideRows = data.map(row => [row[8] || '', row[9] || '', row[10] || '']);

        // 행별로 F열 결정 + 색상 결정
        const processedRows = [];
        const skuCoupangUsed = {};

        for (let i = 2; i < data.length; i++) {
          const row = data[i];
          const boxNo = String(row[0] || '').trim();
          const orderNo = String(row[1] || '').trim();
          const sku = String(row[2] || '').trim();
          const label = String(row[3] || '');
          const qty = safeNum(row[4]);

          if (!sku || !boxNo) continue;

          const isNew = orderNo.toUpperCase().includes('NEW');
          const decision = skuDecisionMap[sku];

          let assignedCenter = '';
          let cellColor = null;

          let splitCoupang = 0;
          let splitBoxhero = 0;

          if (isNew) {
            // NEW → 무조건 박스히어로
            assignedCenter = '박스히어로 입고';
            cellColor = null;
          } else if (decision) {
            const used = skuCoupangUsed[sku] || 0;
            const remaining = decision.coupangQty - used;

            if (remaining >= qty) {
              // 이 행 전부 쿠팡
              assignedCenter = decision.center || '';
              cellColor = getCenterColor(decision.center);
              skuCoupangUsed[sku] = used + qty;
            } else if (remaining > 0) {
              // 이 행 내에서 분리: 일부 쿠팡 + 일부 박스히어로
              splitCoupang = remaining;
              splitBoxhero = qty - remaining;
              assignedCenter = `${decision.center || '쿠팡'} ${splitCoupang}개 / 박스히어로 ${splitBoxhero}개`;
              cellColor = getCenterColor(decision.center); // 쿠팡 색상 우선
              skuCoupangUsed[sku] = used + remaining;
            } else {
              // 쿠팡 할당 소진 → 전부 박스히어로
              assignedCenter = '박스히어로 입고';
              cellColor = null;
            }
          }

          processedRows.push({
            rowIdx: i,
            boxNo, orderNo, sku, label, qty,
            center: assignedCenter,
            cellColor,
            isNew,
            isSplit: splitCoupang > 0,
            splitCoupang,
            splitBoxhero,
          });
        }

        // 통계: 박스 단위 (같은 상자번호는 1박스)
        const allBoxes = new Set(processedRows.map(r => r.boxNo));
        const coupangBoxes = new Set(processedRows.filter(r => r.center && r.center !== '박스히어로 입고').map(r => r.boxNo));
        const boxheroBoxes = new Set(processedRows.filter(r => r.center === '박스히어로 입고' && !coupangBoxes.has(r.boxNo)).map(r => r.boxNo));

        sheetsResult.push({
          name: sheetName,
          rows: processedRows,
          brandCode,
          headerRow,
          rightSideRows,
          stats: {
            totalBoxes: allBoxes.size,
            coupangBoxes: coupangBoxes.size,
            boxheroBoxes: boxheroBoxes.size,
          },
        });
      }

      setResult({ fileName: file.name, date: parseDateFromFilename(file.name), sheets: sheetsResult });
      setStatus('');
    } catch (err) {
      setStatus('오류: ' + err.message);
    }
    setLoading(false);
  }, []);

  const handleExport = () => {
    if (!result) return;
    const wb = XLSX_STYLE.utils.book_new();

    const borderThin = {
      top: { style: 'thin', color: { rgb: 'FFD0D0D0' } },
      bottom: { style: 'thin', color: { rgb: 'FFD0D0D0' } },
      left: { style: 'thin', color: { rgb: 'FFD0D0D0' } },
      right: { style: 'thin', color: { rgb: 'FFD0D0D0' } },
    };

    for (const sheet of result.sheets) {
      // Row 0: 브랜드 코드
      const row0 = [sheet.brandCode[0] || sheet.name, '', '', '', '', '', ''];
      // Row 1: 헤더 (원본 그대로 + 우측)
      const row1 = ['상자 번호', '발주번호', 'SKU', '라벨명', '출고수량', '', '', 'SKU', '라벨명', '합계 : 출고수량'];

      const wsData = [row0, row1];

      // 데이터 행 + 우측 요약
      for (let i = 0; i < sheet.rows.length; i++) {
        const r = sheet.rows[i];
        const origIdx = r.rowIdx; // 원본 행 인덱스
        const right = sheet.rightSideRows[origIdx] || ['', '', ''];
        wsData.push([
          r.boxNo, r.orderNo, r.sku, r.label, r.qty, r.center, '',
          right[0], right[1], right[2],
        ]);
      }

      const ws = XLSX_STYLE.utils.aoa_to_sheet(wsData);

      // 기본 스타일: Arial + 가운데 정렬 → 워크시트 전체 셀에 적용
      const baseFont = { name: 'Arial', sz: 10 };
      const baseAlign = { horizontal: 'center', vertical: 'center' };
      const range = XLSX_STYLE.utils.decode_range(ws['!ref']);
      for (let r = range.s.r; r <= range.e.r; r++) {
        for (let c = range.s.c; c <= range.e.c; c++) {
          const ref = XLSX_STYLE.utils.encode_cell({ r, c });
          if (!ws[ref]) ws[ref] = { v: '', t: 's' };
          // 출고수량(E=4), 합계:출고수량(J=9) 열은 숫자 강제 (엑셀 합계 표시용)
          if (c === 4 || c === 9) {
            if (r > 1 && ws[ref].v !== '' && ws[ref].v != null) {
              ws[ref].v = Number(ws[ref].v) || 0;
              ws[ref].t = 'n';
            }
          } else if (ws[ref].t === 'n') {
            ws[ref].v = String(ws[ref].v);
            ws[ref].t = 's';
          }
          ws[ref].s = {
            font: { ...baseFont },
            alignment: { ...baseAlign },
          };
        }
      }

      // 헤더 행 스타일 (Row 1) - 기본 위에 덮어쓰기
      for (let c = 0; c <= 9; c++) {
        const ref = XLSX_STYLE.utils.encode_cell({ r: 1, c });
        if (!ws[ref]) continue;
        ws[ref].s = {
          font: { name: 'Arial', bold: true, sz: 10, color: { rgb: 'FF333333' } },
          fill: { patternType: 'solid', fgColor: { rgb: 'FFF5F5F5' } },
          border: borderThin,
          alignment: { ...baseAlign },
        };
      }

      // Row 0 스타일 (브랜드코드)
      const r0ref = XLSX_STYLE.utils.encode_cell({ r: 0, c: 0 });
      if (ws[r0ref]) {
        ws[r0ref].s = {
          font: { name: 'Arial', bold: true, sz: 11 },
          alignment: { ...baseAlign },
        };
      }

      // 데이터 행 스타일 - 색상/테두리 추가
      for (let i = 0; i < sheet.rows.length; i++) {
        const row = sheet.rows[i];
        const dataRowIdx = i + 2;

        const fillStyle = row.cellColor
          ? { patternType: 'solid', fgColor: { rgb: row.cellColor } }
          : null;

        // A~F 열 (좌측 박스 데이터)
        for (let c = 0; c <= 5; c++) {
          const ref = XLSX_STYLE.utils.encode_cell({ r: dataRowIdx, c });
          if (!ws[ref]) ws[ref] = { v: '', t: 's' };
          ws[ref].s = {
            font: { ...baseFont },
            border: borderThin,
            alignment: { ...baseAlign },
            ...(fillStyle ? { fill: fillStyle } : {}),
          };
        }

        // H~J 열 (우측 요약)
        for (let c = 7; c <= 9; c++) {
          const ref = XLSX_STYLE.utils.encode_cell({ r: dataRowIdx, c });
          if (!ws[ref]) ws[ref] = { v: '', t: 's' };
          ws[ref].s = {
            font: { ...baseFont },
            border: borderThin,
            alignment: { ...baseAlign },
          };
        }
      }

      // 컬럼 너비 (원본과 동일)
      ws['!cols'] = [
        { wch: 8 },   // A: 상자번호
        { wch: 16 },  // B: 발주번호
        { wch: 14 },  // C: SKU
        { wch: 59 },  // D: 라벨명
        { wch: 8 },   // E: 출고수량
        { wch: 13 },  // F: 입고센터
        { wch: 2 },   // G: 빈칸
        { wch: 18 },  // H: SKU
        { wch: 67 },  // I: 라벨명
        { wch: 15 },  // J: 합계
      ];

      XLSX_STYLE.utils.book_append_sheet(wb, ws, sheet.name);
    }

    XLSX_STYLE.writeFile(wb, result.fileName.replace('.xlsx', '_입고배정.xlsx'));
  };

  return (
    <div>
      {/* 업로드 */}
      {!result && (
        <div
          className={`upload-area${isDragOver ? ' dragover' : ''}`}
          style={{ marginBottom: 16 }}
          onClick={() => fileRef.current?.click()}
          onDragOver={e => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={e => { e.preventDefault(); setIsDragOver(false); processFile(e.dataTransfer.files?.[0]); }}
        >
          <div className="icon">📦</div>
          <h3>CN 그로스 입고요청 파일 업로드</h3>
          <p>AE260324_cn그로스 재고입고요청.xlsx 형식의 파일을 드래그하거나 클릭</p>
          <p style={{ fontSize: 12, color: '#999', marginTop: 8 }}>
            파일명 앞 6자리 숫자가 출고일로 인식됩니다
          </p>
          <input ref={fileRef} type="file" accept=".xlsx,.xls" onChange={e => processFile(e.target.files?.[0])} style={{ display: 'none' }} />
        </div>
      )}

      {loading && (
        <div className="loading" style={{ padding: 40, flexDirection: 'column', gap: 8 }}>
          <div className="spinner" />
          <p>{status}</p>
        </div>
      )}

      {/* 결과 */}
      {result && (
        <div>
          {/* 헤더 */}
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="card-body">
              <div className="filter-bar">
                <div>
                  <strong>{result.fileName}</strong>
                  {result.date && <span style={{ marginLeft: 8, color: '#666', fontSize: 13 }}>출고일: {result.date}</span>}
                </div>
                <div style={{ flex: 1 }} />
                <button className="btn btn-primary btn-sm" onClick={handleExport}>📥 입고배정 엑셀 다운로드</button>
                <button className="btn btn-outline btn-sm" onClick={() => setResult(null)}>🔄 새 파일</button>
              </div>
            </div>
          </div>

          {/* 금일 작업예정물량 */}
          <div className="stat-card" style={{ marginBottom: 16, padding: 20, background: '#1a73e8', color: '#fff' }}>
            <div className="label" style={{ color: 'rgba(255,255,255,0.8)' }}>금일 작업예정물량</div>
            <div className="value" style={{ color: '#fff', fontSize: 36 }}>
              {result.sheets.reduce((sum, s) => sum + s.stats.coupangBoxes, 0)}
              <span style={{ fontSize: 16, fontWeight: 400, marginLeft: 4 }}>박스</span>
            </div>
            <div className="sub" style={{ color: 'rgba(255,255,255,0.7)' }}>
              전체 브랜드 쿠팡입고 박스 합계
            </div>
          </div>

          {/* 시트별 요약 - 박스 단위 */}
          <div className="stats-grid" style={{ marginBottom: 16 }}>
            {result.sheets.map(s => (
              <div className="stat-card" key={s.name} style={{ padding: 16 }}>
                <div className="label" style={{ marginBottom: 8 }}>{s.name}</div>
                <div className="value" style={{ fontSize: 22 }}>{s.stats.coupangBoxes}<span style={{ fontSize: 13, fontWeight: 400, color: '#666' }}>박스</span></div>
                <div style={{ display: 'flex', gap: 12, marginTop: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    <span style={{ display: 'inline-block', width: 10, height: 10, background: '#FFFF00', border: '1px solid #ccc', borderRadius: 2 }} />
                    <span style={{ color: '#333' }}>{s.stats.coupangBoxes}박스</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12 }}>
                    <span style={{ display: 'inline-block', width: 10, height: 10, background: '#E0E0E0', border: '1px solid #ccc', borderRadius: 2 }} />
                    <span style={{ color: '#666' }}>{s.stats.boxheroBoxes}박스</span>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* 색상 범례 */}
          <div style={{ display: 'flex', gap: 16, marginBottom: 16, fontSize: 12, color: '#666' }}>
            <span><span style={{ display: 'inline-block', width: 14, height: 14, background: '#FFFF00', border: '1px solid #ddd', borderRadius: 2, marginRight: 4, verticalAlign: -2 }} />고양/시흥 (수도권)</span>
            <span><span style={{ display: 'inline-block', width: 14, height: 14, background: '#C6EFCE', border: '1px solid #ddd', borderRadius: 2, marginRight: 4, verticalAlign: -2 }} />경기광주/안성</span>
            <span><span style={{ display: 'inline-block', width: 14, height: 14, background: '#F2F2F2', border: '1px solid #ddd', borderRadius: 2, marginRight: 4, verticalAlign: -2 }} />박스히어로 입고</span>
          </div>

          {/* 시트별 테이블 */}
          {result.sheets.map(sheet => (
            <div className="card" key={sheet.name} style={{ marginBottom: 16 }}>
              <div className="card-header">
                <h2 style={{ fontSize: 15, fontWeight: 600 }}>{sheet.name}</h2>
                <span style={{ fontSize: 12, color: '#666' }}>
                  총 {sheet.stats.totalBoxes}박스 · 쿠팡 {sheet.stats.coupangBoxes}박스 · 박히 {sheet.stats.boxheroBoxes}박스
                </span>
              </div>
              <div className="card-body" style={{ padding: 0 }}>
                <div className="table-wrapper" style={{ maxHeight: 400, overflowY: 'auto' }}>
                  <table className="data-table">
                    <thead>
                      <tr>
                        <th>상자번호</th>
                        <th>발주번호</th>
                        <th>SKU</th>
                        <th>라벨명</th>
                        <th className="num">출고수량</th>
                        <th>입고센터</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sheet.rows.map((r, i) => {
                        const bg = r.cellColor === COLOR_YELLOW ? '#FFFF00'
                          : r.cellColor === COLOR_GREEN ? '#C6EFCE'
                          : r.cellColor === COLOR_GRAY ? '#F2F2F2'
                          : 'transparent';
                        return (
                          <tr key={i} style={{ background: bg }}>
                            <td>{r.boxNo}</td>
                            <td style={{ fontSize: 12 }}>
                              {r.orderNo}
                              {r.isNew && <span style={{ marginLeft: 4, background: '#e8f0fe', color: '#1a73e8', padding: '1px 5px', borderRadius: 3, fontSize: 10, fontWeight: 600 }}>NEW</span>}
                            </td>
                            <td style={{ fontSize: 11, color: '#666' }}>{r.sku}</td>
                            <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.label}</td>
                            <td className="num">{r.qty}</td>
                            <td style={{ fontWeight: 600, fontSize: 12 }}>
                              {r.isSplit ? (
                                <span>
                                  <span style={{ color: '#1a73e8' }}>{r.center.split('/')[0]}</span>
                                  {' / '}
                                  <span style={{ color: '#666' }}>{r.center.split('/')[1]}</span>
                                </span>
                              ) : r.center || '-'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
