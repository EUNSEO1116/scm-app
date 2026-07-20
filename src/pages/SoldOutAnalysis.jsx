import { useState, useEffect, useMemo, Fragment } from 'react';
import XLSX from 'xlsx-js-style';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';
import { ensureUploadSoldoutCache } from '../utils/soldoutCache';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const CSV_BARCODE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('쿠팡바코드')}`;
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`;
const CSV_ORDER = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('발주장부')}`;

const STORE_KEY_PREFIX = 'soldout_analysis_';
const SOLDOUT_TRACKER_KEY = 'soldout_analysis_tracker';
const EXCLUDE_KEYWORDS = ['최종마감', '품질확인서', '마감대상', '덤핑', '반출', '지재권'];
const CRISIS_DAYS_THRESHOLD = 3;
const HISTORY_SEARCH_DAYS = 92; // 품절 이력 검색 범위 (약 3개월)
const WING_ON_STATUSES = ['CN 창고도착', '부분출고 대기', '출고 완료', '출고 대기', '출고완료'];

function parseCsvRow(line) {
  const result = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) { if (ch === '"' && line[i+1] === '"') { current += '"'; i++; } else if (ch === '"') inQuotes = false; else current += ch; }
    else { if (ch === '"') inQuotes = true; else if (ch === ',') { result.push(current); current = ''; } else current += ch; }
  }
  result.push(current); return result;
}
function safeNum(v) { if (v === '' || v === '-' || v == null) return 0; const n = Number(v); return isNaN(n) ? 0 : n; }
function todayStr() { return new Date().toISOString().slice(0, 10).replace(/-/g, ''); }
function dateToKey(d) { return `${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}`; }
function keyToDate(k) { return new Date(+k.slice(0,4), +k.slice(4,6)-1, +k.slice(6,8)); }
function keyToDisplay(k) { return `${k.slice(0,4)}-${k.slice(4,6)}-${k.slice(6,8)}`; }
function fmt(n) { if (n == null) return '-'; return Number(n).toLocaleString('ko-KR'); }
function fmtDec(n, d=1) { const num = Number(n); return isNaN(num) ? '-' : num.toFixed(d); }
function shouldExclude(s) { return s ? EXCLUDE_KEYWORDS.some(kw => s.includes(kw)) : false; }

function parseOrderDateSort(dateStr) { const m = (dateStr||'').match(/(\d+)월\s*(\d+)일/); return m ? Number(m[1])*100+Number(m[2]) : 9999; }
function parseShipDate(str) { if (!str) return null; const m = str.match(/(\d+)\/(\d+)/); return m ? new Date(new Date().getFullYear(), parseInt(m[1],10)-1, parseInt(m[2],10)) : null; }
function addDays(date, days) { const d = new Date(date); d.setDate(d.getDate()+days); return d; }
function fmtDate(d) { return `${d.getMonth()+1}/${d.getDate()}`; }

function parseOrderBook(csv) {
  const skuMap = new Map(), skuArrival = new Map();
  if (!csv) return { skuMap, skuArrival };
  const lines = csv.split('\n').filter(l => l.trim()), skuOrders = {};
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]), sku = (cols[2]||'').trim(), cnStatus = (cols[8]||'').trim();
    const shipDate = (cols[10]||'').trim(), orderDate = (cols[16]||'').trim();
    if (!sku) continue;
    const isWingOn = WING_ON_STATUSES.some(s => cnStatus.includes(s));
    const prev = skuMap.get(sku);
    if (!prev || (isWingOn && prev !== 'wing_on')) skuMap.set(sku, isWingOn ? 'wing_on' : 'check');
    if (!skuOrders[sku]) skuOrders[sku] = [];
    skuOrders[sku].push({ cnStatus, shipDate, orderDate });
  }
  const today = new Date();
  for (const [sku, orders] of Object.entries(skuOrders)) {
    orders.sort((a, b) => parseOrderDateSort(a.orderDate) - parseOrderDateSort(b.orderDate));
    const cn = orders[0].cnStatus; let arrival = null;
    if (cn.includes('출고 완료') || cn.includes('출고완료')) { const sd = parseShipDate(orders[0].shipDate); if (sd) arrival = addDays(sd, 3); }
    else if (cn.includes('CN 창고도착') || cn.includes('작업 대기') || cn.includes('출고 대기') || (cn.includes('내륙') && cn.includes('운송'))) arrival = addDays(today, 4);
    else if (cn === '업체발송대기') arrival = addDays(today, 8);
    if (arrival) skuArrival.set(sku, fmtDate(arrival));
  }
  return { skuMap, skuArrival };
}

const RISK_CONFIG = {
  '품절': { emoji: '🔴', cls: 'soldout', label: '품절' },
  '품절위기': { emoji: '🟠', cls: 'risk', label: '품절위기' },
};

export default function SoldOutAnalysis() {
  const [loading, setLoading] = useState(true);
  const [updating, setUpdating] = useState(false);
  const [cachedResult, setCachedResult] = useState(null);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [viewingDate, setViewingDate] = useState(todayStr());
  const [rangeResult, setRangeResult] = useState(null); // 기간 선택 집계 결과 (null=단일 날짜 모드)
  const [selStart, setSelStart] = useState(null); // 달력 기간 선택 시작일 key
  const [selEnd, setSelEnd] = useState(null);     // 달력 기간 선택 종료일 key
  const [tracker, setTracker] = useState({});
  const [riskFilter, setRiskFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('전체');
  const [calendarDate, setCalendarDate] = useState(new Date());
  const [showCalendar, setShowCalendar] = useState(false);
  const [toast, setToast] = useState(null);
  const [excludeSet, setExcludeSet] = useState(new Set());
  const [reasonEditing, setReasonEditing] = useState({});
  const [selected, setSelected] = useState(new Set());
  const [batchReason, setBatchReason] = useState('');
  const [showBatchInput, setShowBatchInput] = useState(false);
  const [editingReason, setEditingReason] = useState(null); // 개별 사유 편집 중인 optionId
  const [stockCorrections, setStockCorrections] = useState({}); // { optionId: true } 재고 수정 영구 저장
  const [sortKey, setSortKey] = useState('productName');
  const [sortDir, setSortDir] = useState('asc');
  const [exporting, setExporting] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResult, setSearchResult] = useState(null); // { term, spells } | null
  const [expandedSpell, setExpandedSpell] = useState(new Set());

  const showToast = (type, title, msg) => { setToast({ type, title, message: msg }); setTimeout(() => setToast(null), 3500); };

  // 특정 날짜 기준 연속품절일수를 일별 DB 데이터로 재계산 + 오염된 rate 복원
  const recalcConsecDaysForDate = async (dt, cached) => {
    if (!cached?.trackerSnapshot || Object.keys(cached.trackerSnapshot).length === 0) return cached;
    const dayKeys = [];
    for (let i = 0; i < 30; i++) {
      const d = new Date(+dt.slice(0,4), +dt.slice(4,6)-1, +dt.slice(6,8)-i);
      dayKeys.push(dateToKey(d));
    }
    const datasets = await Promise.all(dayKeys.map(k => dbStoreGet(`${STORE_KEY_PREFIX}${k}`).catch(() => null)));
    const dailyMaps = datasets.map(ds => {
      const m = new Map();
      if (ds?.items) for (const it of ds.items) m.set(it.optionId, it.coupangStock);
      return m;
    });
    let changed = false;
    for (const [oid, entry] of Object.entries(cached.trackerSnapshot)) {
      let days = 0;
      for (let di = 0; di < dailyMaps.length; di++) {
        const stock = dailyMaps[di].get(oid);
        if (stock === undefined || stock > 0) break;
        days++;
      }
      const newDays = Math.max(1, days);
      if (entry.days !== newDays) { entry.days = newDays; changed = true; }
    }
    // 과거 날짜: rate_snapshots와 캐시 rate 동기화
    const isToday = dt === todayStr();
    if (!isToday) {
      const snapshots = await dbStoreGet('soldout_analysis_rate_snapshots') || {};
      if (snapshots[dt]) {
        // rate_snapshots가 정확한 소스이므로 캐시에 반영
        if (cached.rate !== snapshots[dt].rate) {
          cached.rate = snapshots[dt].rate;
          changed = true;
        }
      }
    }
    if (changed) await dbStoreSet(`soldout_analysis_cached_${dt}`, cached);
    return cached;
  };

  // 품절현황에서 제외 → 해당 날짜 rate_snapshots 즉시 재계산
  const addExclude = async (r) => {
    if (excludeSet.has(r.optionId)) return;
    const data = await dbStoreGet('soldout_analysis_exclude') || [];
    data.push({ optionId: r.optionId, productName: r.productName, optionName: r.optionName, status: r.status, barcode: r.barcode, excludedAt: new Date().toISOString() });
    await dbStoreSet('soldout_analysis_exclude', data, { logDesc: `(NEW)품절 제외 추가: ${r.productName} - ${r.optionName}` });
    const newExSet = new Set(data.map(i => i.optionId));
    setExcludeSet(newExSet);
    // 보고 있는 날짜의 캐시 + rate_snapshots 재계산
    const targetDate = viewingDate;
    const cached = await dbStoreGet(`soldout_analysis_cached_${targetDate}`);
    if (cached) {
      cached.excludeSnapshot = [...newExSet];
      const valid = cached.validItems || [];
      const rTotal = valid.length;
      const rSold = valid.filter(it => !newExSet.has(it.optionId) && it.coupangStock === 0).length;
      const rate = rTotal > 0 ? Math.round(rSold / rTotal * 10000) / 100 : 0;
      cached.rate = rate;
      await dbStoreSet(`soldout_analysis_cached_${targetDate}`, cached);
      setCachedResult(cached);
      // rate_snapshots도 갱신
      try {
        const snaps = await dbStoreGet('soldout_analysis_rate_snapshots') || {};
        snaps[targetDate] = { date: targetDate, total: rTotal, soldout: rSold, rate };
        await dbStoreSet('soldout_analysis_rate_snapshots', snaps);
      } catch {}
    }
    showToast('success', '제외 완료', `${r.productName} - ${r.optionName} 품절률에서 제외`);
  };

  // 재고 수정: 엑셀 품절이지만 실제 재고 있는 항목 — 오늘만 반영
  const correctStock = async (r) => {
    const updated = { ...stockCorrections, [r.optionId]: { productName: r.productName, optionName: r.optionName, calcStock: r.calcStock, correctedAt: new Date().toISOString() } };
    setStockCorrections(updated);
    await dbStoreSet('soldout_stock_corrections', updated, { logDesc: `재고 수정: ${r.productName} - ${r.optionName}` });
    // 오늘 캐시에서 해당 항목 제거 + 품절률 재계산 (과거 캐시는 건드리지 않음)
    const isToday = viewingDate === todayStr();
    if (cachedResult && isToday) {
      const newItems = cachedResult.items.filter(i => i.optionId !== r.optionId);
      const valid = (cachedResult.validItems || []).map(v => v.optionId === r.optionId ? { ...v, coupangStock: 1 } : v);
      const rTotal = valid.length;
      const rSold = valid.filter(it => !excludeSet.has(it.optionId) && it.coupangStock === 0).length;
      const rate = rTotal > 0 ? Math.round(rSold / rTotal * 10000) / 100 : 0;
      const newCached = { ...cachedResult, items: newItems, validItems: valid, rate, correctionsSnapshot: updated };
      setCachedResult(newCached);
      await dbStoreSet(`soldout_analysis_cached_${viewingDate}`, newCached);
      try { const ex = await dbStoreGet('soldout_analysis_rate_snapshots') || {}; ex[viewingDate] = { date: viewingDate, total: rTotal, soldout: rSold, rate }; await dbStoreSet('soldout_analysis_rate_snapshots', ex); } catch {}
    }
    showToast('success', '재고 수정', `${r.productName} - ${r.optionName} 재고 정정 완료 (재고계산기: ${r.calcStock}개)`);
  };

  const toggleSelect = (optionId) => {
    setSelected(prev => { const n = new Set(prev); n.has(optionId) ? n.delete(optionId) : n.add(optionId); return n; });
  };

  const saveBatchReason = async () => {
    if (!batchReason.trim() || selected.size === 0) return;
    const updated = { ...tracker };
    for (const id of selected) {
      if (updated[id]) updated[id].reason = batchReason.trim();
    }
    setTracker(updated);
    await dbStoreSet(SOLDOUT_TRACKER_KEY, updated);
    // 보고 있는 날짜(오늘·주말·과거 무관)의 캐시 trackerSnapshot 갱신
    if (cachedResult && viewingDate) {
      const snap = { ...(cachedResult.trackerSnapshot || {}) };
      for (const id of selected) snap[id] = { ...(snap[id] || {}), reason: batchReason.trim() };
      const updatedCache = { ...cachedResult, trackerSnapshot: snap };
      setCachedResult(updatedCache);
      await dbStoreSet(`soldout_analysis_cached_${viewingDate}`, updatedCache);
    }
    showToast('success', '저장', `${selected.size}개 품목 사유 저장 완료`);
    setSelected(new Set());
    setBatchReason('');
    setShowBatchInput(false);
  };

  const saveReason = async (optionId, reason) => {
    const updated = { ...tracker };
    if (updated[optionId]) {
      updated[optionId].reason = reason;
      setTracker(updated);
      await dbStoreSet(SOLDOUT_TRACKER_KEY, updated);
    }
    // 보고 있는 날짜(오늘·주말·과거 무관)의 캐시 trackerSnapshot 갱신 → 화면 반영 + 영속
    if (cachedResult && viewingDate) {
      const snap = { ...(cachedResult.trackerSnapshot || {}) };
      snap[optionId] = { ...(snap[optionId] || {}), reason };
      const updatedCache = { ...cachedResult, trackerSnapshot: snap };
      setCachedResult(updatedCache);
      await dbStoreSet(`soldout_analysis_cached_${viewingDate}`, updatedCache);
    }
    showToast('success', '저장', '사유 저장 완료');
  };

  // === 초기 로드: DB 캐시 + 연속품절일수 재계산 ===
  useEffect(() => {
    (async () => {
      setLoading(true);
      const today = todayStr();
      const [cached, trk, exData, corrections] = await Promise.all([
        dbStoreGet(`soldout_analysis_cached_${today}`),
        dbStoreGet(SOLDOUT_TRACKER_KEY),
        dbStoreGet('soldout_analysis_exclude'),
        dbStoreGet('soldout_stock_corrections'),
      ]);
      setStockCorrections(corrections || {});
      const newExSet = new Set((exData || []).map(i => i.optionId));
      setExcludeSet(newExSet);
      // 오늘 캐시의 연속품절일수도 일별 DB 기준으로 재계산
      const fixedCached = cached ? await recalcConsecDaysForDate(today, cached) : null;
      // tracker state에도 재계산된 days 반영
      const updatedTrk = { ...(trk || {}) };
      if (fixedCached?.trackerSnapshot) {
        for (const [oid, entry] of Object.entries(fixedCached.trackerSnapshot)) {
          if (updatedTrk[oid]) updatedTrk[oid].days = entry.days;
        }
        await dbStoreSet(SOLDOUT_TRACKER_KEY, updatedTrk);
      }
      setTracker(updatedTrk);
      setCachedResult(fixedCached);
      if (fixedCached) setLastUpdatedAt(fixedCached.updatedAt);
      setLoading(false);
    })();
  }, []);

  // === 업데이트 버튼: 스프레드시트 + 엑셀 데이터 → 계산 → DB 캐시 ===
  const handleUpdate = async () => {
    setUpdating(true);
    try {
      const today = todayStr();
      const [barcodeRes, calcRes, orderRes, upload, exData] = await Promise.all([
        fetch(CSV_BARCODE), fetch(TSV_CALC), fetch(CSV_ORDER),
        dbStoreGet(`${STORE_KEY_PREFIX}${today}`),
        dbStoreGet('soldout_analysis_exclude'),
      ]);
      if (!upload || !upload.items) {
        showToast('error', '실패', '오늘 업로드 데이터가 없습니다. 데이터 업로드를 먼저 해주세요.');
        setUpdating(false); return;
      }

      // 3일 평균
      const avg3dKeys = [];
      for (let i = 0; i < 3; i++) { const d = new Date(+today.slice(0,4), +today.slice(4,6)-1, +today.slice(6,8)-i); avg3dKeys.push(dateToKey(d)); }
      const avg3dSets = await Promise.all(avg3dKeys.map(k => dbStoreGet(`${STORE_KEY_PREFIX}${k}`).catch(() => null)));
      const salesBy = {};
      for (const ds of avg3dSets) { if (!ds?.items) continue; for (const it of ds.items) { if (!salesBy[it.optionId]) salesBy[it.optionId] = { t: 0, c: 0 }; salesBy[it.optionId].t += (it.salesQty||0); salesBy[it.optionId].c++; } }
      const avgMap = {}; for (const [id, v] of Object.entries(salesBy)) avgMap[id] = v.c > 0 ? v.t / v.c : 0;

      // 쿠팡바코드
      const bcCsv = await barcodeRes.text(); const bcLines = bcCsv.split('\n').filter(l => l.trim()); const bcMap = {};
      for (let i = 1; i < bcLines.length; i++) { const c = parseCsvRow(bcLines[i]); const oid = (c[1]||'').trim(); if (oid) bcMap[oid] = { productName: (c[3]||'').trim(), optionName: (c[4]||'').trim(), status: (c[9]||'').trim(), barcode: (c[5]||'').trim() }; }

      // 재고계산기
      const calcTsv = await calcRes.text(); const cLines = calcTsv.split('\n').filter(l => l.trim()); const cMap = {};
      for (let i = 1; i < cLines.length; i++) { const c = cLines[i].split('\t'); const oid = (c[1]||'').trim(); if (oid) cMap[oid] = { barcode: (c[2]||'').trim(), calcStock: safeNum(c[6]), incoming: safeNum(c[7]), ipgo: safeNum(c[8]), bhStock: safeNum(c[9]), totalStock: safeNum(c[14]) }; }

      // 발주장부
      const orderCsv = await orderRes.text();
      const { skuMap: oSkus, skuArrival: oArr } = parseOrderBook(orderCsv);

      // 신규 상품 재고 추적 (최근 30일 업로드 데이터 전체 스캔)
      const stockTracker = {};
      const stKeys = [];
      for (let i = 0; i < 30; i++) {
        const d = new Date(+today.slice(0,4), +today.slice(4,6)-1, +today.slice(6,8)-i);
        stKeys.push(dateToKey(d));
      }
      const stDatasets = await Promise.all(stKeys.map(k => dbStoreGet(`${STORE_KEY_PREFIX}${k}`).catch(() => null)));
      for (let di = 0; di < stDatasets.length; di++) {
        const ds = stDatasets[di];
        if (!ds?.items) continue;
        const dateKey = stKeys[di];
        for (const item of ds.items) {
          const bc = bcMap[item.optionId];
          if (!bc || !bc.status.includes('신규')) continue;
          const oid = item.optionId;
          if (!stockTracker[oid]) stockTracker[oid] = { records: [], firstSeen: dateKey };
          const entry = stockTracker[oid];
          if (!entry.records.find(r => r.date === dateKey)) {
            entry.records.push({ date: dateKey, stock: item.coupangStock });
          }
        }
      }
      await dbStoreSet('soldout_analysis_stock_tracker', stockTracker);

      // 재고 수정 목록 로드 — 오늘 날짜가 아닌 과거 수정 기록은 자동 삭제
      const rawCorrections = await dbStoreGet('soldout_stock_corrections') || {};
      const corrections = {};
      let correctionsCleaned = false;
      for (const [oid, val] of Object.entries(rawCorrections)) {
        const corrDate = val.correctedAt ? val.correctedAt.slice(0, 10).replace(/-/g, '') : '';
        if (corrDate === today) {
          corrections[oid] = val;
        } else {
          correctionsCleaned = true;
        }
      }
      if (correctionsCleaned) await dbStoreSet('soldout_stock_corrections', corrections, { skipLog: true });
      setStockCorrections(corrections);

      // 분석: 전체 유효상품 카운트(품절률용) + 품절/위기 목록 생성
      const exSet = new Set((exData || []).map(i => i.optionId));
      const results = [], soldoutIds = [];
      // 품절률용: 전체 유효 상품 수 / 품절 수 (기존 로직과 동일)
      const validItems = []; // { optionId, coupangStock } - 유효 전체 상품
      for (const item of upload.items) {
        const bc = bcMap[item.optionId]; if (!bc) continue;
        if (!cMap[item.optionId]) continue;
        if (shouldExclude(bc.status)) continue;
        // 신규 상품: 7일간 한 번도 재고 > 0이 된 적 없으면 제외
        if (bc.status.includes('신규') && item.coupangStock === 0) {
          const entry = stockTracker[item.optionId];
          if (!entry || !entry.records.some(r => r.stock > 0)) continue;
        }
        // 재고 수정된 항목은 품절이 아닌 것으로 처리
        const isCorrected = !!corrections[item.optionId];
        // 유효 상품 (품절률 분모) — 수정된 항목은 coupangStock을 실제 재고로 간주
        validItems.push({ optionId: item.optionId, coupangStock: isCorrected ? 1 : item.coupangStock });

        // 수정된 항목은 품절/품절위기 판정 스킵
        if (isCorrected) continue;

        const calc = cMap[item.optionId], barcode = bc.barcode || calc.barcode || '';
        const cs = item.coupangStock, inc = calc.incoming||0, ipgo = calc.ipgo||0;
        const bh = calc.bhStock||0, tot = calc.totalStock||0, a3 = avgMap[item.optionId]||0;
        const calcStock = calc.calcStock || 0; // 재고계산기 G열 쿠팡재고
        const wk = a3 > 0 ? (cs + inc) / (a3 * 7) : 0;
        let rl = null, rr = '', fa = '';
        if (cs === 0) { rl = '품절'; soldoutIds.push(item.optionId); if (inc > 0 || ipgo > 0) { const t = new Date(); t.setDate(t.getDate()+1); fa = `${t.getMonth()+1}/${t.getDate()}`; rr = `입고예정 ${inc+ipgo}개`; } else rr = bh > 0 ? 'BH재고 있음' : '재고 없음'; }
        else if (inc > 0 || ipgo > 0) continue;
        else if (a3 > 0) { const dl = cs / a3; if (wk > 0 && wk < 1) { rl = '품절위기'; rr = `예상 ${fmtDec(wk)}주`; } else if (dl < CRISIS_DAYS_THRESHOLD) { rl = '품절위기'; rr = `${fmtDec(dl)}일분`; } }
        if (!rl) continue;
        const mismatch = cs === 0 && calcStock > 0; // 엑셀=0 vs 재고계산기>0 불일치
        results.push({ optionId: item.optionId, barcode, productName: item.productName || bc.productName, optionName: item.optionName || bc.optionName, status: bc.status, coupangStock: cs, calcStock, incoming: inc, ipgo, bhStock: bh, totalStock: tot, avg3d: a3, weeksStockIncoming: wk, salesQty: item.salesQty, riskLevel: rl, riskReason: rr, orderStatus: oSkus.get(barcode)||null, arrivalEst: fa || (oArr.get(barcode)||''), mismatch });
      }
      results.sort((a, b) => { if (a.riskLevel !== b.riskLevel) return a.riskLevel === '품절' ? -1 : 1; return b.avg3d - a.avg3d; });

      // 연속 품절 일수: 일별 업로드 데이터를 오늘부터 역순 스캔하여 재고 0 연속일 계산
      const dailyMaps = stDatasets.map(ds => {
        const m = new Map();
        if (ds?.items) for (const it of ds.items) m.set(it.optionId, it.coupangStock);
        return m;
      });
      const consecDays = {};
      for (const id of soldoutIds) {
        let days = 0;
        for (let di = 0; di < dailyMaps.length; di++) {
          const stock = dailyMaps[di].get(id);
          if (stock === undefined || stock > 0) break;
          days++;
        }
        consecDays[id] = Math.max(1, days);
      }

      // 추적기
      const trk = await dbStoreGet(SOLDOUT_TRACKER_KEY) || {};
      for (const id of soldoutIds) {
        if (!trk[id]) trk[id] = { startDate: today, reason: '' };
        trk[id].days = consecDays[id] || 1;
      }
      for (const id of Object.keys(trk)) { if (!soldoutIds.includes(id)) delete trk[id]; }
      await dbStoreSet(SOLDOUT_TRACKER_KEY, trk); setTracker(trk);

      // 품절률 스냅샷 (전체 유효 상품 기준, 제외 품목 빼고)
      const rTotal = validItems.length;
      const rSold = validItems.filter(it => !exSet.has(it.optionId) && it.coupangStock === 0).length;
      const rate = rTotal > 0 ? Math.round(rSold / rTotal * 10000) / 100 : 0;
      try { const ex = await dbStoreGet('soldout_analysis_rate_snapshots') || {}; ex[today] = { date: today, total: rTotal, soldout: rSold, rate }; await dbStoreSet('soldout_analysis_rate_snapshots', ex); } catch {}

      // 캐시 저장 (validItems + 제외 스냅샷 포함)
      const cached = { items: results, updatedAt: new Date().toISOString(), rate, trackerSnapshot: trk, validItems, excludeSnapshot: [...exSet], correctionsSnapshot: corrections };
      await dbStoreSet(`soldout_analysis_cached_${today}`, cached);
      setCachedResult(cached); setLastUpdatedAt(cached.updatedAt); setExcludeSet(exSet);
      showToast('success', '업데이트 완료', `${results.length}개 품절/위기 품목 갱신`);
    } catch (e) { console.error(e); showToast('error', '실패', '스프레드시트 연동 오류'); }
    setUpdating(false);
  };

  // === 월 단위 엑셀 다운로드: 그 달을 주(월~일)별 시트로 분할, 품절(🔴)만 ===
  const handleExportMonth = async () => {
    setExporting(true);
    try {
      const pad2 = n => String(n).padStart(2, '0');
      const year = calendarDate.getFullYear();
      const month = calendarDate.getMonth(); // 0-indexed
      const daysInMon = new Date(year, month + 1, 0).getDate();

      // 그 달의 모든 날짜 캐시 병렬 로드
      const dayList = [];
      for (let d = 1; d <= daysInMon; d++) dayList.push(new Date(year, month, d));
      const caches = await Promise.all(dayList.map(dt => ensureUploadSoldoutCache(dateToKey(dt)).catch(() => null)));
      const cacheByKey = {};
      dayList.forEach((dt, i) => { cacheByKey[dateToKey(dt)] = caches[i]; });

      // 이전 품절기록 사유: 월 전체 캐시에서 optionId별 가장 최근 비어있지 않은 사유 수집
      // (주말=원천 캐시는 사유가 비어있어, 평일 기록 사유를 이어받기 위함)
      const reasonByOption = new Map();
      for (const dk of Object.keys(cacheByKey)) {
        const cache = cacheByKey[dk];
        if (!cache?.items) continue;
        const trk = cache.trackerSnapshot || {};
        for (const it of cache.items) {
          if (it.riskLevel !== '품절') continue;
          const rsn = trk[it.optionId]?.reason;
          if (!rsn) continue;
          const prev = reasonByOption.get(it.optionId);
          if (!prev || dk > prev.dateKey) reasonByOption.set(it.optionId, { dateKey: dk, reason: rsn });
        }
      }

      // 월~일 주차로 그룹핑 (월요일 키 기준)
      const weekMap = new Map();
      for (const dt of dayList) {
        const dow = dt.getDay(); // 0=일..6=토
        const diffToMon = dow === 0 ? -6 : 1 - dow;
        const monday = new Date(dt); monday.setDate(dt.getDate() + diffToMon);
        const mk = dateToKey(monday);
        if (!weekMap.has(mk)) weekMap.set(mk, { monday, days: [] });
        weekMap.get(mk).days.push(dt);
      }
      const weeks = [...weekMap.values()].sort((a, b) => a.monday - b.monday);

      const wb = XLSX.utils.book_new();
      let totalRows = 0;
      weeks.forEach((wk, idx) => {
        // 같은 상품(optionId)은 1줄로 합치고, 그 주 가장 최근 날짜 값 사용
        const itemMap = new Map();
        const weekDaysCount = new Map(); // optionId -> 그 주차 내 품절이던 날 수
        for (const dt of wk.days) {
          const dk = dateToKey(dt);
          const cache = cacheByKey[dk];
          if (!cache?.items) continue;
          const trk = cache.trackerSnapshot || {};
          const exSet = new Set(cache.excludeSnapshot || []);
          for (const it of cache.items) {
            if (it.riskLevel !== '품절') continue; // 품절위기 제외
            weekDaysCount.set(it.optionId, (weekDaysCount.get(it.optionId) || 0) + 1); // 주차 내 품절일 누적
            const prev = itemMap.get(it.optionId);
            if (!prev || dk > prev.dateKey) {
              itemMap.set(it.optionId, {
                dateKey: dk,
                source: cache.source || null, // 'upload'=주말(업데이트 못 돌린 날) 원천 기반
                row: {
                  '상품명': it.productName || '',
                  '옵션명': it.optionName || '',
                  '등급': it.status || '',
                  '주간품절일': 0, // 아래에서 주차 누적값으로 채움
                  '사유': trk[it.optionId]?.reason ?? '',
                  '품절율 제외여부': exSet.has(it.optionId) ? 'O' : 'X',
                },
              });
            }
          }
        }
        // 주차 시작~종료 사이 품절이던 날 수로 채움 (주차 이전 연속분은 세지 않음)
        for (const [oid, v] of itemMap) {
          v.row['주간품절일'] = weekDaysCount.get(oid) || 1;
          // 주말(원천 기반) 품절: 사유가 비면 이전 품절기록 사유를 이어받고 옆에 (주말) 표기
          if (v.source === 'upload') {
            const inherited = v.row['사유'] || reasonByOption.get(oid)?.reason || '';
            v.row['사유'] = inherited ? `${inherited} (주말)` : '(주말)';
          }
        }
        const rows = [...itemMap.values()].map(v => v.row).sort((a, b) => {
          const ax = a['품절율 제외여부'] === 'X' ? 0 : 1;
          const bx = b['품절율 제외여부'] === 'X' ? 0 : 1;
          if (ax !== bx) return ax - bx; // 제외 아닌(X) 항목 먼저
          return b['주간품절일'] - a['주간품절일']; // 그 다음 주간품절일 내림차순
        });
        totalRows += rows.length;

        // 주간 품절률 = 그 주 실제 업데이트된 날들의 일별 품절률 평균
        let rateSum = 0, rateDays = 0;
        for (const dt of wk.days) {
          const c = cacheByKey[dateToKey(dt)];
          if (c && typeof c.rate === 'number') { rateSum += c.rate; rateDays++; }
        }
        const weeklyRate = rateDays > 0 ? Math.round(rateSum / rateDays * 100) / 100 : null;
        const titleText = weeklyRate != null
          ? `주간 품절률 ${weeklyRate}%  (업데이트 ${rateDays}일 평균)`
          : '주간 품절률 -  (업데이트 없음)';

        const firstDay = wk.days[0], lastDay = wk.days[wk.days.length - 1];
        const range = `${pad2(firstDay.getMonth()+1)}.${pad2(firstDay.getDate())}-${pad2(lastDay.getMonth()+1)}.${pad2(lastDay.getDate())}`;
        const sheetName = `${month+1}월 ${idx+1}주차 (${range})`;

        const header = ['상품명', '옵션명', '등급', '주간품절일', '사유', '품절율 제외여부'];
        const dataRows = rows.length
          ? rows.map(r => [r['상품명'], r['옵션명'], r['등급'], r['주간품절일'], r['사유'], r['품절율 제외여부']])
          : [['해당 주 품절 없음', '', '', '', '', '']];
        const aoa = [[titleText, '', '', '', '', ''], header, ...dataRows];
        const ws = XLSX.utils.aoa_to_sheet(aoa);
        ws['!merges'] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];

        // === 스타일링 (가독성) ===
        const thin = { style: 'thin', color: { rgb: 'D9D9D9' } };
        const border = { top: thin, bottom: thin, left: thin, right: thin };
        const titleStyle = {
          font: { name: '맑은 고딕', sz: 12, bold: true, color: { rgb: '1F2937' } },
          fill: { patternType: 'solid', fgColor: { rgb: 'DBEAFE' } },
          alignment: { horizontal: 'left', vertical: 'center' },
          border,
        };
        const headerStyle = {
          font: { name: '맑은 고딕', sz: 10, bold: true, color: { rgb: 'FFFFFF' } },
          fill: { patternType: 'solid', fgColor: { rgb: '374151' } },
          alignment: { horizontal: 'center', vertical: 'center' },
          border,
        };
        const yellowFill = { patternType: 'solid', fgColor: { rgb: 'FFF2CC' } }; // 제외 아닌 행 강조
        const leftCols = new Set([0, 1, 4]); // 상품명, 옵션명, 사유는 좌측정렬
        const cellRange = XLSX.utils.decode_range(ws['!ref']);
        for (let ri = cellRange.s.r; ri <= cellRange.e.r; ri++) {
          const isData = ri >= 2 && rows.length > 0;
          const isActive = isData && rows[ri - 2]['품절율 제외여부'] === 'X'; // 제외 아님
          for (let ci = cellRange.s.c; ci <= cellRange.e.c; ci++) {
            const ref = XLSX.utils.encode_cell({ r: ri, c: ci });
            if (!ws[ref]) ws[ref] = { v: '', t: 's' };
            if (ri === 0) { ws[ref].s = titleStyle; continue; }
            if (ri === 1) { ws[ref].s = headerStyle; continue; }
            ws[ref].s = {
              font: { name: '맑은 고딕', sz: 10 },
              alignment: { horizontal: leftCols.has(ci) ? 'left' : 'center', vertical: 'center' },
              border,
              ...(isActive ? { fill: yellowFill } : {}),
            };
          }
        }
        ws['!cols'] = [{ wch: 34 }, { wch: 22 }, { wch: 8 }, { wch: 11 }, { wch: 26 }, { wch: 14 }];
        ws['!rows'] = [{ hpt: 26 }, { hpt: 24 }, ...Array(Math.max(0, cellRange.e.r - 1)).fill({ hpt: 19 })];
        XLSX.utils.book_append_sheet(wb, ws, sheetName);
      });

      if (totalRows === 0) {
        showToast('error', '데이터 없음', `${month+1}월 품절 기록이 없습니다.`);
        setExporting(false);
        return;
      }
      XLSX.writeFile(wb, `품절기록_${year}-${pad2(month+1)}.xlsx`);
      showToast('success', '다운로드 완료', `${month+1}월 품절 기록 (총 ${totalRows}건)`);
    } catch (e) { console.error(e); showToast('error', '실패', '엑셀 생성 오류'); }
    setExporting(false);
  };

  // === 품절 이력 검색: 최근 3개월 일별 캐시 스캔 → 상품별 품절 건(연속 기간) 묶기 ===
  const runSearch = async () => {
    const term = searchTerm.trim();
    if (!term) { setSearchResult(null); return; }
    setSearching(true);
    try {
      // 최근 92일 키 생성 (오늘부터 역순)
      const today = new Date();
      const keys = [];
      for (let i = 0; i < HISTORY_SEARCH_DAYS; i++) {
        const d = new Date(today); d.setDate(today.getDate() - i);
        keys.push(dateToKey(d));
      }
      // 30개씩 배치로 캐시 로드 (DB 과부하 방지)
      const caches = [];
      for (let i = 0; i < keys.length; i += 30) {
        const batch = keys.slice(i, i + 30);
        const r = await Promise.all(batch.map(k => dbStoreGet(`soldout_analysis_cached_${k}`).catch(() => null)));
        caches.push(...r);
      }
      const lower = term.toLowerCase();
      // 캐시가 존재하는 날짜(오름차순) — 품절해제일 판정용
      const availableDates = [];
      keys.forEach((k, idx) => { if (caches[idx]?.items) availableDates.push(k); });
      availableDates.sort();
      // optionId -> { 메타 + records[] }
      const byOption = new Map();
      keys.forEach((k, idx) => {
        const cache = caches[idx];
        if (!cache?.items) return;
        const trk = cache.trackerSnapshot || {};
        for (const it of cache.items) {
          if (it.riskLevel !== '품절') continue;
          const pn = (it.productName || '').toLowerCase();
          const on = (it.optionName || '').toLowerCase();
          const oid = String(it.optionId || '').toLowerCase();
          if (!pn.includes(lower) && !on.includes(lower) && !oid.includes(lower)) continue;
          if (!byOption.has(it.optionId)) {
            byOption.set(it.optionId, { optionId: it.optionId, productName: it.productName, optionName: it.optionName, status: it.status, records: [] });
          }
          const t = trk[it.optionId] || {};
          byOption.get(it.optionId).records.push({
            dateKey: k,
            coupangStock: it.coupangStock,
            bhStock: it.bhStock,
            totalStock: it.totalStock,
            avg3d: it.avg3d,
            arrivalEst: it.arrivalEst,
            reason: t.reason || '',
            startDate: t.startDate || k,
            days: t.days || 1,
          });
        }
      });
      // 같은 startDate끼리 묶어 품절 건(spell) 생성
      const spells = [];
      for (const opt of byOption.values()) {
        const soldoutSet = new Set(opt.records.map(r => r.dateKey)); // 이 옵션이 품절이던 날
        const groups = new Map();
        for (const rec of opt.records) {
          const gk = rec.startDate;
          if (!groups.has(gk)) groups.set(gk, []);
          groups.get(gk).push(rec);
        }
        for (const [startDate, recs] of groups.entries()) {
          recs.sort((a, b) => a.dateKey.localeCompare(b.dateKey)); // 오래된 날 → 최근 날
          const endKey = recs[recs.length - 1].dateKey;
          const days = Math.max(...recs.map(r => r.days));
          // 품절해제일 = endKey 이후 캐시 존재 날짜 중 더 이상 품절이 아닌 첫 날
          let releaseKey = null;
          for (const d of availableDates) {
            if (d > endKey && !soldoutSet.has(d)) { releaseKey = d; break; }
          }
          // 품절 시작일 당시 값 (시작일 캐시 없으면 관측된 최초일 기준)
          const startRec = recs.find(r => r.dateKey === startDate) || recs[0];
          spells.push({
            key: `${opt.optionId}_${startDate}`,
            optionId: opt.optionId,
            productName: opt.productName,
            optionName: opt.optionName,
            status: opt.status,
            startDate,
            endKey,
            releaseKey, // null이면 진행중
            days,
            startStock: startRec.totalStock,
            startAvg: startRec.avg3d,
            records: recs,
          });
        }
      }
      // 최근 품절 건 먼저
      spells.sort((a, b) => b.endKey.localeCompare(a.endKey));
      setSearchResult({ term, spells });
      setExpandedSpell(new Set());
    } catch (e) { console.error(e); showToast('error', '검색 실패', '품절 이력 조회 오류'); }
    setSearching(false);
  };

  const clearSearch = () => { setSearchResult(null); setSearchTerm(''); setExpandedSpell(new Set()); };
  const toggleSpell = (key) => setExpandedSpell(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });

  // === 분석 데이터: 캐시 + 사유 합침 ===
  const analysisData = useMemo(() => {
    // 기간 모드: 이미 집계된 items 사용 (days=기간 내 누적 품절일)
    if (rangeResult) return rangeResult.items.map(r => ({ ...r }));
    if (!cachedResult?.items) return [];
    // 오늘이면 현재 tracker, 과거 날짜면 캐시에 저장된 trackerSnapshot 사용
    const isToday = viewingDate === todayStr();
    const trkSource = isToday ? tracker : (cachedResult.trackerSnapshot || {});
    return cachedResult.items.map(r => ({
      ...r,
      days: trkSource[r.optionId]?.days || 1,
      reason: trkSource[r.optionId]?.reason || '',
    }));
  }, [cachedResult, tracker, viewingDate, rangeResult]);

  // 통계 (품절률 = 전체 유효상품 중 재고0 비율)
  // 오늘 → 현재 excludeSet 실시간 계산 / 과거 → rate_snapshots에 저장된 품절률 그대로 사용
  const stats = useMemo(() => {
    const soldout = analysisData.filter(r => r.riskLevel === '품절').length;
    const risk = analysisData.filter(r => r.riskLevel === '품절위기').length;
    const inOrder = analysisData.filter(r => r.orderStatus === 'wing_on' || r.orderStatus === 'check').length;
    // 기간 모드: 데이터 있는 날만 평균낸 품절률 사용
    if (rangeResult) return { total: analysisData.length, soldout, risk, inOrder, rate: rangeResult.avgRate };
    const isToday = viewingDate === todayStr();
    let rate;
    if (isToday) {
      const valid = cachedResult?.validItems || [];
      const rateTotal = valid.length;
      const rateSoldout = valid.filter(it => !excludeSet.has(it.optionId) && it.coupangStock === 0).length;
      rate = rateTotal > 0 ? Math.round(rateSoldout / rateTotal * 10000) / 100 : 0;
    } else {
      // 과거: 당시 저장된 품절률 스냅샷 그대로 사용
      rate = cachedResult?.rate ?? 0;
    }
    return { total: analysisData.length, soldout, risk, inOrder, rate };
  }, [analysisData, cachedResult, excludeSet, viewingDate, rangeResult]);

  // 화면 표시용 제외 셋 (오늘=실시간, 과거=해당 날짜 스냅샷 그대로)
  const displayExcludeSet = useMemo(() => {
    if (rangeResult) return new Set(rangeResult.excludeSet || []);
    return viewingDate === todayStr() ? excludeSet : new Set(cachedResult?.excludeSnapshot || []);
  }, [viewingDate, excludeSet, cachedResult, rangeResult]);

  const statusOptions = useMemo(() => { const s = new Set(analysisData.map(i => i.status).filter(Boolean)); return ['전체', ...Array.from(s).sort()]; }, [analysisData]);

  const toggleSort = (key) => {
    if (sortKey === key) { setSortDir(d => d === 'asc' ? 'desc' : 'asc'); }
    else { setSortKey(key); setSortDir('asc'); }
  };

  const sortRows = (rows, key, dir) => {
    const d = dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      let va = a[key], vb = b[key];
      if (key === 'orderStatus') { const ord = { wing_on: 0, check: 1 }; va = ord[va] ?? 2; vb = ord[vb] ?? 2; }
      if (va == null && vb == null) return 0;
      if ((va == null || va === '' || va === '-') && (vb == null || vb === '' || vb === '-')) return 0;
      if (va == null || va === '' || va === '-') return 1;
      if (vb == null || vb === '' || vb === '-') return -1;
      if (typeof va === 'number' && typeof vb === 'number') return (va - vb) * d;
      return String(va).localeCompare(String(vb), 'ko') * d;
    });
  };

  const filtered = useMemo(() => {
    let rows = analysisData;
    if (riskFilter === '품절') rows = rows.filter(r => r.riskLevel === '품절');
    else if (riskFilter === '품절위기') rows = rows.filter(r => r.riskLevel === '품절위기');
    else if (riskFilter === 'inOrder') rows = rows.filter(r => r.orderStatus === 'wing_on' || r.orderStatus === 'check');
    if (statusFilter !== '전체') rows = rows.filter(r => r.status === statusFilter);
    // 품절만 정렬, 품절위기는 하단 고정
    const soldout = rows.filter(r => r.riskLevel === '품절');
    const crisis = rows.filter(r => r.riskLevel === '품절위기');
    const sortedSoldout = sortKey ? sortRows(soldout, sortKey, sortDir) : soldout;
    return [...sortedSoldout, ...crisis];
  }, [analysisData, riskFilter, statusFilter, sortKey, sortDir]);

  // 달력
  const calYear = calendarDate.getFullYear(), calMonth = calendarDate.getMonth();
  const firstDay = new Date(calYear, calMonth, 1).getDay();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const calendarDays = useMemo(() => { const d = []; for (let i = 0; i < firstDay; i++) d.push(null); for (let i = 1; i <= daysInMonth; i++) d.push(i); return d; }, [firstDay, daysInMonth]);

  // 단일 날짜 로드 (기존 동작: 연속 품절일 표시)
  const loadSingleDate = async (key) => {
    setRangeResult(null);
    setViewingDate(key); setShowCalendar(false);
    const cached = await ensureUploadSoldoutCache(key).catch(() => null);
    if (cached) {
      const fixed = await recalcConsecDaysForDate(key, cached);
      setCachedResult(fixed);
      setLastUpdatedAt(fixed.updatedAt);
    } else {
      setCachedResult(null); setLastUpdatedAt(null);
    }
  };

  // 기간 집계 로드: [startKey, endKey] 내 품절이던 상품별 "기간 내 누적 품절일" 합산
  const loadRange = async (startKey, endKey) => {
    const dayKeys = [];
    let d = keyToDate(startKey); const endD = keyToDate(endKey);
    while (d <= endD) { dayKeys.push(dateToKey(d)); d = addDays(d, 1); }
    const caches = await Promise.all(dayKeys.map(k => ensureUploadSoldoutCache(k).catch(() => null)));
    let daysWithData = 0, rateSum = 0;
    const byOption = new Map();
    caches.forEach((cache) => {
      if (!cache?.items) return; // 캐시 없는 날 건너뜀 (평균 분모에서도 제외)
      daysWithData++;
      rateSum += (cache.rate ?? 0);
      const trk = cache.trackerSnapshot || {};
      const exSet = new Set(cache.excludeSnapshot || []); // 그날 제외 품목
      for (const it of cache.items) {
        if (it.riskLevel !== '품절') continue;
        let agg = byOption.get(it.optionId);
        if (!agg) { agg = { ...it, days: 0, excludedDays: 0, reason: '' }; byOption.set(it.optionId, agg); }
        agg.days += 1; // 기간 내 품절이던 날 카운트 (시작일 이전은 세지 않음)
        if (exSet.has(it.optionId)) agg.excludedDays += 1; // 그날 제외였던 날 카운트
        // dayKeys 오름차순 → 최신 날짜 값으로 메타 갱신
        agg.productName = it.productName; agg.optionName = it.optionName; agg.status = it.status;
        agg.coupangStock = it.coupangStock; agg.bhStock = it.bhStock; agg.totalStock = it.totalStock;
        agg.avg3d = it.avg3d; agg.arrivalEst = it.arrivalEst; agg.orderStatus = it.orderStatus;
        agg.calcStock = it.calcStock; agg.mismatch = it.mismatch; agg.riskReason = it.riskReason;
        if (trk[it.optionId]?.reason) agg.reason = trk[it.optionId].reason;
      }
    });
    const avgRate = daysWithData > 0 ? Math.round(rateSum / daysWithData * 100) / 100 : 0;
    // 기간 내 품절이던 모든 날에 제외였던 품목만 "제외"로 표시 (일부 날만 제외면 일반 표시)
    const rangeExclude = [];
    for (const agg of byOption.values()) { if (agg.days > 0 && agg.excludedDays === agg.days) rangeExclude.push(agg.optionId); }
    setCachedResult(null); setLastUpdatedAt(null); setShowCalendar(false);
    setRangeResult({ items: [...byOption.values()], avgRate, periodDays: dayKeys.length, daysWithData, startKey, endKey, excludeSet: rangeExclude });
  };

  const handleCalendarDateClick = async (day) => {
    if (!day) return;
    const key = dateToKey(new Date(calYear, calMonth, day));
    // 첫 클릭(또는 이전 선택이 끝난 상태) → 시작일만 지정하고 대기
    if (!selStart || (selStart && selEnd)) {
      setSelStart(key); setSelEnd(null);
      return;
    }
    // 두 번째 클릭 → 기간 확정 (역순 선택 시 스왑)
    let s = selStart, e = key;
    if (e < s) { const t = s; s = e; e = t; }
    setSelStart(s); setSelEnd(e);
    if (s === e) await loadSingleDate(s); // 같은 날 두 번 = 1일 = 단일 모드
    else await loadRange(s, e);
  };
  const goToToday = async () => {
    const t = todayStr(); setViewingDate(t);
    setRangeResult(null); setSelStart(null); setSelEnd(null);
    const cached = await dbStoreGet(`soldout_analysis_cached_${t}`);
    if (cached) {
      const fixed = await recalcConsecDaysForDate(t, cached);
      setCachedResult(fixed);
      setLastUpdatedAt(fixed.updatedAt);
    } else {
      setCachedResult(null); setLastUpdatedAt(null);
    }
  };
  const prevMonth = () => setCalendarDate(new Date(calYear, calMonth - 1, 1));
  const nextMonth = () => setCalendarDate(new Date(calYear, calMonth + 1, 1));
  const todayKey = todayStr();

  if (loading) return <div style={{ textAlign: 'center', padding: 80, color: 'var(--text-secondary)' }}><div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>불러오는 중...</div>;

  return (
    <div>
      {toast && (
        <div style={{ position: 'fixed', top: 32, right: 32, zIndex: 9999, display: 'flex', alignItems: 'flex-start', gap: 12, padding: '16px 20px', borderRadius: 12, background: toast.type === 'success' ? '#e6f4ea' : '#fce8e6', border: `1px solid ${toast.type === 'success' ? '#1e8e3e' : '#d93025'}`, boxShadow: '0 8px 24px rgba(0,0,0,0.15)', animation: 'slideIn 0.3s ease', minWidth: 300 }}>
          <div style={{ width: 32, height: 32, borderRadius: '50%', background: toast.type === 'success' ? '#1e8e3e' : '#d93025', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          </div>
          <div><div style={{ fontWeight: 700, fontSize: 14, color: toast.type === 'success' ? '#1e8e3e' : '#d93025' }}>{toast.title}</div><div style={{ fontSize: 13, color: '#333', marginTop: 2 }}>{toast.message}</div></div>
        </div>
      )}

      {/* 데이터 없을 때 */}
      {!searchResult && !cachedResult && !rangeResult && (
        <div className="card" style={{ marginBottom: 20, padding: 24, textAlign: 'center', color: 'var(--text-secondary)' }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>📊</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{keyToDisplay(viewingDate)} 분석 데이터가 없습니다</div>
          <div style={{ fontSize: 13, marginTop: 4 }}>
            {viewingDate === todayStr() ? '아래 업데이트 버튼을 눌러 스프레드시트에서 데이터를 가져오세요.' : '해당 날짜에 업데이트된 기록이 없습니다.'}
          </div>
          {viewingDate !== todayStr() && (
            <button onClick={goToToday} style={{ marginTop: 12, padding: '6px 16px', borderRadius: 6, border: '1px solid var(--primary)', background: '#fff', color: 'var(--primary)', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>오늘로 돌아가기</button>
          )}
        </div>
      )}

      {/* 필터 바 */}
      <div className="card" style={{ marginBottom: 16, position: 'relative', overflow: 'visible' }}>
        <div className="card-body">
          <div className="filter-bar">
            {(cachedResult || rangeResult) && <>
              <button className={`filter-btn${riskFilter === 'all' ? ' active' : ''}`} onClick={() => setRiskFilter('all')}>전체 ({stats.total})</button>
              <button className={`filter-btn${riskFilter === '품절' ? ' active' : ''}`} style={riskFilter === '품절' ? { background: '#c5221f', borderColor: '#c5221f' } : {}} onClick={() => setRiskFilter(riskFilter === '품절' ? 'all' : '품절')}>🔴 품절 ({stats.soldout})</button>
              <button className={`filter-btn${riskFilter === '품절위기' ? ' active' : ''}`} style={riskFilter === '품절위기' ? { background: '#e65100', borderColor: '#e65100' } : {}} onClick={() => setRiskFilter(riskFilter === '품절위기' ? 'all' : '품절위기')}>🟠 위기 ({stats.risk})</button>
              <button className={`filter-btn${riskFilter === 'inOrder' ? ' active' : ''}`} style={riskFilter === 'inOrder' ? { background: '#00897b', borderColor: '#00897b' } : {}} onClick={() => setRiskFilter(riskFilter === 'inOrder' ? 'all' : 'inOrder')}>✈️ 발주 ({stats.inOrder})</button>
              <span style={{ margin: '0 4px', color: 'var(--border)' }}>|</span>
              {statusOptions.map(s => <button key={s} onClick={() => setStatusFilter(s)} className={`filter-btn${statusFilter === s ? ' active' : ''}`}>{s}</button>)}
              <div style={{ flex: 1, display: 'flex', gap: 6, alignItems: 'center', margin: '0 8px', minWidth: 180 }}>
                <input
                  type="text"
                  className="search-input"
                  placeholder="🔍 상품명·옵션명·옵션ID로 품절 이력 검색 (최근 3개월)"
                  value={searchTerm}
                  onChange={e => setSearchTerm(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') runSearch(); }}
                  style={{ flex: 1, minWidth: 0, maxWidth: 360, padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)', fontSize: 12 }}
                />
                <button onClick={runSearch} disabled={searching} className="btn btn-primary btn-sm" style={{ whiteSpace: 'nowrap' }}>
                  {searching ? '검색 중...' : '검색'}
                </button>
                {searchResult && (
                  <button onClick={clearSearch} className="btn btn-outline btn-sm" style={{ whiteSpace: 'nowrap' }}>✕ 닫기</button>
                )}
              </div>
              {selected.size > 0 && (
                <button className="btn btn-primary btn-sm" onClick={() => setShowBatchInput(true)}>
                  {selected.size}개 사유 입력
                </button>
              )}
              <span style={{ fontSize: 13, fontWeight: 700, padding: '4px 10px', borderRadius: 8, background: stats.rate > 10 ? '#fef0ef' : stats.rate > 5 ? '#fff8f0' : '#f0faf0', color: stats.rate > 10 ? '#d93025' : stats.rate > 5 ? '#e65100' : '#2e7d32' }}>{rangeResult ? '평균 ' : ''}품절률 {stats.rate}%</span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{fmt(filtered.length)}개</span>
            </>}
            {viewingDate === todayStr() && !cachedResult && !rangeResult && (
              <button onClick={handleUpdate} disabled={updating} className="btn btn-primary btn-sm" style={{ whiteSpace: 'nowrap' }}>
                {updating ? '갱신 중...' : '🔄 업데이트'}
              </button>
            )}
            <button onClick={handleExportMonth} disabled={exporting} className="btn btn-outline btn-sm" style={{ whiteSpace: 'nowrap' }}>
              {exporting ? '다운로드 중...' : `📥 ${calMonth + 1}월 엑셀`}
            </button>
            <button onClick={() => { if (!showCalendar && selStart && !selEnd) setSelStart(null); setShowCalendar(!showCalendar); }} style={{ width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)', background: showCalendar ? 'var(--primary)' : '#fff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={showCalendar ? '#fff' : '#555'} strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/></svg>
            </button>
          </div>
          {lastUpdatedAt && <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 4 }}>마지막 업데이트: {new Date(lastUpdatedAt).toLocaleString('ko-KR')}</div>}
        </div>

        {showCalendar && (
          <>
            <div onClick={() => setShowCalendar(false)} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, zIndex: 999 }} />
            <div style={{ position: 'absolute', top: '100%', right: 20, marginTop: 8, zIndex: 1000, background: '#fff', borderRadius: 12, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', border: '1px solid var(--border)', width: 340, padding: 20, animation: 'fadeIn 0.15s ease' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <button onClick={prevMonth} style={calBtnStyle}>◀</button>
                <span style={{ fontWeight: 700, fontSize: 15 }}>{calYear}년 {calMonth+1}월</span>
                <button onClick={nextMonth} style={calBtnStyle}>▶</button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 2, textAlign: 'center' }}>
                {['일','월','화','수','목','금','토'].map(d => <div key={d} style={{ padding: 6, fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)' }}>{d}</div>)}
                {calendarDays.map((day, idx) => {
                  if (!day) return <div key={`e${idx}`} />;
                  const key = dateToKey(new Date(calYear, calMonth, day));
                  const isToday = key === todayKey;
                  const isEdge = key === selStart || key === selEnd;       // 시작/종료일
                  const isMid = selStart && selEnd && key > selStart && key < selEnd; // 기간 중간
                  const isSingleSel = !selStart && !rangeResult && key === viewingDate; // 단일 모드 기존 선택
                  const hi = isEdge || isSingleSel;
                  return <div key={key} onClick={() => handleCalendarDateClick(day)} style={{ padding: '8px 2px', borderRadius: 8, cursor: 'pointer', fontSize: 13, background: hi ? 'var(--primary)' : isMid ? 'var(--primary-light)' : isToday ? 'var(--primary-light)' : 'transparent', color: hi ? '#fff' : isMid ? 'var(--primary)' : isToday ? 'var(--primary)' : 'var(--text)', fontWeight: isToday || hi || isMid ? 700 : 400, border: isToday && !hi ? '2px solid var(--primary)' : '2px solid transparent' }}
                    onMouseOver={e => { if (!hi && !isMid) e.currentTarget.style.background = '#f1f3f4'; }}
                    onMouseOut={e => { if (!hi && !isMid) e.currentTarget.style.background = isToday ? 'var(--primary-light)' : 'transparent'; }}
                  >{day}</div>;
                })}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 12, textAlign: 'center', lineHeight: 1.5 }}>
                {selStart && !selEnd
                  ? <><b style={{ color: 'var(--primary)' }}>{keyToDisplay(selStart)}</b> 시작 · 종료일을 선택하세요</>
                  : '시작일·종료일 두 번 클릭 = 기간 조회 (같은 날 두 번 = 하루)'}
              </div>
            </div>
          </>
        )}
      </div>

      {/* 품절 이력 검색 결과 */}
      {searchResult && (
        <>
          <div style={{ padding: '0 0 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>
              품절 이력 검색: "{searchResult.term}"
              <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-secondary)', marginLeft: 8 }}>{searchResult.spells.length}건 (최근 3개월)</span>
            </span>
            <button onClick={clearSearch} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--primary)', background: '#fff', color: 'var(--primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>✕ 검색 닫기</button>
          </div>
          <div style={{ fontSize: 11, color: '#999', marginBottom: 4 }}>* 각 품절 건을 클릭하면 날짜별 사유가 펼쳐집니다. 총재고·3일평균은 품절 시작일 당시 값입니다.</div>
          <div className="table-wrapper" style={{ maxHeight: 'calc(100vh - 340px)', overflowY: 'auto' }}>
            <table className="data-table">
              <thead><tr>
                <th style={{ width: 32 }}></th>
                <th style={{ width: 30 }}>옵션ID</th>
                <th style={{ width: 44 }}>등급</th>
                <th style={{ width: 220 }}>상품명</th>
                <th style={{ width: 110 }}>옵션명</th>
                <th style={{ width: 84 }}>품절 시작일</th>
                <th style={{ width: 84 }}>품절 해제일</th>
                <th style={{ width: 80, textAlign: 'center' }}>누적 품절일</th>
                <th style={{ width: 70, textAlign: 'center' }}>품절 당시 총재고</th>
                <th style={{ width: 70, textAlign: 'center' }}>품절 당시 3일평균</th>
              </tr></thead>
              <tbody>
                {searchResult.spells.length === 0 ? (
                  <tr><td colSpan={10} style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>최근 3개월간 '{searchResult.term}' 품절 기록이 없습니다</td></tr>
                ) : searchResult.spells.map(sp => {
                  const open = expandedSpell.has(sp.key);
                  return (
                    <Fragment key={sp.key}>
                      <tr onClick={() => toggleSpell(sp.key)} style={{ cursor: 'pointer', background: open ? '#e8f0fe' : '' }}>
                        <td className="center" style={{ color: '#1a73e8', fontWeight: 700 }}>{open ? '▼' : '▶'}</td>
                        <td style={{ width: 30, fontSize: 11, color: '#888', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={sp.optionId}>{sp.optionId}</td>
                        <td><span className={`alert-badge ${sp.status === '효자' ? 'normal' : sp.status?.includes('신규') ? 'excess' : 'no-sales'}`} style={{ fontSize: 10, padding: '1px 6px' }}>{sp.status || '-'}</span></td>
                        <td style={{ width: 220, maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sp.productName}>{sp.productName}</td>
                        <td style={{ width: 110, maxWidth: 110, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={sp.optionName}>{sp.optionName}</td>
                        <td style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap' }}>{keyToDisplay(sp.startDate)}</td>
                        <td style={{ fontSize: 12, fontWeight: 600, whiteSpace: 'nowrap', color: sp.releaseKey ? '#2e7d32' : '#c5221f' }}>{sp.releaseKey ? keyToDisplay(sp.releaseKey) : '진행중'}</td>
                        <td className="center"><span style={{ fontWeight: 700, color: sp.days >= 7 ? '#d93025' : sp.days >= 3 ? '#e65100' : 'var(--text)' }}>{sp.days}일</span></td>
                        <td className="center">{sp.startStock != null ? fmt(sp.startStock) : '-'}</td>
                        <td className="center">{sp.startAvg != null ? fmtDec(sp.startAvg) : '-'}</td>
                      </tr>
                      {open && (
                        <tr>
                          <td colSpan={10} style={{ padding: 0, background: '#fafbfc' }}>
                            <table className="data-table" style={{ margin: 0 }}>
                              <thead><tr>
                                <th style={{ width: 140 }}>날짜</th>
                                <th>사유</th>
                              </tr></thead>
                              <tbody>
                                {sp.records.map(rec => (
                                  <tr key={rec.dateKey}>
                                    <td style={{ fontWeight: 600 }}>{keyToDisplay(rec.dateKey)}</td>
                                    <td style={{ fontSize: 11 }}>{rec.reason ? <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 6, background: '#f3eef8', color: '#7c4dbd', fontWeight: 600 }}>{rec.reason}</span> : <span style={{ color: '#ccc' }}>사유 없음</span>}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* 테이블 */}
      {!searchResult && (cachedResult || rangeResult) && <>
        <div style={{ padding: '0 0 8px', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 700 }}>
            품절 현황 ({filtered.length}개)
            <span style={{ fontSize: 13, fontWeight: 400, color: 'var(--text-secondary)', marginLeft: 8 }}>
              {rangeResult ? `${keyToDisplay(rangeResult.startKey)} ~ ${keyToDisplay(rangeResult.endKey)} (${rangeResult.daysWithData}일 집계)` : keyToDisplay(viewingDate)}
            </span>
          </span>
          {(rangeResult || viewingDate !== todayStr()) && <button onClick={goToToday} style={{ padding: '5px 12px', borderRadius: 6, border: '1px solid var(--primary)', background: '#fff', color: 'var(--primary)', fontSize: 12, fontWeight: 600, cursor: 'pointer' }}>오늘로 돌아가기</button>}
        </div>
        <div style={{ fontSize: 11, color: '#999', marginBottom: 4 }}>* 입고예상은 예상일일 뿐이오니, 정확한 입고 예정일은 SCM팀에 문의 바랍니다.</div>
        <div className="table-wrapper" style={{ maxHeight: 'calc(100vh - 340px)', overflowY: 'auto' }}>
          <table className="data-table">
            <thead><tr>
              <th style={{ width: 32 }}><input type="checkbox" checked={filtered.filter(r => r.riskLevel === '품절').length > 0 && filtered.filter(r => r.riskLevel === '품절').every(r => selected.has(r.optionId))} onChange={() => { const ids = filtered.filter(r => r.riskLevel === '품절').map(r => r.optionId); const allSel = ids.every(id => selected.has(id)); setSelected(allSel ? new Set() : new Set(ids)); }} style={{ cursor: 'pointer' }} /></th>
              {[
                { key: 'riskLevel', label: '상태', style: { width: 56 } },
                { key: 'status', label: '등급', style: { width: 44 } },
                { key: 'optionId', label: '옵션ID' },
                { key: 'productName', label: '상품명', style: { maxWidth: 200 } },
                { key: 'optionName', label: '옵션명' },
                { key: 'arrivalEst', label: '입고예상' },
                { key: 'coupangStock', label: '쿠팡재고' },
                { key: 'bhStock', label: '박스히어로' },
                { key: 'totalStock', label: '총재고' },
                { key: 'avg3d', label: '3일평균' },
                { key: 'weeksStockIncoming', label: '예상주' },
                { key: 'orderStatus', label: '발주현황', style: { width: 80 } },
                { key: 'days', label: '품절일' },
                { key: 'reason', label: '사유' },
              ].map(col => (
                <th key={col.key} style={{ ...col.style, cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }} onClick={() => toggleSort(col.key)}>
                  {col.label}
                  <span style={{ marginLeft: 3, fontSize: 10, color: sortKey === col.key ? 'var(--primary)' : '#ccc' }}>
                    {sortKey === col.key ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                  </span>
                </th>
              ))}
              <th style={{ width: 44 }}>제외</th>
            </tr></thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={16} style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>해당 조건의 품목이 없습니다</td></tr>
              ) : filtered.map(r => {
                const rc = RISK_CONFIG[r.riskLevel];
                return (
                  <tr key={r.optionId} className={r.riskLevel === '품절' ? 'row-emergency' : ''} style={{ ...(displayExcludeSet.has(r.optionId) ? { opacity: 0.45 } : {}), ...(selected.has(r.optionId) ? { background: '#e8f0fe' } : {}) }}>
                    <td className="center">{r.riskLevel === '품절' && <input type="checkbox" checked={selected.has(r.optionId)} onChange={() => toggleSelect(r.optionId)} style={{ cursor: 'pointer' }} />}</td>
                    <td><span className={`alert-badge ${rc.cls}`} style={{ fontSize: 10, padding: '1px 6px' }}>{rc.emoji} {rc.label}</span></td>
                    <td><span className={`alert-badge ${r.status === '효자' ? 'normal' : r.status?.includes('신규') ? 'excess' : 'no-sales'}`} style={{ fontSize: 10, padding: '1px 6px' }}>{r.status || '-'}</span></td>
                    <td style={{ fontSize: 11, color: '#888' }}>{r.optionId}</td>
                    <td style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.productName}>{r.productName}</td>
                    <td>{r.optionName}</td>
                    <td className="center" style={{ fontSize: 11, color: r.arrivalEst ? '#1a73e8' : '#ccc', fontWeight: r.arrivalEst ? 600 : 400 }}>{r.arrivalEst || '-'}</td>
                    <td className="num" style={{ color: r.coupangStock === 0 ? '#c5221f' : '', fontWeight: r.coupangStock === 0 ? 700 : 400 }}>
                      {fmt(r.coupangStock)}
                      {r.mismatch && (
                        <button onClick={() => correctStock(r)} title={`재고계산기: ${r.calcStock}개 — 클릭하여 재고 정정`} style={{ marginLeft: 4, padding: '1px 6px', borderRadius: 4, border: '1px solid #1a73e8', background: '#e8f0fe', color: '#1a73e8', fontSize: 10, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>수정 ({r.calcStock})</button>
                      )}
                    </td>
                    <td className="num">{r.bhStock > 0 ? <span style={{ color: '#2e7d32' }}>{fmt(r.bhStock)}</span> : '-'}</td>
                    <td className="num" style={{ fontWeight: 600 }}>{fmt(r.totalStock)}</td>
                    <td className="num">{r.avg3d > 0 ? fmtDec(r.avg3d) : '-'}</td>
                    <td className="num" style={{ color: r.weeksStockIncoming > 0 && r.weeksStockIncoming < 1 ? '#e65100' : '' }}>{r.weeksStockIncoming > 0 ? fmtDec(r.weeksStockIncoming) + '주' : '-'}</td>
                    <td className="center">
                      {r.orderStatus === 'wing_on' ? <span className="alert-badge" style={{ background: '#e8f5e9', color: '#2e7d32', padding: '3px 10px' }}>✈️ 윙ON</span>
                      : r.orderStatus === 'check' ? <span className="alert-badge" style={{ background: '#fff3e0', color: '#e65100', padding: '3px 10px' }}>📋 장부확인</span>
                      : <span className="alert-badge emergency" style={{ padding: '3px 10px' }}>⚠️ 발주필요</span>}
                    </td>
                    <td className="center">{r.riskLevel === '품절' ? <span style={{ fontWeight: 700, color: r.days >= 7 ? '#d93025' : r.days >= 3 ? '#e65100' : 'var(--text)' }}>{r.days}일</span> : '-'}</td>
                    <td style={{ fontSize: 11, maxWidth: 180 }}>
                      {r.riskLevel === '품절' ? (
                        editingReason === r.optionId ? (
                          <div style={{ display: 'flex', gap: 4 }}>
                            <input type="text" placeholder="사유 입력" defaultValue={r.reason} autoFocus
                              onChange={e => setReasonEditing(p => ({ ...p, [r.optionId]: e.target.value }))}
                              onKeyDown={e => { if (e.key === 'Enter') { saveReason(r.optionId, e.target.value); setEditingReason(null); } if (e.key === 'Escape') setEditingReason(null); }}
                              onBlur={() => setTimeout(() => setEditingReason(null), 150)}
                              className="edit-input" style={{ flex: 1, minWidth: 0 }} />
                            <button onClick={() => { saveReason(r.optionId, reasonEditing[r.optionId] ?? r.reason); setEditingReason(null); }} className="btn btn-primary btn-sm" style={{ fontSize: 11, padding: '2px 8px' }}>저장</button>
                          </div>
                        ) : r.reason ? (
                          <span onClick={() => setEditingReason(r.optionId)} style={{ cursor: 'pointer', display: 'inline-block', padding: '2px 8px', borderRadius: 6, background: '#f3eef8', color: '#7c4dbd', fontWeight: 600, fontSize: 11, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={r.reason}>
                            {r.reason}
                          </span>
                        ) : (
                          <span onClick={() => setEditingReason(r.optionId)} style={{ cursor: 'pointer', color: '#ccc', fontSize: 11 }}>클릭하여 입력</span>
                        )
                      ) : <span style={{ color: '#666' }}>{r.riskReason}</span>}
                    </td>
                    <td className="center">
                      {displayExcludeSet.has(r.optionId) ? <span style={{ fontSize: 11, color: '#1e8e3e', fontWeight: 600 }}>제외</span>
                      : <button onClick={() => addExclude(r)} title="품절률 제외" style={{ width: 24, height: 24, borderRadius: 6, border: 'none', cursor: 'pointer', background: '#f1f3f4', color: '#999', fontSize: 12, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>✕</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>}

      {!searchResult && (cachedResult || rangeResult) && <div style={{ fontSize: 11, color: 'var(--text-secondary)', padding: '8px 4px 0' }}>{rangeResult ? '기간 모드: 품절일 = 선택 기간 내 누적 품절일 (시작일 이전 제외) · 평균 품절률 = 데이터 있는 날만 평균' : '최종마감·품질확인서·마감대상 제외 | 쿠팡재고=업로드 엑셀 | 그 외=스프레드시트 | 품절위기=1주 미만 또는 3일내 소진'}</div>}

      {/* 일괄 사유 입력 모달 */}
      {showBatchInput && (
        <div style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }} onClick={() => setShowBatchInput(false)}>
          <div style={{ background: '#fff', borderRadius: 12, padding: 24, minWidth: 400, boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }} onClick={e => e.stopPropagation()}>
            <h3 style={{ marginBottom: 12, fontSize: 16 }}>{selected.size}개 품목 사유 입력</h3>
            <div style={{ fontSize: 12, color: '#666', marginBottom: 12, maxHeight: 120, overflowY: 'auto' }}>
              {analysisData.filter(r => selected.has(r.optionId)).map(r => (
                <div key={r.optionId} style={{ padding: '2px 0' }}>{r.productName} - {r.optionName}</div>
              ))}
            </div>
            <input
              className="search-input"
              style={{ width: '100%', minWidth: 'auto', marginBottom: 12 }}
              placeholder="사유를 입력하세요 (예: 재발주 완료, 생산중 6/3 입고예정)"
              value={batchReason}
              onChange={e => setBatchReason(e.target.value)}
              autoFocus
              onKeyDown={e => e.key === 'Enter' && saveBatchReason()}
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-outline btn-sm" onClick={() => setShowBatchInput(false)}>취소</button>
              <button className="btn btn-primary btn-sm" onClick={saveBatchReason}>적용</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @keyframes slideIn { from { opacity: 0; transform: translateX(40px); } to { opacity: 1; transform: translateX(0); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(-8px); } to { opacity: 1; transform: translateY(0); } }
      `}</style>
    </div>
  );
}

const calBtnStyle = { width: 32, height: 32, borderRadius: 8, border: '1px solid var(--border)', background: '#fff', cursor: 'pointer', fontSize: 12, display: 'flex', alignItems: 'center', justifyContent: 'center' };
