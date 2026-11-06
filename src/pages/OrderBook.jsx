import { useState, useMemo, useEffect, useCallback, Fragment } from 'react';
import { useLocation } from 'react-router-dom';
import * as XLSX from 'xlsx';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('발주장부')}`;
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`;
const CSV_SPECIAL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('특별 관리 상품')}`;

const TARGET_WEEKS = 2.5;

function safeNum(v) {
  if (!v || v === '-') return 0;
  const n = Number(String(v).replace(/,/g, ''));
  return isNaN(n) ? 0 : n;
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

// CSV 전체 텍스트를 파싱 (따옴표 안의 줄바꿈을 셀 내용으로 유지 → 유령 행 방지)
function parseCsv(text) {
  const rows = [];
  let row = [];
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
      else if (ch === ',') { row.push(current); current = ''; }
      else if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && text[i + 1] === '\n') i++;
        row.push(current); current = '';
        rows.push(row); row = [];
      } else current += ch;
    }
  }
  row.push(current);
  rows.push(row);
  return rows;
}

// 컬럼 매핑 (A=0, B=1, ...)
const COL = {
  orderNo: 0,      // A: 발주번호
  productName: 1,   // B: 한글옵션명
  sku: 2,           // C: SKU
  qty: 3,           // D: 수량
  brand: 4,         // E: 브랜드
  category: 5,      // F: 구분
  actualQty: 6,     // G: 실제출고수량
  cnStatus: 8,      // I: CN 상태
  shipStatus: 9,    // J: 출고 현황
  cnShipDate: 10,   // K: CN 중국 출고일
  incheonDate: 11,  // L: 인천 실제 도착일
  box: 15,          // P: 출고량예상(박스수)
  orderDate: 16,    // Q: 발주일
  colT: 19,         // T: (마지막열)
  memo: 18,         // S: 메모
};

const CARD_FILTERS = [
  { key: 'remind', label: '재촉필요', emoji: '📢', cls: 'warning' },
  { key: 'shipNeeded', label: '출고필요', emoji: '📦', cls: 'danger' },
  { key: 'shipInland', label: '출고필요(내륙운송중)', emoji: '🚛', cls: 'danger' },
  { key: 'check', label: '확인필요', emoji: '🔍', cls: 'info' },
  { key: 'fbc', label: 'FBC입고생성필요', emoji: '🏭', cls: 'success' },
];

function matchFilter(row, filterKey) {
  if (filterKey === 'fbc') {
    return row.category === 'FBC' && row.shipStatus.includes('출고완료');
  }
  if (filterKey === 'remind') {
    return row._remind === true;
  }
  if (filterKey === 'shipNeeded') {
    return row._shipNeeded === true;
  }
  if (filterKey === 'shipInland') {
    return row._shipInland === true;
  }
  if (filterKey === 'check') {
    return row._check === true || row._arrivalCheck === true;
  }
  return false;
}

// 발주일 문자열을 정렬 가능한 숫자로 변환 ("3월 26일" → 326, "12월 5일" → 1205)
function parseOrderDateSort(dateStr) {
  const m = (dateStr || '').match(/(\d+)월\s*(\d+)일/);
  if (!m) return 9999;
  return Number(m[1]) * 100 + Number(m[2]);
}

// 재촉필요 판정: SKU별로 발주일순 누적하여 2.5주 채울 때까지만 표시
function computeRemindFlags(rows, stockMap) {
  // SKU별 전체 발주건 그룹핑
  const skuAllOrders = {};
  for (const row of rows) {
    if (!skuAllOrders[row.sku]) skuAllOrders[row.sku] = [];
    skuAllOrders[row.sku].push(row);
  }

  for (const [sku, allOrders] of Object.entries(skuAllOrders)) {
    const info = stockMap[sku];
    if (!info || info.weeks === null || info.weeks >= TARGET_WEEKS) continue;
    const weeklySales = info.weeklySales;
    if (weeklySales <= 0) continue;

    const targetStock = TARGET_WEEKS * weeklySales;

    // 이미 출고완료된 발주 수량 합산 (곧 입고될 물량)
    let shippedQty = 0;
    for (const row of allOrders) {
      if (row.cnStatus.includes('출고 완료') || row.cnStatus.includes('출고완료')) {
        shippedQty += safeNum(row.qty);
      }
    }

    // 현재 재고 + 입고예정 + 출고완료 수량으로 이미 2.5주 이상이면 스킵
    let currentStock = info.stock + info.incoming + shippedQty;
    if (currentStock >= targetStock) continue;

    // 업체발송대기 건만 발주일순 정렬
    const pendingOrders = allOrders
      .filter(r => r.cnStatus === '업체발송대기')
      .sort((a, b) => parseOrderDateSort(a.orderDate) - parseOrderDateSort(b.orderDate));

    for (const row of pendingOrders) {
      if (currentStock >= targetStock) break;
      row._remind = true;
      currentStock += safeNum(row.qty);
    }
  }
}

const SHIP_TARGET_WEEKS = 5;
const SHIP_THRESHOLD_WEEKS = 3.8;

// 출고필요 판정: CN상태가 "CN 창고도착"/"작업 대기" → 출고필요, "내륙운송중" → 출고필요(내륙운송중)
// 예상판매주 < 3.8주인 SKU 대상, 발주일순 누적하여 5주 될 때까지 표시
function computeShipFlags(rows, stockMap) {
  const skuAllOrders = {};
  for (const row of rows) {
    if (!skuAllOrders[row.sku]) skuAllOrders[row.sku] = [];
    skuAllOrders[row.sku].push(row);
  }

  for (const [sku, allOrders] of Object.entries(skuAllOrders)) {
    const info = stockMap[sku];
    const weeks = info ? info.weeks : 0;
    const weeklySales = info ? info.weeklySales : 0;

    // CN 창고도착 / 작업 대기 건
    const shipOrders = allOrders
      .filter(r => r.cnStatus.includes('CN 창고도착') || r.cnStatus.includes('작업 대기'))
      .sort((a, b) => parseOrderDateSort(a.orderDate) - parseOrderDateSort(b.orderDate));

    // 내륙운송중 건
    const inlandOrders = allOrders
      .filter(r => r.cnStatus.includes('내륙') && r.cnStatus.includes('운송'))
      .sort((a, b) => parseOrderDateSort(a.orderDate) - parseOrderDateSort(b.orderDate));

    // 예상판매주가 비어있으면(null) 판단 불가 → 스킵
    if (weeks === null) continue;

    // 판매량 0이면: 일반은 띄우고, 신규는 스킵
    if (weeklySales <= 0) {
      for (const row of shipOrders) { if (row.category !== '신규') row._shipNeeded = true; }
      for (const row of inlandOrders) { if (row.category !== '신규') row._shipInland = true; }
      continue;
    }

    // 예상판매주 3.8주 이상이면 스킵
    if (weeks >= SHIP_THRESHOLD_WEEKS) continue;

    // 출고완료된 수량 합산 (곧 입고될 물량)
    let shippedQty = 0;
    for (const row of allOrders) {
      if (row.cnStatus.includes('출고 완료') || row.cnStatus.includes('출고완료')) {
        shippedQty += safeNum(row.qty);
      }
    }

    const baseStock = (info ? info.stock + info.incoming : 0) + shippedQty;
    const targetStock = SHIP_TARGET_WEEKS * weeklySales;

    // 출고완료분 포함해서 이미 3.8주 이상이면 출고 안 급함
    const thresholdStock = SHIP_THRESHOLD_WEEKS * weeklySales;
    if (baseStock >= thresholdStock) continue;

    // 출고필요: CN 창고도착/작업 대기
    let currentStock = baseStock;
    for (const row of shipOrders) {
      if (currentStock >= targetStock) break;
      row._shipNeeded = true;
      currentStock += safeNum(row.qty);
    }

    // 출고필요(내륙운송중): 별도 누적
    let currentStockInland = baseStock;
    for (const row of inlandOrders) {
      if (currentStockInland >= targetStock) break;
      row._shipInland = true;
      currentStockInland += safeNum(row.qty);
    }
  }
}

// ===== 급한 출고 추출 (어제/오늘 비교용) =====
// 유니버스: CN상태가 CN창고도착 / 작업대기 / 내륙운송중 인 발주
// 급함 판정: baseStock(재고+입고예정+출고완료수량) ÷ 주판매량 < 임계값(기본 2주)
// 예상판매주(V열)가 '-'이면 stockMap.weeklySales가 W열(총재고 예상판매주)로 폴백돼 있음
const URGENT_THRESHOLD_DEFAULT = 2;
const SNAPSHOT_PREFIX = 'ship_urgent_snapshot_'; // + YYYYMMDD

function dateKeyStr(d) {
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function isUrgentUniverse(r) {
  return r.cnStatus.includes('CN 창고도착') || r.cnStatus.includes('작업 대기') || (r.cnStatus.includes('내륙') && r.cnStatus.includes('운송'));
}

// rows + stockMap → { items: 추천 발주 행[], universe: {key:{w,base,ws,rec}} }
function computeUrgentShip(rows, stockMap, thresholdWeeks) {
  const bySku = {};
  for (const r of rows) { (bySku[r.sku] = bySku[r.sku] || []).push(r); }
  const items = [];
  const universe = {};
  for (const [sku, group] of Object.entries(bySku)) {
    const info = stockMap[sku];
    const weeklySales = info ? info.weeklySales : 0;
    const stock = info ? info.stock : 0;
    const incoming = info ? info.incoming : 0;
    const vEmpty = info ? info.weeks === null : true;
    // 출고완료된 수량(발주장부 기준) → 곧 입고될 물량
    let shippedQty = 0;
    for (const r of group) {
      if (r.cnStatus.includes('출고 완료') || r.cnStatus.includes('출고완료')) shippedQty += safeNum(r.qty);
    }
    const baseStock = stock + incoming + shippedQty;
    const effWeeks = weeklySales > 0 ? Math.round(baseStock / weeklySales * 10) / 10 : null;
    const rec = weeklySales > 0 && effWeeks !== null && effWeeks < thresholdWeeks;
    const urgentOrders = group.filter(isUrgentUniverse);
    for (const r of urgentOrders) {
      const key = r.colT || r.orderNo;
      universe[key] = { w: effWeeks, base: baseStock, ws: Math.round(weeklySales * 10) / 10, rec };
      if (rec) {
        items.push({ ...r, _effWeeks: effWeeks, _baseStock: baseStock, _weeklySales: weeklySales, _stock: stock, _incoming: incoming, _shippedQty: shippedQty, _vEmpty: vEmpty });
      }
    }
  }
  // 급한순(주수 오름차순) 정렬
  items.sort((a, b) => a._effWeeks - b._effWeeks);
  return { items, universe };
}

// 오늘 추천 사유
function urgentReasonToday(it, threshold) {
  const src = it._vEmpty ? ' · V열(예상판매주) 비어있어 W열(총재고 예상판매주) 기준' : '';
  return `예상판매주 ${it._effWeeks}주 < ${threshold}주${src} / base재고 ${it._baseStock}(재고 ${it._stock} + 입고예정 ${it._incoming} + 출고완료 ${it._shippedQty}) ÷ 주판매 ${it._weeklySales.toFixed(1)}`;
}

// 어제 상태(스냅샷) 기반 미추천 사유
function urgentReasonYesterday(ySnap, key, threshold) {
  if (!ySnap) return '비교할 어제 스냅샷이 없음 (오늘이 첫 기준)';
  const y = ySnap[key];
  if (!y) return '어제는 출고 대상 상태가 아니었음 (중국 생산·발송대기 등)';
  if (y.rec) return '어제도 추천됨';
  if (y.w === null) return '어제는 주판매량 0(산출불가)이라 미추천';
  return `어제 예상판매주 ${y.w}주 (${threshold}주 이상이라 미추천)`;
}

// 붙여넣은 발주번호 목록 → 중복/비중복/추천대조 분석
function parseDupList(text, recSet) {
  const list = text.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
  const counts = {};
  for (const c of list) counts[c] = (counts[c] || 0) + 1;
  const uniq = [...new Set(list)];
  const uniqSet = new Set(uniq);
  const rows = uniq.map(c => ({ code: c, count: counts[c], dup: counts[c] > 1, inRec: recSet.has(c) }));
  const missing = [...recSet].filter(c => !uniqSet.has(c)); // 추천엔 있는데 붙여넣기엔 없음
  return { rows, missing, total: list.length, uniqCount: uniq.length };
}

// 공백 제거 정규화 ("작업 대기" == "작업대기", "CN 출고완료" == "CN출고완료")
function normSpace(s) { return (s || '').replace(/\s/g, ''); }

// 재촉필요 행 중 I열(CN상태)에 이 상태가 있는 다른 발주번호가 있으면 맨 아래로
const REMIND_BLOCK_STATUSES = ['내륙운송중', '출고완료', 'CN창고도착', '출고대기', '부분출고대기', '작업대기'];

// 빨간칠/맨아래 정렬 판정 (기존 재촉/출고 판정에는 영향 없음, 표시용 플래그만 추가)
function computeBlockedFlags(rows) {
  const bySku = {};
  for (const row of rows) {
    if (!bySku[row.sku]) bySku[row.sku] = [];
    bySku[row.sku].push(row);
  }
  for (const group of Object.values(bySku)) {
    for (const row of group) {
      // 재촉필요: 동일 SKU의 다른 발주번호 중 I열에 지정 상태가 있으면
      if (row._remind) {
        const blocked = group.some(o =>
          o.orderNo !== row.orderNo &&
          REMIND_BLOCK_STATUSES.some(k => normSpace(o.cnStatus).includes(k))
        );
        if (blocked) row._remindBlocked = true;
      }
      // 출고필요: 동일 SKU의 다른 발주일 중 J열에 "CN 출고완료"가 있으면
      if (row._shipNeeded) {
        const blocked = group.some(o =>
          o.orderDate !== row.orderDate &&
          normSpace(o.shipStatus).includes('CN출고완료')
        );
        if (blocked) row._shipBlocked = true;
      }
      // 출고필요(내륙운송중): 출고필요와 동일 로직
      if (row._shipInland) {
        const blocked = group.some(o =>
          o.orderDate !== row.orderDate &&
          normSpace(o.shipStatus).includes('CN출고완료')
        );
        if (blocked) row._inlandBlocked = true;
      }
    }
  }
}

// localStorage 미등록 특별관리 항목 로드
function loadLocalSpecial() {
  try { return JSON.parse(localStorage.getItem('local_special_items') || '[]'); } catch { return []; }
}

// 상품개선 항목 로드 (localStorage + DB)
function loadImprovementItems() {
  try { return JSON.parse(localStorage.getItem('improvement_items') || '[]'); } catch { return []; }
}

// DB에서 특별관리 항목 로드 후 localStorage 동기화
async function loadLocalSpecialFromDb() {
  try {
    const dbData = await dbStoreGet('issue_special_items');
    if (dbData && Array.isArray(dbData)) {
      localStorage.setItem('local_special_items', JSON.stringify(dbData));
      return dbData;
    }
  } catch {}
  return loadLocalSpecial();
}

// DB에서 상품개선 항목 로드 후 localStorage 동기화
async function loadImprovementItemsFromDb() {
  try {
    const dbData = await dbStoreGet('improvement_items');
    if (dbData && Array.isArray(dbData)) {
      localStorage.setItem('improvement_items', JSON.stringify(dbData));
      return dbData;
    }
  } catch {}
  return loadImprovementItems();
}

// 확인필요: 특별 관리 상품(봉제여부/기타1회성)이면서 CN 창고도착 또는 내륙운송중
// + localStorage에 미리 등록한 항목도 포함
// + 상품개선 항목 (진행중인 이슈가 있는 바코드)
function computeCheckFlags(rows, specialMap, localItems, impItems) {
  // DB에서 로드된 특별관리 항목 → specialMap에 병합
  for (const item of localItems) {
    if (!item.barcode) continue;
    if (!specialMap[item.barcode]) {
      if (item.sewing || item.oneTime) {
        specialMap[item.barcode] = { sewing: item.sewing || '', oneTime: item.oneTime || '' };
      }
    }
  }

  // 상품개선 항목 중 완료되지 않은 것 → 바코드별 이슈 매핑
  const impMap = {};
  for (const item of impItems) {
    if (!item.barcode || item.status === '완료') continue;
    impMap[item.barcode] = { type: item.type, productName: item.productName, status: item.status };
  }

  for (const row of rows) {
    const special = specialMap[row.sku];
    const imp = impMap[row.sku];

    // 특별관리 조건 (기존)
    if (special) {
      const isCnArrived = row.cnStatus.includes('CN 창고도착') || row.cnStatus.includes('작업 대기');
      const isInland = row.cnStatus.includes('내륙') && row.cnStatus.includes('운송');
      if (isCnArrived || isInland) {
        row._check = true;
        const reasons = [];
        if (special.sewing) reasons.push('봉제: ' + special.sewing);
        if (special.oneTime) reasons.push('기타: ' + special.oneTime);
        row._checkReason = reasons.join(' / ');
      }
    }

    // 상품개선 조건 (신규)
    if (imp) {
      row._check = true;
      const impReason = `상품개선: ${imp.type}(${imp.status})`;
      row._checkReason = row._checkReason ? row._checkReason + ' / ' + impReason : impReason;
    }
  }
}

const NOTES_KEY = 'orderbook_notes'; // localStorage key

const SEED_NOTES = {
  'AE-I2-260326-001': { reply: '내일발송 월요일 입고', arrivalDate: '2026-03-30', savedAt: '2026-03-27' },
  'AE-S-260326-001': { reply: '재고 각20개만 있음, 나머지 생산시간 7일', arrivalDate: '2026-04-03', savedAt: '2026-03-27' },
  'AE-R-260326-002': { reply: '내일발송 월요일 입고', arrivalDate: '2026-03-30', savedAt: '2026-03-27' },
  'AE-R-260326-JJ-001': { reply: '생산시간 7일', arrivalDate: '2026-04-03', savedAt: '2026-03-27' },
};

function loadNotes() {
  try {
    const saved = JSON.parse(localStorage.getItem(NOTES_KEY) || '{}');
    // 시드 데이터 병합 (기존에 없는 것만)
    let changed = false;
    for (const [k, v] of Object.entries(SEED_NOTES)) {
      if (!saved[k]) { saved[k] = v; changed = true; }
    }
    if (changed) localStorage.setItem(NOTES_KEY, JSON.stringify(saved));
    return saved;
  } catch { return { ...SEED_NOTES }; }
}
function saveNotes(notes) {
  localStorage.setItem(NOTES_KEY, JSON.stringify(notes));
  dbStoreSet('orderbook_notes', notes).catch(() => {});
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// 답변 일괄입력: 텍스트에서 colT 코드 + 상태 파싱
function parseBulkReply(text) {
  const today = new Date();
  const fmtDate = (d) => `${d.getMonth() + 1}/${d.getDate()}`;
  const todayFmt = fmtDate(today);
  const tomorrowFmt = fmtDate(new Date(today.getTime() + 86400000));
  const dayAfterFmt = fmtDate(new Date(today.getTime() + 86400000 * 2));

  // colT 패턴: AE-XX-YYMMDD-ZZZ 또는 AE-XX-YYMMDD-JJ-ZZZ
  const codePattern = /\b(AE-[A-Z0-9]+-\d{6}(?:-[A-Z0-9]+)*-\d{3})\b/g;
  const lines = text.split('\n');
  const results = [];

  for (const line of lines) {
    const codes = [...line.matchAll(codePattern)].map(m => m[1]);
    if (codes.length === 0) continue;

    // 각 코드별로 뒤따르는 텍스트 파싱
    for (let ci = 0; ci < codes.length; ci++) {
      const code = codes[ci];
      const codeIdx = line.indexOf(code);
      // 이 코드 뒤, 다음 코드 전까지의 텍스트
      const nextCodeIdx = ci + 1 < codes.length ? line.indexOf(codes[ci + 1], codeIdx + code.length) : line.length;
      const statusText = line.slice(codeIdx + code.length, nextCodeIdx).trim();

      // 날짜 결정
      let dateStr = todayFmt;
      if (/내일/.test(statusText)) dateStr = tomorrowFmt;
      else if (/모레/.test(statusText)) dateStr = dayAfterFmt;

      // 상태 키워드 추출
      let status = '';
      if (/발송/.test(statusText)) status = '발송예정';
      else if (/도착/.test(statusText)) status = '도착예정';
      else if (/내륙/.test(statusText) && /운송/.test(statusText)) status = '내륙운송중';
      else if (/생산/.test(statusText)) {
        // "생산시간 7일" 같은 케이스 → 그대로 표시
        const prodMatch = statusText.match(/생산[^\d]*(\d+)\s*일/);
        status = prodMatch ? `생산 ${prodMatch[1]}일` : '생산중';
      } else if (/재고/.test(statusText)) {
        status = statusText.replace(/[,.]?\s*$/, '');
      } else {
        // 기타: 원문 그대로 (공급업체 고유 답변)
        status = statusText.replace(/[,.]?\s*$/, '').replace(/이라고\s*확인되었습니다/, '').replace(/이고$/, '').trim();
      }

      const reply = status ? `${dateStr} ${status}` : `${dateStr} 확인됨`;
      results.push({ colT: code, reply, raw: statusText });
    }
  }
  return results;
}

export default function OrderBook() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const location = useLocation();
  const initialCard = new URLSearchParams(location.search).get('card') || null;
  const [activeCard, setActiveCard] = useState(initialCard);
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [expandedMemo, setExpandedMemo] = useState(new Set());
  const [notes, setNotes] = useState(loadNotes);
  const [editingNote, setEditingNote] = useState(null); // colT key
  const [noteInput, setNoteInput] = useState('');
  const [arrivalInput, setArrivalInput] = useState('');
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkParsed, setBulkParsed] = useState(null); // [{colT, reply, raw, matched}]
  // 급한 출고 추출기
  const [stockMap, setStockMap] = useState(null);
  const [shipOpen, setShipOpen] = useState(false);
  const [shipThreshold, setShipThreshold] = useState(URGENT_THRESHOLD_DEFAULT);
  const [yesterdaySnap, setYesterdaySnap] = useState(null);
  const [snapBaseDate, setSnapBaseDate] = useState(null);
  const [shipExpanded, setShipExpanded] = useState(() => new Set()); // 사유 토글된 key
  const [shipDupText, setShipDupText] = useState('');
  const [shipDupResult, setShipDupResult] = useState(null);

  // DB에서 초기 데이터 로드
  useEffect(() => {
    dbStoreGet('orderbook_notes').then(data => {
      if (data && typeof data === 'object') {
        localStorage.setItem(NOTES_KEY, JSON.stringify(data));
        setNotes(data);
      }
    }).catch(() => {});
  }, []);

  const saveNote = (colT) => {
    if (!colT) return;
    const updated = { ...notes, [colT]: { reply: noteInput, arrivalDate: arrivalInput, savedAt: todayStr() } };
    setNotes(updated);
    saveNotes(updated);
    setEditingNote(null);
    setNoteInput('');
    setArrivalInput('');
  };

  const deleteNote = (colT) => {
    const updated = { ...notes };
    delete updated[colT];
    setNotes(updated);
    saveNotes(updated);
  };

  // 답변 일괄입력: 텍스트 파싱
  const handleBulkParse = () => {
    if (!bulkText.trim()) return;
    const parsed = parseBulkReply(bulkText);
    const activeColTs = new Set((data || []).map(r => r.colT).filter(Boolean));
    const withMatch = parsed.map(p => ({
      ...p,
      matched: activeColTs.has(p.colT),
      checked: activeColTs.has(p.colT),
    }));
    setBulkParsed(withMatch);
  };

  // 답변 일괄입력: 확인 후 저장
  const handleBulkSave = () => {
    if (!bulkParsed) return;
    const toSave = bulkParsed.filter(p => p.checked && p.matched);
    if (toSave.length === 0) { alert('저장할 항목이 없습니다.'); return; }

    const lines = toSave.map(p => `${p.colT} → ${p.reply}`).join('\n');
    if (!window.confirm(`다음 ${toSave.length}건의 답변을 저장하시겠습니까?\n\n${lines}`)) return;

    const updated = { ...notes };
    const today = todayStr();
    for (const p of toSave) {
      updated[p.colT] = { reply: p.reply, arrivalDate: '', savedAt: today };
    }
    setNotes(updated);
    saveNotes(updated);
    setBulkOpen(false);
    setBulkText('');
    setBulkParsed(null);
  };

  // ===== 급한 출고 추출 (화면 임계값 반영) =====
  const urgentAll = useMemo(
    () => (data && stockMap) ? computeUrgentShip(data, stockMap, shipThreshold) : null,
    [data, stockMap, shipThreshold]
  );

  const isNewVsYesterday = useCallback((key) => {
    if (!yesterdaySnap) return false;
    const y = yesterdaySnap[key];
    return !y || !y.rec; // 어제 스냅샷에 없었거나, 있었어도 추천 아니었음
  }, [yesterdaySnap]);

  const newItems = useMemo(() => {
    if (!urgentAll) return [];
    return urgentAll.items.filter(it => isNewVsYesterday(it.colT || it.orderNo));
  }, [urgentAll, isNewVsYesterday]);

  const boxTotalNonFbc = useMemo(() => {
    if (!urgentAll) return 0;
    let t = 0;
    for (const it of urgentAll.items) { if (it.category !== 'FBC') t += safeNum(it.box); }
    return Math.round(t * 10) / 10;
  }, [urgentAll]);

  const toggleShipReason = (key) => {
    setShipExpanded(prev => {
      const n = new Set(prev);
      if (n.has(key)) n.delete(key); else n.add(key);
      return n;
    });
  };

  const copyShipList = (items) => {
    const text = items.map(it => it.colT || it.orderNo).join('\n');
    if (!text) { alert('복사할 발주번호가 없습니다.'); return; }
    navigator.clipboard?.writeText(text).then(
      () => alert(`${items.length}건 발주번호를 복사했습니다.`),
      () => alert('복사 실패 — 브라우저 권한을 확인하세요.')
    );
  };

  const handleShipExcel = () => {
    if (!urgentAll || urgentAll.items.length === 0) { alert('추출된 항목이 없습니다.'); return; }
    const header = ['발주번호', '발주번호(A열)', '상품명', 'SKU', '구분', 'CN상태', '예상판매주', '재고', '입고예정', '주판매', '수량', '박스수', '발주일', '어제대비', '오늘 사유', '어제 사유'];
    const aoa = [header];
    for (const it of urgentAll.items) {
      const key = it.colT || it.orderNo;
      aoa.push([
        key, it.orderNo, it.productName, it.sku, it.category || '', it.cnStatus,
        it._effWeeks, it._stock, it._incoming, Math.round(it._weeklySales * 10) / 10,
        safeNum(it.qty), safeNum(it.box), it.orderDate, isNewVsYesterday(key) ? '신규' : '',
        urgentReasonToday(it, shipThreshold),
        urgentReasonYesterday(yesterdaySnap, key, URGENT_THRESHOLD_DEFAULT),
      ]);
    }
    aoa.push([]);
    aoa.push(['합계(FBC제외 박스)', '', '', '', '', '', '', '', '', '', '', boxTotalNonFbc]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '급한출고');

    // 중복 검증 시트 (붙여넣은 발주번호가 있을 때만)
    if (shipDupText.trim()) {
      const recSet = new Set(urgentAll.items.map(it => it.colT || it.orderNo));
      const dup = parseDupList(shipDupText, recSet);
      const dupList = dup.rows.filter(r => r.dup);   // 입력 2회 이상
      const uniqList = dup.rows.filter(r => !r.dup); // 고유(1회) = 비중복
      const n = Math.max(dupList.length, uniqList.length);
      const aoa2 = [[`중복(${dupList.length}종)`, '입력횟수', '설명', '', `비중복(${uniqList.length}건)`, '추천대조', '설명']];
      for (let i = 0; i < n; i++) {
        const d = dupList[i], u = uniqList[i];
        aoa2.push([
          d ? d.code : '', d ? d.count : '', d ? '시트에 있음' : '', '',
          u ? u.code : '', u ? (u.inRec ? '겹침(추천O)' : '추가(추천X)') : '', u ? '시트에 없었음 (찐 필요여부 확인 필요)' : '',
        ]);
      }
      aoa2.push([]);
      aoa2.push([`누락(추천엔 있는데 붙여넣기엔 없음) ${dup.missing.length}건`]);
      for (const m of dup.missing) aoa2.push([m]);
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa2), '중복검증');
    }

    XLSX.writeFile(wb, `급한출고_${dateKeyStr(new Date())}.xlsx`);
  };

  const handleShipDupCheck = () => {
    if (!shipDupText.trim()) { setShipDupResult(null); return; }
    const recSet = new Set((urgentAll?.items || []).map(it => it.colT || it.orderNo));
    setShipDupResult(parseDupList(shipDupText, recSet));
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [orderRes, calcRes, specialRes] = await Promise.all([fetch(CSV_URL), fetch(TSV_CALC), fetch(CSV_SPECIAL)]);
      if (!orderRes.ok) throw new Error('발주장부 데이터를 불러올 수 없습니다');

      // 재고 계산기: SKU별 예상판매주, 재고, 입고예정, 주간판매량
      const stockMap = {};
      if (calcRes.ok) {
        const tsv = await calcRes.text();
        const tsvLines = tsv.split('\n').filter(l => l.trim());
        for (let i = 1; i < tsvLines.length; i++) {
          const c = tsvLines[i].split('\t');
          const sku = (c[2] || '').trim();
          if (!sku) continue;
          const stock = safeNum(c[6]);
          const incoming = safeNum(c[7]);
          const weeksRaw = (c[21] || '').trim();
          const weeks = weeksRaw === '' ? null : safeNum(weeksRaw); // null = 비어있음, 0 = 진짜 0
          const stockPlusIncoming = stock + incoming;
          let weeklySales = (weeks !== null && weeks > 0) ? stockPlusIncoming / weeks : 0;
          const totalStock = safeNum(c[14]);
          // 쿠팡재고 0이라 weeklySales 못 구할 때, 총재고 판매주로 역산
          if (weeklySales === 0) {
            const totalWeeksRaw = safeNum(c[22]);
            if (totalWeeksRaw > 0 && totalStock > 0) {
              weeklySales = totalStock / totalWeeksRaw;
            }
          }
          const boxhero = safeNum(c[9]);
          const fbcOut = safeNum(c[10]);
          const generalOut = safeNum(c[11]);
          const extraStock = boxhero + fbcOut + generalOut;
          let coupangWeeks;
          let adjustedWeeks;
          if (extraStock > 0 && weeklySales > 0) {
            adjustedWeeks = Math.round((stockPlusIncoming + extraStock) / weeklySales * 10) / 10;
            coupangWeeks = String(adjustedWeeks);
          } else {
            coupangWeeks = (c[21] || '').trim();
            adjustedWeeks = weeksRaw === '' ? null : safeNum(weeksRaw);
          }
          stockMap[sku] = { stock, incoming, weeks: adjustedWeeks, weeklySales, totalStock, coupangWeeks };
        }
      }

      // 특별 관리 상품: SKU → { 봉제여부, 기타(1회성) }
      const specialMap = {};
      if (specialRes.ok) {
        const csv2 = await specialRes.text();
        const lines2 = csv2.split('\n').filter(l => l.trim());
        for (let i = 1; i < lines2.length; i++) {
          const cols = parseCsvRow(lines2[i]);
          const sku = (cols[0] || '').trim();
          if (!sku) continue;
          const sewing = (cols[5] || '').trim();    // 봉제여부
          const oneTime = (cols[8] || '').trim();   // 기타(1회성)
          if (sewing || oneTime) {
            specialMap[sku] = { sewing, oneTime };
          }
        }
      }

      // 발주장부 파싱 (따옴표 안 줄바꿈까지 인식하는 파서 사용 → 메모 여러 줄이 유령 행으로 새지 않음)
      const csv = await orderRes.text();
      const allRows = parseCsv(csv);
      const rows = [];
      for (let i = 1; i < allRows.length; i++) {
        const cols = allRows[i];
        const orderNo = (cols[COL.orderNo] || '').trim();
        if (!orderNo) continue;
        rows.push({
          orderNo,
          productName: (cols[COL.productName] || '').trim(),
          sku: (cols[COL.sku] || '').trim(),
          qty: (cols[COL.qty] || '').trim(),
          brand: (cols[COL.brand] || '').trim(),
          category: (cols[COL.category] || '').trim(),
          actualQty: (cols[COL.actualQty] || '').trim(),
          cnStatus: (cols[COL.cnStatus] || '').trim(),
          shipStatus: (cols[COL.shipStatus] || '').trim(),
          cnShipDate: (cols[COL.cnShipDate] || '').trim(),
          incheonDate: (cols[COL.incheonDate] || '').trim(),
          box: (cols[COL.box] || '').trim(),
          orderDate: (cols[COL.orderDate] || '').trim(),
          colT: (cols[COL.colT] || '').trim(),
          memo: (cols[COL.memo] || '').trim(),
          _raw: cols,
          _remind: false,
          _shipNeeded: false,
          _shipInland: false,
          _check: false,
          _checkReason: '',
          _totalStock: stockMap[(cols[COL.sku] || '').trim()]?.totalStock ?? '-',
          _totalWeeks: stockMap[(cols[COL.sku] || '').trim()]?.coupangWeeks || '-',
        });
      }

      // DB에서 특별관리/상품개선 항목 로드 (localStorage 동기화 포함)
      const [localSpecialItems, improvementItems] = await Promise.all([
        loadLocalSpecialFromDb(),
        loadImprovementItemsFromDb(),
      ]);

      // 재촉필요 + 출고필요 + 확인필요 판정
      computeRemindFlags(rows, stockMap);
      computeShipFlags(rows, stockMap);
      computeCheckFlags(rows, specialMap, localSpecialItems, improvementItems);
      computeBlockedFlags(rows);

      // 입고예정일 도래 → 확인필요 + 존재하지 않는 답변 정리
      const today = todayStr();
      const savedNotes = loadNotes();
      const activeColTs = new Set(rows.map(r => r.colT).filter(Boolean));
      let notesCleaned = false;
      for (const key of Object.keys(savedNotes)) {
        if (!activeColTs.has(key)) {
          delete savedNotes[key];
          notesCleaned = true;
        }
      }
      if (notesCleaned) {
        saveNotes(savedNotes);
        setNotes({ ...savedNotes });
      }

      for (const row of rows) {
        const note = savedNotes[row.colT];
        if (note && note.arrivalDate && note.arrivalDate <= today) {
          row._arrivalCheck = true;
          row._checkReason = (row._checkReason ? row._checkReason + ' / ' : '') + '입고예정일 도래: ' + note.arrivalDate;
          if (!row._check) row._check = true;
        }
      }

      setData(rows);
      setStockMap(stockMap);

      // ===== 급한 출고 스냅샷 (고정 2주 기준) — 어제/오늘 비교용 =====
      try {
        const { universe } = computeUrgentShip(rows, stockMap, URGENT_THRESHOLD_DEFAULT);
        const dayKeys = [];
        for (let i = 0; i < 8; i++) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); dayKeys.push(dateKeyStr(d)); }
        const snaps = await Promise.all(dayKeys.map(k => dbStoreGet(SNAPSHOT_PREFIX + k).catch(() => null)));
        // 오늘자 스냅샷이 없으면 오늘 기준선으로 1회 저장
        if (!snaps[0]) {
          dbStoreSet(SNAPSHOT_PREFIX + dayKeys[0], universe, { skipLog: true }).catch(() => {});
        }
        // 어제 = 오늘 이전 날짜 중 가장 최근 스냅샷
        let ySnap = null, yDate = null;
        for (let i = 1; i < dayKeys.length; i++) { if (snaps[i]) { ySnap = snaps[i]; yDate = dayKeys[i]; break; } }
        setYesterdaySnap(ySnap);
        setSnapBaseDate(yDate);
      } catch { /* 스냅샷 실패해도 추출 기능은 동작 */ }
    } catch (e) {
      setError(e.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const cardCounts = useMemo(() => {
    if (!data) return {};
    const counts = {};
    for (const cf of CARD_FILTERS) {
      counts[cf.key] = data.filter(r => matchFilter(r, cf.key)).length;
    }
    return counts;
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    let rows = data;

    if (activeCard) {
      rows = rows.filter(r => matchFilter(r, activeCard));
    }

    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        r.orderNo.toLowerCase().includes(q) ||
        r.productName.toLowerCase().includes(q) ||
        r.sku.toLowerCase().includes(q) ||
        r.brand.toLowerCase().includes(q) ||
        r.memo.toLowerCase().includes(q)
      );
    }

    if (sortKey) {
      rows = [...rows].sort((a, b) => {
        const va = a[sortKey] || '';
        const vb = b[sortKey] || '';
        const na = Number(va), nb = Number(vb);
        if (!isNaN(na) && !isNaN(nb)) return sortDir === 'asc' ? na - nb : nb - na;
        return sortDir === 'asc' ? va.localeCompare(vb) : vb.localeCompare(va);
      });
    }

    // 블록 행(다른 발주에 진행상태 존재)은 해당 카드에서 맨 아래로
    const blockKey = activeCard === 'remind' ? '_remindBlocked'
      : activeCard === 'shipNeeded' ? '_shipBlocked'
      : activeCard === 'shipInland' ? '_inlandBlocked' : null;
    if (blockKey) {
      const normal = rows.filter(r => !r[blockKey]);
      const blocked = rows.filter(r => r[blockKey]);
      rows = [...normal, ...blocked];
    }

    return rows;
  }, [data, search, activeCard, sortKey, sortDir]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const [copied, setCopied] = useState(false);
  const copyColT = () => {
    const values = filtered.map(r => r.colT).filter(Boolean).join('\n');
    navigator.clipboard.writeText(values).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  const toggleMemo = (i) => {
    setExpandedMemo(prev => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  const columns = [
    { key: 'orderNo', label: '발주번호', width: 130 },
    { key: 'productName', label: '상품명', width: 250 },
    { key: 'sku', label: 'SKU', width: 130 },
    { key: 'qty', label: '수량', width: 50, cls: 'num' },
    { key: 'brand', label: '브랜드', width: 70 },
    { key: 'category', label: '구분', width: 50 },
    { key: 'actualQty', label: '실출고', width: 55, cls: 'num' },
    { key: 'cnStatus', label: 'CN 상태', width: 100 },
    { key: 'shipStatus', label: '출고 현황', width: 100 },
    { key: '_totalStock', label: '총재고', width: 55, cls: 'num' },
    { key: '_totalWeeks', label: '쿠팡판매주', width: 70, cls: 'num' },
    { key: 'cnShipDate', label: 'CN 출고일', width: 80 },
    { key: 'incheonDate', label: '인천 도착일', width: 80 },
    { key: 'orderDate', label: '발주일', width: 80 },
    { key: 'colT', label: '', width: 120, copyable: true },
    { key: 'memo', label: '메모', width: 100, collapsible: true },
    { key: '_note', label: '답변/입고예정', width: 160 },
  ];

  const sortIcon = (key) => {
    if (sortKey !== key) return <span className="sort-icon">↕</span>;
    return <span className="sort-icon">{sortDir === 'asc' ? '↑' : '↓'}</span>;
  };

  if (loading) {
    return (
      <div className="loading" style={{ padding: 40, flexDirection: 'column', gap: 8 }}>
        <div className="spinner" />
        <p>발주장부 데이터 로딩 중...</p>
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

  return (
    <div>
      {/* 통계 카드 */}
      <div className="stats-grid" style={{ marginBottom: 16 }}>
        {CARD_FILTERS.map(cf => (
          <div
            key={cf.key}
            className={`stat-card ${cf.cls} clickable${activeCard === cf.key ? ' selected' : ''}`}
            onClick={() => setActiveCard(activeCard === cf.key ? null : cf.key)}
            style={{ padding: 16 }}
          >
            <div className="label">{cf.emoji} {cf.label}</div>
            <div className="value">{cardCounts[cf.key] || 0}<span style={{ fontSize: 14, fontWeight: 400, marginLeft: 4 }}>건</span></div>
            {cf.key === 'check' && <div style={{ fontSize: 10, color: '#888', marginTop: 4, lineHeight: 1.4 }}>봉제/1회성 상품 CN도착 시 + 입고예정일 도래</div>}
          </div>
        ))}
      </div>

      {/* 필터 바 */}
      <div className="filter-bar" style={{ marginBottom: 16 }}>
        <input
          className="search-input"
          placeholder="발주번호, 상품명, SKU, 브랜드, 메모 검색..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <div style={{ flex: 1 }} />
        <span style={{ fontSize: 13, color: '#666' }}>
          {filtered.length}건{data ? ` / 전체 ${data.length}건` : ''}
        </span>
        <button className="btn btn-outline btn-sm" onClick={fetchData}>🔄 새로고침</button>
        <button className="btn btn-primary btn-sm" style={{ marginLeft: 8 }} onClick={() => setShipOpen(true)}>
          🚚 급한 출고 추출
        </button>
        {activeCard === 'remind' && (
          <button className="btn btn-primary btn-sm" style={{ marginLeft: 8 }} onClick={() => { setBulkOpen(true); setBulkText(''); setBulkParsed(null); }}>
            📋 답변 일괄입력
          </button>
        )}
      </div>

      {/* 답변 일괄입력 모달 */}
      {bulkOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setBulkOpen(false)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 520, maxHeight: '80vh', overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 12px', fontSize: 16 }}>📋 답변 일괄입력</h3>
            <p style={{ fontSize: 12, color: '#666', margin: '0 0 12px' }}>
              공급업체 메시지를 붙여넣기 하세요. 발주코드와 상태를 자동 파싱합니다.
            </p>
            <textarea
              style={{ width: '100%', height: 120, fontSize: 12, padding: 10, border: '1px solid #ddd', borderRadius: 8, resize: 'vertical', fontFamily: 'inherit' }}
              placeholder={'예시:\nAE-O-260403-001 내륙운송 중이고\nAE-I-260406-002 오늘 발송 예정'}
              value={bulkText}
              onChange={e => { setBulkText(e.target.value); setBulkParsed(null); }}
            />
            <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
              <button className="btn btn-primary btn-sm" onClick={handleBulkParse} disabled={!bulkText.trim()}>파싱하기</button>
              <button className="btn btn-outline btn-sm" onClick={() => setBulkOpen(false)}>닫기</button>
            </div>

            {bulkParsed && (
              <div style={{ marginTop: 16 }}>
                <h4 style={{ fontSize: 14, margin: '0 0 8px' }}>파싱 결과 ({bulkParsed.filter(p => p.matched).length}/{bulkParsed.length}건 매칭)</h4>
                <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, overflow: 'hidden' }}>
                  <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f5f5f5' }}>
                        <th style={{ padding: '8px 6px', textAlign: 'center', width: 30 }}></th>
                        <th style={{ padding: '8px 6px', textAlign: 'left' }}>발주코드</th>
                        <th style={{ padding: '8px 6px', textAlign: 'left' }}>답변 내용</th>
                        <th style={{ padding: '8px 6px', textAlign: 'center', width: 60 }}>상태</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bulkParsed.map((p, i) => (
                        <tr key={i} style={{ borderTop: '1px solid #eee', opacity: p.matched ? 1 : 0.5 }}>
                          <td style={{ padding: '6px', textAlign: 'center' }}>
                            <input type="checkbox" checked={p.checked} disabled={!p.matched}
                              onChange={() => {
                                const next = [...bulkParsed];
                                next[i] = { ...next[i], checked: !next[i].checked };
                                setBulkParsed(next);
                              }} />
                          </td>
                          <td style={{ padding: '6px', fontFamily: 'monospace', fontSize: 11 }}>{p.colT}</td>
                          <td style={{ padding: '6px' }}>{p.reply}</td>
                          <td style={{ padding: '6px', textAlign: 'center' }}>
                            {p.matched
                              ? <span style={{ color: '#34a853', fontWeight: 600 }}>매칭</span>
                              : <span style={{ color: '#999' }}>미매칭</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {bulkParsed.some(p => !p.matched) && (
                  <p style={{ fontSize: 11, color: '#d93025', marginTop: 6 }}>
                    ⚠ 미매칭 항목은 현재 발주장부에 해당 코드가 없습니다.
                  </p>
                )}
                <button
                  className="btn btn-primary"
                  style={{ marginTop: 12, width: '100%' }}
                  onClick={handleBulkSave}
                  disabled={!bulkParsed.some(p => p.checked && p.matched)}
                >
                  ✅ {bulkParsed.filter(p => p.checked && p.matched).length}건 저장하기
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 급한 출고 추출 모달 */}
      {shipOpen && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onClick={() => setShipOpen(false)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, width: 920, maxWidth: '96vw', maxHeight: '88vh', overflow: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.2)', textAlign: 'center' }}
            onClick={e => e.stopPropagation()}>
            <h3 style={{ margin: '0 0 6px', fontSize: 17 }}>🚚 급한 출고 추출</h3>
            <p style={{ fontSize: 12, color: '#666', margin: '0 0 14px' }}>
              CN창고도착 · 작업대기 · 내륙운송중 발주 중, 출고완료분이 도착해도 예상판매주가 임계값 미만인 것만 추립니다.
            </p>

            {/* 임계값 + 요약 */}
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', justifyContent: 'center', flexWrap: 'wrap', marginBottom: 14 }}>
              <label style={{ fontSize: 13 }}>임계값(주):
                <input type="number" step="0.5" min="0.5" value={shipThreshold}
                  onChange={e => setShipThreshold(Math.max(0.5, Number(e.target.value) || URGENT_THRESHOLD_DEFAULT))}
                  style={{ width: 64, marginLeft: 6, padding: '4px 6px', border: '1px solid #ddd', borderRadius: 6, textAlign: 'center' }} />
              </label>
              <span style={{ fontSize: 13, color: '#333' }}>추출 <b>{urgentAll?.items.length || 0}</b>건</span>
              <span style={{ fontSize: 13, color: '#333' }}>박스합계(FBC제외) <b>{boxTotalNonFbc}</b></span>
              <span style={{ fontSize: 13, color: '#d93025' }}>어제 대비 신규 <b>{newItems.length}</b>건</span>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'center', flexWrap: 'wrap', marginBottom: 16 }}>
              <button className="btn btn-primary btn-sm" onClick={handleShipExcel}>📥 엑셀 다운로드</button>
              <button className="btn btn-outline btn-sm" onClick={() => copyShipList(urgentAll?.items || [])}>📋 전체 발주번호 복사</button>
              <button className="btn btn-outline btn-sm" onClick={() => copyShipList(newItems)}>🆕 신규만 복사</button>
              <button className="btn btn-outline btn-sm" onClick={() => setShipOpen(false)}>닫기</button>
            </div>

            {/* 어제 대비 신규 추천 */}
            <div style={{ border: '1px solid #f3c2c0', borderRadius: 8, overflow: 'hidden', marginBottom: 18, background: '#fff8f8' }}>
              <div style={{ padding: '8px 12px', background: '#fdecea', fontSize: 14, fontWeight: 600, color: '#c5221f' }}>
                🆕 어제는 추천 안 했는데 오늘 추천 ({newItems.length}건)
                <span style={{ fontWeight: 400, fontSize: 11, color: '#999', marginLeft: 8 }}>
                  {snapBaseDate ? `비교 기준: ${snapBaseDate.slice(0, 4)}-${snapBaseDate.slice(4, 6)}-${snapBaseDate.slice(6, 8)}` : '비교할 어제 스냅샷 없음 (오늘이 첫 기준선 → 내일부터 비교 가능)'}
                </span>
              </div>
              {newItems.length === 0 ? (
                <div style={{ padding: 14, fontSize: 12, color: '#999' }}>신규 없음</div>
              ) : (
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#fbe3e1' }}>
                      <th style={{ padding: '6px 6px', textAlign: 'center' }}>발주번호</th>
                      <th style={{ padding: '6px 6px', textAlign: 'center' }}>상품명</th>
                      <th style={{ padding: '6px 6px', textAlign: 'center' }}>구분</th>
                      <th style={{ padding: '6px 6px', textAlign: 'center' }}>CN상태</th>
                      <th style={{ padding: '6px 6px', textAlign: 'center' }}>예상판매주</th>
                      <th style={{ padding: '6px 6px', textAlign: 'center' }}>박스수</th>
                      <th style={{ padding: '6px 6px', textAlign: 'center' }}>사유</th>
                    </tr>
                  </thead>
                  <tbody>
                    {newItems.map((it, i) => {
                      const key = it.colT || it.orderNo;
                      const open = shipExpanded.has(key);
                      return (
                        <Fragment key={key + i}>
                          <tr style={{ borderTop: '1px solid #f3d6d4' }}>
                            <td style={{ padding: '6px', fontFamily: 'monospace', fontSize: 11, textAlign: 'center' }}>{key}</td>
                            <td style={{ padding: '6px', textAlign: 'center' }}>{it.productName}</td>
                            <td style={{ padding: '6px', textAlign: 'center' }}>{it.category || '-'}</td>
                            <td style={{ padding: '6px', textAlign: 'center' }}>{it.cnStatus}</td>
                            <td style={{ padding: '6px', textAlign: 'center', color: '#c5221f', fontWeight: 600 }}>{it._effWeeks}주</td>
                            <td style={{ padding: '6px', textAlign: 'center' }}>{safeNum(it.box)}</td>
                            <td style={{ padding: '6px', textAlign: 'center' }}>
                              <button className="btn btn-outline btn-sm" style={{ fontSize: 10, padding: '2px 8px' }} onClick={() => toggleShipReason(key)}>
                                {open ? '▲ 접기' : '▼ 사유'}
                              </button>
                            </td>
                          </tr>
                          {open && (
                            <tr style={{ background: '#fffdf5' }}>
                              <td colSpan={7} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 11, lineHeight: 1.6, color: '#555' }}>
                                <div><b style={{ color: '#c5221f' }}>오늘 추천:</b> {urgentReasonToday(it, shipThreshold)}</div>
                                <div><b style={{ color: '#888' }}>어제 상태:</b> {urgentReasonYesterday(yesterdaySnap, key, URGENT_THRESHOLD_DEFAULT)}</div>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* 전체 추출 결과 */}
            <div style={{ border: '1px solid #e0e0e0', borderRadius: 8, overflow: 'hidden', marginBottom: 18 }}>
              <div style={{ padding: '8px 12px', background: '#f5f5f5', fontSize: 14, fontWeight: 600 }}>
                전체 추출 결과 ({urgentAll?.items.length || 0}건) · 박스합계(FBC제외) {boxTotalNonFbc}
              </div>
              <div style={{ maxHeight: 280, overflow: 'auto' }}>
                <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ background: '#fafafa', position: 'sticky', top: 0 }}>
                      <th style={{ padding: '6px', textAlign: 'center' }}>발주번호</th>
                      <th style={{ padding: '6px', textAlign: 'center' }}>상품명</th>
                      <th style={{ padding: '6px', textAlign: 'center' }}>구분</th>
                      <th style={{ padding: '6px', textAlign: 'center' }}>CN상태</th>
                      <th style={{ padding: '6px', textAlign: 'center' }}>예상판매주</th>
                      <th style={{ padding: '6px', textAlign: 'center' }}>수량</th>
                      <th style={{ padding: '6px', textAlign: 'center' }}>박스수</th>
                      <th style={{ padding: '6px', textAlign: 'center' }}>신규</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(urgentAll?.items || []).map((it, i) => {
                      const key = it.colT || it.orderNo;
                      return (
                        <tr key={key + i} style={{ borderTop: '1px solid #eee' }}>
                          <td style={{ padding: '6px', fontFamily: 'monospace', fontSize: 11, textAlign: 'center' }}>{key}</td>
                          <td style={{ padding: '6px', textAlign: 'center' }}>{it.productName}</td>
                          <td style={{ padding: '6px', textAlign: 'center' }}>{it.category || '-'}</td>
                          <td style={{ padding: '6px', textAlign: 'center' }}>{it.cnStatus}</td>
                          <td style={{ padding: '6px', textAlign: 'center', fontWeight: 600 }}>{it._effWeeks}주</td>
                          <td style={{ padding: '6px', textAlign: 'center' }}>{safeNum(it.qty)}</td>
                          <td style={{ padding: '6px', textAlign: 'center' }}>{it.category === 'FBC' ? '-' : safeNum(it.box)}</td>
                          <td style={{ padding: '6px', textAlign: 'center' }}>{isNewVsYesterday(key) ? <span style={{ color: '#c5221f', fontWeight: 600 }}>신규</span> : ''}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* 발주번호 중복 검증기 */}
            <div style={{ border: '1px solid #cfe2f3', borderRadius: 8, overflow: 'hidden', background: '#f7fbff' }}>
              <div style={{ padding: '8px 12px', background: '#e8f0fe', fontSize: 14, fontWeight: 600, color: '#1a56c4' }}>
                🔎 발주번호 중복 검증 (추천 리스트와 대조)
              </div>
              <div style={{ padding: 12 }}>
                <textarea
                  style={{ width: '100%', height: 90, fontSize: 12, padding: 10, border: '1px solid #ddd', borderRadius: 8, resize: 'vertical', fontFamily: 'monospace', textAlign: 'left' }}
                  placeholder={'발주번호를 붙여넣기 (줄바꿈/공백/쉼표 구분)\n예: AE-T-261102-005\nAE-HM-261102-002'}
                  value={shipDupText}
                  onChange={e => { setShipDupText(e.target.value); setShipDupResult(null); }}
                />
                <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 10 }}>
                  <button className="btn btn-primary btn-sm" onClick={handleShipDupCheck} disabled={!shipDupText.trim()}>검증하기</button>
                  <button className="btn btn-outline btn-sm" onClick={() => { setShipDupText(''); setShipDupResult(null); }}>지우기</button>
                </div>

                {shipDupResult && (
                  <div style={{ marginTop: 14 }}>
                    <div style={{ fontSize: 12, color: '#555', marginBottom: 8 }}>
                      입력 {shipDupResult.total}개 · 고유 {shipDupResult.uniqCount}개 · 중복 {shipDupResult.rows.filter(r => r.dup).length}종
                    </div>
                    <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', marginBottom: 12 }}>
                      <thead>
                        <tr style={{ background: '#eef4fb' }}>
                          <th style={{ padding: '6px', textAlign: 'center' }}>발주번호</th>
                          <th style={{ padding: '6px', textAlign: 'center' }}>입력횟수</th>
                          <th style={{ padding: '6px', textAlign: 'center' }}>중복</th>
                          <th style={{ padding: '6px', textAlign: 'center' }}>추천리스트 대조</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shipDupResult.rows.map((r, i) => (
                          <tr key={r.code + i} style={{ borderTop: '1px solid #eee' }}>
                            <td style={{ padding: '6px', fontFamily: 'monospace', fontSize: 11, textAlign: 'center' }}>{r.code}</td>
                            <td style={{ padding: '6px', textAlign: 'center' }}>{r.count}</td>
                            <td style={{ padding: '6px', textAlign: 'center' }}>{r.dup ? <span style={{ color: '#d93025', fontWeight: 600 }}>중복</span> : ''}</td>
                            <td style={{ padding: '6px', textAlign: 'center' }}>{r.inRec ? <span style={{ color: '#188038', fontWeight: 600 }}>겹침(추천O)</span> : <span style={{ color: '#999' }}>추가(추천X)</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ fontSize: 12, textAlign: 'left', background: '#fff', border: '1px solid #e0e0e0', borderRadius: 8, padding: 10 }}>
                      <div style={{ fontWeight: 600, color: '#c5221f', marginBottom: 4 }}>⚠ 누락 (추천엔 있는데 붙여넣기엔 없음): {shipDupResult.missing.length}건</div>
                      <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#555', lineHeight: 1.6, wordBreak: 'break-all' }}>
                        {shipDupResult.missing.length ? shipDupResult.missing.join(', ') : '(없음)'}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 테이블 */}
      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-wrapper" style={{ maxHeight: 'calc(100vh - 320px)', overflowY: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  {columns.map(col => (
                    <th
                      key={col.key}
                      className={`${col.cls || ''} ${sortKey === col.key ? 'sorted' : ''}`}
                      style={{ minWidth: col.width }}
                      onClick={() => !col.copyable && handleSort(col.key)}
                    >
                      {col.copyable ? (
                        <button
                          className="btn btn-outline btn-sm"
                          style={{ fontSize: 11, padding: '2px 8px' }}
                          onClick={(e) => { e.stopPropagation(); copyColT(); }}
                        >
                          {copied ? '✅ 복사됨' : '📋 복사'}
                        </button>
                      ) : (
                        <>{col.label}{sortIcon(col.key)}</>
                      )}
                    </th>
                  ))}
                  <th aria-hidden style={{ width: '100%', padding: 0, cursor: 'default' }} />
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={columns.length + 1} style={{ textAlign: 'center', padding: 40, color: '#999' }}>
                    {activeCard ? '해당 조건에 맞는 발주건이 없습니다' : '데이터가 없습니다'}
                  </td></tr>
                ) : filtered.map((r, i) => {
                  const isBlocked =
                    (activeCard === 'remind' && r._remindBlocked) ||
                    (activeCard === 'shipNeeded' && r._shipBlocked) ||
                    (activeCard === 'shipInland' && r._inlandBlocked);
                  return (
                  <tr key={i} style={isBlocked ? { background: '#ffd6d6' } : undefined}>
                    <td style={{ fontSize: 12, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.orderNo}>{r.orderNo}</td>
                    <td style={{ maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.productName}</td>
                    <td style={{ fontSize: 11, color: '#666' }}>{r.sku}</td>
                    <td className="num">{r.qty}</td>
                    <td>{r.brand}</td>
                    <td className="center">
                      {r.category && (
                        <span className={`status-badge ${r.category === '신규' ? '신규' : ''}`}>
                          {r.category}
                        </span>
                      )}
                    </td>
                    <td className="num">{r.actualQty || '-'}</td>
                    <td>
                      {r.cnStatus ? (
                        <span className={`alert-badge ${
                          r.cnStatus.includes('출고완료') || r.cnStatus.includes('출고 완료') ? 'normal' :
                          r.cnStatus.includes('발주완료') ? 'warning' : 'no-sales'
                        }`}>{r.cnStatus}</span>
                      ) : <span style={{ color: '#ccc' }}>-</span>}
                      {r._check && r._checkReason && (
                        <div style={{ fontSize: 10, color: '#d93025', marginTop: 2 }}>{r._checkReason}</div>
                      )}
                    </td>
                    <td>
                      {r.shipStatus ? (
                        <span className={`alert-badge ${
                          r.shipStatus.includes('출고완료') || r.shipStatus.includes('출고 완료') ? 'normal' :
                          r.shipStatus.includes('발주완료') || r.shipStatus.includes('CN 발주완료') ? 'warning' : 'no-sales'
                        }`}>{r.shipStatus}</span>
                      ) : <span style={{ color: '#ccc' }}>-</span>}
                    </td>
                    <td className="num" style={{ fontSize: 12 }}>{r._totalStock !== '-' ? Number(r._totalStock).toLocaleString() : '-'}</td>
                    <td className="num" style={{ fontSize: 12, color: r._totalWeeks !== '-' && parseFloat(r._totalWeeks) < 2 ? '#d93025' : r._totalWeeks !== '-' && parseFloat(r._totalWeeks) >= 4 ? '#34a853' : '' }}>{r._totalWeeks}</td>
                    <td className="center" style={{ fontSize: 12 }}>{r.cnShipDate || '-'}</td>
                    <td className="center" style={{ fontSize: 12 }}>{r.incheonDate || '-'}</td>
                    <td className="center" style={{ fontSize: 12 }}>{r.orderDate || '-'}</td>
                    <td className="center" style={{ fontSize: 12 }}>{r.colT || '-'}</td>
                    <td>
                      {r.memo ? (
                        <div
                          style={{ cursor: 'pointer', maxWidth: 100 }}
                          onClick={() => toggleMemo(i)}
                        >
                          {expandedMemo.has(i) ? (
                            <span style={{ fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{r.memo}</span>
                          ) : (
                            <span style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'block' }}>
                              {(() => { const m = r.memo.replace(/\s*[\r\n]+\s*/g, ' ').trim(); return '💬 ' + (m.length > 8 ? m.slice(0, 8) + '…' : m); })()}
                            </span>
                          )}
                        </div>
                      ) : <span style={{ color: '#ccc' }}>-</span>}
                    </td>
                    <td>
                      {r.colT ? (() => {
                        const note = notes[r.colT];
                        if (editingNote === r.colT) {
                          return (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 150 }} onClick={e => e.stopPropagation()}>
                              <input
                                style={{ fontSize: 11, padding: '3px 6px', border: '1px solid #ddd', borderRadius: 4, width: '100%' }}
                                placeholder="답변 내용"
                                value={noteInput}
                                onChange={e => setNoteInput(e.target.value)}
                              />
                              <input
                                type="date"
                                style={{ fontSize: 11, padding: '3px 6px', border: '1px solid #ddd', borderRadius: 4, width: '100%' }}
                                value={arrivalInput}
                                onChange={e => setArrivalInput(e.target.value)}
                              />
                              <div style={{ display: 'flex', gap: 4 }}>
                                <button className="btn btn-primary btn-sm" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => saveNote(r.colT)}>저장</button>
                                <button className="btn btn-outline btn-sm" style={{ fontSize: 10, padding: '2px 6px' }} onClick={() => setEditingNote(null)}>취소</button>
                              </div>
                            </div>
                          );
                        }
                        if (note) {
                          const isOverdue = note.arrivalDate && note.arrivalDate <= todayStr();
                          return (
                            <div style={{ fontSize: 11, maxWidth: 160 }}>
                              <div style={{ color: '#333', marginBottom: 2 }}>{note.reply}</div>
                              {note.arrivalDate && (
                                <div style={{
                                  fontSize: 10, fontWeight: 600,
                                  color: isOverdue ? '#d93025' : '#1a73e8',
                                }}>
                                  📅 {note.arrivalDate} {isOverdue ? '(확인필요)' : ''}
                                </div>
                              )}
                              <div style={{ display: 'flex', gap: 4, marginTop: 2 }}>
                                <span style={{ fontSize: 10, color: '#1a73e8', cursor: 'pointer' }} onClick={() => { setEditingNote(r.colT); setNoteInput(note.reply || ''); setArrivalInput(note.arrivalDate || ''); }}>수정</span>
                                <span style={{ fontSize: 10, color: '#999', cursor: 'pointer' }} onClick={() => deleteNote(r.colT)}>삭제</span>
                              </div>
                            </div>
                          );
                        }
                        return (
                          <span
                            style={{ fontSize: 11, color: '#1a73e8', cursor: 'pointer' }}
                            onClick={() => { setEditingNote(r.colT); setNoteInput(''); setArrivalInput(''); }}
                          >+ 답변 입력</span>
                        );
                      })() : <span style={{ color: '#ccc' }}>-</span>}
                    </td>
                    <td style={{ padding: 0 }} />
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
