import { useState, useMemo, useEffect, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
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
const SHIP_THRESHOLD_WEEKS = 2;

// 출고필요 판정: CN상태가 "CN 창고도착"/"작업 대기" → 출고필요, "내륙운송중" → 출고필요(내륙운송중)
// 예상판매주 < 2주인 SKU 대상, 발주일순 누적하여 5주 될 때까지 표시
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

    // 예상판매주 2주 이상이면 스킵
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

    // 출고완료분 포함해서 이미 2주 이상이면 출고 안 급함
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

      // 발주장부 파싱
      const csv = await orderRes.text();
      const lines = csv.split('\n').filter(l => l.trim());
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvRow(lines[i]);
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
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={columns.length} style={{ textAlign: 'center', padding: 40, color: '#999' }}>
                    {activeCard ? '해당 조건에 맞는 발주건이 없습니다' : '데이터가 없습니다'}
                  </td></tr>
                ) : filtered.map((r, i) => (
                  <tr key={i}>
                    <td style={{ fontSize: 12 }}>{r.orderNo}</td>
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
                              💬 {r.memo.length > 8 ? r.memo.slice(0, 8) + '…' : r.memo}
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
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
