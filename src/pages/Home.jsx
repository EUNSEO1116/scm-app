import { useState, useMemo, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { dbSaveCalendar, dbGetCalendar, dbStoreGet, dbStoreSet } from '../utils/dbApi';

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

function saveEvents(events) {
  localStorage.setItem(STORAGE_KEY_FBC, JSON.stringify(events));
  dbSaveCalendar(events).catch(() => {});
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
  const [dashboardData, setDashboardData] = useState({ availableCount: 0, availableCost: 0, badCount: 0, badCost: 0, soldoutRate: null });
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
        // localStorage 특별관리도 포함
        try {
          const localItems = JSON.parse(localStorage.getItem('local_special_items') || '[]');
          for (const item of localItems) {
            if (item.barcode && (item.sewing || item.oneTime)) specialSkus.add(item.barcode);
          }
        } catch {}

        // 발주장부에서 확인필요 카운트
        let checkCount = 0;
        for (let i = 1; i < orderLines.length; i++) {
          const cols = parseCsvRow(orderLines[i]);
          const sku = (cols[2] || '').trim();
          const cnStatus = (cols[8] || '').trim();

          if (!specialSkus.has(sku)) continue;
          const isCnArrived = cnStatus.includes('CN 창고도착') || cnStatus.includes('작업 대기');
          const isInland = cnStatus.includes('내륙') && cnStatus.includes('운송');
          if (isCnArrived || isInland) checkCount++;
        }

        // 입고예정일 도래도 카운트
        const todayKey2 = dateKey(today);
        try {
          const notes = JSON.parse(localStorage.getItem('orderbook_notes') || '{}');
          for (const [, note] of Object.entries(notes)) {
            if (note.arrivalDate && note.arrivalDate <= todayKey2) checkCount++;
          }
        } catch {}

        setAlerts(prev => ({ ...prev, checkCount }));

        // 이슈관리 동기화 알림: 영구 알림 목록 카운트
        try {
          const pendingAlerts = JSON.parse(localStorage.getItem('pending_sync_alerts') || '[]');
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
      // 현재 종료일 있는 항목만 추가
      if (Array.isArray(impItems)) {
        for (const imp of impItems) {
          if (!imp.endDate) continue;
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

    saveEvents(merged);
    setFbcEvents(merged);
    setLoading(false);
  }, []);

  useEffect(() => { fetchEvents(); fetchAlerts(); }, [fetchEvents, fetchAlerts]);

  // 총재고원가 대시보드 데이터 로드
  useEffect(() => {
    (async () => {
      try {
        // 재고계산기 시트에서 총재고 합계
        const calcRes = await fetch(TSV_CALC);
        if (!calcRes.ok) return;
        const tsvText = await calcRes.text();
        const tsvLines = tsvText.split('\n').filter(l => l.trim());

        // 쿠팡바코드 시트에서 원가 매핑 (TSV로 가져와서 쉼표 파싱 문제 방지)
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

        let availableCount = 0, availableCost = 0, badCount = 0, badCost = 0;
        for (let i = 1; i < tsvLines.length; i++) {
          const cols = tsvLines[i].split('\t');
          const barcode = (cols[2] || '').trim();
          const status = (cols[5] || '').trim();
          const totalStock = Number(cols[14]) || 0;
          const unitCost = costMap[barcode] || 0;
          const isBad = status.includes('최종마감') || status.includes('마감대상');
          if (isBad) { badCount += totalStock; badCost += totalStock * unitCost; }
          else { availableCount += totalStock; availableCost += totalStock * unitCost; }
        }

        // 품절률: localStorage soldout_rate_snapshots에서 이번 달 평균
        let soldoutRate = null;
        try {
          const stored = await dbStoreGet('soldout_rate_snapshots');
          const snapshots = stored || JSON.parse(localStorage.getItem('soldout_rate_snapshots') || '{}');
          const now = new Date();
          const yearStr = String(now.getFullYear());
          const monthStr = String(now.getMonth() + 1).padStart(2, '0');
          const prefix = `${yearStr}-${monthStr}`;
          let rateSum = 0, days = 0;
          for (const [date, snap] of Object.entries(snapshots)) {
            if (date.startsWith(prefix)) { rateSum += snap.rate || 0; days++; }
          }
          if (days > 0) soldoutRate = Math.round(rateSum / days * 100) / 100;
        } catch {}

        setDashboardData({ availableCount, availableCost, badCount, badCost, soldoutRate });
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
      badCount: dashboardData.badCount,
      badCost: dashboardData.badCost,
      updatedAt: now.toISOString(),
    };
    await dbStoreSet(`dashboard_history_${yearStr}`, history);

    // CSV 생성
    const header = '월,월 품절률(%),가용 재고(개),가용 재고 총 원가(원),악성 재고(개),악성 재고 원가(원),업데이트일시';
    const csvRows = [header];
    for (let m = 1; m <= 12; m++) {
      const key = `${yearStr}-${String(m).padStart(2, '0')}`;
      const d = history[key];
      if (d) {
        csvRows.push(`${yearStr}년 ${m}월,${d.soldoutRate ?? ''},${d.availableCount},${d.availableCost.toLocaleString()},${d.badCount},${d.badCost.toLocaleString()},${d.updatedAt || ''}`);
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
      {/* 오늘의 알림 */}
      <div style={{
        display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap',
      }}>
        {/* 신규 판매 급증 */}
        <div
          onClick={() => alerts.newSurge.length > 0 && navigate('/sales?tab=surge')}
          style={{
            background: alerts.newSurge.length > 0 ? '#fff' : '#f9f9f9',
            borderRadius: 12, padding: '10px 16px',
            border: alerts.newSurge.length > 0 ? '1px solid #ff8c00' : '1px solid #eee',
            boxShadow: alerts.newSurge.length > 0 ? '0 2px 8px rgba(255,140,0,0.15)' : 'none',
            cursor: alerts.newSurge.length > 0 ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', gap: 10,
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { if (alerts.newSurge.length > 0) e.currentTarget.style.transform = 'translateY(-1px)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = ''; }}
        >
          <div style={{ position: 'relative', fontSize: 22 }}>
            🚀
            {alerts.newSurge.length > 0 && (
              <span style={{
                position: 'absolute', top: -6, right: -8,
                background: '#ff4444', color: '#fff', fontSize: 10, fontWeight: 700,
                borderRadius: 10, minWidth: 18, height: 18, lineHeight: '18px',
                textAlign: 'center', padding: '0 4px',
              }}>{alerts.newSurge.length}</span>
            )}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: alerts.newSurge.length > 0 ? '#333' : '#999' }}>
              신규 판매 급증
            </div>
            <div style={{ fontSize: 11, color: alerts.newSurge.length > 0 ? '#e65100' : '#bbb' }}>
              {alerts.newSurge.length > 0 ? `${alerts.newSurge.length}개 품목 감지` : '없음'}
            </div>
          </div>
        </div>

        {/* 발주장부 확인필요 */}
        <div
          onClick={() => alerts.checkCount > 0 && navigate('/inventory/orderbook?card=check')}
          style={{
            background: alerts.checkCount > 0 ? '#fff' : '#f9f9f9',
            borderRadius: 12, padding: '10px 16px',
            border: alerts.checkCount > 0 ? '1px solid #1a73e8' : '1px solid #eee',
            boxShadow: alerts.checkCount > 0 ? '0 2px 8px rgba(26,115,232,0.15)' : 'none',
            cursor: alerts.checkCount > 0 ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', gap: 10,
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { if (alerts.checkCount > 0) e.currentTarget.style.transform = 'translateY(-1px)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = ''; }}
        >
          <div style={{ position: 'relative', fontSize: 22 }}>
            🔍
            {alerts.checkCount > 0 && (
              <span style={{
                position: 'absolute', top: -6, right: -8,
                background: '#1a73e8', color: '#fff', fontSize: 10, fontWeight: 700,
                borderRadius: 10, minWidth: 18, height: 18, lineHeight: '18px',
                textAlign: 'center', padding: '0 4px',
              }}>{alerts.checkCount}</span>
            )}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: alerts.checkCount > 0 ? '#333' : '#999' }}>
              확인필요
            </div>
            <div style={{ fontSize: 11, color: alerts.checkCount > 0 ? '#1a73e8' : '#bbb' }}>
              {alerts.checkCount > 0 ? `${alerts.checkCount}건 확인 대기` : '없음'}
            </div>
          </div>
        </div>

        {/* 이슈관리 동기화 */}
        <div
          onClick={() => alerts.syncCount > 0 && navigate('/issue')}
          style={{
            background: alerts.syncCount > 0 ? '#fff' : '#f9f9f9',
            borderRadius: 12, padding: '10px 16px',
            border: alerts.syncCount > 0 ? '1px solid #7c4dbd' : '1px solid #eee',
            boxShadow: alerts.syncCount > 0 ? '0 2px 8px rgba(124,77,189,0.15)' : 'none',
            cursor: alerts.syncCount > 0 ? 'pointer' : 'default',
            display: 'flex', alignItems: 'center', gap: 10,
            transition: 'all 0.15s',
          }}
          onMouseEnter={e => { if (alerts.syncCount > 0) e.currentTarget.style.transform = 'translateY(-1px)'; }}
          onMouseLeave={e => { e.currentTarget.style.transform = ''; }}
        >
          <div style={{ position: 'relative', fontSize: 22 }}>
            📋
            {alerts.syncCount > 0 && (
              <span style={{
                position: 'absolute', top: -6, right: -8,
                background: '#7c4dbd', color: '#fff', fontSize: 10, fontWeight: 700,
                borderRadius: 10, minWidth: 18, height: 18, lineHeight: '18px',
                textAlign: 'center', padding: '0 4px',
              }}>{alerts.syncCount}</span>
            )}
          </div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 600, color: alerts.syncCount > 0 ? '#333' : '#999' }}>
              특별관리 동기화
            </div>
            <div style={{ fontSize: 11, color: alerts.syncCount > 0 ? '#7c4dbd' : '#bbb' }}>
              {alerts.syncCount > 0 ? `${alerts.syncCount}건 업데이트` : '없음'}
            </div>
          </div>
        </div>
      </div>

      {/* 헤더: 로고 + 바로가기 */}
      <div style={{ display: 'flex', gap: 24, marginBottom: 24, alignItems: 'flex-start' }}>
        {/* 로고 */}
        <div style={{
          background: '#fff', borderRadius: 16, boxShadow: '0 2px 12px rgba(0,0,0,0.08)',
          padding: 24, display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 200,
        }}>
          <img src="/logo.jpg" alt="로고" style={{ width: 140, borderRadius: 12, marginBottom: 12 }} />
          <div style={{ fontSize: 13, color: '#666', textAlign: 'center' }}>
            {today.toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' })}
          </div>
        </div>

        {/* 총재고원가 대시보드 */}
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#333' }}>총재고원가 대시보드</div>
            <button
              onClick={downloadDashboardExcel}
              style={{
                background: '#f5f5f5', border: '1px solid #ddd', borderRadius: 6,
                padding: '4px 10px', fontSize: 11, color: '#555', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 4,
              }}
              onMouseEnter={e => { e.currentTarget.style.background = '#e8e8e8'; }}
              onMouseLeave={e => { e.currentTarget.style.background = '#f5f5f5'; }}
            >CSV</button>
          </div>
          <div style={{
            background: '#fff', borderRadius: 10, boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
            overflow: 'hidden', border: '1px solid #e0e0e0',
          }}>
            {/* 헤더 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', borderBottom: '1px solid #e0e0e0' }}>
              {['월 품절률', '가용 재고', '가용 재고 총 원가', '악성 재고', '악성 재고 원가'].map((title, i) => {
                const bg = i === 0 ? '#f0f0f0' : i <= 2 ? '#dceefb' : '#fde8e8';
                return (
                  <div key={title} style={{
                    background: bg, padding: '10px 8px', textAlign: 'center',
                    fontSize: 13, fontWeight: 800, color: '#222', letterSpacing: '0.5px',
                    borderRight: i < 4 ? '1px solid #e0e0e0' : 'none',
                  }}>{title}</div>
                );
              })}
            </div>
            {/* 값 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', borderBottom: '1px solid #e0e0e0' }}>
              {[
                dashboardData.soldoutRate !== null ? `${dashboardData.soldoutRate}%` : '—%',
                `${dashboardData.availableCount.toLocaleString()}개`,
                `${dashboardData.availableCost.toLocaleString()}원`,
                `${dashboardData.badCount.toLocaleString()}개`,
                `${dashboardData.badCost.toLocaleString()}원`,
              ].map((val, i) => {
                const bg = i === 0 ? '#fff' : i <= 2 ? '#f0f7ff' : '#fff5f5';
                return (
                  <div key={i} style={{
                    background: bg, padding: '14px 8px', textAlign: 'center',
                    fontSize: 18, fontWeight: 700, color: '#222',
                    borderRight: i < 4 ? '1px solid #e0e0e0' : 'none',
                  }}>{val}</div>
                );
              })}
            </div>
            {/* 설명 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)' }}>
              {['판매중 품절률', '판매중 의 총 재고', '판매중 재고의 총 원가', '최종마감 수량', '최종마감 총 원가 합 (소진가능 재고 포함)'].map((desc, i) => {
                const bg = i === 0 ? '#fff' : i <= 2 ? '#f7fbff' : '#fffafa';
                return (
                  <div key={i} style={{
                    background: bg, padding: '8px 6px', textAlign: 'center',
                    fontSize: 10, color: '#999',
                    borderRight: i < 4 ? '1px solid #e0e0e0' : 'none',
                  }}>{desc}</div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* 달력 */}
      <div className="card">
        <div className="card-header" style={{ justifyContent: 'center', gap: 16 }}>
          <button className="btn btn-outline btn-sm" onClick={prevMonth}>◀</button>
          <h2 style={{ fontSize: 18, fontWeight: 700, minWidth: 140, textAlign: 'center' }}>
            {year}년 {month + 1}월
          </h2>
          <button className="btn btn-outline btn-sm" onClick={nextMonth}>▶</button>
        </div>
        <div className="card-body" style={{ padding: 12 }}>
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
              if (!day) return <div key={`empty-${i}`} style={{ minHeight: 110 }} />;
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
                    minHeight: 110, padding: '6px 6px 4px', borderRadius: 10,
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
