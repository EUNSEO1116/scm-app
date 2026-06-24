import { useState, useEffect, useMemo, useCallback, useRef, Fragment } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ResponsiveContainer, ReferenceLine } from 'recharts';
import XLSX from 'xlsx-js-style';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

const STREAK_MIN = 20; // 30일 기준: 우상향·우하향 20일 이상부터 'N일째' 딱지 + 자동 펼침

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const CSV_BARCODE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('쿠팡바코드')}`;
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`; // 재고 계산기 (B:옵션ID, C:바코드, O(14):총재고)

const OVERSTOCK_MIN_DAYS = 60;  // 소진 예상 일수 이 이상이면 과재고
const OVERSTOCK_MIN_STOCK = 10; // 총재고 최소치 (잡음 제거)

const STORE_PREFIX = 'soldout_analysis_';
const SEASONS_STORE = 'sales_forecast_seasons';      // { [optionId]: { period, tags:[] } }
const SEASON_TAGS_STORE = 'sales_forecast_season_tags'; // 사용자 추가 커스텀 태그 목록
const SOLDOUT_TRACKER_STORE = 'soldout_analysis_tracker'; // { [optionId]: { reason 사유, days, startDate } }
const IMPROVE_STORE = 'improvement_items';            // [{ status, barcode, productName, startDate, endDate }]
const FORECAST_CACHE_STORE = 'sales_forecast_cache'; // { [range]: { date(YYYYMMDD|null), rows, top20, overstockRows, dataDays, coverage, nameMap, seasonMap, customTags, lastUpdated } }
const SOLDOUT_RATE_STORE = 'soldout_rate';           // 품절현황 갱신 시 { [YYYYMMDD]: snapshot } 저장 (오늘 키 존재 = 품절현황 업데이트 완료)

const EXCLUDE_KEYWORDS = ['최종마감', '품질확인서', '마감대상', '덤핑'];

// 정규 시즌 태그 (R열 텍스트를 이 태그로 정규화)
const DEFAULT_SEASON_TAGS = ['여름', '장마', '캠핑', '간절기', '가을', '겨울/눈', '웨딩', '가정의달', '어린이날', '운동회/피크닉', '새학기/개학', '야구', '상시'];
const SEASON_RULES = [
  ['여름', ['여름']],
  ['장마', ['장마']],
  ['캠핑', ['캠핑']],
  ['간절기', ['간절기']],
  ['가을', ['가을']],
  ['겨울/눈', ['눈', '겨울']],
  ['웨딩', ['웨딩']],
  ['가정의달', ['가정의달', '입학', '설날']],
  ['어린이날', ['어린이날', '워터밤', '새학기']],
  ['운동회/피크닉', ['운동회', '피크닉']],
  ['새학기/개학', ['방학', '개학']],
  ['야구', ['야구']],
  ['상시', ['꾸준', '잘팔림', '상시']],
];

const TREND_COLOR = { up: '#1e8e3e', down: '#c5221f', flat: '#80868b' };
const TREND_LABEL = { up: '우상향', down: '우하향', flat: '보합' };

// ───────── helpers ─────────
function parseCsvRow(line) {
  const result = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) { if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; } else if (ch === '"') inQuotes = false; else current += ch; }
    else { if (ch === '"') inQuotes = true; else if (ch === ',') { result.push(current); current = ''; } else current += ch; }
  }
  result.push(current); return result;
}
function safeNum(v) { if (v === '' || v === '-' || v == null) return 0; const n = Number(v); return isNaN(n) ? 0 : n; }
function pad2(n) { return String(n).padStart(2, '0'); }
function dateToKey(d) { return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`; }
function keyToMMDD(k) { return `${k.slice(4, 6)}/${k.slice(6, 8)}`; }
function shouldExclude(s) { return s ? EXCLUDE_KEYWORDS.some(kw => s.includes(kw)) : false; }

// Y축 눈금: 0부터 5·10·15·20·30·40·50 등 깔끔한 정수 단위로 통일
function niceTicks(max) {
  if (!max || max <= 0) return { ticks: [0, 5], top: 5 };
  const steps = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 300, 400, 500, 750, 1000, 2000, 5000];
  let step = steps[steps.length - 1];
  for (const s of steps) { if (Math.ceil(max / s) <= 5) { step = s; break; } }
  const top = Math.ceil(max / step) * step;
  const ticks = []; for (let v = 0; v <= top; v += step) ticks.push(v);
  return { ticks, top };
}

// 시즌기간("12~2 / 6~8" 등) → 해당 월 Set. 숫자 없으면 null(=상시).
function parseSeasonMonths(str) {
  if (!str) return null;
  const ranges = str.match(/\d+\s*~\s*\d+/g) || [];
  const singles = str.match(/\d+/g) || [];
  if (ranges.length === 0 && singles.length === 0) return null;
  const months = new Set();
  for (const r of ranges) {
    const m = r.match(/(\d+)\s*~\s*(\d+)/);
    let a = +m[1], b = +m[2];
    if (a < 1 || a > 12 || b < 1 || b > 12) continue;
    if (a <= b) { for (let x = a; x <= b; x++) months.add(x); }
    else { for (let x = a; x <= 12; x++) months.add(x); for (let x = 1; x <= b; x++) months.add(x); }
  }
  if (months.size === 0) { // 범위 없이 단일 월만 적힌 경우
    for (const s of singles) { const v = +s; if (v >= 1 && v <= 12) months.add(v); }
  }
  return months.size ? months : null;
}
function isInSeasonNow(monthsSet) {
  if (monthsSet === null) return true; // 상시(빈칸) = 항상 시즌
  return monthsSet.has(new Date().getMonth() + 1);
}
function normalizeSeasonText(text) {
  if (!text) return [];
  const tags = new Set();
  for (const [tag, kws] of SEASON_RULES) { for (const kw of kws) { if (text.includes(kw)) { tags.add(tag); break; } } }
  return [...tags];
}

// 이동평균 (들쭉날쭉한 일별값을 평균으로 평탄화)
function movingAvg(vals, w) {
  if (w <= 1) return vals.slice();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const start = Math.max(0, i - w + 1);
    let s = 0; for (let j = start; j <= i; j++) s += vals[j];
    out.push(s / (i - start + 1));
  }
  return out;
}

// 추세 판정: 7일 이동평균으로 봤을 때의 방향. 하루하루 들쭉날쭉해도
// 평균선이 오르면 우상향, 내리면 우하향.
//  - 방향: 한 주(스무딩 폭) 전 평균과 비교해 전반적으로 올랐는지/내렸는지.
//    (마지막 하루 값의 출렁임에 휘둘리지 않게 함)
//  - streak: 평균선이 같은 방향을 유지한 연속 일수. 판매가 들쭉날쭉하므로
//    평균값 크기에 비례한 허용오차(EPS) 안의 작은 출렁임은 무시하고 이어 센다.
function computeTrend(vals, smoothWindow) {
  const ma = movingAvg(vals, smoothWindow);
  const n = ma.length;
  if (n < 2) return { dir: 'flat', streak: 0 };
  const mean = ma.reduce((s, v) => s + Math.abs(v), 0) / n;
  const EPS = Math.max(0.5, mean * 0.2);
  const back = Math.min(smoothWindow, n - 1);
  const netDiff = ma[n - 1] - ma[n - 1 - back];
  if (Math.abs(netDiff) < EPS) return { dir: 'flat', streak: 0 };
  const dir = netDiff > 0 ? 'up' : 'down';
  let streak = 1;
  for (let i = n - 2; i >= 1; i--) {
    const d = ma[i] - ma[i - 1];
    if (dir === 'up' ? d > -EPS : d < EPS) streak++;
    else break;
  }
  return { dir, streak };
}

// availKeys를 bucketDays(달력 일수)씩 묶어 그룹화. 점이 너무 촘촘하지 않게 평균낼 때 사용.
function makeBuckets(availKeys, bucketDays) {
  if (availKeys.length === 0) return [];
  const f = availKeys[0];
  const first = new Date(+f.slice(0, 4), +f.slice(4, 6) - 1, +f.slice(6, 8));
  const map = new Map();
  for (const k of availKeys) {
    const d = new Date(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));
    const bi = Math.floor((d - first) / (bucketDays * 86400000));
    if (!map.has(bi)) map.set(bi, []);
    map.get(bi).push(k);
  }
  return [...map.entries()].sort((a, b) => a[0] - b[0]).map(([, keys]) => keys);
}

// 급상승/급하락 판정: 최근 구간 평균을 기존(기준) 구간 평균과 비교.
//  - 급상승: 최근 평균이 기준의 3배 이상 + 절대 증가 5개 이상.
//    잠깐 튀었다 되돌아온 스파이크 제외 → 마지막 값도 기준의 2배 이상 유지될 때만.
//  - 급하락: 기준 평균이 5개 이상으로 어느 정도 팔리던 상품이, 최근 평균이 기준의 1/3 이하로 떨어지고
//    마지막 값도 기준의 1/2 이하로 내려앉았을 때(유지된 하락).
function classifyMagnitude(vals) {
  if (!vals || vals.length < 4) return null;
  const recentN = Math.max(2, Math.round(vals.length * 0.3));
  const recent = vals.slice(-recentN);
  const base = vals.slice(0, vals.length - recentN);
  if (!base.length) return null;
  const baseAvg = base.reduce((s, v) => s + v, 0) / base.length;
  const recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
  const last = vals[vals.length - 1];
  if (baseAvg >= 1 && recentAvg >= baseAvg * 3 && (recentAvg - baseAvg) >= 5 && last >= baseAvg * 2) {
    return { kind: 'surge', baseAvg, recentAvg };
  }
  if (baseAvg >= 5 && recentAvg <= baseAvg / 3 && last <= baseAvg / 2) {
    return { kind: 'drop', baseAvg, recentAvg };
  }
  return null;
}

// 시즌 임박 판정: 시즌기간(월 범위) 기준.
//  - ending(곧 마감): 이번 달은 시즌이고 다음 달은 비시즌.
//  - starting(곧 시작): 이번 달은 비시즌이고 다음 달은 시즌.
//  - 상시(빈칸)나 그 외는 null.
function seasonImminence(period) {
  const months = parseSeasonMonths(period);
  if (!months) return null;
  const now = new Date().getMonth() + 1;
  const next = now === 12 ? 1 : now + 1;
  const inNow = months.has(now), inNext = months.has(next);
  if (inNow && !inNext) return 'ending';
  if (!inNow && inNext) return 'starting';
  return null;
}

export default function SalesForecast() {
  const [range, setRange] = useState('30'); // '30' | '90'
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [dataDays, setDataDays] = useState(0);
  const [coverage, setCoverage] = useState({ partial: false, firstDate: '' });

  const [top20, setTop20] = useState([]);
  const [overstockRows, setOverstockRows] = useState([]);

  // 필터
  const [search, setSearch] = useState('');
  const [trendFilter, setTrendFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [brandFilter, setBrandFilter] = useState('all');
  const [seasonFilter, setSeasonFilter] = useState('all');
  const [inSeasonOnly, setInSeasonOnly] = useState(false);
  const [sortKey, setSortKey] = useState('brand'); // brand | down | up | sales

  // 시즌 관리
  const [seasonMap, setSeasonMap] = useState({});
  const [nameMap, setNameMap] = useState({}); // optionId -> { productName, optionName, barcode, status }
  const [customTags, setCustomTags] = useState([]);
  const [openOverride, setOpenOverride] = useState({}); // optionId -> bool (펼침 수동 토글)
  const [editing, setEditing] = useState(null); // optionId
  const [editTags, setEditTags] = useState([]);
  const [editPeriod, setEditPeriod] = useState('');
  const [newTag, setNewTag] = useState('');
  const [saving, setSaving] = useState(false);

  const [visibleCount, setVisibleCount] = useState(60);
  const [toast, setToast] = useState(null);
  const showToast = (type, msg) => { setToast({ type, msg }); setTimeout(() => setToast(null), 3000); };

  const unit = range === '30' ? '일' : '주';

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const days = range === '30' ? 30 : 90;
      const dayList = [];
      for (let i = days - 1; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); dayList.push(d); }

      const [barcodeRes, calcRes, dbSeasons, dbTags, dbImprove, dbTracker, ...stores] = await Promise.all([
        fetch(CSV_BARCODE),
        fetch(TSV_CALC),
        dbStoreGet(SEASONS_STORE),
        dbStoreGet(SEASON_TAGS_STORE),
        dbStoreGet(IMPROVE_STORE).catch(() => null),
        dbStoreGet(SOLDOUT_TRACKER_STORE).catch(() => null),
        ...dayList.map(d => dbStoreGet(`${STORE_PREFIX}${dateToKey(d)}`).catch(() => null)),
      ]);

      // 재고 계산기: 옵션ID → 상태(F,5)·그로스재고(G,6)·박스히어로(J,9)·총재고(O,14) (과재고 분석용)
      const calcMap = {};
      try {
        const calcCsv = await calcRes.text();
        const calcLines = calcCsv.split('\n').filter(l => l.trim());
        for (let i = 1; i < calcLines.length; i++) {
          const c = calcLines[i].split('\t');
          const oid = (c[1] || '').trim();
          if (oid) calcMap[oid] = {
            barcode: (c[2] || '').trim(),
            status: (c[5] || '').trim(),       // F열 상태
            grossStock: safeNum(c[6]),         // G열 그로스(쿠팡)재고
            boxhero: safeNum(c[9]),            // J열 박스히어로
            totalStock: safeNum(c[14]),        // O열 총재고
          };
        }
      } catch { /* 재고 시트 실패 시 과재고 분석만 비활성 */ }

      // 상품개선: 바코드 → 진행 상태(처리중/시작전만 = 상품개선중)
      const improveMap = {};
      for (const it of (Array.isArray(dbImprove) ? dbImprove : [])) {
        if (!it.barcode) continue;
        if (it.status === '처리중' || it.status === '시작전') {
          const prev = improveMap[it.barcode];
          if (!prev || (prev !== '처리중' && it.status === '처리중')) improveMap[it.barcode] = it.status;
        }
      }
      const trackerData = dbTracker || {}; // optionId -> { reason 사유 }

      // 쿠팡바코드: 상태·이름·시즌기간(Q,16)·시즌(R,17)
      const bcCsv = await barcodeRes.text();
      const bcLines = bcCsv.split('\n').filter(l => l.trim());
      const bcMap = {};
      for (let i = 1; i < bcLines.length; i++) {
        const c = parseCsvRow(bcLines[i]);
        const oid = (c[1] || '').trim();
        if (!oid) continue;
        bcMap[oid] = {
          productName: (c[3] || '').trim(),
          optionName: (c[4] || '').trim(),
          barcode: (c[5] || '').trim(),
          brand: (c[8] || '').trim(),
          status: (c[9] || '').trim(),
          sheetPeriod: (c[16] || '').trim(),
          sheetSeasonText: (c[17] || '').trim(),
        };
      }
      // 엑셀 내보내기용 이름/상태 맵 (시즌 데이터 전체 대상)
      const nm = {};
      for (const [oid, b] of Object.entries(bcMap)) nm[oid] = { productName: b.productName, optionName: b.optionName, barcode: b.barcode, brand: b.brand, status: b.status };
      setNameMap(nm);

      // 업로드 데이터가 있는 날짜만 사용
      const itemsByKey = {}; // dayKey -> Map(oid -> salesQty)
      const stockByKey = {}; // dayKey -> Map(oid -> coupangStock) (품절 매칭용)
      const availKeys = [];
      dayList.forEach((d, i) => {
        const st = stores[i];
        if (!st?.items) return;
        const key = dateToKey(d);
        const m = new Map();
        const sm = new Map();
        for (const it of st.items) { m.set(it.optionId, it.salesQty || 0); sm.set(it.optionId, it.coupangStock); }
        itemsByKey[key] = m;
        stockByKey[key] = sm;
        availKeys.push(key);
      });
      setDataDays(availKeys.length);

      if (availKeys.length === 0) {
        setRows([]); setError('해당 기간에 업로드된 판매 데이터가 없습니다.'); setLoading(false); return null;
      }

      // 표시 구간 버킷 — 달력 전체 구간을 만들고 DB 없는 구간은 hasData=false (회색 표시)
      //  - 30일: 하루 단위
      //  - 3개월: 1주 단위(주 실판매 합계) — 점이 너무 둔감하지 않게
      let buckets; // [{ label, keys:[dayKey...], hasData }]
      if (range === '30') {
        buckets = dayList.map(d => {
          const k = dateToKey(d);
          return { label: keyToMMDD(k), keys: itemsByKey[k] ? [k] : [], hasData: !!itemsByKey[k] };
        });
      } else {
        const allKeys = dayList.map(dateToKey);
        buckets = makeBuckets(allKeys, 7).map(ks => {
          const dataKeys = ks.filter(k => itemsByKey[k]);
          return { label: keyToMMDD(ks[0]), keys: dataKeys, hasData: dataKeys.length > 0 };
        });
      }
      const curMonth = dateToKey(new Date()).slice(4, 6); // 이번 달 (3개월 추세 비교용)
      const firstDataIdx = buckets.findIndex(b => b.hasData);
      const partial = buckets.some(b => !b.hasData);
      setCoverage({ partial, firstDate: availKeys.length ? keyToMMDD(availKeys[0]) : '' });

      // 시즌 시드 (스프레드시트 → 정규화) + DB 병합
      const seed = {};
      const appeared = new Set();
      for (const key of availKeys) { for (const oid of itemsByKey[key].keys()) appeared.add(oid); }
      for (const oid of appeared) {
        const bc = bcMap[oid];
        if (!bc) continue;
        seed[oid] = { period: bc.sheetPeriod, tags: normalizeSeasonText(bc.sheetSeasonText) };
      }
      const merged = { ...seed, ...(dbSeasons || {}) };
      setSeasonMap(merged);
      setCustomTags(Array.isArray(dbTags) ? dbTags : []);
      if (!dbSeasons) { dbStoreSet(SEASONS_STORE, merged, { skipLog: true }); } // 최초 1회 DB 이관

      // 행 구성: 판매중 + 기간 내 한 번이라도 등장한 상품
      const list = [];
      for (const oid of appeared) {
        const bc = bcMap[oid];
        if (!bc) continue;
        if (shouldExclude(bc.status)) continue;
        const season = merged[oid] || seed[oid] || { period: '', tags: [] };

        // 데이터 있는 구간은 추세색, DB 없는 구간(예: 5월 이전)은 회색선(pre)으로 표시
        const chartData = buckets.map((b, i) => {
          if (!b.hasData) {
            // 데이터 시작 이전(선두) 구간만 회색선(pre=0). 중간 누락은 색선 끊김으로 표현.
            return { label: b.label, value: null, pre: (firstDataIdx > 0 && i < firstDataIdx) ? 0 : null, noData: true };
          }
          // 점 값 = 그 날(30일)/그 주(3개월) 실제 판매 합계. 추세용 평균선과 별개로 정확한 값 표시.
          const v = b.keys.reduce((s, k) => s + (itemsByKey[k].get(oid) || 0), 0);
          // 첫 데이터 지점에 pre=v 를 줘서 회색선이 데이터 시작점까지 이어지게
          return { label: b.label, value: v, pre: (firstDataIdx > 0 && i === firstDataIdx) ? v : null, noData: false };
        });
        const vals = chartData.filter(d => !d.noData).map(d => d.value);
        const totalSales = vals.reduce((s, v) => s + v, 0);
        if (totalSales === 0) continue; // 기간 내 판매 전무 → 제외

        let trend;
        if (range === '30') {
          // 30일: 7일 이동평균 방향 + 연속 일수(streak)
          trend = computeTrend(vals, 7);
        } else {
          // 3개월: 이번 달 일평균 vs 3개월 전체 일평균 비교 (N일째 없음)
          let mSum = 0, mCnt = 0, aSum = 0, aCnt = 0;
          for (const k of availKeys) {
            const q = itemsByKey[k].get(oid) || 0;
            aSum += q; aCnt++;
            if (k.slice(4, 6) === curMonth) { mSum += q; mCnt++; }
          }
          const allAvg = aCnt ? aSum / aCnt : 0;
          const monthAvg = mCnt ? mSum / mCnt : allAvg;
          const eps = Math.max(0.3, allAvg * 0.1);
          const diff = monthAvg - allAvg;
          trend = { dir: Math.abs(diff) < eps ? 'flat' : (diff > 0 ? 'up' : 'down'), streak: 0 };
        }
        const inSeason = isInSeasonNow(parseSeasonMonths(season.period));
        const avg = Math.round((totalSales / vals.length) * 10) / 10;

        // 품절 매칭: 최근 7개 데이터 일자 중 쿠팡재고 0(품절)인 날이 있으면 품절됨 + 사유(추적기)
        let soldOut = false;
        for (const k of availKeys.slice(-7)) {
          if (stockByKey[k]?.get(oid) === 0) { soldOut = true; break; }
        }
        const soldOutReason = soldOut ? (trackerData[oid]?.reason || '') : '';
        // 상품개선 매칭: 바코드 기준 처리중/시작전이면 상품개선중
        const improving = improveMap[bc.barcode] || null;

        list.push({
          optionId: oid,
          productName: bc.productName, optionName: bc.optionName,
          brand: bc.brand, status: bc.status, barcode: bc.barcode,
          season, inSeason, chartData, vals, trend, totalSales, avg,
          soldOut, soldOutReason, improving,
        });
      }

      // 과재고 분석 (엑셀 전용·독립 계산): 총재고(O) ÷ 일평균 판매 = 소진 예상 일수.
      //  - 상태 무관: 과재고 조건(재고·소진일수)만 충족하면 '품질확인서'·'최종마감' 등 모두 포함.
      //  - 판매량 음수(반품 등)는 0으로 치환하여 일평균·소진일수·추세 계산.
      //  - 판매 전무(일평균 0)인데 재고 있는 건 데드스톡 → 소진 ∞ 로 최상단.
      //  - 루프 대상은 재고 시트 전체(calcMap): 판매 0건이라도 재고가 있으면 과재고로 포착.
      const overstockList = [];
      for (const oid of Object.keys(calcMap)) {
        const bc = bcMap[oid];
        if (!bc) continue;
        const calc = calcMap[oid];
        if (!calc) continue;
        const fStatus = calc.status || '';
        const totalStock = calc.totalStock || 0;
        if (totalStock < OVERSTOCK_MIN_STOCK) continue;
        let sum = 0;
        for (const k of availKeys) sum += Math.max(0, itemsByKey[k].get(oid) || 0);
        const dailyAvg = availKeys.length ? sum / availKeys.length : 0;
        const daysOfStock = dailyAvg > 0 ? totalStock / dailyAvg : Infinity;
        if (daysOfStock < OVERSTOCK_MIN_DAYS) continue;
        const ovVals = buckets.filter(b => b.hasData).map(b => b.keys.reduce((s, k) => s + Math.max(0, itemsByKey[k].get(oid) || 0), 0));
        let dir;
        if (range === '30') dir = computeTrend(ovVals, 7).dir;
        else {
          let mSum = 0, mCnt = 0, aSum = 0, aCnt = 0;
          for (const k of availKeys) { const q = Math.max(0, itemsByKey[k].get(oid) || 0); aSum += q; aCnt++; if (k.slice(4, 6) === curMonth) { mSum += q; mCnt++; } }
          const allAvg = aCnt ? aSum / aCnt : 0, monthAvg = mCnt ? mSum / mCnt : allAvg, eps = Math.max(0.3, allAvg * 0.1), diff = monthAvg - allAvg;
          dir = Math.abs(diff) < eps ? 'flat' : (diff > 0 ? 'up' : 'down');
        }
        const season = merged[oid] || seed[oid] || { period: '', tags: [] };
        overstockList.push({
          optionId: oid, barcode: bc.barcode || calc.barcode || '',
          productName: bc.productName, optionName: bc.optionName, brand: bc.brand,
          season, fStatus, totalStock, grossStock: calc.grossStock || 0, boxhero: calc.boxhero || 0,
          dailyAvg, daysOfStock, trendDir: dir,
        });
      }
      overstockList.sort((a, b) => b.daysOfStock - a.daysOfStock);
      setOverstockRows(overstockList);

      // TOP20 수요예측: 기간 전체 판매량 합 기준 상위 20개
      //  - 30일: 주 평균 점,  3개월: 2주 평균 점 (점이 촘촘해지지 않게 평균)
      const miniBuckets = makeBuckets(availKeys, range === '30' ? 7 : 14);
      const top = list.map(r => {
        const mini = miniBuckets.map(ks => {
          const sum = ks.reduce((s, k) => s + (itemsByKey[k].get(r.optionId) || 0), 0);
          return { label: keyToMMDD(ks[0]), value: Math.round((sum / ks.length) * 10) / 10 };
        });
        const miniTotal = availKeys.reduce((s, k) => s + (itemsByKey[k].get(r.optionId) || 0), 0);
        return { ...r, mini, miniTotal };
      }).filter(r => r.miniTotal > 0).sort((a, b) => b.miniTotal - a.miniTotal).slice(0, 20);
      setTop20(top);

      setRows(list);
      setLastUpdated(new Date());
      setVisibleCount(60);
      setOpenOverride({}); // 펼침 수동 토글 초기화 → 기본 규칙(7일 이상) 재적용
      setLoading(false);
      // 캐시 저장용 스냅샷 반환 (decideLoad가 받아 DB 캐시에 보관)
      return {
        rows: list,
        top20: top,
        overstockRows: overstockList,
        dataDays: availKeys.length,
        coverage: { partial, firstDate: availKeys.length ? keyToMMDD(availKeys[0]) : '' },
        nameMap: nm,
        seasonMap: merged,
        customTags: Array.isArray(dbTags) ? dbTags : [],
        lastUpdated: Date.now(),
      };
    } catch (e) {
      console.error(e);
      setError('데이터를 불러오는 중 오류가 발생했습니다.');
    }
    setLoading(false);
    return null;
  }, [range]);

  // 캐시 스냅샷을 화면 상태에 적용 (재계산 없이 즉시 표시)
  const applySnapshot = useCallback((s) => {
    setRows(s.rows || []);
    setTop20(s.top20 || []);
    setOverstockRows(s.overstockRows || []);
    setDataDays(s.dataDays || 0);
    setCoverage(s.coverage || { partial: false, firstDate: '' });
    setNameMap(s.nameMap || {});
    setSeasonMap(s.seasonMap || {});
    setCustomTags(Array.isArray(s.customTags) ? s.customTags : []);
    setLastUpdated(s.lastUpdated ? new Date(s.lastUpdated) : null);
    setVisibleCount(60);
    setOpenOverride({});
    setError(null);
    setLoading(false);
  }, []);

  // DB 캐시 맵 (range별 스냅샷). 최초 1회만 DB에서 읽고 이후 메모리 유지.
  const cacheRef = useRef(null);
  const persistCache = useCallback((map) => {
    dbStoreSet(FORECAST_CACHE_STORE, map, { skipLog: true }).catch(() => {});
  }, []);

  // 자동 갱신 판단: 오늘 캐시가 있으면 그대로 표시, 없으면 두 트리거(데이터 업로드·품절현황 업데이트)가
  // 오늘 모두 완료된 경우에만 1회 재계산. 미충족 시 직전 캐시 유지 표시.
  const decideLoad = useCallback(async () => {
    const rk = range;
    const today = dateToKey(new Date());

    // 1) 캐시 맵 로드 (최초 1회)
    if (cacheRef.current === null) {
      const fromDb = await dbStoreGet(FORECAST_CACHE_STORE).catch(() => null);
      cacheRef.current = (fromDb && typeof fromDb === 'object') ? fromDb : {};
    }
    const map = cacheRef.current;
    const entry = map[rk];

    // 2) 오늘 자 캐시 존재 → 재계산 없이 즉시 표시 (로딩 단축)
    if (entry && entry.date === today) { applySnapshot(entry); return; }

    // 3) 두 트리거 오늘 완료 여부 확인
    setLoading(true);
    const [analysisToday, rateSnap] = await Promise.all([
      dbStoreGet(`${STORE_PREFIX}${today}`).catch(() => null),
      dbStoreGet(SOLDOUT_RATE_STORE).catch(() => null),
    ]);
    const dataUploaded = !!analysisToday;                       // 데이터 업로드 오늘 완료
    const soldoutUpdated = !!(rateSnap && rateSnap[today]);     // 품절현황 업데이트 오늘 완료
    const bothMet = dataUploaded && soldoutUpdated;

    if (bothMet) {
      // 4) 둘 다 완료 → 1회 재계산 후 오늘 자 캐시로 저장
      const snap = await load();
      if (snap) { map[rk] = { date: today, ...snap }; persistCache(map); }
      return;
    }

    // 5) 미충족 → 직전 캐시가 있으면 그대로 유지 표시
    if (entry) { applySnapshot(entry); return; }

    // 6) 캐시가 전혀 없으면(최초) 1회 계산해 기준선 확보 (date=null → 오늘 자 아님)
    const snap = await load();
    if (snap) { map[rk] = { date: null, ...snap }; persistCache(map); }
  }, [range, load, applySnapshot, persistCache]);

  // 현재 range의 캐시 스냅샷에 시즌 편집 결과를 반영 (재계산 없이 일관성 유지)
  const patchCache = useCallback((newRows, newSeasonMap, newCustomTags) => {
    const map = cacheRef.current;
    if (!map) return;
    const entry = map[range];
    if (!entry) return;
    map[range] = { ...entry, rows: newRows, seasonMap: newSeasonMap, customTags: newCustomTags };
    persistCache(map);
  }, [range, persistCache]);

  useEffect(() => { decideLoad(); }, [decideLoad]);

  const allTags = useMemo(() => {
    const set = new Set([...DEFAULT_SEASON_TAGS, ...customTags]);
    for (const v of Object.values(seasonMap)) for (const t of (v.tags || [])) set.add(t);
    return [...set];
  }, [customTags, seasonMap]);

  const statusOptions = useMemo(() => {
    const set = new Set(rows.map(r => r.status).filter(Boolean));
    return ['all', ...[...set].sort()];
  }, [rows]);

  const brandOptions = useMemo(() => {
    const set = new Set(rows.map(r => r.brand).filter(Boolean));
    return ['all', ...[...set].sort((a, b) => a.localeCompare(b))];
  }, [rows]);

  const stats = useMemo(() => {
    const up = rows.filter(r => r.trend.dir === 'up').length;
    const down = rows.filter(r => r.trend.dir === 'down').length;
    const flat = rows.filter(r => r.trend.dir === 'flat').length;
    const inSeason = rows.filter(r => r.inSeason).length;
    return { total: rows.length, up, down, flat, inSeason };
  }, [rows]);

  const filtered = useMemo(() => {
    let list = rows;
    if (trendFilter !== 'all') list = list.filter(r => r.trend.dir === trendFilter);
    if (statusFilter !== 'all') list = list.filter(r => r.status === statusFilter);
    if (brandFilter !== 'all') list = list.filter(r => r.brand === brandFilter);
    if (seasonFilter !== 'all') list = list.filter(r => (r.season.tags || []).includes(seasonFilter));
    if (inSeasonOnly) list = list.filter(r => r.inSeason);
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      list = list.filter(r =>
        r.productName.toLowerCase().includes(q) ||
        r.optionName.toLowerCase().includes(q) ||
        (r.brand || '').toLowerCase().includes(q) ||
        (r.season.tags || []).some(t => t.toLowerCase().includes(q))
      );
    }
    const sorted = [...list];
    const trendOrder = { down: 0, up: 1, flat: 2 };
    if (sortKey === 'brand') {
      sorted.sort((a, b) => (a.brand || '힣').localeCompare(b.brand || '힣') || b.totalSales - a.totalSales);
    } else if (sortKey === 'sales') {
      sorted.sort((a, b) => b.totalSales - a.totalSales);
    } else if (sortKey === 'down' || sortKey === 'up') {
      const first = sortKey === 'down' ? 'down' : 'up';
      sorted.sort((a, b) => {
        const ao = a.trend.dir === first ? 0 : trendOrder[a.trend.dir] + 1;
        const bo = b.trend.dir === first ? 0 : trendOrder[b.trend.dir] + 1;
        if (ao !== bo) return ao - bo;
        if (a.trend.streak !== b.trend.streak) return b.trend.streak - a.trend.streak;
        return b.totalSales - a.totalSales;
      });
    }
    return sorted;
  }, [rows, trendFilter, statusFilter, brandFilter, seasonFilter, inSeasonOnly, search, sortKey]);

  // 보고서·엑셀 공용 분석 결과 (필터 적용된 품목 대상)
  const analysis = useMemo(() => {
    const surge = [], drop = [];
    for (const r of filtered) {
      const mag = classifyMagnitude(r.vals);
      if (mag?.kind === 'surge') surge.push({ ...r, mag });
      else if (mag?.kind === 'drop') drop.push({ ...r, mag });
    }
    surge.sort((a, b) => (b.mag.recentAvg - b.mag.baseAvg) - (a.mag.recentAvg - a.mag.baseAvg));
    drop.sort((a, b) => (a.mag.recentAvg - a.mag.baseAvg) - (b.mag.recentAvg - b.mag.baseAvg));
    const seasonStarting = [], seasonEnding = [];
    for (const r of filtered) {
      const s = seasonImminence(r.season.period);
      if (s === 'starting') seasonStarting.push(r);
      else if (s === 'ending') seasonEnding.push(r);
    }
    return { surge, drop, seasonStarting, seasonEnding };
  }, [filtered]);

  // 카드 펼침 여부: 기본은 우상향·우하향 7(단위) 이상만 펼침, 수동 토글이 우선
  // 30일: 우상향·우하향 20일 이상만 자동 펼침. 3개월: 강도 기준이 없어 기본 접힘(전체 펼치기로 확인).
  const defaultOpen = (row) => range === '30' && row.trend.dir !== 'flat' && row.trend.streak >= STREAK_MIN;
  const isOpen = (row) => (row.optionId in openOverride) ? openOverride[row.optionId] : defaultOpen(row);
  const toggleOpen = (row) => setOpenOverride(prev => ({ ...prev, [row.optionId]: !isOpen(row) }));
  const setAllOpen = (val) => {
    const next = {};
    for (const r of filtered) next[r.optionId] = val;
    setOpenOverride(prev => ({ ...prev, ...next }));
  };

  // ───────── 시즌 데이터 엑셀 다운로드 ─────────
  const exportSeasonExcel = () => {
    const aoa = [['옵션ID', '바코드', '상품명', '옵션명', '시즌', '시즌기간']];
    const entries = Object.entries(seasonMap)
      .filter(([oid]) => { const nm = nameMap[oid]; return nm && !shouldExclude(nm.status); }) // 판매중만
      .sort((a, b) => (nameMap[a[0]]?.productName || '').localeCompare(nameMap[b[0]]?.productName || ''));
    for (const [oid, s] of entries) {
      const nm = nameMap[oid] || {};
      aoa.push([oid, nm.barcode || '', nm.productName || '', nm.optionName || '', (s.tags || []).join(', '), s.period || '']);
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 16 }, { wch: 16 }, { wch: 40 }, { wch: 24 }, { wch: 22 }, { wch: 16 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '시즌데이터');
    XLSX.writeFile(wb, `시즌데이터_${dateToKey(new Date())}.xlsx`);
    showToast('success', `시즌 데이터 ${entries.length}건 다운로드`);
  };

  // ───────── 시즌 데이터 엑셀 업로드 (대량편집·병합 덮어쓰기) ─────────
  const importSeasonExcel = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // 같은 파일 재선택 가능하게 초기화
    if (!file) return;
    try {
      const buf = await file.arrayBuffer();
      const wb = XLSX.read(buf, { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      if (!aoa.length) { showToast('error', '빈 파일입니다.'); return; }
      // 헤더에서 옵션ID/시즌/시즌기간 컬럼 위치 찾기
      const header = aoa[0].map(h => String(h).trim());
      const idxOf = (...names) => header.findIndex(h => names.includes(h));
      const oidCol = idxOf('옵션ID', '옵션id', 'optionId');
      const tagCol = idxOf('시즌');
      const periodCol = idxOf('시즌기간', '시즌 기간');
      if (oidCol < 0 || tagCol < 0 || periodCol < 0) {
        showToast('error', '옵션ID·시즌·시즌기간 컬럼이 필요합니다.');
        return;
      }
      // 셀 규칙: 빈칸=기존값 유지, '-'=삭제, 값=갱신
      const updates = {};
      for (let i = 1; i < aoa.length; i++) {
        const row = aoa[i];
        const oid = String(row[oidCol] ?? '').trim();
        if (!oid) continue;
        const tagsStr = String(row[tagCol] ?? '').trim();
        const periodStr = String(row[periodCol] ?? '').trim();
        if (!tagsStr && !periodStr) continue; // 둘 다 빈칸이면 변화 없음 → 건너뛰기
        const existing = seasonMap[oid] || { period: '', tags: [] };
        // 시즌기간
        let period;
        if (periodStr === '-') period = '';
        else if (periodStr === '') period = existing.period || '';
        else period = periodStr;
        // 시즌 태그
        let tags;
        if (tagsStr === '-') tags = [];
        else if (tagsStr === '') tags = existing.tags || [];
        else tags = tagsStr.split(',').map(t => t.trim()).filter(Boolean);
        updates[oid] = { period, tags };
      }
      const count = Object.keys(updates).length;
      if (!count) { showToast('error', '반영할 데이터가 없습니다.'); return; }
      const next = { ...seasonMap, ...updates }; // 병합 덮어쓰기
      // 업로드 태그 중 DB·기본 목록에 없던 새 태그는 커스텀 태그로 등록
      const knownTags = new Set([...DEFAULT_SEASON_TAGS, ...customTags]);
      const newTags = [];
      for (const u of Object.values(updates)) {
        for (const t of u.tags) { if (!knownTags.has(t)) { knownTags.add(t); newTags.push(t); } }
      }
      setSaving(true);
      setSeasonMap(next);
      // 화면 행 즉시 반영
      const newRows = rows.map(r => updates[r.optionId]
        ? { ...r, season: updates[r.optionId], inSeason: isInSeasonNow(parseSeasonMonths(updates[r.optionId].period)) }
        : r);
      setRows(newRows);
      const finalTags = newTags.length ? [...customTags, ...newTags] : customTags;
      if (newTags.length) {
        setCustomTags(finalTags);
        dbStoreSet(SEASON_TAGS_STORE, finalTags, { skipLog: true });
      }
      patchCache(newRows, next, finalTags); // 캐시 일관성 유지
      const ok = await dbStoreSet(SEASONS_STORE, next, { logDesc: `수요예측 시즌 일괄 업로드 (${count}건)` });
      setSaving(false);
      showToast(ok ? 'success' : 'error', ok
        ? `시즌 데이터 ${count}건 업로드 저장됨${newTags.length ? ` · 새 태그 ${newTags.length}개 추가` : ''}`
        : '저장 실패');
    } catch (err) {
      console.error(err);
      showToast('error', '엑셀 읽기 실패: ' + (err.message || err));
    }
  };

  // ───────── 분석 엑셀 (급상승 · 급하락 · 과재고 3시트) ─────────
  const exportAnalysisExcel = () => {
    const { surge, drop } = analysis;
    const dec = n => Math.round(n * 10) / 10;
    const seasonTxt = r => (r.season.tags || []).join(', ');
    const wb = XLSX.utils.book_new();
    const addSheet = (aoa, name, cols) => {
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = cols;
      XLSX.utils.book_append_sheet(wb, ws, name);
    };

    const surgeAoa = [['바코드', '옵션ID', '상품명', '옵션명', '브랜드', '시즌', '기존평균', '최근평균', '추세', '상품개선']];
    for (const r of surge) surgeAoa.push([r.barcode, r.optionId, r.productName, r.optionName, r.brand, seasonTxt(r), dec(r.mag.baseAvg), dec(r.mag.recentAvg), TREND_LABEL[r.trend.dir], r.improving || '']);

    const dropAoa = [['바코드', '옵션ID', '상품명', '옵션명', '브랜드', '시즌', '기존평균', '최근평균', '품절', '품절사유', '상품개선']];
    for (const r of drop) dropAoa.push([r.barcode, r.optionId, r.productName, r.optionName, r.brand, seasonTxt(r), dec(r.mag.baseAvg), dec(r.mag.recentAvg), r.soldOut ? '품절됨' : '', r.soldOutReason || '', r.improving || '']);

    const overAoa = [['바코드', '옵션ID', '상품명', '옵션명', '브랜드', '시즌', '상태', '총재고', '그로스재고', '박스히어로', '일평균판매', '소진예상일수', '추세']];
    for (const r of overstockRows) overAoa.push([r.barcode, r.optionId, r.productName, r.optionName, r.brand, seasonTxt(r), r.fStatus, r.totalStock, r.grossStock, r.boxhero, dec(r.dailyAvg), r.daysOfStock === Infinity ? '판매없음' : Math.round(r.daysOfStock), TREND_LABEL[r.trendDir]]);

    addSheet(surgeAoa, '급상승', [{ wch: 16 }, { wch: 16 }, { wch: 40 }, { wch: 24 }, { wch: 14 }, { wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 10 }]);
    addSheet(dropAoa, '급하락', [{ wch: 16 }, { wch: 16 }, { wch: 40 }, { wch: 24 }, { wch: 14 }, { wch: 18 }, { wch: 10 }, { wch: 10 }, { wch: 8 }, { wch: 24 }, { wch: 10 }]);
    addSheet(overAoa, '과재고', [{ wch: 16 }, { wch: 16 }, { wch: 40 }, { wch: 24 }, { wch: 14 }, { wch: 18 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 8 }]);

    XLSX.writeFile(wb, `수요예측_분석_${dateToKey(new Date())}.xlsx`);
    showToast('success', `분석 다운로드 (급상승 ${surge.length} · 급하락 ${drop.length} · 과재고 ${overstockRows.length})`);
  };

  // ───────── 시즌 편집 ─────────
  const openEdit = (row) => {
    setEditing(row.optionId);
    setEditTags([...(row.season.tags || [])]);
    setEditPeriod(row.season.period || '');
    setNewTag('');
  };
  const toggleEditTag = (tag) => setEditTags(prev => prev.includes(tag) ? prev.filter(t => t !== tag) : [...prev, tag]);
  const addCustomTag = () => {
    const t = newTag.trim();
    if (!t) return;
    if (!allTags.includes(t)) {
      const next = [...customTags, t];
      setCustomTags(next);
      dbStoreSet(SEASON_TAGS_STORE, next, { skipLog: true });
    }
    if (!editTags.includes(t)) setEditTags(prev => [...prev, t]);
    setNewTag('');
  };
  const saveEdit = async () => {
    setSaving(true);
    const newSeason = { period: editPeriod.trim(), tags: editTags };
    const next = { ...seasonMap, [editing]: newSeason };
    setSeasonMap(next);
    // 화면 행 즉시 반영
    const newRows = rows.map(r => r.optionId === editing
      ? { ...r, season: newSeason, inSeason: isInSeasonNow(parseSeasonMonths(editPeriod.trim())) }
      : r);
    setRows(newRows);
    patchCache(newRows, next, customTags); // 캐시 일관성 유지
    const ok = await dbStoreSet(SEASONS_STORE, next, { logDesc: '수요예측 시즌 정보 수정' });
    setSaving(false);
    setEditing(null);
    showToast(ok ? 'success' : 'error', ok ? '시즌 정보 저장됨' : '저장 실패');
  };

  // ───────── 보고서(PDF) ─────────
  const openReport = () => {
    const reportRows = filtered;
    const win = window.open('', '_blank');
    if (!win) { showToast('error', '팝업이 차단되었습니다.'); return; }
    const rangeLabel = range === '30' ? '최근 30일' : '최근 3개월(주별 평균)';
    const today = new Date().toLocaleString('ko-KR');

    const sparkline = (vals, color) => {
      const w = 240, h = 56, pad = 5;
      const max = Math.max(...vals, 1), min = Math.min(...vals, 0);
      const rng = (max - min) || 1;
      const pts = vals.map((v, i) => {
        const x = pad + (i / (vals.length - 1 || 1)) * (w - 2 * pad);
        const y = h - pad - ((v - min) / rng) * (h - 2 * pad);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      }).join(' ');
      return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><polyline fill="none" stroke="${color}" stroke-width="2" points="${pts}"/></svg>`;
    };

    const topUp = reportRows.filter(r => r.trend.dir === 'up').slice(0, 10);
    const topDown = reportRows.filter(r => r.trend.dir === 'down').sort((a, b) => b.trend.streak - a.trend.streak).slice(0, 10);
    const esc = s => String(s || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]));

    const listHtml = (arr) => arr.map(r =>
      `<li><b>${esc(r.productName)}</b> ${esc(r.optionName)} — <span style="color:${TREND_COLOR[r.trend.dir]}">${TREND_LABEL[r.trend.dir]}${r.trend.streak >= STREAK_MIN ? ` ${r.trend.streak}${unit}째` : ''}</span> (현재 ${r.vals[r.vals.length - 1]}개)</li>`
    ).join('');

    // 공용 분석 결과 (급상승/급하락/시즌임박)
    const { surge, drop, seasonStarting, seasonEnding } = analysis;

    const dec = n => Math.round(n * 10) / 10;
    // 급상승/급하락 카드: 상품개선중 + (급하락) 품절 사유 표시
    const magCard = (r, kind) => {
      const color = kind === 'surge' ? TREND_COLOR.up : TREND_COLOR.down;
      const ann = [];
      if (kind === 'drop' && r.soldOut) ann.push(`<span class="ann soldout">📦 품절됨${r.soldOutReason ? ' · 사유: ' + esc(r.soldOutReason) : ''}</span>`);
      if (r.improving) ann.push(`<span class="ann improve">🛠 상품개선중 (${esc(r.improving)})</span>`);
      return `<div class="card">
        <div class="pn">${esc(r.productName)}</div>
        <div class="on">${esc(r.optionName)} · ${esc(r.status)}${(r.season.tags || []).length ? ' · ' + esc(r.season.tags.join(', ')) : ''}</div>
        <div class="badge" style="background:${color}">${kind === 'surge' ? '급상승' : '급하락'} · 평균 ${dec(r.mag.baseAvg)}개 → 최근 ${dec(r.mag.recentAvg)}개</div>
        ${sparkline(r.vals, color)}
        ${ann.length ? '<div class="anns">' + ann.join('') + '</div>' : ''}
      </div>`;
    };
    // 시즌 임박 카드
    const seasonCard = (r, kind) => {
      const label = kind === 'starting' ? '곧 시작' : '곧 마감';
      const bg = kind === 'starting' ? '#1a73e8' : '#b8860b';
      return `<div class="card">
        <div class="pn">${esc(r.productName)}</div>
        <div class="on">${esc(r.optionName)} · ${esc(r.status)}${(r.season.tags || []).length ? ' · ' + esc(r.season.tags.join(', ')) : ''}</div>
        <div class="badge" style="background:${bg}">${label}${r.season.period ? ' · 시즌 ' + esc(r.season.period) + '월' : ''}</div>
        ${sparkline(r.vals, TREND_COLOR[r.trend.dir])}
      </div>`;
    };

    const surgeHtml = surge.length ? surge.map(r => magCard(r, 'surge')).join('') : '<div class="empty">해당 없음</div>';
    const dropHtml = drop.length ? drop.map(r => magCard(r, 'drop')).join('') : '<div class="empty">해당 없음</div>';
    const seasonImm = [...seasonStarting.map(r => seasonCard(r, 'starting')), ...seasonEnding.map(r => seasonCard(r, 'ending'))];
    const seasonHtml = seasonImm.length ? seasonImm.join('') : '<div class="empty">해당 없음</div>';

    win.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8"><title>수요 예측 분석 보고서</title>
      <style>
        body{font-family:'맑은 고딕','Malgun Gothic',sans-serif;color:#222;margin:28px;}
        h1{font-size:22px;margin:0 0 4px;} .sub{color:#666;font-size:13px;margin-bottom:18px;}
        .summary{display:flex;gap:18px;margin-bottom:20px;flex-wrap:wrap;}
        .stat{border:1px solid #ddd;border-radius:10px;padding:12px 18px;text-align:center;min-width:90px;}
        .stat .n{font-size:24px;font-weight:700;} .stat .l{font-size:12px;color:#666;}
        h2{font-size:15px;border-left:4px solid #374151;padding-left:8px;margin:22px 0 8px;}
        ul{margin:4px 0 0;padding-left:20px;font-size:13px;line-height:1.7;}
        .grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-top:10px;}
        .card{border:1px solid #e2e2e2;border-radius:10px;padding:12px 14px;page-break-inside:avoid;}
        .pn{font-size:13px;font-weight:700;line-height:1.3;} .on{font-size:11px;color:#666;margin:2px 0 8px;}
        .badge{display:inline-block;color:#fff;font-size:11px;font-weight:700;border-radius:8px;padding:2px 10px;margin-bottom:6px;}
        .season{color:#b8860b;font-weight:700;}
        .anns{margin-top:8px;display:flex;flex-direction:column;gap:4px;}
        .ann{font-size:11px;font-weight:700;border-radius:6px;padding:3px 8px;display:inline-block;}
        .ann.soldout{background:#fce8e6;color:#c5221f;}
        .ann.improve{background:#fff3cd;color:#b8860b;}
        .empty{color:#aaa;font-size:13px;padding:8px 2px;grid-column:1/-1;}
        @media print{ .noprint{display:none;} }
      </style></head><body>
      <h1>수요 예측 분석 보고서</h1>
      <div class="sub">${rangeLabel} · 생성일 ${today} · 대상 ${reportRows.length}개 품목 (판매중)</div>
      <div class="summary">
        <div class="stat"><div class="n">${reportRows.length}</div><div class="l">전체</div></div>
        <div class="stat"><div class="n" style="color:${TREND_COLOR.up}">${reportRows.filter(r => r.trend.dir === 'up').length}</div><div class="l">우상향</div></div>
        <div class="stat"><div class="n" style="color:${TREND_COLOR.down}">${reportRows.filter(r => r.trend.dir === 'down').length}</div><div class="l">우하향</div></div>
        <div class="stat"><div class="n" style="color:${TREND_COLOR.flat}">${reportRows.filter(r => r.trend.dir === 'flat').length}</div><div class="l">보합</div></div>
        <div class="stat"><div class="n" style="color:#b8860b">${reportRows.filter(r => r.inSeason).length}</div><div class="l">시즌중</div></div>
      </div>
      <h2>📈 우상향 TOP</h2><ul>${topUp.length ? listHtml(topUp) : '<li>해당 없음</li>'}</ul>
      <h2>📉 우하향 TOP (연속 하락)</h2><ul>${topDown.length ? listHtml(topDown) : '<li>해당 없음</li>'}</ul>
      <h2>🚀 급상승 품목 (${surge.length})</h2>
      <div class="grid">${surgeHtml}</div>
      <h2>📉 급하락 품목 · 원인 분석 (${drop.length})</h2>
      <div class="grid">${dropHtml}</div>
      <h2>🗓 시즌 임박 품목 (${seasonImm.length})</h2>
      <div class="grid">${seasonHtml}</div>
      <div class="noprint" style="margin-top:24px;text-align:center;">
        <button onclick="window.print()" style="padding:10px 24px;font-size:14px;background:#374151;color:#fff;border:none;border-radius:8px;cursor:pointer;">PDF로 저장 / 인쇄</button>
      </div>
      <script>window.onload=function(){setTimeout(function(){window.print();},400);};</script>
      </body></html>`);
    win.document.close();
  };

  // ───────── render ─────────
  const filterBtn = (active) => ({
    padding: '5px 12px', fontSize: 13, borderRadius: 8, cursor: 'pointer',
    border: active ? '1px solid #374151' : '1px solid var(--border, #ddd)',
    background: active ? '#374151' : '#fff', color: active ? '#fff' : '#444', fontWeight: active ? 700 : 400,
  });

  return (
    <div>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h2 style={{ margin: 0 }}>수요 예측</h2>
          {lastUpdated && <span style={{ fontSize: 12, color: '#999' }}>{lastUpdated.toLocaleTimeString('ko-KR')} 기준 · 데이터 {dataDays}일분</span>}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <div style={{ display: 'flex', border: '1px solid #ddd', borderRadius: 8, overflow: 'hidden' }}>
            <button onClick={() => setRange('30')} style={{ ...filterBtn(range === '30'), border: 'none', borderRadius: 0 }}>30일</button>
            <button onClick={() => setRange('90')} style={{ ...filterBtn(range === '90'), border: 'none', borderRadius: 0 }}>3개월</button>
          </div>
          <button onClick={decideLoad} disabled={loading} style={{ padding: '5px 14px', fontSize: 13, borderRadius: 8, border: '1px solid #ddd', background: '#fff', cursor: 'pointer' }}>
            {loading ? '불러오는 중…' : '↻ 다시 보기'}
          </button>
          <button onClick={exportSeasonExcel} style={{ padding: '5px 14px', fontSize: 13, borderRadius: 8, border: '1px solid #1e7e34', background: '#fff', color: '#1e7e34', cursor: 'pointer' }}>
            ⬇ 시즌 데이터 (엑셀)
          </button>
          <label style={{ padding: '5px 14px', fontSize: 13, borderRadius: 8, border: '1px solid #1e7e34', background: '#1e7e34', color: '#fff', cursor: saving ? 'default' : 'pointer', opacity: saving ? 0.6 : 1 }}>
            {saving ? '업로드 중…' : '⬆ 시즌 업로드 (엑셀)'}
            <input type="file" accept=".xlsx,.xls" onChange={importSeasonExcel} disabled={saving} style={{ display: 'none' }} />
          </label>
          <button onClick={exportAnalysisExcel} disabled={!filtered.length} style={{ padding: '5px 14px', fontSize: 13, borderRadius: 8, border: '1px solid #8e44ad', background: '#fff', color: '#8e44ad', cursor: 'pointer', opacity: filtered.length ? 1 : 0.5 }}>
            ⬇ 분석 데이터 (엑셀)
          </button>
          <button onClick={openReport} disabled={!filtered.length} style={{ padding: '5px 14px', fontSize: 13, borderRadius: 8, border: 'none', background: '#1a73e8', color: '#fff', cursor: 'pointer', opacity: filtered.length ? 1 : 0.5 }}>
            📄 분석 보고서 (PDF)
          </button>
        </div>
      </div>

      {error && (
        <div style={{ background: '#fce8e6', color: '#c5221f', border: '1px solid #f5c6c3', borderRadius: 10, padding: '12px 16px', marginBottom: 16, fontSize: 14 }}>⚠️ {error}</div>
      )}

      {!loading && !error && range === '90' && coverage.partial && (
        <div style={{ background: '#f1f3f4', color: '#5f6368', border: '1px solid #e0e0e0', borderRadius: 10, padding: '10px 16px', marginBottom: 16, fontSize: 13, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ display: 'inline-block', width: 22, height: 0, borderTop: '2px dashed #c9ccd1' }} />
          3개월 전체 DB가 없습니다. 데이터가 있는 <b>{coverage.firstDate}</b> 이전 구간은 회색 점선(데이터 없음)으로 표시됩니다.
        </div>
      )}

      {/* 요약 */}
      {!loading && rows.length > 0 && (
        <div style={{ display: 'flex', gap: 12, marginBottom: 16, flexWrap: 'wrap' }}>
          {[
            ['전체', stats.total, '#374151'],
            ['우상향', stats.up, TREND_COLOR.up],
            ['우하향', stats.down, TREND_COLOR.down],
            ['보합', stats.flat, TREND_COLOR.flat],
            ['시즌중', stats.inSeason, '#b8860b'],
          ].map(([label, n, color]) => (
            <div key={label} style={{ border: '1px solid #eee', borderRadius: 10, padding: '10px 18px', textAlign: 'center', minWidth: 80 }}>
              <div style={{ fontSize: 22, fontWeight: 700, color }}>{n}</div>
              <div style={{ fontSize: 12, color: '#666' }}>{label}</div>
            </div>
          ))}
        </div>
      )}

      {/* TOP20 수요예측 */}
      {!loading && top20.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ margin: '0 0 10px', fontSize: 15, display: 'flex', alignItems: 'center', gap: 8 }}>
            🏆 TOP20 수요예측 <span style={{ fontSize: 12, color: '#888', fontWeight: 400 }}>판매량 상위 20개 · {range === '30' ? '최근 30일 추이 (주 평균)' : '최근 3개월 추이 (2주 평균)'}</span>
          </h3>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
            {top20.map((r, i) => {
              const delta = (r.mini[r.mini.length - 1]?.value || 0) - (r.mini[0]?.value || 0);
              const dColor = delta > 0 ? TREND_COLOR.up : delta < 0 ? TREND_COLOR.down : TREND_COLOR.flat;
              return (
                <div key={r.optionId} style={{ border: '1px solid #e7e7e7', borderRadius: 10, padding: '10px 12px', background: '#fff' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#1a73e8' }}>#{i + 1}</span>
                    <span style={{ fontSize: 11, color: '#666' }}>{range === '30' ? '30일' : '3개월'} {r.miniTotal.toLocaleString('ko-KR')}개</span>
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 700, lineHeight: 1.3, margin: '4px 0 1px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.productName}</div>
                  <div style={{ fontSize: 10, color: '#888', marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.optionName || '—'}</div>
                  <ResponsiveContainer width="100%" height={56}>
                    <LineChart data={r.mini} margin={{ top: 4, right: 4, bottom: 0, left: -30 }}>
                      <XAxis dataKey="label" hide />
                      <YAxis hide />
                      <Tooltip formatter={(v) => [`${v}개`, '평균']} labelStyle={{ fontSize: 11 }} contentStyle={{ fontSize: 11, padding: '4px 8px' }} />
                      <Line type="monotone" dataKey="value" stroke={dColor} strokeWidth={2} dot={{ r: 2 }} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 필터 바 */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="상품명·시즌 검색"
          style={{ padding: '6px 12px', fontSize: 13, border: '1px solid #ddd', borderRadius: 8, minWidth: 180 }} />
        <div style={{ display: 'flex', gap: 4 }}>
          {[['all', '전체'], ['up', '우상향'], ['down', '우하향'], ['flat', '보합']].map(([v, l]) => (
            <button key={v} onClick={() => setTrendFilter(v)} style={filterBtn(trendFilter === v)}>{l}</button>
          ))}
        </div>
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ padding: '6px 10px', fontSize: 13, border: '1px solid #ddd', borderRadius: 8 }}>
          {statusOptions.map(s => <option key={s} value={s}>{s === 'all' ? '전체 상태' : s}</option>)}
        </select>
        <select value={brandFilter} onChange={e => setBrandFilter(e.target.value)} style={{ padding: '6px 10px', fontSize: 13, border: '1px solid #ddd', borderRadius: 8, maxWidth: 160 }}>
          {brandOptions.map(b => <option key={b} value={b}>{b === 'all' ? '전체 브랜드' : b}</option>)}
        </select>
        <select value={seasonFilter} onChange={e => setSeasonFilter(e.target.value)} style={{ padding: '6px 10px', fontSize: 13, border: '1px solid #ddd', borderRadius: 8 }}>
          <option value="all">전체 시즌</option>
          {allTags.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 13, cursor: 'pointer' }}>
          <input type="checkbox" checked={inSeasonOnly} onChange={e => setInSeasonOnly(e.target.checked)} /> 시즌중만
        </label>
        <select value={sortKey} onChange={e => setSortKey(e.target.value)} style={{ padding: '6px 10px', fontSize: 13, border: '1px solid #ddd', borderRadius: 8 }}>
          <option value="brand">브랜드순</option>
          <option value="down">우하향순</option>
          <option value="up">우상향순</option>
          <option value="sales">판매량순</option>
        </select>
        <div style={{ display: 'flex', gap: 4, marginLeft: 'auto', alignItems: 'center' }}>
          <button onClick={() => setAllOpen(true)} style={{ fontSize: 12, padding: '5px 10px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer' }}>전체 펼치기</button>
          <button onClick={() => setAllOpen(false)} style={{ fontSize: 12, padding: '5px 10px', border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer' }}>전체 접기</button>
          <span style={{ fontSize: 12, color: '#999', marginLeft: 6 }}>{filtered.length}개 표시</span>
        </div>
      </div>

      {/* 로딩 */}
      {loading && (
        <div className="loading"><div className="spinner" />데이터를 불러오는 중...</div>
      )}

      {/* 리스트 대시보드 (제품 한 줄씩, 펼치면 넓은 차트) */}
      {!loading && (
        <div style={{ border: '1px solid #eaeaea', borderRadius: 12, overflow: 'hidden' }}>
          {filtered.slice(0, visibleCount).map((row, idx, arr) => {
            const color = TREND_COLOR[row.trend.dir];
            const open = isOpen(row);
            const { ticks, top } = niceTicks(Math.max(...row.vals, 0));
            const showBrandHeader = sortKey === 'brand' && (idx === 0 || (arr[idx - 1].brand || '') !== (row.brand || ''));
            return (
              <Fragment key={row.optionId}>
                {showBrandHeader && (
                  <div style={{ background: '#f3f5f8', padding: '6px 16px', fontSize: 12, fontWeight: 700, color: '#374151', borderTop: idx === 0 ? 'none' : '1px solid #e3e6ea' }}>
                    {row.brand || '(브랜드 없음)'}
                  </div>
                )}
                {/* 헤더 줄 (클릭 시 펼침) */}
                <div onClick={() => toggleOpen(row)} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 16px', cursor: 'pointer', borderTop: '1px solid #f0f0f0', background: row.inSeason ? '#fffdf5' : '#fff' }}>
                  <span style={{ width: 14, flexShrink: 0, color: '#999', fontSize: 11 }}>{open ? '▼' : '▶'}</span>
                  <div style={{ flex: '1 1 0', minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.productName}</div>
                    <div style={{ fontSize: 11, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.optionName || '—'}</div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                    <span style={{ fontSize: 11, color: '#5f6368', background: '#f1f3f4', borderRadius: 6, padding: '1px 7px' }}>{row.status || '상태없음'}</span>
                    <span style={{ fontSize: 11, color: '#444', background: '#eef1f5', borderRadius: 6, padding: '1px 7px' }}>평균 {row.avg}개</span>
                    {row.inSeason && <span style={{ fontSize: 11, color: '#b8860b', background: '#fff3cd', borderRadius: 6, padding: '1px 7px', fontWeight: 700 }}>시즌중</span>}
                    {(row.season.tags || []).map(t => (
                      <span key={t} style={{ fontSize: 11, color: '#1967d2', background: '#e8f0fe', borderRadius: 6, padding: '1px 7px' }}>{t}</span>
                    ))}
                    <span style={{ background: color, color: '#fff', fontSize: 11, fontWeight: 700, borderRadius: 8, padding: '2px 8px', minWidth: 84, textAlign: 'center' }}>
                      {row.trend.dir === 'up' ? '↑' : row.trend.dir === 'down' ? '↓' : '→'} {TREND_LABEL[row.trend.dir]}{row.trend.dir !== 'flat' && row.trend.streak >= STREAK_MIN ? ` ${row.trend.streak}${unit}째` : ''}
                    </span>
                    <button onClick={(e) => { e.stopPropagation(); openEdit(row); }} style={{ fontSize: 11, color: '#888', background: 'none', border: '1px dashed #ccc', borderRadius: 6, padding: '1px 7px', cursor: 'pointer' }}>시즌 편집</button>
                  </div>
                </div>

                {/* 펼친 차트 (가로 전체 폭) */}
                {open && (
                  <div style={{ padding: '8px 16px 18px', background: '#fafbfc', borderTop: '1px solid #f0f0f0' }}>
                    <ResponsiveContainer width="100%" height={240}>
                      <LineChart data={row.chartData} margin={{ top: 10, right: 24, bottom: 4, left: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#e8e8e8" />
                        <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#999' }} minTickGap={20} axisLine={{ stroke: '#ddd' }} tickLine={false} />
                        <YAxis domain={[0, top]} ticks={ticks} tick={{ fontSize: 10, fill: '#999' }} width={36} axisLine={{ stroke: '#ddd' }} tickLine={false} />
                        <Tooltip content={({ active, payload, label }) => {
                          if (!active || !payload) return null;
                          const p = payload.find(x => x.dataKey === 'value' && x.value != null);
                          if (!p) return null;
                          return (
                            <div style={{ background: '#fff', border: '1px solid #ddd', borderRadius: 6, padding: '6px 10px', fontSize: 12 }}>
                              <div style={{ color: '#888', marginBottom: 2 }}>{label}</div>
                              <div><b>{p.value}</b>개 {range === '30' ? '판매' : '주간 판매'}</div>
                            </div>
                          );
                        }} />
                        <ReferenceLine y={row.avg} stroke="#9aa0a6" strokeDasharray="5 4" label={{ value: `평균 ${row.avg}개`, position: 'insideTopRight', fontSize: 11, fill: '#888' }} />
                        <Line type="monotone" dataKey="pre" stroke="#c9ccd1" strokeWidth={2} strokeDasharray="5 4" dot={false} connectNulls={false} isAnimationActive={false} legendType="none" />
                        <Line type="monotone" dataKey="value" stroke={color} strokeWidth={2} dot={{ r: 2 }} activeDot={{ r: 4 }} connectNulls={false} isAnimationActive={false} />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </Fragment>
            );
          })}
        </div>
      )}

      {!loading && filtered.length > visibleCount && (
        <div style={{ textAlign: 'center', marginTop: 18 }}>
          <button onClick={() => setVisibleCount(c => c + 60)} style={{ padding: '8px 24px', fontSize: 13, borderRadius: 8, border: '1px solid #ddd', background: '#fff', cursor: 'pointer' }}>
            더 보기 ({filtered.length - visibleCount}개 남음)
          </button>
        </div>
      )}

      {!loading && !error && filtered.length === 0 && rows.length > 0 && (
        <div style={{ textAlign: 'center', padding: '60px 20px', color: '#aaa', fontSize: 14 }}>필터 조건에 맞는 상품이 없습니다.</div>
      )}

      {/* 시즌 편집 모달 */}
      {editing && (
        <div onClick={() => setEditing(null)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 14, padding: 22, width: 'min(440px, 92vw)', maxHeight: '86vh', overflowY: 'auto' }}>
            <h3 style={{ margin: '0 0 4px' }}>시즌 정보 편집</h3>
            <div style={{ fontSize: 12, color: '#888', marginBottom: 16 }}>변경 내용은 DB에 저장됩니다 (스프레드시트 대신 DB가 원본).</div>

            <label style={{ fontSize: 13, fontWeight: 600 }}>시즌기간 (월 범위)</label>
            <input value={editPeriod} onChange={e => setEditPeriod(e.target.value)} placeholder="예: 12~2 / 6~8 (빈칸=상시)"
              style={{ width: '100%', boxSizing: 'border-box', padding: '8px 10px', fontSize: 13, border: '1px solid #ddd', borderRadius: 8, margin: '6px 0 4px' }} />
            <div style={{ fontSize: 11, color: '#999', marginBottom: 16 }}>
              {(() => { const ms = parseSeasonMonths(editPeriod.trim()); return ms === null ? '상시 (연중 항상 시즌)' : `${[...ms].sort((a, b) => a - b).join(', ')}월 · ${isInSeasonNow(ms) ? '현재 시즌중' : '비시즌'}`; })()}
            </div>

            <label style={{ fontSize: 13, fontWeight: 600 }}>시즌 태그</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, margin: '8px 0 12px' }}>
              {allTags.map(t => (
                <button key={t} onClick={() => toggleEditTag(t)} style={{
                  fontSize: 12, padding: '4px 10px', borderRadius: 16, cursor: 'pointer',
                  border: editTags.includes(t) ? '1px solid #1967d2' : '1px solid #ddd',
                  background: editTags.includes(t) ? '#e8f0fe' : '#fff', color: editTags.includes(t) ? '#1967d2' : '#666', fontWeight: editTags.includes(t) ? 700 : 400,
                }}>{t}</button>
              ))}
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 18 }}>
              <input value={newTag} onChange={e => setNewTag(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') addCustomTag(); }} placeholder="새 시즌 태그 추가"
                style={{ flex: 1, padding: '7px 10px', fontSize: 13, border: '1px solid #ddd', borderRadius: 8 }} />
              <button onClick={addCustomTag} style={{ padding: '7px 14px', fontSize: 13, border: '1px solid #ddd', borderRadius: 8, background: '#f8f9fa', cursor: 'pointer' }}>추가</button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
              <button onClick={() => setEditing(null)} style={{ padding: '8px 18px', fontSize: 13, border: '1px solid #ddd', borderRadius: 8, background: '#fff', cursor: 'pointer' }}>취소</button>
              <button onClick={saveEdit} disabled={saving} style={{ padding: '8px 18px', fontSize: 13, border: 'none', borderRadius: 8, background: '#1a73e8', color: '#fff', cursor: 'pointer' }}>{saving ? '저장 중…' : '저장'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 토스트 */}
      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: toast.type === 'error' ? '#c5221f' : '#1e8e3e', color: '#fff', padding: '10px 20px', borderRadius: 10, fontSize: 13, zIndex: 1100, boxShadow: '0 2px 12px rgba(0,0,0,0.2)' }}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
