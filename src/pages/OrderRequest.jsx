import { useState, useMemo, useEffect, useCallback } from 'react';
import XLSX_STYLE from 'xlsx-js-style';
import { dbStoreGet } from '../utils/dbApi';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`;
const CSV_BARCODE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('쿠팡바코드')}`;
const CSV_ORDER_FORM = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('발주서 양식')}`;
const CSV_SPECIAL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('특별 관리 상품')}`;

// 브랜드 → 코드 매핑
const BRAND_CODE = {
  '일상포인트': 'AE-I',
  '하루모음': 'AE-HM',
  '리빙스타일': 'AE-L',
  '어리플': 'AE-S',
  '룸앤업': 'AE-R',
  '펄빈': 'AE-P',
  '생활기준': 'AE-SH',
  '토글리': 'AE-T',
  '에브리잇템': 'AE-E',
  '프루드': 'AE-E',
  '로즈바운드': 'AE-B',
  '원데이홈': 'AE-O',
};

// 경기광주/안성 센터면 코드 뒤에 2 붙임
function getBrandCode(brand, center) {
  const base = BRAND_CODE[brand] || 'AE-X';
  if (center && (center.includes('경기광주') || center.includes('안성'))) {
    return base + '2';
  }
  return base;
}

function getDateCode() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return yy + mm + dd;
}

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

// CSV 전체를 줄바꿈 포함하여 행 단위로 파싱
function parseCsvRows(text) {
  const rows = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') inQuotes = false;
      else current += ch;
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === '\n' || (ch === '\r' && text[i + 1] === '\n')) {
        rows.push(parseCsvRow(current));
        current = '';
        if (ch === '\r') i++; // skip \n after \r
      } else {
        current += ch;
      }
    }
  }
  if (current.trim()) rows.push(parseCsvRow(current));
  return rows;
}

function safeNum(v) {
  if (!v || v === '-') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
}

export default function OrderRequest() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [calcRes, barcodeRes, formRes, specialRes] = await Promise.all([fetch(TSV_CALC), fetch(CSV_BARCODE), fetch(CSV_ORDER_FORM), fetch(CSV_SPECIAL)]);

      // 쿠팡바코드: barcode → { brand, center }
      const barcodeMap = {};
      if (barcodeRes.ok) {
        const csv = await barcodeRes.text();
        const lines = csv.split('\n').filter(l => l.trim());
        for (let i = 1; i < lines.length; i++) {
          const cols = parseCsvRow(lines[i]);
          const barcode = (cols[5] || '').trim();
          const brand = (cols[8] || '').trim();
          const center = (cols[11] || '').trim();
          const note = (cols[13] || '').trim(); // 비고
          if (barcode) barcodeMap[barcode] = { brand, center, note };
        }
      }

      // 발주서 양식: SKU(col2) → 비고(col4) — 줄바꿈 포함 파싱
      const formNoteMap = {};
      if (formRes.ok) {
        const csv2 = await formRes.text();
        const formRows = parseCsvRows(csv2);
        for (let i = 1; i < formRows.length; i++) {
          const cols = formRows[i];
          const sku = (cols[2] || '').trim();
          const note = (cols[4] || '').trim();
          if (sku && note) formNoteMap[sku] = note;
        }
      }

      // 특별관리 상품: SKU → { sewing, fbcItem, oneTime }
      const specialMap = {};
      if (specialRes.ok) {
        const spCsv = await specialRes.text();
        const spRows = parseCsvRows(spCsv);
        for (let i = 1; i < spRows.length; i++) {
          const cols = spRows[i];
          const sku = (cols[0] || '').trim();
          if (sku) {
            specialMap[sku] = {
              sewing: (cols[5] || '').trim(),
              fbcItem: (cols[6] || '').trim(),
              oneTime: (cols[8] || '').trim(),
            };
          }
        }
      }

      // 재고 계산기: Q열(col16)에 수량이 있는 행만
      const rows = [];
      if (calcRes.ok) {
        const tsv = await calcRes.text();
        const tsvLines = tsv.split('\n').filter(l => l.trim());
        for (let i = 1; i < tsvLines.length; i++) {
          const c = tsvLines[i].split('\t');
          const qtyRaw = (c[16] || '').trim();
          if (!qtyRaw || safeNum(qtyRaw) <= 0) continue;

          const sku = (c[2] || '').trim();
          const productName = (c[3] || '').trim();
          const optionName = (c[4] || '').trim();
          const qty = safeNum(qtyRaw);
          const bcInfo = barcodeMap[sku] || {};
          const brand = bcInfo.brand || '';
          const center = bcInfo.center || '';
          const totalWeeks = safeNum(c[22]); // W열(col22) = 총재고 예상 판매 주
          const note = formNoteMap[sku] || bcInfo.note || '';
          const brandCode = getBrandCode(brand, center);
          const suffix = totalWeeks < 3.5 ? '-JJ' : '';
          const orderNo = brandCode + '-' + getDateCode() + suffix;

          const sp = specialMap[sku] || {};
          rows.push({
            sku,
            productName: productName + (optionName ? ' ' + optionName : ''),
            qty,
            brand,
            center,
            brandCode,
            orderNo,
            totalWeeks,
            note,
            sewing: sp.sewing || '',
            fbcItem: sp.fbcItem || '',
            oneTime: sp.oneTime || '',
          });
        }
      }

      setData(rows);
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // 발주번호별 그룹
  const grouped = useMemo(() => {
    if (!data) return [];
    const map = {};
    for (const row of data) {
      if (!map[row.orderNo]) map[row.orderNo] = [];
      map[row.orderNo].push(row);
    }
    return Object.entries(map).sort((a, b) => a[0].localeCompare(b[0]));
  }, [data]);

  const [copiedGroup, setCopiedGroup] = useState(null);
  const [copiedAll, setCopiedAll] = useState(false);
  const [imgCounts, setImgCounts] = useState({});
  const [photoModal, setPhotoModal] = useState(null); // { items: [...] }
  const [photoIdx, setPhotoIdx] = useState(0);
  const [photoLoading, setPhotoLoading] = useState(false);

  // 이슈관리 이미지 카운트 로드
  useEffect(() => {
    dbStoreGet('issue_img_counts').then(counts => {
      if (counts && typeof counts === 'object') setImgCounts(counts);
    }).catch(() => {});
  }, []);

  const totalItems = data ? data.length : 0;
  const totalQty = data ? data.reduce((s, r) => s + r.qty, 0) : 0;

  // 탭 구분 복사 (엑셀 붙여넣기용) — 비고 안의 줄바꿈은 제거
  const buildTsv = (rows) => {
    return rows.map(r =>
      [r.orderNo, r.productName, r.sku, r.qty, (r.note || '').replace(/[\r\n]+/g, ' '), '', r.center, r.sewing || '', r.fbcItem || '', r.oneTime || ''].join('\t')
    ).join('\n');
  };

  // 복사 후 사진 있는 상품 확인 & 모달 표시
  const showPhotosAfterCopy = async (rows) => {
    const withImg = rows.filter(r => imgCounts[r.sku] > 0);
    if (withImg.length === 0) return;
    setPhotoLoading(true);
    setPhotoModal({ items: [] });
    const items = await Promise.all(
      withImg.map(async (r) => {
        const images = await dbStoreGet(`issue_img_${r.sku}`).catch(() => []);
        return { orderNo: r.orderNo, productName: r.productName, sku: r.sku, images: Array.isArray(images) ? images : [] };
      })
    );
    setPhotoModal({ items: items.filter(it => it.images.length > 0) });
    setPhotoIdx(0);
    setPhotoLoading(false);
  };

  const copyGroup = (orderNo, rows) => {
    navigator.clipboard.writeText(buildTsv(rows)).then(() => {
      setCopiedGroup(orderNo);
      setTimeout(() => setCopiedGroup(null), 2000);
      showPhotosAfterCopy(rows);
    });
  };

  const copyAll = () => {
    const allRows = grouped.flatMap(([, rows]) => rows);
    navigator.clipboard.writeText(buildTsv(allRows)).then(() => {
      setCopiedAll(true);
      setTimeout(() => setCopiedAll(false), 2000);
      showPhotosAfterCopy(allRows);
    });
  };

  const handleExport = () => {
    if (!data || data.length === 0) return;
    const wb = XLSX_STYLE.utils.book_new();

    const baseFont = { name: 'Arial', sz: 10 };
    const baseAlign = { horizontal: 'center', vertical: 'center' };

    // 양식대로: 발주번호*, 한글옵션명*, SKU*, 수량*, 비고, 실패 원인, 입고센터
    const wsData = [
      ['발주번호*', '한글옵션명*', 'SKU*', '수량*', '비고', '실패 원인', '입고센터'],
    ];

    // 발주번호별 정렬 후 전부 1시트에
    for (const [orderNo, rows] of grouped) {
      for (const r of rows) {
        wsData.push([r.orderNo, r.productName, r.sku, r.qty, r.note, '', r.center]);
      }
    }

    const ws = XLSX_STYLE.utils.aoa_to_sheet(wsData);

    // 전체 셀 스타일
    const range = XLSX_STYLE.utils.decode_range(ws['!ref']);
    for (let ri = range.s.r; ri <= range.e.r; ri++) {
      for (let ci = range.s.c; ci <= range.e.c; ci++) {
        const ref = XLSX_STYLE.utils.encode_cell({ r: ri, c: ci });
        if (!ws[ref]) ws[ref] = { v: '', t: 's' };
        if (ws[ref].t === 'n') {
          ws[ref].v = String(ws[ref].v);
          ws[ref].t = 's';
        }
        ws[ref].s = { font: { ...baseFont }, alignment: { ...baseAlign } };
      }
    }

    // Row 0 (헤더)
    for (let ci = 0; ci <= 6; ci++) {
      const ref = XLSX_STYLE.utils.encode_cell({ r: 0, c: ci });
      if (ws[ref]) {
        ws[ref].s = {
          font: { name: 'Arial', bold: true, sz: 10 },
          alignment: { ...baseAlign },
        };
      }
    }

    ws['!cols'] = [
      { wch: 22 },  // 발주번호*
      { wch: 55 },  // 한글옵션명*
      { wch: 18 },  // SKU*
      { wch: 8 },   // 수량*
      { wch: 30 },  // 비고
      { wch: 15 },  // 실패 원인
      { wch: 20 },  // 입고센터
    ];

    XLSX_STYLE.utils.book_append_sheet(wb, ws, '주문서엑셀양식');

    const dateCode = getDateCode();
    XLSX_STYLE.writeFile(wb, `CN발주서_${dateCode}.xlsx`);
  };

  if (loading) {
    return (
      <div className="loading" style={{ padding: 40, flexDirection: 'column', gap: 8 }}>
        <div className="spinner" />
        <p>발주 데이터 로딩 중...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: 40, textAlign: 'center' }}>
        <p style={{ color: 'var(--danger)', marginBottom: 12 }}>{error}</p>
        <button className="btn btn-primary" onClick={fetchData}>다시 시도</button>
      </div>
    );
  }

  if (!data || data.length === 0) {
    return (
      <div className="placeholder-page">
        <div className="icon">📋</div>
        <h2>발주 신청 대상 없음</h2>
        <p>재고 계산기 Q열(CN 발주)에 수량이 입력된 상품이 없습니다</p>
        <button className="btn btn-outline" style={{ marginTop: 16 }} onClick={fetchData}>🔄 새로고침</button>
      </div>
    );
  }

  return (
    <div>
      {/* 요약 + 다운로드 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className="filter-bar">
            <div>
              <strong>발주 신청 목록</strong>
              <span style={{ marginLeft: 12, fontSize: 13, color: '#666' }}>
                {grouped.length}건 발주서 · {totalItems}개 품목 · 총 {totalQty.toLocaleString()}개
              </span>
            </div>
            <div style={{ flex: 1 }} />
            <button className="btn btn-primary btn-sm" onClick={copyAll}>
              {copiedAll ? '✅ 전체 복사됨' : '📋 전체 복사'}
            </button>
            <button className="btn btn-outline btn-sm" onClick={handleExport}>📥 엑셀 다운로드</button>
            <button className="btn btn-outline btn-sm" onClick={fetchData}>🔄 새로고침</button>
          </div>
        </div>
      </div>

      {/* 발주번호별 카드 — 엑셀 양식 구조 */}
      {grouped.map(([orderNo, rows]) => (
        <div className="card" key={orderNo} style={{ marginBottom: 16 }}>
          <div className="card-header">
            <h2 style={{ fontSize: 15, fontWeight: 600 }}>{orderNo}</h2>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 12, color: '#666' }}>
                {rows[0].brand} · {rows[0].center || '-'} · {rows.length}품목 · {rows.reduce((s, r) => s + r.qty, 0).toLocaleString()}개
              </span>
              <button
                className="btn btn-outline btn-sm"
                style={{ fontSize: 11, padding: '2px 8px' }}
                onClick={() => copyGroup(orderNo, rows)}
              >
                {copiedGroup === orderNo ? '✅ 복사됨' : '📋 복사'}
              </button>
            </div>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th style={{ minWidth: 160 }}>발주번호*</th>
                    <th style={{ minWidth: 280 }}>한글옵션명*</th>
                    <th style={{ minWidth: 140 }}>SKU*</th>
                    <th className="num" style={{ minWidth: 60 }}>수량*</th>
                    <th style={{ minWidth: 200 }}>비고</th>
                    <th style={{ minWidth: 80 }}>실패 원인</th>
                    <th style={{ minWidth: 120 }}>입고센터</th>
                    <th style={{ minWidth: 50 }}>봉제</th>
                    <th style={{ minWidth: 50 }}>FBC</th>
                    <th style={{ minWidth: 100 }}>기타(1회성)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i}>
                      <td style={{ fontSize: 12 }}>{r.orderNo}</td>
                      <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.productName}</td>
                      <td style={{ fontSize: 11, color: '#666' }}>{r.sku}</td>
                      <td className="num">{r.qty.toLocaleString()}</td>
                      <td style={{ fontSize: 11, maxWidth: 200, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{r.note || ''}</td>
                      <td></td>
                      <td style={{ fontSize: 12 }}>{r.center || '-'}</td>
                      <td style={{ fontSize: 11, color: r.sewing ? '#c62828' : '#ccc' }}>{r.sewing || '-'}</td>
                      <td style={{ fontSize: 11, color: r.fbcItem ? '#1565c0' : '#ccc' }}>{r.fbcItem || '-'}</td>
                      <td style={{ fontSize: 11, color: r.oneTime ? '#e65100' : '#ccc' }}>{r.oneTime || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      ))}

      {/* 이슈관리 사진 모달 — 화살표로 상품별 이동 */}
      {photoModal && (() => {
        const items = photoModal.items;
        const cur = items[photoIdx] || null;
        const total = items.length;
        const arrowBtn = {
          background: 'none', border: 'none', fontSize: 28, cursor: 'pointer',
          color: '#1976d2', padding: '4px 8px', lineHeight: 1, userSelect: 'none',
        };
        const arrowDisabled = { ...arrowBtn, color: '#ccc', cursor: 'default' };
        return (
          <div style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.5)', zIndex: 9999,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} onClick={() => setPhotoModal(null)}>
            <div style={{
              background: '#fff', borderRadius: 12, padding: 24,
              maxWidth: 600, width: '90%', boxShadow: '0 8px 32px rgba(0,0,0,0.2)',
            }} onClick={e => e.stopPropagation()}>
              {/* 헤더 */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 16 }}>📷 이슈관리 등록 사진</h3>
                <button onClick={() => setPhotoModal(null)} style={{
                  background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#666',
                }}>✕</button>
              </div>

              {photoLoading ? (
                <div style={{ textAlign: 'center', padding: 32 }}>
                  <div className="spinner" />
                  <p style={{ marginTop: 8, color: '#666' }}>사진 불러오는 중...</p>
                </div>
              ) : total === 0 ? (
                <p style={{ textAlign: 'center', color: '#999', padding: 20 }}>사진이 있는 상품이 없습니다.</p>
              ) : (
                <>
                  {/* 상품 정보 */}
                  <div style={{ padding: 16, background: '#f8f9fa', borderRadius: 8, border: '1px solid #e9ecef' }}>
                    <div style={{ marginBottom: 10 }}>
                      <span style={{
                        display: 'inline-block', background: '#1976d2', color: '#fff',
                        padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600, marginRight: 8,
                      }}>{cur.orderNo}</span>
                      <span style={{ fontSize: 13, color: '#333' }}>{cur.productName}</span>
                      <span style={{ fontSize: 11, color: '#999', marginLeft: 8 }}>{cur.sku}</span>
                    </div>
                    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', justifyContent: 'center' }}>
                      {cur.images.map((img, imgIdx) => (
                        <img key={imgIdx} src={img} alt={`${cur.sku}-${imgIdx}`} style={{
                          width: 160, height: 160, objectFit: 'cover',
                          borderRadius: 6, border: '1px solid #ddd', cursor: 'pointer',
                        }} onClick={() => window.open(img, '_blank')} />
                      ))}
                    </div>
                  </div>

                  {/* 화살표 네비게이션 */}
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 16, marginTop: 16 }}>
                    <button
                      style={photoIdx > 0 ? arrowBtn : arrowDisabled}
                      disabled={photoIdx <= 0}
                      onClick={() => setPhotoIdx(i => i - 1)}
                    >◀</button>
                    <span style={{ fontSize: 13, color: '#666' }}>{photoIdx + 1} / {total}</span>
                    <button
                      style={photoIdx < total - 1 ? arrowBtn : arrowDisabled}
                      disabled={photoIdx >= total - 1}
                      onClick={() => setPhotoIdx(i => i + 1)}
                    >▶</button>
                  </div>
                </>
              )}
            </div>
          </div>
        );
      })()}
    </div>
  );
}
