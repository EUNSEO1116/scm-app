import { useState, useMemo, useEffect, useCallback } from 'react';
import * as XLSX from 'xlsx';
import { fetchFromSheet, saveReasonsToSheet, deleteReasonFromSheet, markLocalSave } from '../sheetSync.js';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`;
const TSV_DATA = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=0`;
const CSV_ORDER = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('발주장부')}`;

// 제외 상태 키워드
const EXCLUDE_KEYWORDS = ['최종마감', '품질확인서', '마감대상'];

// 품절위기: 재고 / 3일평균판매 < 3일치 (3일 안에 소진 예상)
const CRISIS_DAYS_THRESHOLD = 3;

function safeNum(v) {
  if (v === '' || v === '-' || v === undefined || v === null) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function fmt(n) {
  if (n === null || n === undefined || n === '' || n === '-') return '-';
  const num = Number(n);
  if (isNaN(num)) return n;
  return num.toLocaleString('ko-KR');
}

function fmtDec(n, d = 1) {
  if (n === null || n === undefined || n === '' || n === '-') return '-';
  const num = Number(n);
  if (isNaN(num)) return '-';
  return num.toFixed(d);
}

function shouldExclude(status) {
  if (!status) return false;
  return EXCLUDE_KEYWORDS.some(kw => status.includes(kw));
}

const RISK_CONFIG = {
  '품절':   { emoji: '🔴', cls: 'soldout',  label: '품절' },
  '품절위기': { emoji: '🟠', cls: 'risk',    label: '품절위기' },
};

// 윙 ON 판정 CN 상태 키워드
const WING_ON_STATUSES = ['CN 창고도착', '부분출고 대기', '출고 완료', '출고 대기', '출고완료'];

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

// "3월 26일" → 정렬용 숫자 (326)
function parseOrderDateSort(dateStr) {
  const m = (dateStr || '').match(/(\d+)월\s*(\d+)일/);
  if (!m) return 9999;
  return Number(m[1]) * 100 + Number(m[2]);
}

// "3/27" → Date
function parseShipDate(str) {
  if (!str) return null;
  const m = str.match(/(\d+)\/(\d+)/);
  if (!m) return null;
  return new Date(new Date().getFullYear(), parseInt(m[1], 10) - 1, parseInt(m[2], 10));
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function fmtDate(d) {
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const SOLDOUT_REASONS_KEY = 'soldout_reasons_v2';
const SOLDOUT_HISTORY_KEY = 'soldout_history';
const NEW_PRODUCT_STOCK_KEY = 'new_product_stock_tracker';
const PREV_SOLDOUT_KEY = 'soldout_prev_barcodes';

// 신규 상품 재고 추적: 7일간 G열 기록
function loadStockTrackerLocal() {
  try { return JSON.parse(localStorage.getItem(NEW_PRODUCT_STOCK_KEY)) || {}; } catch { return {}; }
}
async function loadStockTracker() {
  const local = loadStockTrackerLocal();
  try {
    const db = await dbStoreGet('new_product_stock');
    if (!db) return local;
    // DB와 localStorage 병합: 바코드별로 records 합치고 중복 날짜는 로컬 우선
    const merged = { ...db };
    for (const [barcode, entry] of Object.entries(local)) {
      if (!merged[barcode]) {
        merged[barcode] = entry;
      } else {
        const dateMap = {};
        for (const r of merged[barcode].records) dateMap[r.date] = r;
        for (const r of entry.records) dateMap[r.date] = r; // 로컬 우선
        merged[barcode].records = Object.values(dateMap);
        merged[barcode].firstSeen = merged[barcode].firstSeen < entry.firstSeen
          ? merged[barcode].firstSeen : entry.firstSeen;
      }
    }
    return merged;
  } catch {
    return local;
  }
}
function saveStockTracker(data) {
  localStorage.setItem(NEW_PRODUCT_STOCK_KEY, JSON.stringify(data));
  dbStoreSet('new_product_stock', data).catch(() => {});
}
// tracker: { [barcode]: { records: [{date, stock}], firstSeen: 'YYYY-MM-DD' } }
async function updateStockTracker(newProducts, preloadedTracker) {
  // newProducts: [{ barcode, stock }]  — 신규 상태 상품들
  const tracker = preloadedTracker || await loadStockTracker();
  const today = todayStr();
  const sevenDaysAgo = new Date();
  sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

  for (const { barcode, stock } of newProducts) {
    if (!tracker[barcode]) {
      tracker[barcode] = { records: [], firstSeen: today };
    }
    const entry = tracker[barcode];
    // 오늘 이미 기록했으면 업데이트
    const todayRecord = entry.records.find(r => r.date === today);
    if (todayRecord) {
      todayRecord.stock = stock;
    } else {
      entry.records.push({ date: today, stock });
    }
    // 7일 초과 기록 제거
    entry.records = entry.records.filter(r => new Date(r.date) >= sevenDaysAgo);
  }

  // 더이상 신규가 아닌 상품은 정리 (30일 이상 기록 없으면 삭제)
  for (const barcode of Object.keys(tracker)) {
    const lastRecord = tracker[barcode].records[tracker[barcode].records.length - 1];
    if (lastRecord && new Date(lastRecord.date) < sevenDaysAgo) {
      delete tracker[barcode];
    }
  }

  saveStockTracker(tracker);
  return tracker;
}
// 한 번이라도 재고 > 0이었는지 확인
function hadStockBefore(tracker, barcode) {
  const entry = tracker[barcode];
  if (!entry) return false;
  return entry.records.some(r => r.stock > 0);
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function daysBetween(dateStr) {
  if (!dateStr) return 0;
  const d = new Date(dateStr);
  const now = new Date();
  return Math.floor((now - d) / (1000 * 60 * 60 * 24));
}

// 현재 사유: { barcode: { reason, date } }
// 사유가 비어있으면 품절기록(history)에서 최신 사유 복원
function loadSoldoutReasons() {
  try {
    const reasons = JSON.parse(localStorage.getItem(SOLDOUT_REASONS_KEY) || '{}');
    const history = JSON.parse(localStorage.getItem(SOLDOUT_HISTORY_KEY) || '{}');
    let restored = false;
    for (const [barcode, entries] of Object.entries(history)) {
      if (!reasons[barcode] && entries.length > 0) {
        const latest = entries[entries.length - 1];
        reasons[barcode] = { reason: latest.reason, date: latest.date };
        restored = true;
      }
    }
    if (restored) localStorage.setItem(SOLDOUT_REASONS_KEY, JSON.stringify(reasons));
    return reasons;
  } catch { return {}; }
}
function saveSoldoutReasons(data) {
  localStorage.setItem(SOLDOUT_REASONS_KEY, JSON.stringify(data));
}

// 품절 기록 누적: { barcode: [{ reason, date, productName, optionName }] }
function loadSoldoutHistory() {
  try { return JSON.parse(localStorage.getItem(SOLDOUT_HISTORY_KEY) || '{}'); } catch { return {}; }
}
function saveSoldoutHistory(data) {
  localStorage.setItem(SOLDOUT_HISTORY_KEY, JSON.stringify(data));
}

function parseOrderBook(csv) {
  const skuMap = new Map();
  const skuArrival = new Map(); // SKU → 입고예상일
  if (!csv) return { skuMap, skuArrival };
  const lines = csv.split('\n').filter(l => l.trim());

  // SKU별 발주건 모으기
  const skuOrders = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    const sku = (cols[2] || '').trim();
    const cnStatus = (cols[8] || '').trim();
    const shipDate = (cols[10] || '').trim(); // CN 중국 출고일
    const orderDate = (cols[16] || '').trim(); // 발주일
    if (!sku) continue;

    const isWingOn = WING_ON_STATUSES.some(s => cnStatus.includes(s));
    const prev = skuMap.get(sku);
    if (!prev || (isWingOn && prev !== 'wing_on')) {
      skuMap.set(sku, isWingOn ? 'wing_on' : 'check');
    }

    if (!skuOrders[sku]) skuOrders[sku] = [];
    skuOrders[sku].push({ cnStatus, shipDate, orderDate });
  }

  // SKU별 입고예상일 계산 (발주일이 가장 빠른 건 기준)
  const today = new Date();
  for (const [sku, orders] of Object.entries(skuOrders)) {
    orders.sort((a, b) => parseOrderDateSort(a.orderDate) - parseOrderDateSort(b.orderDate));
    const first = orders[0];
    const cn = first.cnStatus;
    let arrival = null;

    if (cn.includes('출고 완료') || cn.includes('출고완료')) {
      const sd = parseShipDate(first.shipDate);
      if (sd) arrival = addDays(sd, 3);
    } else if (cn.includes('CN 창고도착') || cn.includes('작업 대기') || cn.includes('출고 대기') || (cn.includes('내륙') && cn.includes('운송'))) {
      arrival = addDays(today, 4);
    } else if (cn === '업체발송대기') {
      arrival = addDays(today, 8);
    }
    // cn이 비어있으면 null 유지

    if (arrival) skuArrival.set(sku, fmtDate(arrival));
  }

  return { skuMap, skuArrival };
}

async function parseData(calcTsv, dataTsv, orderSkus, skuArrival, preloadedTracker) {
  // 데이터 입력 시트에서 옵션ID → 상품등급 매핑
  const statusMap = {};
  if (dataTsv) {
    const lines = dataTsv.split('\n').filter(l => l.trim());
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      const optionId = (cols[2] || '').trim();
      const grade = (cols[6] || '').trim();
      if (optionId) statusMap[optionId] = grade;
    }
  }

  const lines = calcTsv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  const results = [];
  let totalValidCount = 0;
  let soldoutRateCount = 0;

  // 제외 품목 로드 (품절률 계산용)
  const excludeItems = (() => {
    try { return JSON.parse(localStorage.getItem('soldout_exclude_items') || '[]'); } catch { return []; }
  })();
  const todayKey = todayStr();
  const isExcludedBarcode = (bc) => excludeItems.some(item =>
    item.barcode === bc && (!item.endDate || item.endDate >= todayKey)
  );

  // 1차 패스: 신규 상품 재고 수집 → tracker 업데이트
  const newProducts = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    const barcode = cols[2] || '';
    const rawStatus = cols[5] || '';
    const st = rawStatus || statusMap[cols[1] || ''] || '';
    if (st.includes('신규') && barcode) {
      newProducts.push({ barcode, stock: safeNum(cols[6]) });
    }
  }
  const stockTracker = await updateStockTracker(newProducts, preloadedTracker);

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (!cols[1] && !cols[2]) continue;

    const optionId = cols[1] || '';
    const barcode = cols[2] || '';
    const productName = cols[3] || '';
    const optionName = cols[4] || '';
    const rawStatus = cols[5] || '';
    const status = rawStatus || statusMap[optionId] || '';
    const stock = safeNum(cols[6]);          // 쿠팡재고
    const incoming = safeNum(cols[7]);       // 그로스 입고예정
    const ipgo = safeNum(cols[8]);           // 입고
    const bhStock = safeNum(cols[9]);        // 박스히어로
    const totalStock = safeNum(cols[14]);    // 총재고
    const weeksStockIncoming = safeNum(cols[21]); // 쿠팡재고+입고예정 예상 판매 주
    const avg3d = safeNum(cols[26]);         // 3일 평균 판매량
    const alert = (cols[33] || '').trim();   // 알림
    const leadTime = safeNum(cols[31]) || 30;
    const orderQty7d = safeNum(cols[19]);

    // 제외: 최종마감, 품질확인서, 마감대상 포함 상태
    if (shouldExclude(status)) continue;

    // 품절률 계산: 월별품절률(SoldOutRate)과 동일 기준
    const skipForRate = (status === '신규' && incoming > 0) || (status === 'NEW' && incoming > 0) || isExcludedBarcode(barcode);
    if (!skipForRate) {
      totalValidCount++;
      if (stock === 0) soldoutRateCount++;
    }

    // 품절/품절위기 판정
    let riskLevel = null;
    let riskReason = '';
    let forceArrival = '';

    // 신규 상품: 7일간 재고 추적 결과 한 번도 재고 > 0이 된 적 없으면 품절 아님
    // 단, 수동 예외 목록은 신규 조건 무시 (재고 이력 확인된 상품)
    if (status.includes('신규') && stock === 0 && !hadStockBefore(stockTracker, barcode)) continue;

    if (stock === 0) {
      riskLevel = '품절';
      if (incoming > 0 || ipgo > 0) {
        // 입고예정/입고 수량 있으면 입고예상일을 내일로
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        forceArrival = `${tomorrow.getFullYear()}-${String(tomorrow.getMonth()+1).padStart(2,'0')}-${String(tomorrow.getDate()).padStart(2,'0')}`;
        riskReason = `재고 없음 (입고예정 ${incoming + ipgo}개)`;
      } else {
        riskReason = bhStock > 0 ? '박스히어로 재고 있음' : '재고 없음';
      }
    } else if (incoming > 0 || ipgo > 0) {
      // 재고 있고 입고예정도 있으면 제외
      continue;
    } else if (avg3d > 0) {
      const daysLeft = stock / avg3d;
      if (weeksStockIncoming > 0 && weeksStockIncoming < 1) {
        // 예상 판매 주 < 1주
        riskLevel = '품절위기';
        riskReason = `예상 ${fmtDec(weeksStockIncoming)}주 (1주 미만)`;
      } else if (daysLeft < CRISIS_DAYS_THRESHOLD) {
        // 3일 평균으로 봤을 때 3일 이내 소진
        riskLevel = '품절위기';
        riskReason = `재고 ${stock}개 / 일평균 ${fmtDec(avg3d)}개 = ${fmtDec(daysLeft)}일분`;
      }
    }

    if (!riskLevel) continue; // 품절도 품절위기도 아니면 스킵

    // 발주장부 상태 확인: 'wing_on' | 'check' | null(없음)
    const orderStatus = orderSkus ? orderSkus.get(barcode) || null : null;
    const arrivalEst = forceArrival || (skuArrival ? skuArrival.get(barcode) || '' : '');

    results.push({
      optionId, barcode, productName, optionName, status,
      stock, incoming, ipgo, bhStock, totalStock,
      weeksStockIncoming, avg3d, alert, leadTime,
      riskLevel, riskReason, orderStatus, arrivalEst,
    });
  }

  // 정렬: 품절 먼저, 그 안에서 판매량 높은 순
  results.sort((a, b) => {
    if (a.riskLevel !== b.riskLevel) return a.riskLevel === '품절' ? -1 : 1;
    return b.avg3d - a.avg3d;
  });

  const soldoutRate = totalValidCount > 0 ? Math.round(soldoutRateCount / totalValidCount * 10000) / 100 : 0;
  results._meta = { totalValidCount, soldoutRateCount, soldoutRate };
  return results;
}

export default function SoldOut() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [search, setSearch] = useState('');
  const [riskFilter, setRiskFilter] = useState('all');
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [reasons, setReasons] = useState(loadSoldoutReasons);
  const [selected, setSelected] = useState(new Set());
  const [reasonInput, setReasonInput] = useState('');
  const [showReasonInput, setShowReasonInput] = useState(false);

  const toggleSelect = (barcode) => {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(barcode) ? next.delete(barcode) : next.add(barcode);
      return next;
    });
  };

  const applyReason = () => {
    if (!reasonInput.trim() || selected.size === 0) return;
    const today = todayStr();
    const updatedReasons = { ...reasons };
    const history = loadSoldoutHistory();

    for (const barcode of selected) {
      const item = data?.find(r => r.barcode === barcode);
      updatedReasons[barcode] = { reason: reasonInput.trim(), date: today };
      // 기록 누적
      if (!history[barcode]) history[barcode] = [];
      history[barcode].push({
        reason: reasonInput.trim(),
        date: today,
        productName: item?.productName || '',
        optionName: item?.optionName || '',
      });
    }

    setReasons(updatedReasons);
    saveSoldoutReasons(updatedReasons);
    saveSoldoutHistory(history);

    // Sync to sheet (fire-and-forget)
    const items = [];
    for (const barcode of selected) {
      const item = data?.find(r => r.barcode === barcode);
      items.push({
        barcode,
        reason: reasonInput.trim(),
        date: today,
        productName: item?.productName || '',
        optionName: item?.optionName || '',
      });
    }
    markLocalSave([...selected]);
    saveReasonsToSheet(items);

    setSelected(new Set());
    setReasonInput('');
    setShowReasonInput(false);
  };

  const clearReason = (barcode) => {
    const updated = { ...reasons };
    delete updated[barcode];
    setReasons(updated);
    saveSoldoutReasons(updated);
    deleteReasonFromSheet(barcode); // fire-and-forget
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [calcRes, dataRes, orderRes] = await Promise.all([
        fetch(TSV_CALC), fetch(TSV_DATA), fetch(CSV_ORDER),
      ]);
      if (!calcRes.ok) throw new Error(`HTTP ${calcRes.status}`);
      const calcTsv = await calcRes.text();
      const dataTsv = dataRes.ok ? await dataRes.text() : null;
      const orderCsv = orderRes.ok ? await orderRes.text() : null;
      const { skuMap: orderSkus, skuArrival } = parseOrderBook(orderCsv);
      const preloadedTracker = await loadStockTracker();
      const parsed = await parseData(calcTsv, dataTsv, orderSkus, skuArrival, preloadedTracker);

      // 재진입 품절 사유 자동 삭제: 이전에 품절 아니었다가 다시 품절된 항목
      // 단, 최근 저장한 항목(보호 기간)은 삭제하지 않음
      const currentSoldout = new Set(parsed.filter(r => r.riskLevel === '품절').map(r => r.barcode));
      try {
        const prevRaw = localStorage.getItem(PREV_SOLDOUT_KEY);
        if (prevRaw !== null) {
          const prevSoldout = new Set(JSON.parse(prevRaw));
          const protected_ = getProtectedBarcodes();
          const currentReasons = loadSoldoutReasons();
          let changed = false;
          for (const barcode of currentSoldout) {
            if (!prevSoldout.has(barcode) && currentReasons[barcode] && !protected_.has(barcode)) {
              delete currentReasons[barcode];
              changed = true;
              // 스프레드시트에서는 삭제하지 않음 (기록 유지)
            }
          }
          if (changed) {
            saveSoldoutReasons(currentReasons);
            setReasons({ ...currentReasons });
          }
        }
        localStorage.setItem(PREV_SOLDOUT_KEY, JSON.stringify([...currentSoldout]));
      } catch {}

      setData(parsed);
      setLastUpdated(new Date());
    } catch (err) {
      setError('데이터를 불러오지 못했습니다: ' + err.message);
    }
    setLoading(false);
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    fetchFromSheet().then(data => {
      if (data) {
        setReasons(loadSoldoutReasons());
      }
    });
  }, []);

  const stats = useMemo(() => {
    if (!data) return null;
    const soldout = data.filter(r => r.riskLevel === '품절');
    const risk = data.filter(r => r.riskLevel === '품절위기');
    const inOrder = data.filter(r => r.orderStatus === 'wing_on' || r.orderStatus === 'check');
    const meta = data._meta || {};
    return {
      total: data.length,
      soldout: soldout.length,
      todayRate: meta.soldoutRate ?? null,
      risk: risk.length,
      inOrder: inOrder.length,
    };
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    let rows = data;

    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        r.productName.toLowerCase().includes(q) ||
        r.optionName.toLowerCase().includes(q) ||
        r.barcode.toLowerCase().includes(q)
      );
    }

    if (riskFilter === '품절' || riskFilter === '품절위기') {
      rows = rows.filter(r => r.riskLevel === riskFilter);
    } else if (riskFilter === 'inOrder') {
      rows = rows.filter(r => r.orderStatus === 'wing_on' || r.orderStatus === 'check');
    }

    if (sortKey) {
      rows = [...rows].sort((a, b) => {
        let va = a[sortKey], vb = b[sortKey];
        if (typeof va === 'string') va = va.toLowerCase();
        if (typeof vb === 'string') vb = vb.toLowerCase();
        if (va == null) va = '';
        if (vb == null) vb = '';
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return rows;
  }, [data, search, riskFilter, sortKey, sortDir]);

  const handleSort = (key) => {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('asc'); }
  };

  const SortIcon = ({ col }) => (
    <span className="sort-icon">
      {sortKey === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );

  const handleExport = () => {
    if (!filtered.length) return;
    const rows = filtered.map(r => ({
      '상태': r.riskLevel,
      '사유': r.riskReason,
      '바코드': r.barcode,
      '상품명': r.productName,
      '옵션명': r.optionName,
      '쿠팡재고': r.stock,
      '박스히어로': r.bhStock,
      '총재고': r.totalStock,
      '3일평균판매': r.avg3d,
      '예상판매주': r.weeksStockIncoming,
      '발주현황': r.orderStatus === 'wing_on' ? '윙 ON' : r.orderStatus === 'check' ? '발주장부 확인' : '발주 필요',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '품절관리');
    XLSX.writeFile(wb, `품절관리_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  if (loading && !data) {
    return (
      <div className="loading" style={{ padding: 80, flexDirection: 'column', gap: 12 }}>
        <div className="spinner" />
        <p>스프레드시트에서 데이터를 불러오는 중...</p>
      </div>
    );
  }

  if (error && !data) {
    return (
      <div className="card">
        <div className="card-body" style={{ textAlign: 'center', padding: 60 }}>
          <div style={{ fontSize: 48, marginBottom: 16 }}>⚠️</div>
          <h3>{error}</h3>
          <button className="btn btn-primary" style={{ marginTop: 16 }} onClick={fetchData}>다시 시도</button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  const rateColor = stats.todayRate != null ? (stats.todayRate > 10 ? '#d93025' : stats.todayRate > 5 ? '#e65100' : '#2e7d32') : '#999';

  return (
    <div>
      {/* Stats */}
      <div className="stats-grid">
        <div
          className={`stat-card danger clickable${riskFilter === 'all' ? '' : ''}`}
          style={{ cursor: 'pointer', border: riskFilter === 'all' ? '2px solid var(--danger)' : '2px solid transparent' }}
          onClick={() => setRiskFilter('all')}
        >
          <div className="label">전체 품절/위기</div>
          <div className="value">{fmt(stats.total)}</div>
          <div className="sub">관리 대상 전체</div>
        </div>
        <div
          className="stat-card clickable"
          style={{
            cursor: 'pointer', background: '#fff5f5',
            border: riskFilter === '품절' ? '2px solid #c5221f' : '2px solid transparent',
          }}
          onClick={() => setRiskFilter(riskFilter === '품절' ? 'all' : '품절')}
        >
          <div className="label">🔴 품절</div>
          <div className="value" style={{ color: '#c5221f' }}>{fmt(stats.soldout)}</div>
          <div className="sub">쿠팡재고 0</div>
        </div>
        <div
          className="stat-card"
          style={{
            background: stats.todayRate > 10 ? '#fef0ef' : stats.todayRate > 5 ? '#fff8f0' : '#f0faf0',
            border: `2px solid ${rateColor}`,
          }}
        >
          <div className="label" style={{ color: rateColor, fontWeight: 700, fontSize: 13, textShadow: `0 1px 3px ${rateColor}44` }}>오늘 품절률</div>
          <div className="value" style={{ color: rateColor }}>{stats.todayRate != null ? stats.todayRate + '%' : '-'}</div>
          <div className="sub" style={{ color: rateColor, fontWeight: 600 }}>
            {stats.todayRate != null ? (stats.todayRate > 10 ? '위험' : stats.todayRate > 5 ? '주의' : '양호') : ''}
          </div>
        </div>
        <div
          className="stat-card clickable"
          style={{
            cursor: 'pointer', background: '#fff3e0',
            border: riskFilter === '품절위기' ? '2px solid #e65100' : '2px solid transparent',
          }}
          onClick={() => setRiskFilter(riskFilter === '품절위기' ? 'all' : '품절위기')}
        >
          <div className="label">🟠 품절위기</div>
          <div className="value" style={{ color: '#e65100' }}>{fmt(stats.risk)}</div>
          <div className="sub">3일 이내 소진 예상</div>
        </div>
        <div
          className="stat-card clickable"
          style={{
            cursor: 'pointer', background: riskFilter === 'inOrder' ? '#e0f2f1' : '#e8f5e9',
            border: riskFilter === 'inOrder' ? '2px solid #00897b' : '2px solid transparent',
          }}
          onClick={() => setRiskFilter(riskFilter === 'inOrder' ? 'all' : 'inOrder')}
        >
          <div className="label">✈️ 윙ON + 📋 장부확인</div>
          <div className="value" style={{ color: '#00897b' }}>{fmt(stats.inOrder)}</div>
          <div className="sub">발주장부에 있는 품목</div>
        </div>
      </div>

      {/* Filters */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className="filter-bar">
            <input
              className="search-input"
              placeholder="상품명, 옵션명, 바코드 검색..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <button
              className={`filter-btn${riskFilter === 'all' ? ' active' : ''}`}
              onClick={() => setRiskFilter('all')}
            >전체 ({stats.total})</button>
            <button
              className={`filter-btn${riskFilter === '품절' ? ' active' : ''}`}
              style={riskFilter === '품절' ? { background: '#c5221f', borderColor: '#c5221f' } : {}}
              onClick={() => setRiskFilter(riskFilter === '품절' ? 'all' : '품절')}
            >🔴 품절 ({stats.soldout})</button>
            <button
              className={`filter-btn${riskFilter === '품절위기' ? ' active' : ''}`}
              style={riskFilter === '품절위기' ? { background: '#e65100', borderColor: '#e65100' } : {}}
              onClick={() => setRiskFilter(riskFilter === '품절위기' ? 'all' : '품절위기')}
            >🟠 품절위기 ({stats.risk})</button>
            {selected.size > 0 && (
              <button className="btn btn-primary btn-sm" onClick={() => setShowReasonInput(true)}>
                ✏️ {selected.size}개 사유 입력
              </button>
            )}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 13, color: '#5f6368' }}>
              {fmt(filtered.length)}개 상품
              {lastUpdated && ` · ${lastUpdated.toLocaleTimeString('ko-KR')}`}
            </span>
            <button className="btn btn-primary btn-sm" onClick={handleExport}>📥 엑셀</button>
            <button className="btn btn-outline btn-sm" onClick={fetchData} disabled={loading}>
              {loading ? '로딩...' : '🔄 새로고침'}
            </button>
          </div>
        </div>
      </div>

      {/* Info */}
      <div style={{ padding: '0 0 12px', fontSize: 12, color: '#5f6368' }}>
        최종마감 · 품질확인서 · 마감대상 상태 제외 | 품절 = 쿠팡재고 0 | 품절위기 = 예상판매 1주 미만 또는 재고 3일 이내 소진
      </div>

      {/* Table */}
      <div className="table-wrapper" style={{ maxHeight: 'calc(100vh - 380px)', overflowY: 'auto' }}>
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 36 }}>
                <input type="checkbox"
                  checked={filtered.length > 0 && filtered.filter(r => r.riskLevel === '품절').every(r => selected.has(r.barcode)) && filtered.some(r => r.riskLevel === '품절')}
                  onChange={() => {
                    const soldouts = filtered.filter(r => r.riskLevel === '품절').map(r => r.barcode);
                    const allSelected = soldouts.every(b => selected.has(b));
                    if (allSelected) setSelected(new Set());
                    else setSelected(new Set(soldouts));
                  }}
                  style={{ cursor: 'pointer' }}
                />
              </th>
              <th style={{ width: 40 }}>#</th>
              <th>상태</th>
              <th>사유</th>
              <th>입고예상일</th>
              <th>품절일수</th>
              <th onClick={() => handleSort('barcode')} className={sortKey === 'barcode' ? 'sorted' : ''}>
                바코드<SortIcon col="barcode" />
              </th>
              <th onClick={() => handleSort('productName')} className={sortKey === 'productName' ? 'sorted' : ''} style={{ maxWidth: 250 }}>
                상품명<SortIcon col="productName" />
              </th>
              <th onClick={() => handleSort('optionName')} className={sortKey === 'optionName' ? 'sorted' : ''}>
                옵션명<SortIcon col="optionName" />
              </th>
              <th onClick={() => handleSort('stock')} className={sortKey === 'stock' ? 'sorted' : ''}>
                쿠팡재고<SortIcon col="stock" />
              </th>
              <th onClick={() => handleSort('bhStock')} className={sortKey === 'bhStock' ? 'sorted' : ''}>
                박스히어로<SortIcon col="bhStock" />
              </th>
              <th onClick={() => handleSort('totalStock')} className={sortKey === 'totalStock' ? 'sorted' : ''}>
                총재고<SortIcon col="totalStock" />
              </th>
              <th onClick={() => handleSort('avg3d')} className={sortKey === 'avg3d' ? 'sorted' : ''}>
                3일평균<SortIcon col="avg3d" />
              </th>
              <th onClick={() => handleSort('weeksStockIncoming')} className={sortKey === 'weeksStockIncoming' ? 'sorted' : ''}>
                예상판매주<SortIcon col="weeksStockIncoming" />
              </th>
              <th onClick={() => handleSort('orderStatus')} className={sortKey === 'orderStatus' ? 'sorted' : ''}>
                발주현황<SortIcon col="orderStatus" />
              </th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((r, i) => {
              const rc = RISK_CONFIG[r.riskLevel];
              return (
                <tr key={r.optionId + '-' + i} className={r.riskLevel === '품절' ? 'row-emergency' : ''} style={selected.has(r.barcode) ? { background: '#e8f0fe' } : {}}>
                  <td style={{ textAlign: 'center' }}>
                    {r.riskLevel === '품절' && (
                      <input type="checkbox" checked={selected.has(r.barcode)} onChange={() => toggleSelect(r.barcode)} style={{ cursor: 'pointer' }} />
                    )}
                  </td>
                  <td className="num">{i + 1}</td>
                  <td>
                    <span className={`alert-badge ${rc.cls}`}>
                      {rc.emoji} {rc.label}
                    </span>
                  </td>
                  <td style={{ fontSize: 11, color: '#666', maxWidth: 160 }}>
                    {r.riskLevel === '품절' ? (
                      <div>
                        {reasons[r.barcode]?.reason ? (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                            <span style={{ fontSize: 10, background: '#f3eef8', color: '#7c4dbd', borderRadius: 4, padding: '1px 6px', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', display: 'inline-block' }} title={reasons[r.barcode].reason}>
                              {reasons[r.barcode].reason}
                            </span>
                            <span style={{ fontSize: 10, color: '#999', cursor: 'pointer' }} onClick={() => clearReason(r.barcode)}>✕</span>
                          </div>
                        ) : (
                          <span style={{ color: '#ccc', fontSize: 10 }}>체크 후 입력</span>
                        )}
                      </div>
                    ) : r.riskReason}
                  </td>
                  <td className="center" style={{ fontSize: 11, color: r.arrivalEst ? '#1a73e8' : '#ccc', fontWeight: r.arrivalEst ? 600 : 400 }}>
                    {r.arrivalEst || '-'}
                  </td>
                  <td className="center" style={{ fontSize: 11 }}>
                    {r.riskLevel === '품절' && reasons[r.barcode]?.date ? (
                      <span style={{ color: daysBetween(reasons[r.barcode].date) >= 7 ? '#d93025' : '#666', fontWeight: daysBetween(reasons[r.barcode].date) >= 7 ? 600 : 400 }}>
                        {daysBetween(reasons[r.barcode].date)}일
                      </span>
                    ) : <span style={{ color: '#ccc' }}>-</span>}
                  </td>
                  <td style={{ fontSize: 11, color: '#666' }}>{r.barcode}</td>
                  <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.productName}>
                    {r.productName}
                  </td>
                  <td>{r.optionName}</td>
                  <td className="num" style={{ color: r.stock === 0 ? '#c5221f' : '', fontWeight: r.stock === 0 ? 700 : 400 }}>
                    {fmt(r.stock)}
                  </td>
                  <td className="num">
                    {r.bhStock > 0 ? (
                      <span style={{ color: '#2e7d32' }}>{fmt(r.bhStock)}</span>
                    ) : '-'}
                  </td>
                  <td className="num" style={{ fontWeight: 600 }}>{fmt(r.totalStock)}</td>
                  <td className="num">{r.avg3d > 0 ? fmtDec(r.avg3d) : '-'}</td>
                  <td className="num" style={{ color: r.weeksStockIncoming < 1 && r.weeksStockIncoming > 0 ? '#e65100' : '' }}>
                    {r.weeksStockIncoming > 0 ? fmtDec(r.weeksStockIncoming) + '주' : '-'}
                  </td>
                  <td className="center">
                    {r.orderStatus === 'wing_on' ? (
                      <span className="alert-badge" style={{ background: '#e8f5e9', color: '#2e7d32' }}>
                        ✈️ 윙 ON
                      </span>
                    ) : r.orderStatus === 'check' ? (
                      <span className="alert-badge" style={{ background: '#fff3e0', color: '#e65100' }}>
                        📋 발주장부 확인
                      </span>
                    ) : (
                      <span className="alert-badge emergency">
                        ⚠️ 발주 필요
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* 사유 입력 모달 */}
      {showReasonInput && (
        <div
          style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setShowReasonInput(false)}
        >
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, minWidth: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: 12, fontSize: 16 }}>{selected.size}개 품목 사유 입력</h3>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 12, maxHeight: 120, overflowY: 'auto' }}>
              {filtered.filter(r => selected.has(r.barcode)).map(r => (
                <div key={r.barcode} style={{ padding: '2px 0' }}>{r.productName} {r.optionName}</div>
              ))}
            </div>
            <input
              className="search-input"
              style={{ width: '100%', minWidth: 'auto', marginBottom: 12 }}
              placeholder="사유를 입력하세요 (예: 재발주 완료, 생산중 4/3 입고예정)"
              value={reasonInput}
              onChange={e => setReasonInput(e.target.value)}
              autoFocus
              onKeyDown={e => e.key === 'Enter' && applyReason()}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline btn-sm" onClick={() => setShowReasonInput(false)}>취소</button>
              <button className="btn btn-primary btn-sm" onClick={applyReason}>적용</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
