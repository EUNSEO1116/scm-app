import { useState, useMemo, useEffect, useCallback, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import { dbSaveCalendar, dbGetCalendar, dbStoreGet, dbStoreSet } from '../utils/dbApi';
import { ensureDailyRateSnapshots } from '../utils/soldoutCache';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const CSV_ORDER = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('발주장부')}`;
const CSV_DAILY = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('일일 판매량')}`;
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`;
const CSV_SPECIAL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('특별 관리 상품')}`;
const CSV_BARCODE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('쿠팡바코드')}`;
const TSV_BARCODE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=2111556061`;

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
      else if (ch === '\n') { rows.push(parseCsvRow(current)); current = ''; }
      else if (ch === '\r') { /* skip */ }
      else current += ch;
    }
  }
  if (current.trim()) rows.push(parseCsvRow(current));
  return rows;
}

// "3/27" → Date 객체 (올해 기준)
function parseShipDate(str) {
  if (!str) return null;
  const m = str.match(/(\d+)\/(\d+)/);
  if (!m) return null;
  const month = parseInt(m[1], 10) - 1;
  const day = parseInt(m[2], 10);
  const year = new Date().getFullYear();
  return new Date(year, month, day);
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function dateKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

function getCalendarDays(year, month) {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const days = [];
  // 이전 달 빈칸
  for (let i = 0; i < firstDay.getDay(); i++) {
    days.push(null);
  }
  for (let d = 1; d <= lastDay.getDate(); d++) {
    days.push(new Date(year, month, d));
  }
  return days;
}

const NAV_SHORTCUTS = [
  { label: '재고 계산기', path: '/inventory', icon: '📊' },
  { label: '발주장부', path: '/inventory/orderbook', icon: '📋' },
  { label: '발주신청', path: '/inventory/order', icon: '📝' },
  { label: '품절 현황', path: '/soldout', icon: '🔴' },
  { label: '매출관리', path: '/sales', icon: '💰' },
  { label: '입고신청', path: '/inventory/incoming', icon: '🚛' },
];

const STORAGE_KEY_FBC = 'fbc_calendar_events';

function loadCachedEvents() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY_FBC) || '{}'); } catch { return {}; }
}

async function loadRemoteEvents() {
  try {
    const remote = await dbGetCalendar();
    const events = remote && typeof remote === 'object' && !Array.isArray(remote) ? remote : {};
    localStorage.setItem(STORAGE_KEY_FBC, JSON.stringify(events));
    return events;
  } catch { return null; }
}

function saveEvents(events, { skipLog } = {}) {
  localStorage.setItem(STORAGE_KEY_FBC, JSON.stringify(events));
  dbSaveCalendar(events, { skipLog }).catch(() => {});
}

export default function Home() {
  const navigate = useNavigate();
  const today = new Date();
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());
  const [fbcEvents, setFbcEvents] = useState(() => loadCachedEvents());
  const [selectedDay, setSelectedDay] = useState(null);
  const [loading, setLoading] = useState(false);
  const [alerts, setAlerts] = useState({ newSurge: [], checkCount: 0, syncCount: 0 });
  const [dragData, setDragData] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null);
  const [dashboardData, setDashboardData] = useState({ availableCount: 0, availableCost: 0, longTermCount: 0, longTermCost: 0, soldoutRate: null });
  const [panelData, setPanelData] = useState({ availableView: null, longtermList: [], rateView: null });
  const [panelView, setPanelView] = useState('menu'); // menu | calendar | rate | available | longterm
  const [expandedDate, setExpandedDate] = useState(null); // 월 품절률: 펼쳐진 날짜 키
  const [addingDay, setAddingDay] = useState(null); // 메모 추가할 날짜 키
  const [memoText, setMemoText] = useState('');

  // 알림 데이터 로드: 신규 상품 판매 급증
  const fetchAlerts = useCallback(async () => {
    try {
      const res = await fetch(CSV_DAILY);
      if (!res.ok) return;
      const csv = await res.text();
      const lines = csv.split('\n').filter(l => l.trim());
      if (lines.length < 2) return;

      const surgeItems = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = parseCsvRow(lines[i]);
        const status = (cols[5] || '').trim();
        if (status !== '신규') continue;

        const productName = (cols[3] || '').trim();
        const optionName = (cols[4] || '').trim();
        // G~L열: 6일전~1일전 (인덱스 6~11)
        const days = [6,7,8,9,10,11].map(j => Number(cols[j]) || 0);
        const curr = days[5]; // 1일전 (L열)
        const prevDays = days.slice(0, 5); // 6일전~2일전
        const avg = prevDays.reduce((a,b) => a+b, 0) / prevDays.length;
        const max = Math.max(...prevDays);

        // 급증 기준: 1일전이 4개 이상 AND (평균의 2배 이상 OR 최대값보다 3개 이상 많음)
        if (curr >= 4 && (avg > 0 && curr >= avg * 2 || curr >= max + 3)) {
          surgeItems.push({ productName, optionName, avg: Math.round(avg * 10) / 10, curr, diff: curr - Math.round(avg) });
        }
      }
      // 증가량 높은 순 정렬
      surgeItems.sort((a, b) => b.diff - a.diff);
      setAlerts(prev => ({ ...prev, newSurge: surgeItems }));
    } catch (e) { /* ignore */ }

    // 발주장부 확인필요 수 계산
    try {
      const [orderRes, specialRes] = await Promise.all([fetch(CSV_ORDER), fetch(CSV_SPECIAL)]);
      if (orderRes.ok) {
        const orderCsv = await orderRes.text();
        const orderLines = orderCsv.split('\n').filter(l => l.trim());

        // 특별관리 상품 파싱 (확인필요 + 동기화 알림 공용)
        const specialSkus = new Set();
        const allSheetBarcodes = new Set();
        if (specialRes.ok) {
          const spCsv = await specialRes.text();
          const spLines = spCsv.split('\n').filter(l => l.trim());
          for (let i = 1; i < spLines.length; i++) {
            const cols = parseCsvRow(spLines[i]);
            const sku = (cols[0] || '').trim();
            if (!sku) continue;
            allSheetBarcodes.add(sku);
            const sewing = (cols[5] || '').trim();
            const oneTime = (cols[8] || '').trim();
            if (sewing || oneTime) specialSkus.add(sku);
          }
        }
        // 특별관리 로컬등록 항목도 포함 (DB 우선, localStorage fallback)
        try {
          let localItems;
          try {
            localItems = await dbStoreGet('issue_special_items');
          } catch {}
          if (!localItems) localItems = JSON.parse(localStorage.getItem('local_special_items') || '[]');
          for (const item of localItems) {
            if (item.barcode && (item.sewing || item.oneTime)) specialSkus.add(item.barcode);
          }
        } catch {}

        // 상품개선 미완료 바코드 목록 (OrderBook computeCheckFlags와 동일)
        let impItems;
        try {
          impItems = await dbStoreGet('improvement_items');
          if (!impItems) impItems = JSON.parse(localStorage.getItem('improvement_items') || '[]');
        } catch { impItems = []; }
        const impSkus = new Set();
        for (const item of (impItems || [])) {
          if (item.barcode && item.status !== '완료') impSkus.add(item.barcode);
        }

        // 발주장부에서 확인필요 카운트 (OrderBook matchFilter 'check'와 동일 로직)
        let checkCount = 0;
        const todayKey2 = dateKey(today);
        let notes = {};
        try {
          const dbNotes = await dbStoreGet('orderbook_notes');
          notes = dbNotes || JSON.parse(localStorage.getItem('orderbook_notes') || '{}');
        } catch { try { notes = JSON.parse(localStorage.getItem('orderbook_notes') || '{}'); } catch {} }

        for (let i = 1; i < orderLines.length; i++) {
          const cols = parseCsvRow(orderLines[i]);
          const orderNo = (cols[0] || '').trim();
          if (!orderNo) continue;
          const sku = (cols[2] || '').trim();
          const cnStatus = (cols[8] || '').trim();
          const colT = (cols[19] || '').trim();
          if (!sku) continue;

          let isCheck = false;

          // 특별관리 조건: CN 창고도착/작업대기/내륙운송
          if (specialSkus.has(sku)) {
            const isCnArrived = cnStatus.includes('CN 창고도착') || cnStatus.includes('작업 대기');
            const isInland = cnStatus.includes('내륙') && cnStatus.includes('운송');
            if (isCnArrived || isInland) isCheck = true;
          }

          // 상품개선 미완료 조건
          if (impSkus.has(sku)) isCheck = true;

          // 입고예정일 도래 조건
          if (colT && notes[colT] && notes[colT].arrivalDate && notes[colT].arrivalDate <= todayKey2) isCheck = true;

          if (isCheck) checkCount++;
        }

        setAlerts(prev => ({ ...prev, checkCount }));

        // 이슈관리 동기화 알림: 영구 알림 목록 카운트 (DB 우선)
        try {
          let pendingAlerts;
          try {
            pendingAlerts = await dbStoreGet('pending_sync_alerts');
          } catch {}
          if (!pendingAlerts) pendingAlerts = JSON.parse(localStorage.getItem('pending_sync_alerts') || '[]');
          setAlerts(prev => ({ ...prev, syncCount: pendingAlerts.length }));
        } catch {}
      }
    } catch (e) { /* ignore */ }
  }, []);

  const fetchEvents = useCallback(async () => {
    setLoading(true);

    // 원격 캐시 로드, 실패시 localStorage 폴백
    const cached = (await loadRemoteEvents()) || loadCachedEvents();
    const merged = { ...cached };

    // 1) 발주장부에서 FBC 이벤트 파싱
    try {
      const res = await fetch(CSV_ORDER);
      if (res.ok) {
        const csv = await res.text();
        const lines = csv.split('\n').filter(l => l.trim());
        const sheetEvents = {};
        for (let i = 1; i < lines.length; i++) {
          const cols = parseCsvRow(lines[i]);
          const category = (cols[5] || '').trim();
          if (category !== 'FBC') continue;
          const orderNo = (cols[0] || '').trim();
          const productName = (cols[1] || '').trim();
          const qty = (cols[3] || '').trim();
          const cnShipDate = (cols[10] || '').trim();

          if (!cnShipDate) continue;
          const shipDate = parseShipDate(cnShipDate);
          if (!shipDate) continue;

          const arrivalDate = addDays(shipDate, 7);
          const key = dateKey(arrivalDate);

          if (!sheetEvents[key]) sheetEvents[key] = [];
          sheetEvents[key].push({ orderNo, productName, qty });
        }

        // 시트에서 새로 들어온 이벤트 추가 (사용자가 옮긴 것 보호)
        for (const [key, items] of Object.entries(sheetEvents)) {
          if (!merged[key]) merged[key] = [];
          for (const item of items) {
            const existsAnywhere = Object.values(merged).some(dayItems =>
              dayItems.some(e => e.orderNo === item.orderNo && e.productName === item.productName)
            );
            if (!existsAnywhere) {
              merged[key].push(item);
            }
          }
        }
      }
    } catch { /* FBC 파싱 실패해도 계속 진행 */ }

    // 2) 상품개선: 기존 상품개선 이벤트 전부 제거 후 현재 종료일 기준으로 재추가
    try {
      let impItems = await dbStoreGet('improvement_items');
      if (!Array.isArray(impItems) || impItems.length === 0) {
        try { impItems = JSON.parse(localStorage.getItem('improvement_items') || 'null'); } catch {}
      }
      // 기존 상품개선 이벤트 모두 제거
      for (const key of Object.keys(merged)) {
        merged[key] = merged[key].filter(e => !e.improvement);
      }
      // 종료일 있고 완료되지 않은 항목만 추가
      if (Array.isArray(impItems)) {
        for (const imp of impItems) {
          if (!imp.endDate || imp.status === '완료') continue;
          const key = imp.endDate;
          if (!merged[key]) merged[key] = [];
          merged[key].push({
            orderNo: '',
            productName: `[상품개선] ${imp.productName}`,
            qty: '',
            impId: imp.id,
            improvement: true,
          });
        }
      }
    } catch { /* 상품개선 실패해도 계속 진행 */ }

    // 빈 날짜 키 제거
    for (const key of Object.keys(merged)) {
      if (merged[key].length === 0) delete merged[key];
    }

    saveEvents(merged, { skipLog: true });
    setFbcEvents(merged);
    setLoading(false);
  }, []);

  useEffect(() => { fetchEvents(); fetchAlerts(); }, [fetchEvents, fetchAlerts]);

  // 총재고원가 대시보드 데이터 로드 (하루 1회, 12시 이후 갱신)
  useEffect(() => {
    (async () => {
      try {
        // 오늘 12시 기준 타임스탬프
        const now = new Date();
        const todayNoon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0).getTime();

        // 캐시 버전: 새 패널(가용/장기/품절률 요약) 데이터 포함 버전.
        // 구버전 캐시면 시각과 무관하게 딱 1회 강제 재계산 → 이후 정상(내일 12시) 스케줄 복귀.
        const CACHE_VERSION = 7;

        // DB 캐시 확인
        const cached = await dbStoreGet('dashboard_cache').catch(() => null);
        const forceRecalc = !cached || cached.version !== CACHE_VERSION;
        if (cached && !forceRecalc && cached.calculatedAt >= todayNoon) {
          setDashboardData(cached.data);
          if (cached.panelData) setPanelData(cached.panelData);
          return;
        }
        // 12시 이전이면 어제 캐시라도 먼저 표시
        if (cached && cached.data) setDashboardData(cached.data);
        if (cached && cached.panelData) setPanelData(cached.panelData);

        // 12시 이전이면 새로 계산하지 않음 (단, 구버전 강제 재계산은 예외)
        if (!forceRecalc && now.getTime() < todayNoon) return;

        // 새로 계산
        const calcRes = await fetch(TSV_CALC);
        if (!calcRes.ok) return;
        const tsvText = await calcRes.text();
        const tsvLines = tsvText.split('\n').filter(l => l.trim());

        const barcodeRes = await fetch(TSV_BARCODE);
        const barcodeTsv = barcodeRes.ok ? await barcodeRes.text() : '';
        const barcodeLines = barcodeTsv.split('\n').filter(l => l.trim());
        const costMap = {};
        for (let i = 1; i < barcodeLines.length; i++) {
          const cols = barcodeLines[i].split('\t');
          const bc = (cols[5] || '').trim();
          const cost = Number(String(cols[6] || '').replace(/[₩,\s]/g, '')) || 0;
          if (bc) costMap[bc] = cost;
        }
        // 옵션ID → 상품명/옵션명 (쿠팡바코드: B=optionId, D=상품명, E=옵션명)
        const nameMap = {};
        for (let i = 1; i < barcodeLines.length; i++) {
          const cols = barcodeLines[i].split('\t');
          const oid = (cols[1] || '').trim();
          if (oid) nameMap[oid] = { productName: (cols[3] || '').trim(), optionName: (cols[4] || '').trim() };
        }

        // 재고계산기 전체 합 + 옵션별 정보 수집 (장기재고 판정용)
        let totalCount = 0, totalCost = 0;
        const calcRows = []; // { oid, status, totalStock, unitCost }
        for (let i = 1; i < tsvLines.length; i++) {
          const cols = tsvLines[i].split('\t');
          const totalStock = Number(cols[14]) || 0;
          const barcode = (cols[2] || '').trim();
          const unitCost = costMap[barcode] || 0;
          totalCount += totalStock; totalCost += totalStock * unitCost;
          const oid = (cols[1] || '').trim();
          if (oid) calcRows.push({ oid, status: (cols[5] || '').trim(), totalStock, unitCost });
        }

        // 최근 30일 판매 데이터 로드 → 옵션별 판매합 (수요예측 과재고 '판매없음' 재현)
        const OVERSTOCK_MIN_STOCK = 10;
        const salesSum = {}; // oid -> 30일 판매합(음수 0처리)
        let availDays = 0;
        try {
          const dayKeys = [];
          for (let d = 29; d >= 0; d--) {
            const dt = new Date(); dt.setHours(0, 0, 0, 0); dt.setDate(dt.getDate() - d);
            dayKeys.push(`${dt.getFullYear()}${String(dt.getMonth() + 1).padStart(2, '0')}${String(dt.getDate()).padStart(2, '0')}`);
          }
          const stores = await Promise.all(dayKeys.map(k => dbStoreGet(`soldout_analysis_${k}`).catch(() => null)));
          for (const st of stores) {
            if (!st?.items) continue;
            availDays++;
            for (const it of st.items) salesSum[it.optionId] = (salesSum[it.optionId] || 0) + Math.max(0, it.salesQty || 0);
          }
        } catch {}

        // 장기재고 = 과재고 '판매없음'(30일 판매 0) & 총재고≥10 & 상태 '신규' 제외
        let longTermCount = 0, longTermCost = 0;
        if (availDays > 0) {
          for (const r of calcRows) {
            if (r.totalStock < OVERSTOCK_MIN_STOCK) continue;
            if (r.status === '신규') continue;
            if ((salesSum[r.oid] || 0) > 0) continue; // 판매 있음 → 제외
            longTermCount += r.totalStock;
            longTermCost += r.totalStock * r.unitCost;
          }
        }
        const availableCount = totalCount - longTermCount;
        const availableCost = totalCost - longTermCost;

        let soldoutRate = null;
        let rateView = { avg: null, avgOpp: null, dayCount: 0, daily: [] };
        try {
          // 이번 달 데이터 있는 날(평일 정식 + 주말 원천)의 "일별 품절률 평균"
          // 영구 저장된 일 품절률 스냅샷을 읽는다(매일 12시 1회 계산·저장, 이후 읽기만).
          // 분모 = 데이터 있는 날 수 / 제외 = 그 날짜 excludeSnapshot 그대로
          const prefix = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
          const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
          const store = await ensureDailyRateSnapshots(`${prefix}01`, `${prefix}${String(lastDay).padStart(2, '0')}`);
          const snaps = Object.values(store).filter(s => s.date && String(s.date).startsWith(prefix));
          const rates = snaps.map(s => s.rate);
          if (rates.length > 0) soldoutRate = Math.round(rates.reduce((a, b) => a + b, 0) / rates.length * 100) / 100;
          const oppRates = snaps.map(s => s.oppRate ?? 0);
          const avgOpp = oppRates.length > 0 ? Math.round(oppRates.reduce((a, b) => a + b, 0) / oppRates.length * 100) / 100 : null;
          const daily = snaps.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)));
          rateView = { avg: soldoutRate, avgOpp, dayCount: daily.length, daily };
        } catch {}

        // 가용재고 요약: 일평균판매(30일합/데이터일수) 기준 그룹
        const dailyAvgOf = (oid) => (availDays > 0 ? (salesSum[oid] || 0) / availDays : 0);
        const highGroup = [], lowGroup = [];
        let highStock = 0, highCost = 0;
        for (const r of calcRows) {
          const avg = dailyAvgOf(r.oid);
          const nm = nameMap[r.oid] || {};
          const entry = { productName: nm.productName || r.oid, optionName: nm.optionName || '', avg: Math.round(avg * 10) / 10, stock: r.totalStock };
          if (avg >= 10) { highGroup.push(entry); highStock += r.totalStock; highCost += r.totalStock * r.unitCost; }
          else lowGroup.push(entry);
        }
        highGroup.sort((a, b) => b.avg - a.avg);
        lowGroup.sort((a, b) => b.avg - a.avg);
        const availableView = { highStock, highCost, highCount: highGroup.length, highTop10: highGroup.slice(0, 10), lowTop10: lowGroup.slice(0, 10) };

        // 장기재고(판매없음) 목록: 30일 판매 0 & 총재고≥10 & 상태 '신규' 제외
        const longtermList = [];
        if (availDays > 0) {
          for (const r of calcRows) {
            if (r.totalStock < OVERSTOCK_MIN_STOCK) continue;
            if (r.status === '신규') continue;
            if ((salesSum[r.oid] || 0) > 0) continue;
            const nm = nameMap[r.oid] || {};
            longtermList.push({ productName: nm.productName || r.oid, optionName: nm.optionName || '', status: r.status || '', stock: r.totalStock, cost: r.totalStock * r.unitCost });
          }
          longtermList.sort((a, b) => b.cost - a.cost);
        }

        const newData = { availableCount, availableCost, longTermCount, longTermCost, soldoutRate };
        const newPanel = { availableView, longtermList, rateView };
        setDashboardData(newData);
        setPanelData(newPanel);
        await dbStoreSet('dashboard_cache', { data: newData, panelData: newPanel, calculatedAt: Date.now(), version: CACHE_VERSION }).catch(() => {});
      } catch (e) { console.error('Dashboard data load error:', e); }
    })();
  }, []);

  // 대시보드 엑셀 다운로드
  const downloadDashboardExcel = useCallback(async () => {
    const yearStr = String(new Date().getFullYear());
    let history = {};
    try {
      history = (await dbStoreGet(`dashboard_history_${yearStr}`)) || {};
    } catch {}

    // 현재 월 데이터 추가
    const now = new Date();
    const monthKey = `${yearStr}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    history[monthKey] = {
      soldoutRate: dashboardData.soldoutRate,
      availableCount: dashboardData.availableCount,
      availableCost: dashboardData.availableCost,
      longTermCount: dashboardData.longTermCount,
      longTermCost: dashboardData.longTermCost,
      updatedAt: now.toISOString(),
    };
    await dbStoreSet(`dashboard_history_${yearStr}`, history);

    // CSV 생성
    const header = '월,월 품절률(%),가용 재고(개),가용 재고 총 원가(원),장기 재고(개),장기 재고 총 원가(원),업데이트일시';
    const csvRows = [header];
    for (let m = 1; m <= 12; m++) {
      const key = `${yearStr}-${String(m).padStart(2, '0')}`;
      const d = history[key];
      if (d) {
        csvRows.push(`${yearStr}년 ${m}월,${d.soldoutRate ?? ''},${d.availableCount},${d.availableCost.toLocaleString()},${d.longTermCount ?? d.badCount ?? 0},${(d.longTermCost ?? d.badCost ?? 0).toLocaleString()},${d.updatedAt || ''}`);
      } else {
        csvRows.push(`${yearStr}년 ${m}월,,,,,,`);
      }
    }

    const bom = '\uFEFF';
    const blob = new Blob([bom + csvRows.join('\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `총재고원가_대시보드_${yearStr}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }, [dashboardData]);

  // 드래그앤드롭: 이벤트를 다른 날짜로 이동
  const handleDragStart = (e, fromKey, event) => {
    setDragData({ fromKey, event });
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', ''); // Firefox 호환
  };

  const handleDragOver = (e, key) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverKey(key);
  };

  const handleDragLeave = () => {
    setDragOverKey(null);
  };

  const handleDrop = (e, toKey) => {
    e.preventDefault();
    setDragOverKey(null);
    if (!dragData || dragData.fromKey === toKey) { setDragData(null); return; }

    setFbcEvents(prev => {
      const updated = { ...prev };
      // 출발지에서 제거
      updated[dragData.fromKey] = (updated[dragData.fromKey] || []).filter(
        ev => !(ev.orderNo === dragData.event.orderNo && ev.productName === dragData.event.productName)
      );
      if (updated[dragData.fromKey].length === 0) delete updated[dragData.fromKey];
      // 도착지에 추가
      if (!updated[toKey]) updated[toKey] = [];
      updated[toKey].push({ ...dragData.event, moved: true });

      saveEvents(updated);
      return updated;
    });
    setDragData(null);
  };

  // 메모 직접 추가
  const handleAddMemo = (dayKey) => {
    if (!memoText.trim()) return;
    setFbcEvents(prev => {
      const updated = { ...prev };
      if (!updated[dayKey]) updated[dayKey] = [];
      updated[dayKey].push({
        orderNo: '',
        productName: memoText.trim(),
        qty: '',
        memo: true,
      });
      saveEvents(updated);
      return updated;
    });
    setMemoText('');
    setAddingDay(null);
  };

  // 이벤트 삭제
  const handleDeleteEvent = (dayKey, idx) => {
    setFbcEvents(prev => {
      const updated = { ...prev };
      updated[dayKey] = [...(updated[dayKey] || [])];
      updated[dayKey].splice(idx, 1);
      if (updated[dayKey].length === 0) delete updated[dayKey];
      saveEvents(updated);
      return updated;
    });
  };

  const calendarDays = useMemo(() => getCalendarDays(year, month), [year, month]);
  const todayKey = dateKey(today);

  const prevMonth = () => {
    if (month === 0) { setYear(y => y - 1); setMonth(11); }
    else setMonth(m => m - 1);
  };
  const nextMonth = () => {
    if (month === 11) { setYear(y => y + 1); setMonth(0); }
    else setMonth(m => m + 1);
  };

  return (
    <div>
      <style>{`
        .home-menu-btn { display:flex; align-items:center; gap:14px; padding:24px 22px; border-radius:14px; background:#f8fafc; border:1.5px solid #e2e8f0; cursor:pointer; transition:all .14s; text-align:left; }
        .home-menu-btn:hover { transform:translateY(-2px); box-shadow:0 8px 18px rgba(42,50,89,.35); filter:brightness(1.08); }
        .home-menu-btn .mnum { font-size:24px; font-weight:800; color:#344179; min-width:26px; }
        .home-menu-btn .mlbl { font-size:17px; font-weight:700; color:#334155; }
        .home-dash-btn { cursor:pointer; border-radius:12px; padding:16px 12px; text-align:center; transition:all .14s; background:#fff; border:2px solid #e2e8f0; box-shadow:0 1px 4px rgba(0,0,0,.06); }
        .home-dash-btn:hover { transform:translateY(-2px); box-shadow:0 6px 16px rgba(0,0,0,.12); }
        .home-sum-table { width:100%; border-collapse:collapse; font-size:13px; }
        .home-sum-table th { background:#f4f6f8; color:#5f6368; font-weight:700; padding:9px 10px; border:1px solid #e3e7eb; text-align:center; white-space:nowrap; position:sticky; top:0; z-index:3; }
        .home-sum-table td { padding:8px 10px; border:1px solid #eceff1; color:#333; }
      `}</style>

      <div style={{ maxWidth: 1180, margin: '0 auto' }}>
      {/* 총재고원가 대시보드 (버튼형) */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ fontSize: 14, fontWeight: 600, color: '#333' }}>총재고원가 대시보드</span>
            <span style={{ fontSize: 11, color: '#bbb' }}>매일 12시 업데이트 · 눌러서 상세 보기</span>
          </div>
          <button
            onClick={downloadDashboardExcel}
            style={{
              background: '#f5f5f5', border: '1px solid #ddd', borderRadius: 6,
              padding: '4px 10px', fontSize: 11, color: '#555', cursor: 'pointer',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = '#e8e8e8'; }}
            onMouseLeave={e => { e.currentTarget.style.background = '#f5f5f5'; }}
          >CSV</button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
          {[
            { key: 'rate', title: '월 품절률', desc: '판매중 품절률 · 일별 추이', accent: '#64748b', bg: '#f1f5f9',
              lines: [dashboardData.soldoutRate !== null ? `${dashboardData.soldoutRate}%` : '—%'] },
            { key: 'available', title: '가용 재고', desc: '전체 재고 - 장기재고 · 총 원가', accent: '#2563eb', bg: '#e0edff',
              lines: [`${dashboardData.availableCount.toLocaleString()}개`, `${dashboardData.availableCost.toLocaleString()}원`] },
            { key: 'longterm', title: '장기 재고', desc: '30일간 판매없음 · 총 원가', accent: '#ea580c', bg: '#ffe9dc',
              lines: [`${dashboardData.longTermCount.toLocaleString()}개`, `${dashboardData.longTermCost.toLocaleString()}원`] },
          ].map(card => {
            const active = panelView === card.key;
            return (
              <button key={card.key} className="home-dash-btn" onClick={() => setPanelView(card.key)}
                style={{ border: 'none', background: active ? card.bg : `${card.bg}88`, boxShadow: active ? `0 4px 14px ${card.accent}44` : '0 1px 4px rgba(0,0,0,.06)' }}>
                <div style={{ fontSize: 13, fontWeight: 800, color: '#334155', marginBottom: 8 }}>{card.title}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  {card.lines.map((l, i) => (
                    <div key={i} style={{ fontSize: i === 0 ? 22 : 15, fontWeight: 800, color: i === 0 ? card.accent : '#475569' }}>{l}</div>
                  ))}
                </div>
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 8 }}>{card.desc}</div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 메인 전환 패널 */}
      <div className="card" style={{ minHeight: 460 }}>
        {/* 패널 헤더 */}
        <div className="card-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {(panelView === 'rate' || panelView === 'available' || panelView === 'longterm') ? (
              <button
                onClick={() => setPanelView('menu')}
                style={{ background: '#f1f5f9', border: '1px solid #e2e8f0', borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 700, color: '#475569', cursor: 'pointer' }}
              >← 돌아가기</button>
            ) : (
              <>
                <button
                  onClick={() => setPanelView('menu')}
                  style={{ background: panelView === 'menu' ? '#344179' : '#fff', color: panelView === 'menu' ? '#fff' : '#475569', border: `1.5px solid ${panelView === 'menu' ? '#344179' : '#e2e8f0'}`, borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                >⭐ 자주 이용하는 메뉴</button>
                <button
                  onClick={() => setPanelView('calendar')}
                  style={{ background: panelView === 'calendar' ? '#344179' : '#fff', color: panelView === 'calendar' ? '#fff' : '#475569', border: `1.5px solid ${panelView === 'calendar' ? '#344179' : '#e2e8f0'}`, borderRadius: 8, padding: '7px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
                >📅 달력</button>
              </>
            )}
            {panelView === 'rate' && <span style={{ fontSize: 15, fontWeight: 800, color: '#334155' }}>월 품절률 요약</span>}
            {panelView === 'available' && <span style={{ fontSize: 15, fontWeight: 800, color: '#334155' }}>가용 재고 요약</span>}
            {panelView === 'longterm' && <span style={{ fontSize: 15, fontWeight: 800, color: '#334155' }}>장기 재고 (판매없음) 목록</span>}
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {panelView === 'calendar' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <button className="btn btn-outline btn-sm" onClick={prevMonth}>◀</button>
                <span style={{ fontSize: 16, fontWeight: 700, minWidth: 110, textAlign: 'center' }}>{year}년 {month + 1}월</span>
                <button className="btn btn-outline btn-sm" onClick={nextMonth}>▶</button>
              </div>
            )}
            <button
              onClick={() => navigate('/activity-log')}
              style={{ background: '#fff', border: '1px solid #ddd', borderRadius: 8, padding: '6px 14px', fontSize: 12, color: '#555', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, boxShadow: '0 1px 4px rgba(0,0,0,0.06)' }}
              onMouseEnter={e => { e.currentTarget.style.background = '#f5f5f5'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#fff'; }}
            ><span style={{ fontSize: 14 }}>&#128221;</span>활동 로그</button>
          </div>
        </div>

        <div className="card-body" style={{ padding: 16 }}>
          {/* 자주 이용하는 메뉴 (기본) */}
          {panelView === 'menu' && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
              {[
                { label: '일일 매출 순위', path: '/soldout-analysis/history' },
                { label: '품절 현황', path: '/soldout-analysis' },
                { label: '매출관리', path: '/sales' },
                { label: '상품개선', path: '/issue/improvement' },
                { label: 'FBC 사전계산기', path: '/fbc/pallet' },
                { label: 'CN 결산', path: '/cn-settlement/dashboard' },
              ].map((m, i) => {
                // 배경은 일괄 연회색, 카드 앞쪽(좌측 바)에 퍼스널 남색 계열 그라데이션.
                // 1번이 가장 진하고 6번으로 갈수록 옅어짐.
                const navyBar = ['#1e2433', '#2a3259', '#3a4680', '#4f5d9e', '#7b85b8', '#a8afd4'];
                return (
                  <button key={m.path} className="home-menu-btn" onClick={() => navigate(m.path)}
                    style={{ background: '#f2f3f5', border: '1px solid #e6e8eb', borderLeft: `6px solid ${navyBar[i]}` }}>
                    <span className="mnum" style={{ color: navyBar[i] }}>{i + 1}</span>
                    <span className="mlbl" style={{ color: '#334155' }}>{m.label}</span>
                  </button>
                );
              })}
            </div>
          )}

          {/* 월 품절률 요약 */}
          {panelView === 'rate' && (
            panelData.rateView && panelData.rateView.daily.length > 0 ? (
              <div>
                <div style={{ display: 'flex', gap: 16, marginBottom: 16, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 180, background: '#f1f5f9', borderRadius: 12, padding: '18px 20px', border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600, marginBottom: 6 }}>이번 달 평균 품절률</div>
                    <div style={{ fontSize: 30, fontWeight: 800, color: '#64748b' }}>{panelData.rateView.avg !== null ? `${panelData.rateView.avg}%` : '—'}</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 180, background: '#fff7ed', borderRadius: 12, padding: '18px 20px', border: '1px solid #fed7aa' }}>
                    <div style={{ fontSize: 12, color: '#c2410c', fontWeight: 600, marginBottom: 6 }}>이번 달 평균 기회손실률</div>
                    <div style={{ fontSize: 30, fontWeight: 800, color: '#ea580c' }}>{panelData.rateView.avgOpp != null ? `${panelData.rateView.avgOpp}%` : '—'}</div>
                  </div>
                  <div style={{ flex: 1, minWidth: 180, background: '#fff', borderRadius: 12, padding: '18px 20px', border: '1px solid #e2e8f0' }}>
                    <div style={{ fontSize: 12, color: '#64748b', fontWeight: 600, marginBottom: 6 }}>집계된 날 수</div>
                    <div style={{ fontSize: 30, fontWeight: 800, color: '#334155' }}>{panelData.rateView.dayCount}일</div>
                  </div>
                </div>
                <div style={{ maxHeight: 420, overflow: 'auto' }}>
                  <table className="home-sum-table" style={{ tableLayout: 'fixed' }}>
                    <colgroup>
                      <col style={{ width: 10 }} />
                      <col style={{ width: '22%' }} />
                      <col style={{ width: '15%' }} />
                      <col style={{ width: '15%' }} />
                      <col style={{ width: '18%' }} />
                      <col style={{ width: '18%' }} />
                    </colgroup>
                    <thead>
                      <tr><th style={{ padding: 0 }}></th><th>날짜</th><th>전체</th><th>품절수</th><th>품절률</th><th>기회손실률</th></tr>
                    </thead>
                    <tbody>
                      {panelData.rateView.daily.map(d => {
                        const isOpen = expandedDate === d.date;
                        const items = d.items || [];
                        return (
                          <Fragment key={d.date}>
                            <tr onClick={() => setExpandedDate(isOpen ? null : d.date)}
                              style={{ cursor: 'pointer', background: isOpen ? '#eef2fb' : undefined }}>
                              <td style={{ textAlign: 'center', color: '#64748b', userSelect: 'none', padding: '8px 0', fontSize: 10 }}>{isOpen ? '▼' : '▶'}</td>
                              <td style={{ textAlign: 'center' }}>{String(d.date).replace(/(\d{4})(\d{2})(\d{2})/, '$1.$2.$3')}</td>
                              <td style={{ textAlign: 'center' }}>{d.total}</td>
                              <td style={{ textAlign: 'center' }}>{d.soldout}</td>
                              <td style={{ textAlign: 'center', fontWeight: 700, color: '#d93025' }}>{d.rate}%</td>
                              <td style={{ textAlign: 'center', fontWeight: 700, color: '#ea580c' }}>{d.oppRate ?? 0}%</td>
                            </tr>
                            {isOpen && items.length > 0 && (
                              <>
                                {/* 확장 섹션 헤더 + 병합된 오늘 손실 비용 (부모 컬럼에 정렬) */}
                                <tr style={{ background: '#f1f5f9', color: '#94a3b8', fontWeight: 600, fontSize: 12 }}>
                                  <td></td>
                                  <td colSpan={2} style={{ padding: '6px 14px', textAlign: 'left' }}>상품</td>
                                  <td style={{ padding: '6px 8px', textAlign: 'center' }}>손실 판매량</td>
                                  <td style={{ padding: '6px 8px', textAlign: 'center' }}>손실비용</td>
                                  <td rowSpan={items.length + 1} style={{ textAlign: 'center', verticalAlign: 'middle', background: '#fff7ed', borderLeft: '1px solid #e2e8f0' }}>
                                    <div style={{ fontSize: 12, color: '#c2410c', fontWeight: 600, marginBottom: 4 }}>오늘 손실 비용</div>
                                    <div style={{ fontSize: 18, fontWeight: 800, color: '#ea580c', fontVariantNumeric: 'tabular-nums' }}>{(d.dailyLoss ?? 0).toLocaleString()}원</div>
                                  </td>
                                </tr>
                                {items.map((it, i) => (
                                  <tr key={i} style={{ background: '#f8fafc', fontSize: 12.5 }}>
                                    <td></td>
                                    <td colSpan={2} style={{ padding: '5px 14px', textAlign: 'left', color: '#334155', overflowWrap: 'anywhere' }}>
                                      <span style={{ fontWeight: 600 }}>{it.productName}</span>
                                      {it.optionName && <span style={{ color: '#64748b' }}> · {it.optionName}</span>}
                                    </td>
                                    <td style={{ padding: '5px 8px', textAlign: 'center', color: '#64748b', fontVariantNumeric: 'tabular-nums' }}>{(it.avg30d ?? 0).toLocaleString()}</td>
                                    <td style={{ padding: '5px 8px', textAlign: 'center', color: '#c2410c', fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{(it.lossAmount ?? 0).toLocaleString()}원</td>
                                  </tr>
                                ))}
                              </>
                            )}
                            {isOpen && items.length === 0 && (
                              <tr>
                                <td colSpan={6} style={{ background: '#f8fafc', textAlign: 'center', color: '#94a3b8', padding: '8px 14px', fontSize: 12.5 }}>집계된 품절 상품이 없습니다.</td>
                              </tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div style={{ padding: '60px 0', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>집계된 품절률 데이터가 없습니다. (매일 12시 이후 갱신)</div>
            )
          )}

          {/* 가용 재고 요약 */}
          {panelView === 'available' && (
            panelData.availableView ? (
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
                  {[
                    { title: '일평균 10개 이상 TOP 10', rows: panelData.availableView.highTop10, color: '#0ea5e9' },
                    { title: '일평균 10개 미만 TOP 10', rows: panelData.availableView.lowTop10, color: '#f59e0b' },
                  ].map(grp => (
                    <div key={grp.title}>
                      <div style={{ fontSize: 13, fontWeight: 800, color: grp.color, marginBottom: 8 }}>{grp.title}</div>
                      <table className="home-sum-table">
                        <thead>
                          <tr><th>상품명</th><th>옵션명</th><th>일평균</th></tr>
                        </thead>
                        <tbody>
                          {grp.rows.length > 0 ? grp.rows.map((r, i) => (
                            <tr key={i}>
                              <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.productName}</td>
                              <td style={{ maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.optionName}</td>
                              <td style={{ textAlign: 'center', fontWeight: 700 }}>{r.avg}</td>
                            </tr>
                          )) : (
                            <tr><td colSpan={3} style={{ textAlign: 'center', color: '#94a3b8' }}>데이터 없음</td></tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <div style={{ padding: '60px 0', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>가용 재고 데이터가 없습니다. (매일 12시 이후 갱신)</div>
            )
          )}

          {/* 장기 재고 (판매없음) 목록 */}
          {panelView === 'longterm' && (
            panelData.longtermList && panelData.longtermList.length > 0 ? (
              <div>
                <div style={{ fontSize: 13, color: '#64748b', marginBottom: 12 }}>
                  30일간 판매 없는 순수 장기재고 <b style={{ color: '#f59e0b' }}>{panelData.longtermList.length}종</b> · 총 재고 {panelData.longtermList.reduce((a, b) => a + b.stock, 0).toLocaleString()}개 · 총 원가 {Math.round(panelData.longtermList.reduce((a, b) => a + b.cost, 0)).toLocaleString()}원
                </div>
                <div style={{ maxHeight: 440, overflow: 'auto' }}>
                  <table className="home-sum-table">
                    <thead>
                      <tr><th>상품명</th><th>옵션명</th><th>상태</th><th>재고</th><th>재고별 원가</th></tr>
                    </thead>
                    <tbody>
                      {panelData.longtermList.map((r, i) => (
                        <tr key={i}>
                          <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.productName}</td>
                          <td style={{ maxWidth: 160, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.optionName}</td>
                          <td style={{ textAlign: 'center' }}>{r.status || '-'}</td>
                          <td style={{ textAlign: 'center' }}>{r.stock.toLocaleString()}</td>
                          <td style={{ textAlign: 'right' }}>{Math.round(r.cost).toLocaleString()}원</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : (
              <div style={{ padding: '60px 0', textAlign: 'center', color: '#94a3b8', fontSize: 14 }}>순수 판매없음 장기재고가 없습니다. (매일 12시 이후 갱신)</div>
            )
          )}

          {/* 달력 */}
          {panelView === 'calendar' && (<>
          {/* 요일 헤더 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, marginBottom: 4 }}>
            {WEEKDAYS.map((w, i) => (
              <div key={w} style={{
                textAlign: 'center', fontSize: 12, fontWeight: 600, padding: '6px 0',
                color: i === 0 ? '#d93025' : i === 6 ? '#1a73e8' : '#666',
              }}>{w}</div>
            ))}
          </div>
          {/* 날짜 그리드 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2 }}>
            {calendarDays.map((day, i) => {
              if (!day) return <div key={`empty-${i}`} style={{ minHeight: 84 }} />;
              const key = dateKey(day);
              const isToday = key === todayKey;
              const events = fbcEvents[key] || [];
              const dayOfWeek = day.getDay();
              const isDragOver = dragOverKey === key;
              const isAdding = addingDay === key;
              // FBC 이벤트는 발주번호 기준 중복 제거, 메모/상품개선은 그대로
              const fbcItems = events.filter(e => !e.memo && !e.improvement);
              const memoItems = events.filter(e => e.memo);
              const impItems = events.filter(e => e.improvement);
              const uniqueFbc = [...new Map(fbcItems.map(e => [e.orderNo + e.productName, e])).values()];
              const allItems = [...uniqueFbc, ...impItems, ...memoItems];

              return (
                <div
                  key={key}
                  onDragOver={e => handleDragOver(e, key)}
                  onDragLeave={handleDragLeave}
                  onDrop={e => handleDrop(e, key)}
                  style={{
                    minHeight: 84, padding: '5px 5px 3px', borderRadius: 9,
                    background: isDragOver ? '#e8f0fe' : isToday ? '#f0f4ff' : '#fafbfc',
                    border: isDragOver ? '2px dashed #1a73e8' : isToday ? '2px solid #5b7ff5' : '1px solid #e8e8e8',
                    transition: 'background 0.15s, border 0.15s',
                    cursor: 'pointer',
                  }}
                  onClick={() => { setAddingDay(isAdding ? null : key); setMemoText(''); }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                    <span
                      style={{
                        fontSize: 13, fontWeight: isToday ? 700 : 500,
                        color: dayOfWeek === 0 ? '#d93025' : dayOfWeek === 6 ? '#5b7ff5' : '#333',
                      }}
                    >
                      {day.getDate()}
                    </span>
                    <span
                      style={{
                        fontSize: 14, color: '#bbb', lineHeight: 1,
                        width: 18, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center',
                      }}
                    >+</span>
                  </div>
                  {/* 메모 입력 UI */}
                  {isAdding && (
                    <div style={{ marginBottom: 4 }} onClick={e => e.stopPropagation()}>
                      <input
                        autoFocus
                        value={memoText}
                        onChange={e => setMemoText(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') handleAddMemo(key); if (e.key === 'Escape') setAddingDay(null); }}
                        placeholder="메모 입력 후 Enter"
                        style={{
                          width: '100%', fontSize: 10, padding: '3px 5px', border: '1px solid #1a73e8',
                          borderRadius: 4, outline: 'none', boxSizing: 'border-box',
                        }}
                      />
                    </div>
                  )}
                  {allItems.slice(0, 3).map((e, j) => (
                    <div
                      key={j}
                      draggable
                      onDragStart={ev => handleDragStart(ev, key, e)}
                      onDragEnd={() => { setDragData(null); setDragOverKey(null); }}
                      onClick={ev => { ev.stopPropagation(); if (events.length > 0) setSelectedDay(selectedDay === key ? null : key); }}
                      style={{
                        fontSize: 10,
                        background: e.improvement ? '#f3e5f5' : e.memo ? '#fff8e1' : e.moved ? '#e8f5e9' : '#f3eef8',
                        color: e.improvement ? '#6a1b9a' : e.memo ? '#e65100' : e.moved ? '#2e7d32' : '#7c4dbd',
                        fontWeight: 500,
                        borderRadius: 4, padding: '2px 6px', marginBottom: 3,
                        borderLeft: e.improvement ? '3px solid #9c27b0' : e.memo ? '3px solid #ff9800' : e.moved ? '3px solid #4caf50' : '3px solid #7c4dbd',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                        cursor: 'grab',
                      }}
                    >
                      {e.improvement ? e.productName : e.memo ? e.productName : `${e.orderNo} 픽업일`}{e.moved && !e.memo && !e.improvement ? ' ✦' : ''}
                    </div>
                  ))}
                  {allItems.length > 3 && (
                    <div
                      style={{ fontSize: 10, color: '#999', marginTop: 2, cursor: 'pointer' }}
                      onClick={ev => { ev.stopPropagation(); setSelectedDay(key); }}
                    >+{allItems.length - 3}건 더</div>
                  )}
                </div>
              );
            })}
          </div>
          </>)}
        </div>
      </div>
      </div>

      {/* 선택한 날 오버레이 */}
      {selectedDay && fbcEvents[selectedDay] && (
        <div
          style={{
            position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
            background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
          }}
          onClick={() => setSelectedDay(null)}
        >
          <div
            style={{
              background: '#fff', borderRadius: 12, padding: 24, minWidth: 400, maxWidth: 550,
              boxShadow: '0 8px 32px rgba(0,0,0,0.2)', maxHeight: '70vh', overflow: 'auto',
            }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
              <h3 style={{ fontSize: 16 }}>
                {selectedDay.replace(/-/g, '.')} 일정
              </h3>
              <button className="btn btn-outline btn-sm" onClick={() => setSelectedDay(null)}>✕</button>
            </div>
            {(() => {
              const items = fbcEvents[selectedDay] || [];
              const fbcItems = items.filter(e => !e.memo && !e.improvement);
              const memoItems = items.filter(e => e.memo);
              const impItems = items.filter(e => e.improvement);

              // FBC 발주번호별 그룹핑
              const grouped = {};
              for (const e of fbcItems) {
                if (!grouped[e.orderNo]) grouped[e.orderNo] = [];
                grouped[e.orderNo].push(e);
              }

              return (
                <>
                  {Object.entries(grouped).map(([orderNo, gItems]) => (
                    <div key={orderNo} style={{ marginBottom: 12 }}>
                      <div style={{
                        fontSize: 13, fontWeight: 600, color: '#1a73e8',
                        background: '#e8f0fe', padding: '4px 10px', borderRadius: 6, marginBottom: 6,
                      }}>
                        {orderNo}
                      </div>
                      {gItems.map((item, j) => {
                        const globalIdx = items.indexOf(item);
                        return (
                          <div key={j} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '4px 10px', fontSize: 13, borderBottom: '1px solid #f0f0f0',
                          }}>
                            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.productName}</span>
                            <span style={{ fontWeight: 600, marginLeft: 12, whiteSpace: 'nowrap' }}>{Number(item.qty).toLocaleString()}개</span>
                            <span
                              onClick={() => handleDeleteEvent(selectedDay, globalIdx)}
                              style={{ marginLeft: 8, color: '#d93025', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                              title="삭제"
                            >✕</span>
                          </div>
                        );
                      })}
                    </div>
                  ))}
                  {impItems.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{
                        fontSize: 13, fontWeight: 600, color: '#6a1b9a',
                        background: '#f3e5f5', padding: '4px 10px', borderRadius: 6, marginBottom: 6,
                      }}>
                        상품개선 종료일
                      </div>
                      {impItems.map((item, j) => {
                        const globalIdx = items.indexOf(item);
                        return (
                          <div key={j} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '4px 10px', fontSize: 13, borderBottom: '1px solid #f0f0f0',
                          }}>
                            <span style={{ flex: 1 }}>{item.productName}</span>
                            <span
                              onClick={() => handleDeleteEvent(selectedDay, globalIdx)}
                              style={{ marginLeft: 8, color: '#d93025', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                              title="삭제"
                            >✕</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {memoItems.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      <div style={{
                        fontSize: 13, fontWeight: 600, color: '#e65100',
                        background: '#fff8e1', padding: '4px 10px', borderRadius: 6, marginBottom: 6,
                      }}>
                        메모
                      </div>
                      {memoItems.map((item, j) => {
                        const globalIdx = items.indexOf(item);
                        return (
                          <div key={j} style={{
                            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                            padding: '4px 10px', fontSize: 13, borderBottom: '1px solid #f0f0f0',
                          }}>
                            <span style={{ flex: 1 }}>{item.productName}</span>
                            <span
                              onClick={() => handleDeleteEvent(selectedDay, globalIdx)}
                              style={{ marginLeft: 8, color: '#d93025', cursor: 'pointer', fontSize: 12, fontWeight: 600 }}
                              title="삭제"
                            >✕</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </>
              );
            })()}
          </div>
        </div>
      )}
    </div>
  );
}
