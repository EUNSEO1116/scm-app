import { useState, useMemo, useEffect, useCallback, useRef, Fragment } from 'react';
import * as XLSX from 'xlsx';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const TSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('특별 관리 상품')}`;
const ORDERBOOK_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('발주장부')}`;
// 발주장부: 발주번호 = T열(19), 출고현황 = J열(9), 실제 출고일 = K열(10), 인천 실제 도착일 = L열(11)
const OB_ORDERNO_COL = 19;
const OB_SHIPSTATUS_COL = 9;
const OB_ACTUALSHIP_COL = 10;
const OB_INCHEON_COL = 11;

const STORE_KEY = 'delay_cause_items';
const SOLDOUT_CACHE_PREFIX = 'soldout_analysis_cached_'; // 품절현황 일자별 캐시 (YYYYMMDD)
const AUTORUN_KEY = 'delay_cause_autorun'; // { date: 'YYYY-MM-DD', count: N } (KST 11시 1회 자동감지)

const REASON_STATUSES = ['작업지연', '업체발송지연', '판매량 증가', '운송지연', '재수배지연', '조치지연'];
const REASON_COLORS = {
  '작업지연': '#fb8c00',
  '업체발송지연': '#c62828',
  '판매량 증가': '#2e7d32',
  '운송지연': '#00838f',
  '재수배지연': '#6a1b9a',
  '조치지연': '#1565c0',
};
// '*' 표시 대상 사유상태 (재수배지연·조치지연은 별표 없음)
const REASON_STAR = new Set(['작업지연', '업체발송지연', '판매량 증가', '운송지연']);
const reasonLabel = (s) => (REASON_STAR.has(s) ? '*' : '') + s;
// 기존 데이터 호환: '재수배지연(SCM귀책)'·'조치지연(SCM귀책)' → '(SCM귀책)' 문구 제거
const migrateReasonStatus = (arr) => Array.isArray(arr)
  ? arr.map(it => (typeof it.reasonStatus === 'string' && it.reasonStatus.includes('(SCM귀책)'))
      ? { ...it, reasonStatus: it.reasonStatus.replace('(SCM귀책)', '') }
      : it)
  : arr;

// 진행상태 (필수) — 사유상태와 별개. 종결은 별도 체크박스로만 처리
const PROGRESS_STATUSES = ['확인중', '지장없음', '독촉완료', '조치안됨', '품절됨'];
const PROGRESS_COLORS = {
  '확인중': '#9e9e9e',
  '지장없음': '#1e8e3e',
  '독촉완료': '#0097a7',
  '조치안됨': '#e65100',
  '품절됨': '#c62828',
};
const CLOSED_COLOR = '#303f9f';
// 기존 데이터 호환: 유효한 progressStatus면 사용, 아니면 확인중
const getProgress = (item) => (PROGRESS_STATUSES.includes(item.progressStatus) ? item.progressStatus : '확인중');

// 날짜 컬럼별 포인트 색상
const DATE_COLORS = {
  orderDate: '#1565c0',    // 발주일 · 파랑
  confirmDate: '#00897b',  // 확인일 · 청록
  shipEtaDate: '#6a1b9a',  // 발송예정일 · 보라
  releaseReqDate: '#ef6c00', // 출고요청일 · 주황
  actualShipDate: '#2e7d32', // 실제 출고일 · 초록
  incheonArriveDate: '#ad1457', // 인천도착일 · 마젠타
  soldoutDate: '#c62828',  // 품절일 · 빨강
};

// 발주장부 K열 셀 값 → 'YYYY-MM-DD' 정규화 (여러 표기 대응)
// refDate(발주일 'YYYY-MM-DD') = 연도 없는 '월/일' 표기의 연도 추정 기준
function normalizeShipDate(s, refDate) {
  if (!s) return '';
  const t = String(s).trim();
  const pad = (n) => String(n).padStart(2, '0');
  // YYYY-M-D / YYYY.M.D / YYYY/M/D / 'YYYY. M. D'
  let m = t.match(/(\d{4})[.\-/\s]+(\d{1,2})[.\-/\s]+(\d{1,2})/);
  if (m) return `${m[1]}-${pad(m[2])}-${pad(m[3])}`;
  // M/D/YYYY
  m = t.match(/(\d{1,2})[/](\d{1,2})[/](\d{4})/);
  if (m) return `${m[3]}-${pad(m[1])}-${pad(m[2])}`;
  // 연도 없는 '월/일' : '7/30', '7.30', '7-30', '7월 30일'
  m = t.match(/^(\d{1,2})\s*[./\-월]\s*(\d{1,2})/);
  if (m) {
    const mo = +m[1], d = +m[2];
    if (mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    const year = (refDate && /^\d{4}/.test(refDate))
      ? +refDate.slice(0, 4)
      : new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' })).getFullYear();
    const cand = `${year}-${pad(mo)}-${pad(d)}`;
    // 출고일이 발주일보다 앞서면(연말→연초 넘어감) 다음 해로 보정
    if (refDate && cand < refDate) return `${year + 1}-${pad(mo)}-${pad(d)}`;
    return cand;
  }
  return '';
}

const ROW_MIN_WIDTH = 1526;

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

// KST(한국시간) 현재 Date
const kstNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Seoul' }));
// KST 기준 오늘 날짜 문자열 (YYYY-MM-DD)
const kstToday = () => {
  const d = kstNow();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
// KST 기준 내일 날짜 문자열 (YYYY-MM-DD)
const kstTomorrow = () => {
  const d = kstNow();
  d.setDate(d.getDate() + 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
// 발주번호 정규화 (공백 제거 + 대문자)
const normOrder = (s) => (s || '').replace(/\s+/g, '').toUpperCase();

// 'YYYYMMDD'(또는 'YYYY-MM-DD') → 'YYYY-MM-DD'
const normDateKey = (s) => {
  if (!s) return '';
  const t = String(s).replace(/[^0-9]/g, '');
  if (t.length < 8) return '';
  return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
};
// 'YYYY-MM-DD' + n일 → 'YYYY-MM-DD'
const addDays = (dateStr, n) => {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T00:00:00`);
  if (isNaN(d)) return '';
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
// 두 날짜(YYYY-MM-DD) 사이 일수 차이 (b - a). 유효하지 않으면 null
const daysDiff = (a, b) => {
  if (!a || !b) return null;
  const da = new Date(`${a}T00:00:00`);
  const db = new Date(`${b}T00:00:00`);
  if (isNaN(da) || isNaN(db)) return null;
  return Math.round((db - da) / 86400000);
};
// 자동 종결 분류: 처리 대상이면 { reasonStatus?, progressStatus } 반환, 미분류(2f)면 null.
// (호출 측에서 progressStatus='확인중' & 알림대상 & 미처리 항목만 넘김)
const classifyAutoClose = (it) => {
  // 1. 품절시작일 공백 → 지장없음 (사유는 그대로)
  if (!it.soldoutDate) return { progressStatus: '지장없음' };
  // 2a. 사유 이미 있음 → 사유 유지 + 품절됨
  if (it.reasonStatus) return { progressStatus: '품절됨' };
  // 2b. 확인일 공백 → 조치지연 + 품절됨
  if (!it.confirmDate) return { reasonStatus: '조치지연', progressStatus: '품절됨' };
  // 2c. 발주일~확인일 5일 이상 → 조치지연 우선
  const co = daysDiff(it.orderDate, it.confirmDate);
  if (co !== null && co >= 5) return { reasonStatus: '조치지연', progressStatus: '품절됨' };
  const oi = daysDiff(it.orderDate, it.incheonArriveDate); // 발주일~인천도착일 총기간
  // 2d. 출고요청일 공백 → 총기간<10이면 판매량 증가, 아니면 조치지연
  if (!it.releaseReqDate) {
    const r = (oi !== null && oi < 10) ? '판매량 증가' : '조치지연';
    return { reasonStatus: r, progressStatus: '품절됨' };
  }
  // 2e. 발주일~인천도착일 10일 미만 → 판매량 증가
  if (oi !== null && oi < 10) return { reasonStatus: '판매량 증가', progressStatus: '품절됨' };
  // 2f. 미분류 → 처리 안 함
  return null;
};
// KST 기준 오늘부터 back일 전 YYYYMMDD 키
const kstDateKey = (back) => {
  const d = kstNow();
  d.setDate(d.getDate() - back);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
};

// 발주번호에서 날짜 형식(YYMMDD) 추출 → 'YYYY-MM-DD'
// 예) 'AE-I-260529' / 'AE-I-2605292' → '2026-05-29'
function parseOrderDate(orderNo) {
  if (!orderNo) return '';
  const runs = String(orderNo).match(/\d+/g) || [];
  for (const run of runs) {
    if (run.length < 6) continue;
    const six = run.slice(0, 6);
    const mm = +six.slice(2, 4);
    const dd = +six.slice(4, 6);
    if (mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31) {
      return `20${six.slice(0, 2)}-${six.slice(2, 4)}-${six.slice(4, 6)}`;
    }
  }
  return '';
}

const emptyForm = {
  barcode: '',
  productName: '',
  optionName: '',
  orderNo: '',
  orderDate: '',
  confirmDate: new Date().toISOString().slice(0, 10),
  shipEtaDate: '',
  releaseReqDate: '',
  incheonArriveDate: '',
  soldoutDate: '',
  reasonStatus: '',
  progressStatus: '확인중',
  reasonDetail: '',
};

export default function SoldOutAnalysisDelayCause() {
  // 상품 자동완성 (특별 관리 상품 시트 — 상품개선과 동일)
  const [productList, setProductList] = useState([]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(TSV_URL);
        if (!res.ok) throw new Error();
        const text = await res.text();
        const lines = parseCSV(text);
        const results = [];
        for (let i = 1; i < lines.length; i++) {
          const cols = lines[i];
          const barcode = (cols[0] || '').trim();
          const productName = (cols[1] || '').trim();
          const optionName = (cols[2] || '').trim();
          if (!barcode && !productName) continue;
          results.push({ barcode, productName, optionName });
        }
        setProductList(results);
      } catch { /* 실패해도 수동 입력 가능 */ }
    })();
  }, []);

  const [items, setItems] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const [productSearch, setProductSearch] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);

  const [searchQuery, setSearchQuery] = useState('');
  const [filterReason, setFilterReason] = useState('all');
  const [dateFilters, setDateFilters] = useState({}); // { field: 'YYYY-MM-DD' } 날짜 컬럼별 필터
  const [openDateMenu, setOpenDateMenu] = useState(null); // { field, rect } 열린 날짜 필터 드롭다운
  const [expandedId, setExpandedId] = useState(null);
  const [selectedIds, setSelectedIds] = useState([]); // 체크박스 선택 (나중에 일괄 저장 기능 연결)

  const [timelineInput, setTimelineInput] = useState({});
  const [editingTL, setEditingTL] = useState(null); // { itemId, idx }
  const [editingTLText, setEditingTLText] = useState('');

  const [editingCell, setEditingCell] = useState(null); // { id, field }
  const [editValue, setEditValue] = useState('');

  const [dbSyncFailed, setDbSyncFailed] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshMsg, setRefreshMsg] = useState('');

  // 스크롤 시 컬럼 헤더 고정: 상단 툴바(sticky top:40)와 동일 방식.
  // 페이지(창)를 스크롤하면 헤더(th)가 툴바 바로 아래에 sticky로 붙어있게 함.
  // 툴바 높이를 실시간 측정해 헤더 top 오프셋(40 + 툴바높이)을 계산.
  const filterCardRef = useRef(null);
  const [headerTop, setHeaderTop] = useState(108);

  const [showUrgePanel, setShowUrgePanel] = useState(false);
  const [urgeText, setUrgeText] = useState('');
  const [urgeResult, setUrgeResult] = useState(null); // { matched: [...], unmatched: [...] }

  const [showShipReqPanel, setShowShipReqPanel] = useState(false);
  const [shipReqText, setShipReqText] = useState('');
  const [shipReqResult, setShipReqResult] = useState(null); // { matched, unmatched, updated, date }

  // 조치안됨 자동감지 (KST 11시 1회)
  const [autoDetectInfo, setAutoDetectInfo] = useState(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(AUTORUN_KEY) || 'null');
      if (raw && raw.date === kstToday() && raw.count > 0) return raw;
    } catch { /* ignore */ }
    return null;
  });
  const itemsRef = useRef([]);
  const autoRunningRef = useRef(false);
  const [autoCloseInfo, setAutoCloseInfo] = useState(null); // { count } 이번 접속 자동 종결 건수
  useEffect(() => { itemsRef.current = items; }, [items]);

  // 툴바 높이 측정 → 헤더 sticky top 오프셋. 툴바 줄바꿈 등 높이 변동 시 재계산.
  useEffect(() => {
    const el = filterCardRef.current;
    if (!el) return;
    const measure = () => setHeaderTop(40 + el.offsetHeight);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener('resize', measure);
    return () => { ro.disconnect(); window.removeEventListener('resize', measure); };
  }, []);

  const fileInputRef = useRef(null);

  // localStorage + DB 이중 저장/로드
  useEffect(() => {
    let localItems = null;
    try {
      localItems = migrateReasonStatus(JSON.parse(localStorage.getItem(STORE_KEY) || 'null'));
      if (Array.isArray(localItems) && localItems.length > 0) setItems(localItems);
    } catch { /* ignore */ }
    dbStoreGet(STORE_KEY).then((rawDbItems) => {
      const dbItems = migrateReasonStatus(rawDbItems);
      if (Array.isArray(dbItems) && Array.isArray(localItems)) {
        if (localItems.length > dbItems.length) {
          setItems(localItems);
          dbStoreSet(STORE_KEY, localItems, { skipLog: true });
        } else {
          setItems(dbItems);
          localStorage.setItem(STORE_KEY, JSON.stringify(dbItems));
        }
      } else if (Array.isArray(dbItems)) {
        setItems(dbItems);
        localStorage.setItem(STORE_KEY, JSON.stringify(dbItems));
      } else if (Array.isArray(localItems) && localItems.length > 0) {
        dbStoreSet(STORE_KEY, localItems, { skipLog: true });
      }
      setLoaded(true);
    }).catch(() => setLoaded(true));
  }, []);

  const dbSaveWithRetry = useCallback(async (data) => {
    for (let i = 0; i < 3; i++) {
      const ok = await dbStoreSet(STORE_KEY, data, { logDesc: '보충 지연 원인 관리 수정' });
      if (ok) { setDbSyncFailed(false); return true; }
      await new Promise(r => setTimeout(r, 1000));
    }
    setDbSyncFailed(true);
    return false;
  }, []);

  const saveItems = useCallback((updated) => {
    setItems(updated);
    localStorage.setItem(STORE_KEY, JSON.stringify(updated));
    dbSaveWithRetry(updated);
  }, [dbSaveWithRetry]);

  // 발주장부를 읽어 '조치안됨' 자동 감지 (항목당 1회) — KST today 문자열을 인자로 받음
  const runAutoUnactioned = useCallback(async (todayStr) => {
    if (autoRunningRef.current) return;
    autoRunningRef.current = true;
    try {
      const res = await fetch(ORDERBOOK_URL);
      if (!res.ok) throw new Error('발주장부 로드 실패');
      const rows = parseCSV(await res.text());
      // 발주번호(T열) → 출고완료/인천도착 여부
      const shippedSet = new Set(); // 출고완료 또는 인천도착인 발주번호
      const ledgerSet = new Set();  // 발주장부에 존재하는 발주번호
      for (let i = 1; i < rows.length; i++) {
        const key = normOrder(rows[i][OB_ORDERNO_COL]);
        if (!key) continue;
        ledgerSet.add(key);
        const ship = (rows[i][OB_SHIPSTATUS_COL] || '').replace(/\s+/g, '');
        if (ship.includes('출고완료') || ship.includes('인천도착')) shippedSet.add(key);
      }
      const cur = itemsRef.current;
      let count = 0;
      const next = cur.map(it => {
        if (it.closed || it.autoUnactionedApplied) return it;
        if (!it.releaseReqDate) return it;
        if (todayStr <= it.releaseReqDate) return it; // 아직 기한 안 지남
        const key = normOrder(it.orderNo);
        if (!ledgerSet.has(key)) return it;          // 발주장부에 없으면 판단 보류
        if (shippedSet.has(key)) return it;          // 출고완료/인천도착이면 제외
        count++;
        return { ...it, progressStatus: '조치안됨', autoUnactionedApplied: true };
      });
      if (count > 0) saveItems(next);
      const info = { date: todayStr, count };
      localStorage.setItem(AUTORUN_KEY, JSON.stringify(info));
      if (count > 0) setAutoDetectInfo(info);
    } catch { /* 실패 시 다음 접속에서 재시도 (lastRun 미기록) */ }
    finally { autoRunningRef.current = false; }
  }, [saveItems]);

  // === 새로고침: 발주장부(실제출고일·인천도착일) + 품절현황(품절시작일)을 비어있는 항목에만 1회 채움 ===
  // (한번 채워진 값은 유지 — 스프레드시트/품절현황이 바뀌어도 자동 변경 안 함. 수동 수정은 가능)
  const handleRefresh = useCallback(async () => {
    if (refreshing) return;
    setRefreshing(true);
    setRefreshMsg('');
    try {
      // 1) 발주장부: 발주번호 → 실제 출고일(K), 인천 실제 도착일(L)
      const shipMap = new Map();
      const incheonMap = new Map();
      try {
        const res = await fetch(ORDERBOOK_URL);
        if (res.ok) {
          const rows = parseCSV(await res.text());
          for (let i = 1; i < rows.length; i++) {
            const rawOrder = rows[i][OB_ORDERNO_COL];
            const key = normOrder(rawOrder);
            if (!key) continue;
            const ref = parseOrderDate(rawOrder);
            const ship = normalizeShipDate(rows[i][OB_ACTUALSHIP_COL], ref);
            if (ship && !shipMap.has(key)) shipMap.set(key, ship);
            const inc = normalizeShipDate(rows[i][OB_INCHEON_COL], ref);
            if (inc && !incheonMap.has(key)) incheonMap.set(key, inc);
          }
        }
      } catch { /* 발주장부 실패해도 품절현황은 시도 */ }

      // 2) 품절현황: 최근 일자별 캐시를 역순 스캔하여 최신 캐시 확보 (주말 미집계 대비)
      //    바코드 → 품절이 시작된 날짜(trackerSnapshot.startDate, 품절위기 제외)
      const soldoutMap = new Map();
      for (let back = 0; back < 10; back++) {
        let cached = null;
        try { cached = await dbStoreGet(`${SOLDOUT_CACHE_PREFIX}${kstDateKey(back)}`); } catch { cached = null; }
        if (!cached || !Array.isArray(cached.items)) continue;
        const trk = cached.trackerSnapshot || {};
        for (const it of cached.items) {
          if (it.riskLevel !== '품절') continue; // 품절 제외/실제 품절 모두 riskLevel '품절', 품절위기만 제외
          const bc = (it.barcode || '').trim();
          if (!bc) continue;
          const s = normDateKey(trk[it.optionId]?.startDate);
          if (!s) continue;
          if (!soldoutMap.has(bc) || s < soldoutMap.get(bc)) soldoutMap.set(bc, s);
        }
        break; // 가장 최신 캐시 하나만 사용
      }

      // 3) 비어있는 항목만 채움
      const cur = itemsRef.current;
      let cShip = 0, cInc = 0, cSold = 0;
      const next = cur.map(it => {
        let out = it;
        const okey = normOrder(it.orderNo);
        // 실제 출고일
        if (!out.actualShipDate) {
          const d = shipMap.get(okey);
          if (d) { out = { ...out, actualShipDate: d }; cShip++; }
        }
        // 인천 도착일
        if (!out.incheonArriveDate) {
          const d = incheonMap.get(okey);
          if (d) { out = { ...out, incheonArriveDate: d }; cInc++; }
        }
        // 품절 시작일 (진행중 = 종결 아님, 비어있을 때만)
        if (!out.closed && !out.soldoutDate) {
          const s = soldoutMap.get((out.barcode || '').trim());
          if (s) {
            const orderOk = !out.orderDate || out.orderDate < s;          // 발주일 이후에 품절 시작
            const limit = out.incheonArriveDate ? addDays(out.incheonArriveDate, 3) : '';
            const withinLimit = !limit || s <= limit;                     // 인천도착일 있으면 +3일 이내
            if (orderOk && withinLimit) { out = { ...out, soldoutDate: s }; cSold++; }
          }
        }
        return out;
      });
      if (cShip + cInc + cSold > 0) saveItems(next);
      setRefreshMsg(`실제출고일 ${cShip} · 인천도착일 ${cInc} · 품절시작일 ${cSold}건 갱신`);
    } catch {
      setRefreshMsg('새로고침 실패 — 잠시 후 다시 시도하세요.');
    } finally {
      setRefreshing(false);
    }
  }, [refreshing, saveItems]);

  // KST 11시 이후 첫 접속 시 하루 1회 자동감지 실행
  useEffect(() => {
    if (!loaded) return;
    const check = () => {
      const today = kstToday();
      if (kstNow().getHours() < 11) return;      // 아직 11시 이전
      let last = null;
      try { last = JSON.parse(localStorage.getItem(AUTORUN_KEY) || 'null'); } catch { /* ignore */ }
      if (last && last.date === today) return;    // 오늘 이미 실행함
      runAutoUnactioned(today);
    };
    check();
    const timer = setInterval(check, 5 * 60 * 1000); // 5분마다 재확인 (11시 전 접속 대비)
    return () => clearInterval(timer);
  }, [loaded, runAutoUnactioned]);

  // === 자동 종결: 종결 알림 뜬 항목(미종결·인천도착일+4일 경과)을 규칙에 따라 자동 분류·종결 ===
  // 새로고침(로드) 시 1회 실행. 진행상태와 무관하게 기준에 따라 분류(사유는 R5로 기존 것 유지, 진행상태는 덮어씀). 항목당 1회(autoClosedApplied).
  useEffect(() => {
    if (!loaded) return;
    const today = kstToday();
    const cur = itemsRef.current;
    let count = 0;
    const next = cur.map(it => {
      if (it.closed || it.autoClosedApplied) return it;       // 이미 종결/처리됨
      if (!it.incheonArriveDate || !(today > addDays(it.incheonArriveDate, 4))) return it; // 알림 대상 아님
      const cls = classifyAutoClose(it);
      if (!cls) return it;                                     // 2f 미분류 → 알림 유지, 처리 안 함
      count++;
      return { ...it, ...cls, autoClosedApplied: true, closed: true, closedAt: new Date().toISOString() };
    });
    if (count > 0) {
      saveItems(next);
      setAutoCloseInfo({ count });
    }
  }, [loaded, saveItems]);

  const suggestions = useMemo(() => {
    if (!productSearch || productSearch.length < 1) return [];
    const q = productSearch.toLowerCase();
    return productList.filter(p =>
      p.productName.toLowerCase().includes(q) || p.barcode.toLowerCase().includes(q)
    ).slice(0, 15);
  }, [productSearch, productList]);

  const selectProduct = (product) => {
    setForm(prev => ({ ...prev, productName: product.productName, barcode: product.barcode, optionName: product.optionName || '' }));
    setProductSearch(product.productName);
    setShowSuggestions(false);
  };

  const filtered = useMemo(() => {
    let rows;
    if (filterReason === '종결') rows = items.filter(r => r.closed);
    else {
      rows = items.filter(r => !r.closed);
      if (filterReason === '확인중' || filterReason === '지장없음' || filterReason === '독촉완료' || filterReason === '조치안됨' || filterReason === '품절됨') rows = rows.filter(r => getProgress(r) === filterReason);
    }
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      rows = rows.filter(r =>
        (r.productName || '').toLowerCase().includes(q) ||
        (r.optionName || '').toLowerCase().includes(q) ||
        (r.barcode || '').toLowerCase().includes(q) ||
        (r.orderNo || '').toLowerCase().includes(q) ||
        (r.reasonDetail || '').toLowerCase().includes(q)
      );
    }
    const activeDates = Object.entries(dateFilters).filter(([, v]) => v);
    if (activeDates.length) {
      rows = rows.filter(r => activeDates.every(([f, v]) => (r[f] || '') === v));
    }
    return rows;
  }, [items, filterReason, searchQuery, dateFilters]);

  // 날짜 필터 드롭다운: 스크롤/리사이즈 시 닫기 (fixed 위치가 헤더에서 분리되는 것 방지)
  useEffect(() => {
    if (!openDateMenu) return;
    const close = () => setOpenDateMenu(null);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [openDateMenu]);

  const canSubmit = form.barcode.trim() && form.confirmDate;

  const resetForm = () => {
    setForm(emptyForm);
    setProductSearch('');
    setShowForm(false);
  };

  const handleAdd = () => {
    if (!canSubmit) return;
    const newItem = {
      ...form,
      id: Date.now().toString(),
      timeline: [],
      createdAt: new Date().toISOString(),
    };
    saveItems([newItem, ...items]);
    resetForm();
  };

  const handleDelete = (id) => {
    if (!confirm('삭제하시겠습니까?')) return;
    saveItems(items.filter(i => i.id !== id));
    setSelectedIds(prev => prev.filter(x => x !== id));
  };

  // 체크박스 선택
  const toggleSelect = (id) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const changeFilter = (key) => { setFilterReason(key); setSelectedIds([]); };

  // 일괄 종결 / 종결 해제
  const handleBulkClose = () => {
    if (selectedIds.length === 0) return;
    const closing = filterReason !== '종결';
    const msg = closing
      ? `선택한 ${selectedIds.length}건을 종결 처리할까요? (목록에서 숨겨집니다)`
      : `선택한 ${selectedIds.length}건의 종결을 해제할까요?`;
    if (!confirm(msg)) return;
    saveItems(items.map(i => selectedIds.includes(i.id)
      ? { ...i, closed: closing, closedAt: closing ? new Date().toISOString() : null }
      : i));
    setSelectedIds([]);
  };

  // 선택 일괄 삭제
  const handleBulkDelete = () => {
    if (selectedIds.length === 0) return;
    if (!confirm(`선택한 ${selectedIds.length}건을 삭제할까요? (되돌릴 수 없습니다)`)) return;
    saveItems(items.filter(i => !selectedIds.includes(i.id)));
    setSelectedIds([]);
  };

  // 엑셀 다운로드 (현재 필터/검색 결과 기준)
  const handleExcelDownload = () => {
    if (filtered.length === 0) {
      alert('다운로드할 데이터가 없습니다.');
      return;
    }
    const rows = filtered.map(it => ({
      '진행상태': it.closed ? '종결' : getProgress(it),
      '발주번호': it.orderNo || '',
      '상품명': it.productName || '',
      '옵션명': it.optionName || '',
      '바코드': it.barcode || '',
      '발주일': it.orderDate || '',
      '확인일': it.confirmDate || '',
      '업체발송예정일': it.shipEtaDate || '',
      'CN출고요청일': it.releaseReqDate || '',
      '실제출고일': it.actualShipDate || '',
      '인천도착일': it.incheonArriveDate || '',
      '품절시작일': it.soldoutDate || '',
      '사유상태': it.reasonStatus || '',
      '자세한사유': it.reasonDetail || '',
      '조치내용': (it.timeline || []).map(t => `[${t.date}] ${t.text}`).join('\n'),
    }));
    const header = ['진행상태', '발주번호', '상품명', '옵션명', '바코드', '발주일', '확인일', '업체발송예정일', 'CN출고요청일', '실제출고일', '인천도착일', '품절시작일', '사유상태', '자세한사유', '조치내용'];
    const ws = XLSX.utils.json_to_sheet(rows, { header });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '보충지연원인');
    XLSX.writeFile(wb, `보충지연원인_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  // 업로드 양식(템플릿) 다운로드
  const handleTemplateDownload = () => {
    const rows = [
      { '발주번호': 'AE-E-260720-JJ-002', '바코드': '8801234567890' },
      { '발주번호': '', '바코드': '' },
    ];
    const ws = XLSX.utils.json_to_sheet(rows, { header: ['발주번호', '바코드'] });
    ws['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 8 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '업로드양식');
    XLSX.writeFile(wb, '보충지연원인_업로드양식.xlsx');
  };

  // 엑셀 업로드 (발주번호·바코드) → 일괄 신규 등록 (발주일/확인일 자동, 진행상태 확인중)
  const handleExcelUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = ''; // 같은 파일 재선택 가능하도록 초기화
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (!rows.length) { alert('빈 파일입니다.'); return; }
      const header = rows[0].map(h => String(h).replace(/\s+/g, ''));
      const idxOrderNo = header.findIndex(h => h.includes('발주번호') || h.includes('발주'));
      const idxBarcode = header.findIndex(h => h.includes('바코드'));
      if (idxOrderNo < 0 || idxBarcode < 0) {
        alert('첫 행 헤더에 발주번호 · 바코드 열이 있어야 합니다.');
        return;
      }
      const pmap = {};
      for (const p of productList) { if (p.barcode) pmap[p.barcode] = p; }
      const today = kstToday();
      // 발주번호 중복 판정용: 기존 테이블 + 파일 내 이미 처리한 발주번호
      const existingOrderSet = new Set(items.map(i => normOrder(i.orderNo)).filter(Boolean));
      const seenOrderSet = new Set();
      const newItems = [];
      let skippedNoBarcode = 0;
      let skippedDup = 0;
      for (let i = 1; i < rows.length; i++) {
        const r = rows[i];
        const barcode = String(r[idxBarcode] ?? '').trim();
        const orderNo = String(r[idxOrderNo] ?? '').trim();
        if (!barcode) { if (orderNo) skippedNoBarcode++; continue; }
        const okey = normOrder(orderNo);
        if (okey && (existingOrderSet.has(okey) || seenOrderSet.has(okey))) { skippedDup++; continue; }
        if (okey) seenOrderSet.add(okey);
        const prod = pmap[barcode] || {};
        newItems.push({
          ...emptyForm,
          barcode,
          productName: prod.productName || '',
          optionName: prod.optionName || '',
          orderNo,
          orderDate: parseOrderDate(orderNo),
          confirmDate: today,
          progressStatus: '확인중',
          id: `${Date.now()}_${i}`,
          timeline: [],
          createdAt: new Date().toISOString(),
        });
      }
      if (!newItems.length) { alert(`등록할 데이터가 없습니다. (바코드 없음 ${skippedNoBarcode}건, 발주번호 중복 ${skippedDup}건)`); return; }
      saveItems([...newItems, ...items]);
      const skipParts = [];
      if (skippedDup) skipParts.push(`발주번호 중복 ${skippedDup}건`);
      if (skippedNoBarcode) skipParts.push(`바코드 없음 ${skippedNoBarcode}건`);
      alert(`${newItems.length}건 일괄 등록 완료${skipParts.length ? ` (${skipParts.join(', ')} 건너뜀)` : ''}`);
    } catch (err) {
      console.error(err);
      alert('엑셀 처리 중 오류가 발생했습니다.');
    }
  };

  // 발주번호 텍스트 붙여넣기 → 매칭 카드 진행상태를 '독촉완료'로 변경 (확인일도 오늘로)
  const normOrderNo = (s) => (s || '').trim().toUpperCase();
  const handleApplyUrge = () => {
    const parsed = (urgeText.match(/[A-Za-z]{1,4}(?:-[A-Za-z0-9]+){2,}/g) || []).map(normOrderNo);
    const uniq = [...new Set(parsed)];
    if (uniq.length === 0) {
      setUrgeResult({ matched: [], unmatched: [], updated: 0 });
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const activeSet = new Set(items.filter(i => !i.closed).map(i => normOrderNo(i.orderNo)));
    const matched = uniq.filter(o => activeSet.has(o));
    const unmatched = uniq.filter(o => !activeSet.has(o));
    const matchedSet = new Set(matched);
    let updated = 0;
    const next = items.map(i => {
      if (!i.closed && matchedSet.has(normOrderNo(i.orderNo))) {
        updated++;
        return { ...i, progressStatus: '독촉완료', confirmDate: today };
      }
      return i;
    });
    if (updated > 0) saveItems(next);
    setUrgeResult({ matched, unmatched, updated });
  };

  // 발주번호 텍스트 붙여넣기 → 매칭 카드 CN출고요청일을 오늘+1일로 자동 입력
  const handleApplyShipReq = () => {
    const parsed = (shipReqText.match(/[A-Za-z]{1,4}(?:-[A-Za-z0-9]+){2,}/g) || []).map(normOrderNo);
    const uniq = [...new Set(parsed)];
    if (uniq.length === 0) {
      setShipReqResult({ matched: [], unmatched: [], updated: 0, date: '' });
      return;
    }
    const nextDay = kstTomorrow();
    const activeSet = new Set(items.filter(i => !i.closed).map(i => normOrderNo(i.orderNo)));
    const matched = uniq.filter(o => activeSet.has(o));
    const unmatched = uniq.filter(o => !activeSet.has(o));
    const matchedSet = new Set(matched);
    let updated = 0;
    const next = items.map(i => {
      if (!i.closed && matchedSet.has(normOrderNo(i.orderNo))) {
        updated++;
        return { ...i, releaseReqDate: nextDay };
      }
      return i;
    });
    if (updated > 0) saveItems(next);
    setShipReqResult({ matched, unmatched, updated, date: nextDay });
  };

  // 셀 인라인 수정
  const updateField = (id, field, value) => {
    saveItems(items.map(i => i.id === id ? { ...i, [field]: value } : i));
  };
  const startEdit = (id, field, val) => { setEditingCell({ id, field }); setEditValue(val ?? ''); };
  const commitEdit = () => {
    if (!editingCell) return;
    updateField(editingCell.id, editingCell.field, editValue);
    setEditingCell(null);
    setEditValue('');
  };

  // 타임라인
  const handleAddTimeline = (id) => {
    const text = (timelineInput[id] || '').trim();
    if (!text) return;
    const updated = items.map(i => {
      if (i.id !== id) return i;
      return { ...i, timeline: [...(i.timeline || []), { date: new Date().toISOString().slice(0, 16).replace('T', ' '), text }] };
    });
    saveItems(updated);
    setTimelineInput(prev => ({ ...prev, [id]: '' }));
  };
  const handleDeleteTimeline = (itemId, idx) => {
    if (!confirm('이 기록을 삭제하시겠습니까?')) return;
    saveItems(items.map(i => i.id === itemId ? { ...i, timeline: i.timeline.filter((_, k) => k !== idx) } : i));
  };
  const startEditTimeline = (itemId, idx, text) => { setEditingTL({ itemId, idx }); setEditingTLText(text); };
  const saveEditTimeline = () => {
    if (!editingTL) return;
    const text = editingTLText.trim();
    if (!text) { setEditingTL(null); return; }
    const { itemId, idx } = editingTL;
    saveItems(items.map(i => i.id === itemId ? { ...i, timeline: i.timeline.map((t, k) => k === idx ? { ...t, text } : t) } : i));
    setEditingTL(null);
    setEditingTLText('');
  };

  if (!loaded) {
    return (
      <div className="loading" style={{ padding: 80, flexDirection: 'column', gap: 12 }}>
        <div className="spinner" />
        <p>보충 지연 원인 데이터를 불러오는 중...</p>
      </div>
    );
  }

  const countAll = items.filter(r => !r.closed).length;
  const countPending = items.filter(r => !r.closed && getProgress(r) === '확인중').length;
  const countOk = items.filter(r => !r.closed && getProgress(r) === '지장없음').length;
  const countUrged = items.filter(r => !r.closed && getProgress(r) === '독촉완료').length;
  const countUnactioned = items.filter(r => !r.closed && getProgress(r) === '조치안됨').length;
  const countSoldout = items.filter(r => !r.closed && getProgress(r) === '품절됨').length;
  const countClosed = items.filter(r => r.closed).length;
  const viewingClosed = filterReason === '종결';

  const allSelected = filtered.length > 0 && filtered.every(i => selectedIds.includes(i.id));
  const toggleSelectAll = () => {
    if (allSelected) setSelectedIds(prev => prev.filter(id => !filtered.some(f => f.id === id)));
    else setSelectedIds(prev => [...new Set([...prev, ...filtered.map(f => f.id)])]);
  };

  // ---- 스타일 토큰 ----
  const labelStyle = { fontSize: 10.5, color: '#5f6368', display: 'block', marginBottom: 3, fontWeight: 500 };
  const reqLabelStyle = { ...labelStyle, color: '#d93025', fontWeight: 700 };
  const inputStyle = { width: '100%', minWidth: 'auto', padding: '6px 9px', fontSize: 12.5, height: 34, boxSizing: 'border-box' };
  const reqInputStyle = { ...inputStyle, border: '1.5px solid #f0b4b4', background: '#fffafa' };

  // 표 셀 표시/입력 스타일
  const cellDisplay = { display: 'block', padding: '9px 10px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', borderRadius: 4 };
  const cellInputStyle = { width: '100%', minWidth: 'auto', fontSize: 12, padding: '6px 8px', height: 32, boxSizing: 'border-box', border: '1.5px solid #1a73e8', borderRadius: 6, outline: 'none' };

  // 날짜 컬럼 필터: 해당 컬럼의 고유 날짜값 목록(최신순) + 건수
  const dateOptions = (field) => {
    const m = new Map();
    for (const it of items) { const v = it[field]; if (v) m.set(v, (m.get(v) || 0) + 1); }
    return [...m.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  };
  // 날짜 컬럼 헤더 (클릭 시 필터 드롭다운)
  const renderDateHeader = (field, label) => {
    const c = DATE_COLORS[field];
    const active = !!dateFilters[field];
    return (
      <th
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          setOpenDateMenu(prev => (prev && prev.field === field) ? null : { field, rect });
        }}
        style={{ color: c, borderBottom: `2px solid ${c}`, cursor: 'pointer', userSelect: 'none', background: active ? `${c}18` : undefined }}
        title="클릭하여 날짜 필터"
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          {label}
          <span style={{ fontSize: 8, opacity: active ? 1 : 0.45 }}>▼</span>
        </span>
      </th>
    );
  };

  // 클릭하여 수정되는 셀
  const renderCell = (item, field, type, big) => {
    if (field === 'reasonStatus' || field === 'progressStatus') {
      const isProg = field === 'progressStatus';
      const val = isProg ? getProgress(item) : (item.reasonStatus || '');
      const palette = isProg ? PROGRESS_COLORS : REASON_COLORS;
      const opts = isProg ? PROGRESS_STATUSES : REASON_STATUSES;
      const c = palette[val] || '#bbb';
      return (
        <select value={val} onChange={e => updateField(item.id, field, e.target.value)}
          onClick={e => e.stopPropagation()}
          style={{ width: '100%', padding: '5px 8px', fontSize: 11, fontWeight: 700, border: `1.5px solid ${c}`, borderRadius: 6, color: c, background: '#fff', cursor: 'pointer', appearance: 'none', WebkitAppearance: 'none', MozAppearance: 'none', textAlignLast: 'center' }}>
          {!isProg && <option value="" style={{ color: '#999' }}>*미선택</option>}
          {opts.map(s => <option key={s} value={s} style={{ color: '#333' }}>{isProg ? s : reasonLabel(s)}</option>)}
        </select>
      );
    }
    const editing = editingCell && editingCell.id === item.id && editingCell.field === field;
    if (editing) {
      const inputType = type === 'date' ? 'date' : type === 'number' ? 'number' : 'text';
      return (
        <input type={inputType} value={editValue}
          onChange={e => setEditValue(e.target.value)}
          onBlur={commitEdit}
          onClick={e => e.stopPropagation()}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commitEdit(); } else if (e.key === 'Escape') { setEditingCell(null); } }}
          ref={el => { if (el) { el.focus(); if (type === 'date') { try { el.showPicker && el.showPicker(); } catch { /* ignore */ } } } }}
          style={{ ...cellInputStyle, fontSize: big ? 13 : 12 }} />
      );
    }
    const raw = item[field];
    const empty = (raw ?? '') === '';
    const dateColor = DATE_COLORS[field];
    const wrap = field === 'productName' || field === 'reasonDetail';
    return (
      <span className="dc-editable" onClick={e => { e.stopPropagation(); startEdit(item.id, field, raw); }}
        title="클릭하여 수정"
        style={{
          ...cellDisplay,
          fontSize: big ? 13 : 12,
          color: empty ? '#c4c7cc' : (dateColor || '#333'),
          fontWeight: dateColor && !empty ? 600 : 400,
          textAlign: type === 'number' ? 'center' : 'left',
          whiteSpace: wrap ? 'normal' : 'nowrap',
          overflow: wrap ? 'visible' : 'hidden',
          textOverflow: wrap ? 'clip' : 'ellipsis',
          wordBreak: wrap ? 'break-word' : 'normal',
        }}>
        {empty ? '-' : raw}
      </span>
    );
  };

  return (
    <div>
      <style>{`
        .dc-table { width: 100%; border-collapse: collapse; background: #fff; }
        .dc-table th {
          padding: 11px 10px; font-size: 11.5px; font-weight: 700; color: #5f6368;
          background: #f4f6f8; border: 1px solid #e3e7eb; text-align: left;
          white-space: nowrap; letter-spacing: 0.2px;
          position: sticky; top: var(--dc-header-top, 108px); z-index: 5;
        }
        .dc-table td { border: 1px solid #eceff1; vertical-align: middle; padding: 0; }
        .dc-table td.dc-pad { padding: 5px 6px; }
        .dc-table tbody tr.dc-row:hover { background: #f8fafd; }
        .dc-editable { transition: background 0.12s, box-shadow 0.12s; }
        .dc-editable:hover { background: #eef4ff; box-shadow: inset 0 0 0 1.5px #cfe0ff; }
        .dc-del { color: #cfd3d6; cursor: pointer; font-size: 15px; transition: color 0.15s; }
        .dc-del:hover { color: #d93025; }
        .dc-select-wrap { position: relative; display: inline-block; }
        .dc-select-wrap select {
          appearance: none; -webkit-appearance: none; -moz-appearance: none;
          padding: 9px 36px 9px 14px; font-size: 13px; font-weight: 500; color: #333;
          border: 1px solid #d8dce0; border-radius: 10px; background: #fff; cursor: pointer;
          outline: none; box-shadow: 0 1px 2px rgba(0,0,0,0.04); min-width: 140px; transition: border-color 0.15s;
        }
        .dc-select-wrap select:focus { border-color: #1a73e8; }
        .dc-select-wrap .dc-arrow { position: absolute; right: 13px; top: 50%; transform: translateY(-50%); pointer-events: none; font-size: 9px; color: #888; }
        .dc-help { position: relative; display: inline-flex; align-items: center; gap: 5px; padding: 0 12px; height: 36px; border: 1.5px solid #d2e3fc; border-radius: 8px; background: #f7faff; color: #1a73e8; font-size: 13px; font-weight: 600; cursor: help; white-space: nowrap; }
        .dc-help .dc-help-tip { position: absolute; top: calc(100% + 8px); right: 0; z-index: 9999; width: 460px; padding: 16px 18px; background: #263238; color: #eceff1; border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,0.28); font-size: 12.5px; font-weight: 400; line-height: 1.7; white-space: pre-line; text-align: left; opacity: 0; visibility: hidden; transform: translateY(-4px); transition: opacity 0.15s, transform 0.15s; }
        .dc-help:hover .dc-help-tip { opacity: 1; visibility: visible; transform: translateY(0); }
        .dc-help-tip b { color: #ffd54f; font-weight: 700; }
      `}</style>

      {dbSyncFailed && (
        <div style={{ marginBottom: 16, background: '#fdedeb', border: '1px solid #ef5350', borderRadius: 12, padding: 16, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontWeight: 600, fontSize: 14, color: '#c62828' }}>
            DB 저장 실패 — 현재 로컬에만 저장됨. 다른 컴퓨터에서 보이지 않을 수 있습니다.
          </span>
          <button className="btn btn-sm" style={{ fontSize: 12, background: '#c62828', color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px' }}
            onClick={() => dbSaveWithRetry(items)}>재시도</button>
        </div>
      )}

      {/* 툴바 */}
      <div ref={filterCardRef} className="card" style={{ marginBottom: 16, overflow: 'visible', position: 'sticky', top: 40, zIndex: 30 }}>
        <div className="card-body" style={{ padding: 16 }}>
          <div className="filter-bar" style={{ flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 0 }}>
            <input className="search-input" placeholder="상품명, 옵션명, 바코드, 발주번호, 사유 검색..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)} style={{ maxWidth: 260 }} />
            {/* 상태 카드 필터 */}
            <div style={{ display: 'flex', gap: 8 }}>
              {[
                { key: 'all', label: '전체', count: countAll, color: '#5f6368' },
                { key: '확인중', label: '확인중', count: countPending, color: PROGRESS_COLORS['확인중'] },
                { key: '지장없음', label: '지장없음', count: countOk, color: PROGRESS_COLORS['지장없음'] },
                { key: '독촉완료', label: '독촉완료', count: countUrged, color: PROGRESS_COLORS['독촉완료'] },
                { key: '조치안됨', label: '조치안됨', count: countUnactioned, color: PROGRESS_COLORS['조치안됨'] },
                { key: '품절됨', label: '품절됨', count: countSoldout, color: PROGRESS_COLORS['품절됨'] },
                { key: '종결', label: '종결', count: countClosed, color: CLOSED_COLOR },
              ].map(c => {
                const active = filterReason === c.key;
                return (
                  <button key={c.key} onClick={() => changeFilter(c.key)}
                    style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '7px 14px', border: `1.5px solid ${active ? c.color : '#e0e0e0'}`, borderRadius: 10, background: active ? c.color : '#fff', color: active ? '#fff' : '#5f6368', cursor: 'pointer', fontSize: 13, fontWeight: 600, transition: 'all 0.15s', boxShadow: active ? `0 2px 6px ${c.color}55` : '0 1px 2px rgba(0,0,0,0.04)' }}>
                    {c.label}
                    <span style={{ fontSize: 12, fontWeight: 700, minWidth: 18, textAlign: 'center', padding: '1px 6px', borderRadius: 8, background: active ? 'rgba(255,255,255,0.25)' : '#f1f3f4', color: active ? '#fff' : c.color }}>{c.count}</span>
                  </button>
                );
              })}
            </div>
            {autoDetectInfo && autoDetectInfo.count > 0 && (
              <button onClick={() => changeFilter('조치안됨')}
                title="오늘 자동 감지된 조치안됨 건 보기"
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: `1.5px solid ${PROGRESS_COLORS['조치안됨']}`, borderRadius: 10, background: '#fff3e0', color: '#e65100', cursor: 'pointer', fontSize: 13, fontWeight: 700, boxShadow: '0 1px 3px rgba(230,81,0,0.15)' }}>
                🔔 조치안됨 감지 {autoDetectInfo.count}건
              </button>
            )}
            {autoCloseInfo && autoCloseInfo.count > 0 && (
              <button onClick={() => changeFilter('종결')}
                title="이번 접속에서 자동 종결된 건 보기"
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 14px', border: `1.5px solid ${CLOSED_COLOR}`, borderRadius: 10, background: '#e8eaf6', color: CLOSED_COLOR, cursor: 'pointer', fontSize: 13, fontWeight: 700, boxShadow: '0 1px 3px rgba(48,63,159,0.15)' }}>
                🔒 자동 종결 {autoCloseInfo.count}건
              </button>
            )}
            {selectedIds.length > 0 && (
              <button className="btn" onClick={handleBulkClose}
                style={{ background: viewingClosed ? '#fff' : '#1e8e3e', color: viewingClosed ? '#1e8e3e' : '#fff', border: viewingClosed ? '1.5px solid #1e8e3e' : 'none', fontWeight: 600 }}>
                선택 {selectedIds.length}건 {viewingClosed ? '종결 해제' : '종결'}
              </button>
            )}
            {selectedIds.length > 0 && (
              <button className="btn" onClick={handleBulkDelete}
                style={{ background: '#c62828', color: '#fff', border: 'none', fontWeight: 600 }}>
                선택 {selectedIds.length}건 삭제
              </button>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              {refreshMsg && <span style={{ fontSize: 12, color: '#5f6368', fontWeight: 600 }}>{refreshMsg}</span>}
              <button className="btn" onClick={() => setShowShipReqPanel(v => !v)}
                style={{ background: showShipReqPanel ? '#fff' : '#6a1b9a', color: showShipReqPanel ? '#6a1b9a' : '#fff', border: showShipReqPanel ? '1.5px solid #6a1b9a' : 'none', fontWeight: 600 }}>
                {showShipReqPanel ? '닫기' : '출고요청 업로드'}
              </button>
              <button className="btn" onClick={() => setShowUrgePanel(v => !v)}
                style={{ background: showUrgePanel ? '#fff' : '#0097a7', color: showUrgePanel ? '#0097a7' : '#fff', border: showUrgePanel ? '1.5px solid #0097a7' : 'none', fontWeight: 600 }}>
                {showUrgePanel ? '닫기' : '독촉완료 업로드'}
              </button>
              <button className="btn" onClick={handleExcelDownload}
                style={{ background: '#1e8e3e', color: '#fff', border: 'none', fontWeight: 600 }}>
                엑셀 다운로드
              </button>
              <input ref={fileInputRef} type="file" accept=".xlsx,.xls" onChange={handleExcelUpload} style={{ display: 'none' }} />
              <button className="btn" onClick={() => fileInputRef.current?.click()}
                style={{ background: '#fff', color: '#1e8e3e', border: '1.5px solid #1e8e3e', fontWeight: 600 }}
                title="발주번호·바코드 열이 있는 엑셀을 올리면 일괄 등록됩니다. 양식이 필요하면 '양식' 버튼을 받으세요.">
                엑셀 업로드
              </button>
              <button className="btn" onClick={handleTemplateDownload}
                style={{ background: 'transparent', color: '#5f6368', border: '1px dashed #bdbdbd', fontWeight: 600, fontSize: 12.5 }}
                title="발주번호·바코드 헤더가 든 빈 엑셀 양식 다운로드">
                양식
              </button>
              <button className="btn btn-primary" onClick={() => { if (showForm) { resetForm(); } else { setForm(emptyForm); setProductSearch(''); setShowForm(true); } }}>
                {showForm ? '닫기' : '+ 새 항목'}
              </button>
              <span className="dc-help" style={{ color: '#d32f2f', fontWeight: 800, fontSize: 17, cursor: 'help', border: 'none', background: 'transparent', padding: '0 6px', height: 36 }}>
                ?
                <span className="dc-help-tip">
                  <b>[CN 귀책]</b>{'\n'}
                  1. 작업 지연 : 독촉O → 작업X{'\n'}
                  ex) 봉제 등 작업량 많아서 출고가 누락된 경우{'\n'}
                  2. 작업 지연 : 독촉O → 확인X{'\n'}
                  ex) 사이즈실측 OR 출고 요청 했지만 답변 늦는 경우{'\n\n'}
                  <b>[업체 귀책]</b>{'\n'}
                  3. 업체 발송지연 : 독촉O → 발송X → 재수배O{'\n'}
                  ex) 독촉 했지만 보내준다고 해놓고 발송부터가 늦어져서 재수배도 늦어진 경우(업체가 약속 안지킴){'\n\n'}
                  <b>[SCM 귀책]</b>{'\n'}
                  4. 재수배 지연 : 독촉O → 발송X → 재수배X{'\n'}
                  ex) 독촉 했지만, 발송 안해준다고 답변 바로 들었지만, 빠른 조치 안해둔 경우{'\n'}
                  5. 조치 지연 : 독촉X{'\n'}
                  ex) 늦게 오는것 확인 안해서 독촉도 안되있는 경우{'\n\n'}
                  <b>[불가피 사유]</b>{'\n'}
                  6. 판매량 증가 : 발주일 전엔 재고 충분 → 갑자기 판매량 증가 → 급히 발주하게 되어 리드타임 내 도착 불가{'\n'}
                  7. 운송 지연 : 재수배 해봤지만, 이 업체가 유일 + 내륙 운송 기간이 3일 이상인 경우
                </span>
              </span>
              <button className="btn" onClick={handleRefresh} disabled={refreshing}
                title="발주장부에서 실제출고일·인천도착일, 품절현황에서 품절시작일을 비어있는 항목에만 가져옵니다."
                style={{ background: refreshing ? '#eceff1' : '#0b5cad', color: refreshing ? '#9aa0a6' : '#fff', border: 'none', fontWeight: 600, cursor: refreshing ? 'default' : 'pointer', padding: '7px 12px' }}>
                {refreshing ? '⟳' : '↻'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* 출고요청 일괄 업로드 패널 */}
      {showShipReqPanel && (
        <div className="card" style={{ marginBottom: 16, border: '1px solid #e1bee7', boxShadow: '0 2px 10px rgba(106,27,154,0.10)' }}>
          <div className="card-header" style={{ background: '#faf5fc', borderBottom: '1px solid #f0e2f5' }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: '#6a1b9a' }}>출고요청 일괄 업로드</h2>
            <span style={{ fontSize: 11.5, color: '#5f6368' }}>발주번호를 붙여넣으면, 테이블에 있는 항목의 <b style={{ color: '#6a1b9a' }}>CN출고요청일</b>이 오늘의 다음 날(<b style={{ color: '#6a1b9a' }}>{kstTomorrow()}</b>)로 자동 입력됩니다.</span>
          </div>
          <div className="card-body" style={{ paddingTop: 12 }}>
            <textarea className="search-input"
              placeholder={'발주번호를 줄단위로 붙여넣으세요. (머리글 [ ... ] 줄은 자동 무시)\n예)\n[출고 요청]\nAE-E-260720-JJ-002\nAE-R-260720-JJ-003'}
              value={shipReqText}
              onChange={e => setShipReqText(e.target.value)}
              style={{ width: '100%', minHeight: 130, resize: 'vertical', fontFamily: 'monospace', fontSize: 12.5, lineHeight: 1.6, boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <button className="btn" onClick={handleApplyShipReq}
                style={{ background: '#6a1b9a', color: '#fff', border: 'none', fontWeight: 600 }}>
                출고요청일 적용
              </button>
              <button className="btn" onClick={() => { setShipReqText(''); setShipReqResult(null); }}
                style={{ background: '#fff', color: '#5f6368', border: '1.5px solid #e0e0e0', fontWeight: 600 }}>
                초기화
              </button>
            </div>
            {shipReqResult && (
              <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 10, background: '#f7f9fa', border: '1px solid #e6eaed', fontSize: 13 }}>
                <div style={{ fontWeight: 700, color: '#6a1b9a', marginBottom: shipReqResult.unmatched.length ? 6 : 0 }}>
                  적용 완료 — {shipReqResult.updated}건 CN출고요청일 {shipReqResult.date} 입력 (인식 {shipReqResult.matched.length + shipReqResult.unmatched.length}건 중 매칭 {shipReqResult.matched.length}건)
                </div>
                {shipReqResult.unmatched.length > 0 && (
                  <div style={{ color: '#c62828', lineHeight: 1.7 }}>
                    <b>미매칭 {shipReqResult.unmatched.length}건</b> (테이블에 없음): <span style={{ fontFamily: 'monospace' }}>{shipReqResult.unmatched.join(', ')}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 독촉완료 일괄 업로드 패널 */}
      {showUrgePanel && (
        <div className="card" style={{ marginBottom: 16, border: '1px solid #b2ebf2', boxShadow: '0 2px 10px rgba(0,151,167,0.10)' }}>
          <div className="card-header" style={{ background: '#f0fbfc', borderBottom: '1px solid #d5f2f5' }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: '#00838f' }}>독촉완료 일괄 업로드</h2>
            <span style={{ fontSize: 11.5, color: '#5f6368' }}>발주번호를 붙여넣으면, 테이블에 있는 항목의 진행상태가 <b style={{ color: '#00838f' }}>독촉완료</b>로 변경되고 확인일(조치일)이 오늘로 갱신됩니다.</span>
          </div>
          <div className="card-body" style={{ paddingTop: 12 }}>
            <textarea className="search-input"
              placeholder={'발주번호를 줄단위로 붙여넣으세요. (머리글 [ ... ] 줄은 자동 무시)\n예)\n[발송 독촉 요청]\nAE-E-260720-JJ-002\nAE-R-260720-JJ-003'}
              value={urgeText}
              onChange={e => setUrgeText(e.target.value)}
              style={{ width: '100%', minHeight: 130, resize: 'vertical', fontFamily: 'monospace', fontSize: 12.5, lineHeight: 1.6, boxSizing: 'border-box' }} />
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 10 }}>
              <button className="btn" onClick={handleApplyUrge}
                style={{ background: '#0097a7', color: '#fff', border: 'none', fontWeight: 600 }}>
                독촉완료 적용
              </button>
              <button className="btn" onClick={() => { setUrgeText(''); setUrgeResult(null); }}
                style={{ background: '#fff', color: '#5f6368', border: '1.5px solid #e0e0e0', fontWeight: 600 }}>
                초기화
              </button>
            </div>
            {urgeResult && (
              <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 10, background: '#f7f9fa', border: '1px solid #e6eaed', fontSize: 13 }}>
                <div style={{ fontWeight: 700, color: '#00838f', marginBottom: urgeResult.unmatched.length ? 6 : 0 }}>
                  적용 완료 — {urgeResult.updated}건 독촉완료 처리 (인식 {urgeResult.matched.length + urgeResult.unmatched.length}건 중 매칭 {urgeResult.matched.length}건)
                </div>
                {urgeResult.unmatched.length > 0 && (
                  <div style={{ color: '#c62828', lineHeight: 1.7 }}>
                    <b>미매칭 {urgeResult.unmatched.length}건</b> (테이블에 없음): <span style={{ fontFamily: 'monospace' }}>{urgeResult.unmatched.join(', ')}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {/* 등록 폼 */}
      {showForm && (
        <div className="card" style={{ marginBottom: 16, border: '1px solid #d2e3fc', boxShadow: '0 2px 10px rgba(26,115,232,0.10)' }}>
          <div className="card-header" style={{ background: '#f7faff', borderBottom: '1px solid #e6eefc' }}>
            <h2 style={{ fontSize: 15, fontWeight: 700, color: '#1a73e8' }}>새 보충 지연 항목 등록</h2>
            <span style={{ fontSize: 11, color: '#d93025', fontWeight: 600 }}>* 필수 입력</span>
          </div>
          <div className="card-body" style={{ paddingTop: 12 }}>
            {/* 1줄: 상품명 · 바코드 · 옵션명 · 발주번호 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(170px,1.7fr) 1fr 0.85fr 1fr', gap: 10, marginBottom: 10 }}>
              <div style={{ position: 'relative' }}>
                <label style={reqLabelStyle}>상품 * (상품명·바코드 검색)</label>
                <input className="search-input" placeholder="상품명·바코드 검색..." value={productSearch}
                  onChange={e => { setProductSearch(e.target.value); setShowSuggestions(true); setForm(p => ({ ...p, productName: e.target.value, barcode: '', optionName: '' })); }}
                  onFocus={() => setShowSuggestions(true)}
                  onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                  style={reqInputStyle} />
                {showSuggestions && suggestions.length > 0 && (
                  <div style={{ position: 'absolute', top: '100%', left: 0, right: 0, background: '#fff', border: '1px solid #ddd', borderRadius: 8, maxHeight: 200, overflow: 'auto', zIndex: 100, boxShadow: '0 4px 12px rgba(0,0,0,0.15)', marginTop: 4 }}>
                    {suggestions.map((p, idx) => (
                      <div key={idx} style={{ padding: '8px 12px', cursor: 'pointer', borderBottom: '1px solid #f0f0f0', fontSize: 12 }}
                        onMouseDown={() => selectProduct(p)}>
                        <div style={{ fontWeight: 500 }}>{p.productName}</div>
                        <div style={{ color: '#999', fontSize: 11, fontFamily: 'monospace' }}>{p.barcode}{p.optionName ? ` · ${p.optionName}` : ''}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              <div>
                <label style={reqLabelStyle}>바코드 *</label>
                <input className="search-input" value={form.barcode} onChange={e => setForm(p => ({ ...p, barcode: e.target.value }))} style={reqInputStyle} placeholder="바코드" />
              </div>
              <div>
                <label style={labelStyle}>옵션명</label>
                <input className="search-input" value={form.optionName} onChange={e => setForm(p => ({ ...p, optionName: e.target.value }))} style={inputStyle} placeholder="옵션" />
              </div>
              <div>
                <label style={labelStyle}>발주번호</label>
                <input className="search-input" value={form.orderNo}
                  onChange={e => { const v = e.target.value; setForm(p => ({ ...p, orderNo: v, orderDate: parseOrderDate(v) || p.orderDate })); }}
                  style={inputStyle} placeholder="AE-I-260529" />
              </div>
            </div>

            {/* 2줄: 발주일 · 확인일 · 발송예정일 · 출고요청일 · 인천도착일 · 품절일 */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 10 }}>
              <div>
                <label style={labelStyle}>발주일 (자동 인식)</label>
                <input type="date" className="search-input" value={form.orderDate} onChange={e => setForm(p => ({ ...p, orderDate: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={reqLabelStyle}>확인일(조치일) *</label>
                <input type="date" className="search-input" value={form.confirmDate} onChange={e => setForm(p => ({ ...p, confirmDate: e.target.value }))} style={reqInputStyle} />
              </div>
              <div>
                <label style={labelStyle}>업체 발송예정일</label>
                <input type="date" className="search-input" value={form.shipEtaDate} onChange={e => setForm(p => ({ ...p, shipEtaDate: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>CN출고요청일</label>
                <input type="date" className="search-input" value={form.releaseReqDate} onChange={e => setForm(p => ({ ...p, releaseReqDate: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>인천도착일</label>
                <input type="date" className="search-input" value={form.incheonArriveDate} onChange={e => setForm(p => ({ ...p, incheonArriveDate: e.target.value }))} style={inputStyle} />
              </div>
              <div>
                <label style={labelStyle}>품절시작일</label>
                <input type="date" className="search-input" value={form.soldoutDate} onChange={e => setForm(p => ({ ...p, soldoutDate: e.target.value }))} style={inputStyle} />
              </div>
            </div>

            {/* 3줄: 사유상태 · 진행상태 · 자세한 사유 */}
            <div style={{ display: 'grid', gridTemplateColumns: '170px 170px 1fr', gap: 10 }}>
              <div>
                <label style={labelStyle}>사유 상태 (선택)</label>
                <div className="dc-select-wrap" style={{ display: 'block' }}>
                  <select value={form.reasonStatus} onChange={e => setForm(p => ({ ...p, reasonStatus: e.target.value }))} style={{ width: '100%', padding: '6px 34px 6px 12px', fontSize: 12.5 }}>
                    <option value="">*미선택</option>
                    {REASON_STATUSES.map(s => <option key={s} value={s}>{reasonLabel(s)}</option>)}
                  </select>
                  <span className="dc-arrow">▼</span>
                </div>
              </div>
              <div>
                <label style={reqLabelStyle}>진행상태 *</label>
                <div className="dc-select-wrap" style={{ display: 'block' }}>
                  <select value={form.progressStatus} onChange={e => setForm(p => ({ ...p, progressStatus: e.target.value }))} style={{ width: '100%', padding: '6px 34px 6px 12px', fontSize: 12.5 }}>
                    {PROGRESS_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                  <span className="dc-arrow">▼</span>
                </div>
              </div>
              <div>
                <label style={labelStyle}>자세한 사유</label>
                <input className="search-input" value={form.reasonDetail} onChange={e => setForm(p => ({ ...p, reasonDetail: e.target.value }))} style={inputStyle} placeholder="자세한 사유를 입력하세요..." />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 14, paddingTop: 14, borderTop: '1px solid #eef1f4' }}>
              <button className="btn btn-outline" onClick={resetForm}>취소</button>
              <button className="btn btn-primary" onClick={handleAdd} disabled={!canSubmit}>등록</button>
            </div>
          </div>
        </div>
      )}

      {/* 목록 */}
      {filtered.length === 0 ? (
        <div className="card">
          <div className="card-body" style={{ textAlign: 'center', padding: 48, color: '#999' }}>
            {items.length === 0 ? '등록된 항목이 없습니다. [+ 새 항목] 버튼으로 추가하세요.' : '검색/필터 조건에 맞는 항목이 없습니다.'}
          </div>
        </div>
      ) : (
        <div className="card" style={{ padding: 0, overflow: 'visible' }}>
          <div>
            <table className="dc-table" style={{ minWidth: ROW_MIN_WIDTH, '--dc-header-top': `${headerTop}px` }}>
              <colgroup>
                <col style={{ width: 40 }} />
                <col style={{ width: 38 }} />
                <col style={{ width: 88 }} />
                <col style={{ width: 104 }} />
                <col style={{ width: 96 }} />
                <col style={{ width: 234 }} />
                <col style={{ width: 110 }} />
                <col style={{ width: 120 }} />
                <col style={{ width: 92 }} />
                <col style={{ width: 92 }} />
                <col style={{ width: 92 }} />
                <col style={{ width: 92 }} />
                <col style={{ width: 92 }} />
                <col style={{ width: 92 }} />
                <col style={{ width: 92 }} />
                <col style={{ width: 52 }} />
              </colgroup>
              <thead>
                <tr>
                  <th style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={allSelected} onChange={toggleSelectAll} style={{ width: 15, height: 15, cursor: 'pointer', accentColor: '#1a73e8', verticalAlign: 'middle' }} title="전체 선택" />
                  </th>
                  <th></th>
                  <th>사유상태</th>
                  <th>진행상태</th>
                  <th>발주번호</th>
                  <th>상품명</th>
                  <th>옵션명</th>
                  <th>바코드</th>
                  {renderDateHeader('orderDate', '발주일')}
                  {renderDateHeader('confirmDate', '확인일(조치일)')}
                  {renderDateHeader('shipEtaDate', '업체 발송예정일')}
                  {renderDateHeader('releaseReqDate', 'CN출고요청일')}
                  {renderDateHeader('actualShipDate', '실제 출고일')}
                  {renderDateHeader('incheonArriveDate', '인천도착일')}
                  {renderDateHeader('soldoutDate', '품절시작일')}
                  <th style={{ textAlign: 'center' }}></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((item) => {
                  const isOpen = expandedId === item.id;
                  const isSelected = selectedIds.includes(item.id);
                  const color = item.closed ? CLOSED_COLOR : (PROGRESS_COLORS[getProgress(item)] || '#9e9e9e');
                  // 종결 필요 알림: 인천도착일 + 4일이 지났는데 아직 종결 안 됨 → 행 전체 옅은 호박색
                  const needClose = !item.closed && item.incheonArriveDate && kstToday() > addDays(item.incheonArriveDate, 4);
                  const rowBg = isSelected ? '#eef4ff' : (needClose ? '#fff8e1' : (isOpen ? '#f8fafd' : undefined));
                  return (
                    <Fragment key={item.id}>
                      <tr className="dc-row" style={rowBg ? { background: rowBg } : undefined}>
                        <td style={{ textAlign: 'center', borderLeft: `3px solid ${color}` }}>
                          <input type="checkbox" checked={isSelected} onChange={() => toggleSelect(item.id)}
                            style={{ width: 15, height: 15, cursor: 'pointer', accentColor: '#1a73e8', verticalAlign: 'middle' }} />
                        </td>
                        <td style={{ textAlign: 'center' }}>
                          <span onClick={() => setExpandedId(prev => prev === item.id ? null : item.id)}
                            title="조치 내용 열기/닫기"
                            style={{ fontSize: 13, color: '#9aa0a6', cursor: 'pointer', display: 'inline-block', transition: 'transform 0.2s', transform: isOpen ? 'rotate(90deg)' : 'none' }}>&#9654;</span>
                        </td>
                        <td className="dc-pad">{renderCell(item, 'reasonStatus')}</td>
                        <td className="dc-pad">{renderCell(item, 'progressStatus')}</td>
                        <td>{renderCell(item, 'orderNo', 'text')}</td>
                        <td>{renderCell(item, 'productName', 'text')}</td>
                        <td>{renderCell(item, 'optionName', 'text')}</td>
                        <td>{renderCell(item, 'barcode', 'text')}</td>
                        <td>{renderCell(item, 'orderDate', 'date')}</td>
                        <td>{renderCell(item, 'confirmDate', 'date')}</td>
                        <td>{renderCell(item, 'shipEtaDate', 'date')}</td>
                        <td>{renderCell(item, 'releaseReqDate', 'date')}</td>
                        <td>{renderCell(item, 'actualShipDate', 'date')}</td>
                        <td>{renderCell(item, 'incheonArriveDate', 'date')}</td>
                        <td>{renderCell(item, 'soldoutDate', 'date')}</td>
                        <td style={{ textAlign: 'center' }}>
                          <span className="dc-del" onClick={() => handleDelete(item.id)} title="삭제">&#10005;</span>
                        </td>
                      </tr>
                      {isOpen && (
                        <tr>
                          <td colSpan={16} style={{ background: '#fafbfc', padding: 0 }}>
                            <div style={{ padding: '16px 20px 20px 44px' }}>
                              <div style={{ display: 'flex', alignItems: 'center', gap: 12, paddingBottom: 14, marginBottom: 4, borderBottom: '1px solid #eef1f4' }}>
                                <div style={{ fontSize: 11, color: '#999', fontWeight: 600, whiteSpace: 'nowrap' }}>자세한 사유</div>
                                <div style={{ flex: 1, maxWidth: 800, border: '1px solid #e3e7eb', borderRadius: 6, background: '#fff' }}>{renderCell(item, 'reasonDetail', 'text', true)}</div>
                              </div>

                              <div style={{ fontSize: 12, fontWeight: 700, color: '#555', margin: '14px 0 12px' }}>조치 내용</div>
                              <div style={{ marginLeft: 8, borderLeft: '2px solid #e0e0e0', paddingLeft: 16 }}>
                                {(item.timeline || []).map((entry, tIdx) => {
                                  const editing = editingTL && editingTL.itemId === item.id && editingTL.idx === tIdx;
                                  return (
                                    <div key={tIdx} style={{ position: 'relative', marginBottom: 10 }}>
                                      <div style={{ position: 'absolute', left: -22, top: 4, width: 10, height: 10, borderRadius: '50%', background: tIdx === (item.timeline.length - 1) ? '#1a73e8' : '#bdbdbd' }} />
                                      {editing ? (
                                        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                                          <span style={{ fontSize: 11, color: '#999', whiteSpace: 'nowrap', minWidth: 100, marginTop: 6 }}>{entry.date}</span>
                                          <textarea className="search-input" value={editingTLText} onChange={e => setEditingTLText(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEditTimeline(); } }}
                                            rows={1} style={{ flex: 1, minWidth: 'auto', resize: 'vertical', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5 }} />
                                          <button className="btn btn-primary btn-sm" onClick={saveEditTimeline} style={{ fontSize: 11, padding: '4px 10px', whiteSpace: 'nowrap' }}>저장</button>
                                          <button className="btn btn-outline btn-sm" onClick={() => setEditingTL(null)} style={{ fontSize: 11, padding: '4px 10px', whiteSpace: 'nowrap' }}>취소</button>
                                        </div>
                                      ) : (
                                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                                          <span style={{ fontSize: 11, color: '#999', whiteSpace: 'nowrap', minWidth: 100 }}>{entry.date}</span>
                                          <span style={{ fontSize: 13, color: '#333', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', flex: 1 }}>{entry.text}</span>
                                          <span style={{ fontSize: 11, color: '#1a73e8', cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => startEditTimeline(item.id, tIdx, entry.text)}>수정</span>
                                          <span style={{ fontSize: 11, color: '#ccc', cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => handleDeleteTimeline(item.id, tIdx)}>삭제</span>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                                <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', position: 'relative' }}>
                                  <div style={{ position: 'absolute', left: -22, top: 8, width: 10, height: 10, borderRadius: '50%', border: '2px solid #bdbdbd', background: '#fff' }} />
                                  <textarea className="search-input" placeholder="조치한 내용 추가..."
                                    value={timelineInput[item.id] || ''}
                                    onChange={e => setTimelineInput(prev => ({ ...prev, [item.id]: e.target.value }))}
                                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleAddTimeline(item.id); } }}
                                    rows={1} style={{ flex: 1, minWidth: 'auto', resize: 'vertical', fontFamily: 'inherit', fontSize: 12, lineHeight: 1.5 }} />
                                  <button className="btn btn-primary btn-sm" onClick={() => handleAddTimeline(item.id)} style={{ fontSize: 11, padding: '4px 12px', whiteSpace: 'nowrap', marginTop: 2 }}>추가</button>
                                </div>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 날짜 컬럼 필터 드롭다운 (헤더 클릭 시) */}
      {openDateMenu && (() => {
        const field = openDateMenu.field;
        const opts = dateOptions(field);
        const c = DATE_COLORS[field];
        const left = Math.min(openDateMenu.rect.left, window.innerWidth - 190);
        return (
          <>
            <div onClick={() => setOpenDateMenu(null)} style={{ position: 'fixed', inset: 0, zIndex: 200 }} />
            <div style={{ position: 'fixed', top: openDateMenu.rect.bottom + 3, left, zIndex: 201, minWidth: 170, maxHeight: 320, overflowY: 'auto', background: '#fff', border: '1px solid #dcdfe3', borderRadius: 8, boxShadow: '0 8px 24px rgba(0,0,0,0.18)', padding: 4 }}>
              <div onClick={() => { setDateFilters(prev => { const n = { ...prev }; delete n[field]; return n; }); setOpenDateMenu(null); }}
                style={{ padding: '8px 12px', fontSize: 12.5, cursor: 'pointer', borderRadius: 6, fontWeight: 600, color: dateFilters[field] ? '#1a73e8' : '#999', borderBottom: '1px solid #eef1f4', marginBottom: 2 }}>
                전체 (해제)
              </div>
              {opts.length === 0 && <div style={{ padding: '8px 12px', fontSize: 12, color: '#aaa' }}>날짜 값 없음</div>}
              {opts.map(([v, cnt]) => {
                const sel = dateFilters[field] === v;
                return (
                  <div key={v} onClick={() => { setDateFilters(prev => ({ ...prev, [field]: v })); setOpenDateMenu(null); }}
                    style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '8px 12px', fontSize: 12.5, cursor: 'pointer', borderRadius: 6, background: sel ? `${c}18` : undefined, color: sel ? c : '#333', fontWeight: sel ? 700 : 400 }}>
                    <span>{v}</span>
                    <span style={{ fontSize: 11, color: sel ? c : '#9aa0a6' }}>{cnt}</span>
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}
    </div>
  );
}
