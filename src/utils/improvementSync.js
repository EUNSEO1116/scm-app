// 상품개선 구글시트 → improvement_items DB 동기화
// - 시트가 입력 소스, improvement_items DB store는 연동 메뉴들의 정답 소스로 유지
// - source:'sheet' 항목만 교체하고, 기존 수기/레거시 항목(source!=='sheet')은 절대 삭제하지 않음
import { dbStoreGet, dbStoreSet } from './dbApi';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const IMPROVE_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('상품개선')}`;
const SPECIAL_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('특별 관리 상품')}`;

const WATCH_KEY = 'imp_watch_barcodes';
const VALID_TYPES = ['재등록', '재수배', '업체문제', '상품문제', 'CSV·VOC'];

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
      } else { cell += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\r' || ch === '\n') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(cell); cell = '';
        result.push(row);
        row = [];
      } else { cell += ch; }
    }
  }
  row.push(cell);
  result.push(row);
  return result;
}

// 업체 블록(6열: 업체명/URL, 중어옵션1, 중어옵션2, 비고, 리드타임, 이슈) 파싱.
// 리드타임만 채워진 블록(템플릿 기본값)은 내용 없음으로 간주해 제외.
function parseVendorBlock(row, base, label) {
  const url = (row[base] || '').trim();
  const opt1 = (row[base + 1] || '').trim();
  const opt2 = (row[base + 2] || '').trim();
  const note = (row[base + 3] || '').trim();
  const leadTime = (row[base + 4] || '').trim();
  const issue = (row[base + 5] || '').trim();
  const hasContent = url || opt1 || opt2 || note || issue;
  if (!hasContent) return null;
  return { name: label, url, opt1, opt2, note, leadTime, issue };
}

// 상품개선 시트 → 항목 배열. 유형+상태가 모두 채워진 행만 가져온다.
export async function fetchImprovementSheet() {
  const res = await fetch(IMPROVE_URL);
  if (!res.ok) throw new Error('상품개선 시트 로드 실패');
  const rows = parseCSV(await res.text());
  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const type = (r[0] || '').trim();
    const status = (r[1] || '').trim();
    if (!type || !status) continue;            // 유형+상태 채워진 행만
    if (!VALID_TYPES.includes(type)) continue; // 오타 유형 스킵
    const barcode = (r[5] || '').trim();
    const vendors = [
      parseVendorBlock(r, 10, '1업체'),
      parseVendorBlock(r, 16, '2업체'),
      parseVendorBlock(r, 22, '3업체'),
    ].filter(Boolean);
    const id = barcode ? `sheet_${barcode}` : `sheet_row_${i}`;
    items.push({
      id,
      source: 'sheet',
      type,
      status,
      productName: (r[3] || '').trim(),
      optionName: (r[4] || '').trim(),
      barcode,
      cost: (r[6] || '').trim(),
      sellStatus: (r[7] || '').trim(),
      appliedVendor: (r[8] || '').trim(),
      commonIssue: (r[9] || '').trim(),
      vendors,
      createdAt: new Date().toISOString(),
    });
  }
  return items;
}

async function fetchSpecialBarcodes() {
  try {
    const res = await fetch(SPECIAL_URL);
    if (!res.ok) return new Set();
    const rows = parseCSV(await res.text());
    const s = new Set();
    for (let i = 1; i < rows.length; i++) {
      const bc = (rows[i][0] || '').trim();
      if (bc) s.add(bc);
    }
    return s;
  } catch { return new Set(); }
}

// 시트 → improvement_items 병합 저장.
// sheet 항목은 통째로 교체, 기존 수기/레거시 항목은 보존(삭제 금지).
export async function syncImprovementFromSheet({ logDesc } = {}) {
  const sheetItems = await fetchImprovementSheet();

  let current = null;
  try { current = await dbStoreGet('improvement_items'); } catch { current = null; }
  if (!Array.isArray(current)) {
    try { current = JSON.parse(localStorage.getItem('improvement_items') || '[]'); } catch { current = []; }
  }
  const kept = (Array.isArray(current) ? current : []).filter(i => i && i.source !== 'sheet');
  const merged = [...sheetItems, ...kept];

  localStorage.setItem('improvement_items', JSON.stringify(merged));
  const ok = await dbStoreSet('improvement_items', merged, {
    logDesc: logDesc || `상품개선 시트 동기화 (${sheetItems.length}건)`,
  });

  // 특별관리 시트 미등록 바코드 감시 목록 갱신 → 기존 알림 기능 유지
  try {
    const special = await fetchSpecialBarcodes();
    let watch = null;
    try { watch = await dbStoreGet(WATCH_KEY); } catch { watch = null; }
    if (!Array.isArray(watch)) watch = [];
    const watched = new Set(watch.map(w => w.barcode));
    let changed = false;
    for (const it of sheetItems) {
      if (it.barcode && !special.has(it.barcode) && !watched.has(it.barcode)) {
        watch.push({ barcode: it.barcode, productName: it.productName, type: it.type });
        watched.add(it.barcode);
        changed = true;
      }
    }
    if (changed) {
      localStorage.setItem(WATCH_KEY, JSON.stringify(watch));
      await dbStoreSet(WATCH_KEY, watch, { skipLog: true });
    }
  } catch { /* 감시 목록 갱신 실패해도 동기화 자체는 성공 처리 */ }

  return { ok, count: sheetItems.length, items: merged };
}
