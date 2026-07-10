import { useState, useEffect, useCallback } from 'react';
import XLSX from 'xlsx-js-style';
import { dbStoreGet, dbStoreSet, dbGetCaution } from '../utils/dbApi';

// ───────── 상수 ─────────
const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`; // 재고 계산기
const CSV_BARCODE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('쿠팡바코드')}`;

const STORE_PREFIX = 'soldout_analysis_';
const SEASONS_STORE = 'sales_forecast_seasons';
const IMPROVE_STORE = 'improvement_items';

const FORECAST_DAYS = 90;     // 수요예측 일별 데이터 로딩 기간
const HORIZON_WEEKS = 4;      // 발주 커버 기간 (4주)
const HORIZON_DAYS = HORIZON_WEEKS * 7; // 28일 (예측 주간율 환산 기준)
const REVIEW_DAYS = 4; // 발주 주기 (월·금 발주, 최대 간격 4일)
const SAFETY_BUFFER_DAYS = 7; // 안전재고: 평균 7일치 여유분
const DEFAULT_LEAD_DAYS = 20; // AF열 리드타임 빈칸 시 기본값
const HOLT_ALPHA = 0.3;       // 레벨 평활 계수
const HOLT_BETA = 0.1;        // 트렌드 평활 계수
const PEAK_MULT = 1.2;        // 시즌피크: 입고예정일이 시즌 한가운데
const ENDING_MULT = 0.7;      // 끝물: 입고예정일이 시즌 마지막 달
const OFFSEASON_MULT = 0.2;   // 시즌밖 입고: 시즌 종료 후 도착 — 트리클(소량)만 채움

const VOC_ACTIVE_STATUS = ['처리중', '시작전'];
const VOC_TARGET_TYPE = ['상품문제', '재수배'];

// 대량구매(1인 몰아사기) 의심 판정 — 이번주 일별에서 특정 하루가 튀는 경우
const SPIKE_RATIO = 3;        // 그날 판매 ≥ 나머지 요일 평균의 3배
const SPIKE_MIN_QTY = 12;     // 그날 판매 ≥ 12개 (자잘한 알럿 방지 하한)
const CORRECTIONS_STORE = 'order_recommend_corrections'; // 보정 저장소 (날짜_옵션ID 키)
const CORRECTION_MAX_AGE_DAYS = 30; // 30일 초과 보정 기록은 로드 시 자동 정리

// 발주추천 태그별 색상 (필터/식별용)
const TAG_COLORS = {
  '시즌피크': { bg: '#fce8e6', fg: '#c5221f' },
  '끝물발주': { bg: '#feefc3', fg: '#b06000' },
  '시즌밖발주': { bg: '#fef7e0', fg: '#9a6700' },
  '일반발주': { bg: '#e6f4ea', fg: '#1e8e3e' },
  '시즌마감보류': { bg: '#e8eaed', fg: '#5f6368' },
  '재고충분': { bg: '#e8f0fe', fg: '#1a73e8' },
  '제외': { bg: '#f1f3f4', fg: '#80868b' },
  '데이터없음': { bg: '#f1f3f4', fg: '#bdc1c6' },
};

// 판매중이 아닌 제외 대상(발주추천 안 함) — 수요예측과 동일 기준
const EXCLUDE_KEYWORDS = ['최종마감', '품질확인서', '마감대상', '덤핑'];
function shouldExclude(s) { return s ? EXCLUDE_KEYWORDS.some(kw => s.includes(kw)) : false; }

// ───────── helpers ─────────
function safeNum(v) { if (v === '' || v === '-' || v == null) return 0; const n = Number(v); return isNaN(n) ? 0 : n; }
function pad2(n) { return String(n).padStart(2, '0'); }
function dateToKey(d) { return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`; }

function parseCsvRow(line) {
  const result = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) { if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; } else if (ch === '"') inQuotes = false; else current += ch; }
    else { if (ch === '"') inQuotes = true; else if (ch === ',') { result.push(current); current = ''; } else current += ch; }
  }
  result.push(current); return result;
}

// 시즌기간("12~2 / 6~8") → 해당 월 Set. 숫자 없으면 null(=상시).
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
  if (months.size === 0) { for (const s of singles) { const v = +s; if (v >= 1 && v <= 12) months.add(v); } }
  return months.size ? months : null;
}

// 이동평균 (들쭉날쭉한 일별값 평탄화)
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

// 추세 판정: 7일 이동평균 방향. 우상향/우하향/보합.
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

// 가장 최근 데이터일을 기준으로 bucketDays씩 뒤로 끊는 롤링 윈도우.
// 첫 데이터일 기준이 아니라 "오늘 기준 최근 7일/8~14일/…"로 묶어, 최근 며칠이 항상 포함되게 한다.
// 반환: 오래된→최근 순의 [[keys],...]
function makeRecentWindows(availKeys, bucketDays) {
  if (availKeys.length === 0) return [];
  const last = availKeys[availKeys.length - 1]; // 최근 데이터일을 앵커로
  const anchor = new Date(+last.slice(0, 4), +last.slice(4, 6) - 1, +last.slice(6, 8));
  const map = new Map();
  for (const k of availKeys) {
    const d = new Date(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));
    const daysAgo = Math.floor((anchor - d) / 86400000);
    const wi = Math.floor(daysAgo / bucketDays); // 0 = 최근 윈도우
    if (!map.has(wi)) map.set(wi, []);
    map.get(wi).push(k);
  }
  // wi 큰값(오래됨) → 작은값(최근) 순으로 정렬 = 오래된→최근
  return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([, keys]) => keys);
}

// 트렌드보정 지수평활(Holt 선형) → 4주 누적 예측.
//  L = α·실제 + (1-α)(전L + 전T),  T = β(L - 전L) + (1-β)·전T,  예측 = L + k·T (k=1..4) 누적
function holtCumForecast(weekly) {
  const n = weekly.length;
  if (n < 2) return null;
  let L = weekly[0];
  let T = 0; // 초기 추세 0 — 런치 램프/노이즈로 인한 추세 폭주 방지
  for (let t = 1; t < n; t++) {
    const prevL = L;
    L = HOLT_ALPHA * weekly[t] + (1 - HOLT_ALPHA) * (L + T);
    T = HOLT_BETA * (L - prevL) + (1 - HOLT_BETA) * T;
  }
  let sum = 0;
  for (let k = 1; k <= HORIZON_WEEKS; k++) sum += Math.max(0, L + k * T);
  return sum;
}

// 최근 4주 가중평균 × 4주. 최근 주에 큰 가중치 — 4주전→1주전 = 1 / 1.5 / 2.5 / 4
const RECENT_WEIGHTS = [1, 1.5, 2.5, 4]; // 오래된→최근 (HORIZON_WEEKS=4 기준)
const SENSITIVE_WEIGHTS = [0.5, 1, 2, 6]; // 재고주수 4주 미만: 최근 1주에 더 민감(최근≈63%)
function weightedCumForecast(weekly, weights = RECENT_WEIGHTS) {
  const recent = weekly.slice(-HORIZON_WEEKS);
  const n = recent.length;
  if (n === 0) return 0;
  const w = weights.slice(-n); // 데이터가 4주 미만이면 최근쪽 가중치만 사용
  let wsum = 0, vsum = 0;
  for (let i = 0; i < n; i++) { wsum += w[i]; vsum += recent[i] * w[i]; }
  return (vsum / wsum) * HORIZON_WEEKS;
}

export default function OrderRecommend() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [dataDays, setDataDays] = useState(0);
  const [corrections, setCorrections] = useState({});   // 저장된 보정 { "YYYYMMDD_옵션ID": {corrected|ignored} }
  const [spikes, setSpikes] = useState([]);             // 보정 대상 목록 (유형1/2)
  const [showCorrModal, setShowCorrModal] = useState(false);
  const [corrDraft, setCorrDraft] = useState({});       // 모달 임시 입력 { spikeId: {value|ignored} }
  const [savingCorr, setSavingCorr] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const dayList = [];
      for (let i = FORECAST_DAYS - 1; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); dayList.push(d); }

      const [calcRes, barcodeRes, dbSeasons, dbImprove, dbCorrections, dbCaution, ...stores] = await Promise.all([
        fetch(TSV_CALC),
        fetch(CSV_BARCODE),
        dbStoreGet(SEASONS_STORE).catch(() => null),
        dbStoreGet(IMPROVE_STORE).catch(() => null),
        dbStoreGet(CORRECTIONS_STORE).catch(() => null),
        dbGetCaution().catch(() => new Set()),
        ...dayList.map(d => dbStoreGet(`${STORE_PREFIX}${dateToKey(d)}`).catch(() => null)),
      ]);
      const cautionSet = (dbCaution instanceof Set) ? dbCaution : new Set();

      // 대량구매 보정: { "YYYYMMDD_옵션ID": { corrected } | { ignored } }. 30일 초과분 자동 정리.
      const corrections = (dbCorrections && typeof dbCorrections === 'object') ? dbCorrections : {};
      const pruneBefore = new Date(); pruneBefore.setHours(0, 0, 0, 0); pruneBefore.setDate(pruneBefore.getDate() - CORRECTION_MAX_AGE_DAYS);
      let prunedAny = false;
      for (const ck of Object.keys(corrections)) {
        const dkey = ck.slice(0, 8);
        const cd = new Date(+dkey.slice(0, 4), +dkey.slice(4, 6) - 1, +dkey.slice(6, 8));
        if (!(cd >= pruneBefore)) { delete corrections[ck]; prunedAny = true; }
      }
      if (prunedAny) dbStoreSet(CORRECTIONS_STORE, corrections, { skipLog: true }).catch(() => {});
      setCorrections(corrections);
      // 보정 적용값 조회 (corrected 있으면 교체)
      const corrQty = (key, oid, raw) => {
        const c = corrections[`${key}_${oid}`];
        return (c && typeof c.corrected === 'number') ? c.corrected : raw;
      };

      // 일별 판매 (옵션id → 판매량)
      const itemsByKey = {};
      const availKeys = [];
      const appeared = new Set();
      dayList.forEach((d, i) => {
        const st = stores[i];
        if (!st?.items) return;
        const key = dateToKey(d);
        const m = new Map();
        for (const it of st.items) { m.set(it.optionId, it.salesQty || 0); appeared.add(it.optionId); }
        itemsByKey[key] = m;
        availKeys.push(key);
      });
      setDataDays(availKeys.length);
      // 최근 데이터일 기준 7일 롤링 윈도우 [[keys],...] 오래된→최근.
      // 최근 며칠(진행 중 주)도 항상 포함된다 — 예전처럼 부분 주를 잘라내지 않음.
      const useBuckets = makeRecentWindows(availKeys, 7);
      // 이번주(최근 7일 버킷) — 대량구매/0판매 스파이크 감지 대상. 오래된→최근 순.
      const recentBucket = useBuckets.length ? useBuckets[useBuckets.length - 1] : [];
      const spikeList = []; // 보정 알럿 목록

      // 시즌기간 시드: 쿠팡바코드 시트 Q(16) → 옵션id별 period
      const seedPeriod = {};
      try {
        const bcCsv = await barcodeRes.text();
        const bcLines = bcCsv.split('\n').filter(l => l.trim());
        for (let i = 1; i < bcLines.length; i++) {
          const c = parseCsvRow(bcLines[i]);
          const oid = (c[1] || '').trim();
          if (oid) seedPeriod[oid] = (c[16] || '').trim();
        }
      } catch { /* 시즌 시드 실패 시 DB값만 사용 */ }
      const seasons = dbSeasons || {};
      // DB에 키가 있으면(시즌 삭제로 빈칸이어도) DB값 우선 — 시트 시드로 부활 방지.
      // 빈칸 period는 seasonMult에서 '상시'(보정 없음)로 처리됨.
      const periodOf = (oid) => (oid in seasons) ? (seasons[oid].period || '') : (seedPeriod[oid] || '');

      // VOC: 쿠팡바코드 → 상품문제/재수배 & 처리중/시작전
      const vocBarcodes = new Set();
      for (const it of (Array.isArray(dbImprove) ? dbImprove : [])) {
        if (!it.barcode) continue;
        if (VOC_ACTIVE_STATUS.includes(it.status) && VOC_TARGET_TYPE.includes(it.type)) {
          vocBarcodes.add(it.barcode);
        }
      }

      // 시즌 보정 계수 — 입고예정일(오늘+리드타임) 기준 판정
      const now = new Date();
      const curM = now.getMonth() + 1;
      // 현재 시즌 중인 상품만 입고예정일로 보정. 시즌 밖이면 baseF가 이미 비시즌 속도라 보정 없음.
      function seasonMult(period, arrival) {
        const months = parseSeasonMonths(period);
        if (!months) return 1;            // 상시(시즌 미지정)
        if (!months.has(curM)) return 1;  // 현재 시즌 아님(시즌 전/후) → 보정 없음
        const aM = arrival.getMonth() + 1;
        const aNextM = aM === 12 ? 1 : aM + 1;
        if (!months.has(aM)) return OFFSEASON_MULT;  // 입고예정이 시즌밖 → 트리클만 ×0.2
        if (!months.has(aNextM)) return ENDING_MULT; // 입고예정이 시즌 마지막 달 → ×0.7
        return PEAK_MULT;                            // 시즌 한가운데 → ×1.2
      }

      // 재고 계산기: 시트 순서 그대로 전 품목
      const calcText = await calcRes.text();
      const calcLines = calcText.split('\n');
      const out = [];
      // 마지막 실제 상품 행 위치(이후 빈 패딩 행은 출력 제외)
      let lastProductIdx = 0;
      for (let i = 1; i < calcLines.length; i++) {
        if ((calcLines[i].split('\t')[2] || '').trim()) lastProductIdx = i;
      }
      for (let i = 1; i <= lastProductIdx; i++) {
        const line = calcLines[i];
        const c = line.split('\t');
        const barcode = (c[2] || '').trim();
        const productName = (c[3] || '').trim();
        // 시트의 상품 간 간격(빈 행)은 그대로 유지 — 세로 복붙 정렬용
        if (!barcode && !productName) {
          out.push({ spacer: true, barcode: '', productName: '', optionName: '', status: '', recQty: '', sPos: '', tPos: '', note: '', weeksStock: '', totalStock: '', reason: '', tag: '', kws: [] });
          continue;
        }
        if (!barcode) continue; // 바코드 없는 비정상 행 제외
        const optionId = (c[1] || '').trim();
        const optionName = (c[4] || '').trim();
        const status = (c[5] || '').trim();
        const totalStock = safeNum(c[14]);          // O열 총재고 (그로스+박스히어로+미입고 구매분 포함)
        const leadRaw = (c[31] || '').trim();        // AF열 리드타임(일)
        const leadDays = (leadRaw === '' || isNaN(Number(leadRaw))) ? DEFAULT_LEAD_DAYS : Number(leadRaw);
        const orderUnit = (c[17] || '').trim();      // R열 발주단위
        const sRaw = safeNum(c[18]);
        const tRaw = safeNum(c[19]);
        const sPos = sRaw < 0 ? Math.abs(sRaw) : ''; // S열: 음수(발주필요)만 양수화, 양수는 공백
        const tPos = tRaw < 0 ? Math.abs(tRaw) : ''; // T열: 음수(발주필요)만 양수화, 양수는 공백
        const wRaw = (c[22] || '').trim();           // W열 총재고 주치
        const weeksStock = (wRaw === '' || isNaN(Number(wRaw))) ? '' : Number(wRaw);

        let recQty = '';
        let reason = '';
        let tag = '';
        let kws = [];                              // 엑셀 사유 키워드(사유1~5)
        let isUrgent = false, isCautionRow = false;

        // 최종마감·품질확인서 등 판매중 아닌 대상은 발주추천 제외
        if (shouldExclude(status)) {
          tag = '제외';
        } else {
          // 6주 판매 예측치 F
          let baseF = null;
          let method = '';
          if (optionId && appeared.has(optionId)) {
            // 보정값(corrected) 반영한 일별/주간 판매
            const dailyVals = availKeys.map(k => corrQty(k, optionId, itemsByKey[k].get(optionId) || 0));
            // 주간 판매 합 (음수=반품/보정은 0으로 정리)
            const weeklyVals = useBuckets.map(ks => Math.max(0, ks.reduce((s, k) => s + corrQty(k, optionId, itemsByKey[k].get(optionId) || 0), 0)));
            const down = computeTrend(dailyVals, 7).dir === 'down';
            const weighted = weightedCumForecast(weeklyVals);
            const urgent = typeof weeksStock === 'number' && weeksStock < 4;
            const isCaution = cautionSet.has(optionId);
            isUrgent = urgent; isCautionRow = isCaution;
            if (urgent || isCaution) {
              // 재고주수 4주 미만 또는 주의품목: 최근 1주 민감가중(0.5/1/2/6) — 등락 민감 반영(Holt 미사용)
              baseF = weightedCumForecast(weeklyVals, SENSITIVE_WEIGHTS);
              method = urgent ? '긴급민감' : '주의민감';
            } else if (down && weeklyVals.length >= 3) {
              const holt = holtCumForecast(weeklyVals);
              // 우하향: Holt 예측이 평탄 가중평균을 넘지 못하게 캡 — 감소 상품 과발주 방지
              baseF = (holt == null) ? weighted : Math.min(holt, weighted);
              method = 'Holt';
            } else {
              baseF = weighted;
              method = '가중평균';
            }
          }

          if (baseF == null) {
            tag = '데이터없음';
          } else {
            // 입고예정일 = 오늘 + 리드타임 → 시즌 보정에 사용
            const arrivalDate = new Date(now);
            arrivalDate.setDate(arrivalDate.getDate() + leadDays);
            const mult = seasonMult(periodOf(optionId), arrivalDate);
            // 커버일수 = 리드타임 + 발주주기 + 안전. baseF(4주=28일 예측)를 커버일수로 비례 확대.
            const coverDays = leadDays + REVIEW_DAYS + SAFETY_BUFFER_DAYS;
            const demand = baseF * (coverDays / HORIZON_DAYS) * mult;
            const q = Math.ceil(demand - totalStock);
            const demandRound = Math.round(demand);
            const seasonTxt = mult === PEAK_MULT ? '·시즌피크 ×1.2'
              : mult === ENDING_MULT ? '·시즌 끝물 ×0.7'
              : mult === OFFSEASON_MULT ? '·시즌밖 입고 ×0.2' : '';
            if (q > 0) {
              recQty = Math.ceil(q / 10) * 10; // 추천 발주량은 10단위 올림(1의 자리 → 0)
              const fRound = Math.round(baseF);
              const methodTxt = method === 'Holt'
                ? `우하향 추세 ${HORIZON_WEEKS}주예측 필요재고 ${fRound}개`
                : method === '긴급민감'
                ? `긴급(재고주수 ${weeksStock}주) 최근1주 민감가중 ${HORIZON_WEEKS}주예측 필요재고 ${fRound}개`
                : method === '주의민감'
                ? `주의품목 최근1주 민감가중 ${HORIZON_WEEKS}주예측 필요재고 ${fRound}개`
                : `${HORIZON_WEEKS}주예측 필요재고 ${fRound}개`;
              reason = `${methodTxt}${seasonTxt} → 커버 ${coverDays}일(리드 ${leadDays}) 수요 ${demandRound} − 재고 ${totalStock} = ${q}`;
              // 엑셀 사유 키워드 — 적용된 것만 순서대로(사유1~5)
              if (method === 'Holt') kws.push('우하향');
              if (mult === PEAK_MULT) kws.push('시즌피크');
              else if (mult === ENDING_MULT) kws.push('끝물');
              else if (mult === OFFSEASON_MULT) kws.push('시즌밖');
              if (leadDays > DEFAULT_LEAD_DAYS) kws.push('리드타임');
              if (isUrgent) kws.push('긴급');
              if (isCautionRow) kws.push('주의품목');
              tag = mult === PEAK_MULT ? '시즌피크'
                : mult === ENDING_MULT ? '끝물발주'
                : mult === OFFSEASON_MULT ? '시즌밖발주' : '일반발주';
            } else {
              // 발주 없음. 시즌 보정(×0.7·×0.2)으로 빠졌고, 원래(시즌피크 ×1.2)였다면 발주대상이던 경우만 사유/태그 표시.
              const peakDemand = baseF * (coverDays / HORIZON_DAYS) * PEAK_MULT;
              const qPeak = Math.ceil(peakDemand - totalStock);
              if ((mult === ENDING_MULT || mult === OFFSEASON_MULT) && qPeak > 0) {
                const arrLabel = `${arrivalDate.getFullYear()}-${pad2(arrivalDate.getMonth() + 1)}-${pad2(arrivalDate.getDate())}`;
                const adjTxt = mult === OFFSEASON_MULT
                  ? `시즌(${periodOf(optionId)}) 종료 후 도착 ×0.2`
                  : `시즌(${periodOf(optionId)}) 끝물 도착 ×0.7`;
                reason = `원래 ${qPeak}개 발주 대상이나, 입고예정 ${arrLabel} ${adjTxt}로 보정 → 보정수요 ${demandRound} ≤ 재고 ${totalStock}, 발주안함`;
                tag = '시즌마감보류';
              } else {
                tag = '재고충분';
                // 재고주수 5주 미만인데 재고충분인 상품 — 왜 충분한지 사유 표시
                if (typeof weeksStock === 'number' && weeksStock < 5) {
                  kws.push(`수요 ${demandRound} ≤ 재고 ${totalStock}`);
                }
              }
            }
          }
        }

        // ── 보정 알럿 스파이크 감지 (이번주 원본값 기준) + 이미 반영된 보정 표시 ──
        if (optionId && recentBucket.length >= 1 && !shouldExclude(status)) {
          const wk = recentBucket.map(k => ({ key: k, qty: itemsByKey[k]?.get(optionId) || 0 }));
          // 유형1: 대량구매 의심 — 그날 ≥12 & 나머지 요일 평균의 3배↑ (여러 날 가능)
          if (wk.length >= 3) {
            const flagged = [];
            for (let j = 0; j < wk.length; j++) {
              const qty = wk[j].qty;
              if (qty < SPIKE_MIN_QTY) continue;
              let os = 0; for (let m = 0; m < wk.length; m++) if (m !== j) os += wk[m].qty;
              const avgOthers = os / (wk.length - 1);
              if (qty >= SPIKE_RATIO * avgOthers) flagged.push({ key: wk[j].key, qty, avgOthers });
            }
            if (flagged.length) spikeList.push({ id: `bulk_${optionId}`, type: 'bulk', optionId, barcode, productName, optionName, week: wk, flagged });
          }
          // 유형2: 주의품목 0판매 — 이번주 0인 날 전부
          if (cautionSet.has(optionId)) {
            const zeros = wk.filter(d => d.qty === 0).map(d => ({ key: d.key, qty: 0 }));
            if (zeros.length) spikeList.push({ id: `caution0_${optionId}`, type: 'caution0', optionId, barcode, productName, optionName, week: wk, flagged: zeros });
          }
        }
        // 이미 저장된 보정이 이번주에 적용됐으면 사유에 표시
        if (optionId) {
          const cp = [];
          for (const k of recentBucket) {
            const cc = corrections[`${k}_${optionId}`];
            if (cc && typeof cc.corrected === 'number') { const raw = itemsByKey[k]?.get(optionId) || 0; cp.push(`${k.slice(4, 6)}-${k.slice(6, 8)} ${raw}→${cc.corrected}`); }
          }
          if (cp.length) reason = (reason ? reason + ' | ' : '') + `판매보정(${cp.join(', ')})`;
        }

        // 비고
        const noteParts = [];
        if (orderUnit) noteParts.push(orderUnit);
        if (vocBarcodes.has(barcode)) noteParts.push('voc 확인');
        const note = noteParts.join(', ');

        out.push({ barcode, productName, optionName, status, recQty, sPos, tPos, note, weeksStock, totalStock, reason, tag, kws });
      }

      setRows(out);
      setSpikes(spikeList);
      // 아직 보정/무시 안 한 날(pending)이 하나라도 있으면 자동으로 모달 오픈
      const hasPending = spikeList.some(sp => sp.flagged.some(f => !corrections[`${f.key}_${sp.optionId}`]));
      setShowCorrModal(hasPending);
      setCorrDraft({});
      setLastUpdated(new Date());
      if (availKeys.length === 0) setError('수요예측 일별 데이터가 없어 계산 발주량은 모두 공백입니다. (S/T 열은 시트값으로 표시)');
    } catch (e) {
      setError('데이터 로딩 실패: ' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // 모달 입력 → 저장 → DB 반영 → 재계산
  const applyCorrections = async () => {
    setSavingCorr(true);
    const next = { ...corrections };
    for (const sp of spikes) {
      const draft = corrDraft[sp.id];
      if (!draft) {
        // 손 안 댄 행: 이미 저장된 값(corrected/ignored)이 flagged 날짜 중 하나라도 있으면
        // 나머지 flagged 날짜에도 같은 값을 채워 부분저장으로 인한 모달 재오픈을 방지.
        const saved = sp.flagged.map(f => next[`${f.key}_${sp.optionId}`]).find(Boolean);
        if (saved) for (const f of sp.flagged) next[`${f.key}_${sp.optionId}`] = saved;
        continue;
      }
      if (draft.reset) { for (const f of sp.flagged) delete next[`${f.key}_${sp.optionId}`]; }
      else if (draft.ignored) { for (const f of sp.flagged) next[`${f.key}_${sp.optionId}`] = { ignored: true }; }
      else if (draft.value !== undefined && draft.value !== '') {
        const m = Number(draft.value);
        if (!isNaN(m) && m >= 0) for (const f of sp.flagged) next[`${f.key}_${sp.optionId}`] = { corrected: m };
      }
    }
    await dbStoreSet(CORRECTIONS_STORE, next, { logDesc: '발주추천 판매 보정' }).catch(() => {});
    setSavingCorr(false);
    setShowCorrModal(false);
    await load(); // 보정 반영해 추천 발주량·엑셀 재계산
  };

  const pendingSpikeCount = spikes.reduce((n, sp) => n + (sp.flagged.some(f => !corrections[`${f.key}_${sp.optionId}`]) ? 1 : 0), 0);

  const exportExcel = () => {
    const header = ['쿠팡바코드', '상품명', '옵션명', '상태', '추천 발주량', '태그', 'S열 발주필요', 'T열 발주필요', '비고', '재고주수(W)', '현재 총재고', '사유1', '사유2', '사유3', '사유4', '사유5'];
    const aoa = [header, ...rows.map(r => {
      const kw = r.kws || [];
      return [r.barcode, r.productName, r.optionName, r.status, r.recQty, r.tag, r.sPos, r.tPos, r.note, r.weeksStock, r.totalStock, kw[0] || '', kw[1] || '', kw[2] || '', kw[3] || '', kw[4] || ''];
    })];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 16 }, { wch: 28 }, { wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 11 }, { wch: 12 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 10 }];
    // 전체 셀 폰트 Arial 적용 (헤더는 굵게)
    const WEEKS_COL = 9; // 재고주수(W) 컬럼 인덱스
    const NOTE_COL = 8; // 비고 컬럼 인덱스
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r; R <= range.e.r; R++) {
      for (let C = range.s.c; C <= range.e.c; C++) {
        const addr = XLSX.utils.encode_cell({ r: R, c: C });
        const cell = ws[addr];
        if (!cell) continue;
        cell.s = { ...(cell.s || {}), font: { ...((cell.s && cell.s.font) || {}), name: 'Arial', bold: R === 0 } };
        // 재고주수 4 미만(재고 부족)이면 연한 빨강 채움
        if (C === WEEKS_COL && R > 0 && typeof cell.v === 'number' && cell.v < 4) {
          cell.s.fill = { patternType: 'solid', fgColor: { rgb: 'FCE8E6' } };
        }
        // 비고에 VOC 확인이 있으면 진한 빨강 채움(글자 흰색)
        if (C === NOTE_COL && R > 0 && typeof cell.v === 'string' && /voc/i.test(cell.v)) {
          cell.s.fill = { patternType: 'solid', fgColor: { rgb: 'CC0000' } };
          cell.s.font = { ...cell.s.font, color: { rgb: 'FFFFFF' }, bold: true };
        }
      }
    }
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '발주추천');
    XLSX.writeFile(wb, `발주추천_${dateToKey(new Date())}.xlsx`);
  };

  const orderCount = rows.filter(r => r.recQty !== '' && r.recQty > 0).length;
  const productCount = rows.filter(r => r.barcode).length;

  return (
    <div className="card">
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } details.dd > summary::-webkit-details-marker { display: none; }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <details className="dd" style={{ position: 'relative' }}>
            <summary style={{ cursor: 'pointer', listStyle: 'none', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: '1px solid #d2e8d8', background: '#fff', color: '#1e8e3e', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
              </svg>
              추천 발주량 계산 로직
            </summary>
            <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 20, width: 560, maxWidth: '88vw', maxHeight: '70vh', overflowY: 'auto', background: '#fff', border: '1px solid #e8eaed', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: '14px 16px', fontSize: 12.5, color: '#3c4043', lineHeight: 1.7 }}>
          <div style={{ marginBottom: 6 }}><b>① 데이터 매칭</b> — 재고계산기 시트의 각 상품을 <b>옵션ID</b>로 수요예측 일별 판매 데이터와 매칭합니다.</div>
          <div style={{ marginBottom: 6 }}><b>② 4주 판매 예측 (F)</b> — <b>오늘 기준 최근 7일/8~14일/15~21일/22~28일</b>로 묶어(진행 중인 최근 며칠도 항상 포함),
            우하향(감소) 추세 상품은 <b>Holt 선형추세 지수평활</b>로, 그 외는 <b>최근 4주 가중평균</b>(최근일수록 가중)으로 향후 4주 판매량을 예측합니다.
            (우하향 상품의 Holt 예측은 과발주 방지를 위해 가중평균을 넘지 않도록 캡)
            <div style={{ marginTop: 6, marginLeft: 14, padding: '8px 12px', background: '#fff', border: '1px solid #e8eaed', borderRadius: 8, color: '#5f6368', fontSize: 12 }}>
              <div style={{ marginBottom: 4 }}>• <b>최근 4주 가중평균</b> : 4주전→1주전에 <u>가중치 1 / 1.5 / 2.5 / 4</u>를 줘서 평균냅니다(최근 1주가 4주전의 4배).
                예) 4주 전부터 <code>10·20·30·40</code>개 팔렸으면 단순평균은 25지만, 이 가중이면 <b>약 31개</b> 쪽으로 계산 → 최근 흐름을 강하게 반영.</div>
              <div>• <b>Holt 선형추세 지수평활</b> : 판매가 꾸준히 줄고 있는(우하향) 상품에 쓰는 방식으로,
                현재 <u>판매 수준(level)</u>과 <u>주마다 늘거나 줄어드는 변화량(trend)</u> 두 가지를 함께 추정해서
                "<b>지금 추세대로 가면 4주 뒤엔 얼마나 팔릴까</b>"를 예측합니다. 감소세가 이어지면 예측치도 따라 낮아져 과발주를 막습니다.</div>
            </div></div>
          <div style={{ marginBottom: 6 }}><b>③ 시즌 보정 — "물건이 도착하는 날" 기준</b>
            <div style={{ marginTop: 2 }}>오늘 발주분이 입고되는 날(<b>오늘 + 리드타임</b>)이 시즌의 어디에 떨어지는지로 계수를 정합니다.</div>
            <div style={{ marginTop: 6, marginLeft: 14, padding: '8px 12px', background: '#fff', border: '1px solid #e8eaed', borderRadius: 8, color: '#5f6368', fontSize: 12 }}>
              <div>• 입고가 <b>시즌 한가운데</b> → <b style={{ color: '#c5221f' }}>×1.2</b> (피크, 넉넉히)</div>
              <div>• 입고가 <b>시즌 마지막 달</b> → <b style={{ color: '#b06000' }}>×0.7</b> (끝물, 줄임)</div>
              <div>• 입고가 <b>시즌 끝난 뒤</b> → <b style={{ color: '#9a6700' }}>×0.2</b> (시즌밖 소량분만)</div>
              <div>• <b>현재 시즌이 아님(전·후)·상시 상품</b> → 보정 없음 (×1.0)</div>
            </div>
            <div style={{ marginTop: 4 }}>→ 리드타임이 길어 물건이 시즌 끝난 뒤 도착하면 발주가 자동으로 확 줄어 <b>끝물 과발주</b>를 막습니다.</div></div>
          <div style={{ marginBottom: 6 }}><b>④ 리드타임 · 커버기간</b> — 커버기간 = <b>리드타임(AF열) + 발주주기 {REVIEW_DAYS}일 + 안전 {SAFETY_BUFFER_DAYS}일</b>.
            발주주기·안전은 고정값(월·금 주 2회 발주 기준)이고, AF열이 비면 리드타임 <b>{DEFAULT_LEAD_DAYS}일</b> 기본 적용. 4주예측 F를 이 커버일수에 맞춰 환산합니다.</div>
          <div style={{ marginBottom: 6 }}><b>⑤ 추천 발주량</b> = <b>올림( F × (커버일수 ÷ 28) × 시즌계수 − O열 총재고 )</b>.
            O열 총재고는 <u>그로스 + 박스히어로 + 미입고(오고있는) 구매분</u>을 모두 포함하므로 중복발주가 방지됩니다. 결과가 0 이하거나 예측 데이터가 없으면 공백.
            <div style={{ marginTop: 6, marginLeft: 14, padding: '8px 12px', background: '#f8faf9', border: '1px solid #e8eaed', borderRadius: 8, fontSize: 12 }}>
              <b>예시</b> — 리드 30 · 4주예측 필요재고 84개 · 시즌피크 ×1.2 → 커버 41일, 수요 84×(41÷28)×1.2 ≈ <b>148</b>, 재고 132 → 추천 <b>16개</b>.</div></div>
          <div style={{ marginBottom: 6 }}><b>⑥ 태그(분류) — 엑셀에서 필터로 빠르게 거를 수 있습니다</b>
            <div style={{ marginTop: 6, marginLeft: 14, fontSize: 12, lineHeight: 1.9 }}>
              {[
                ['시즌피크', '×1.2로 발주'],
                ['끝물발주', '×0.7인데 재고 부족해 발주'],
                ['시즌밖발주', '×0.2 소량 발주'],
                ['일반발주', '상시·시즌전후 정상 발주'],
                ['시즌마감보류', '원래 발주대상인데 시즌 끝물/밖 보정으로 빠짐'],
                ['재고충분', '재고가 많아 발주 불필요'],
                ['제외', '최종마감·품질확인서 등 상태 제외'],
                ['데이터없음', '수요예측 매칭 데이터 없음'],
              ].map(([t, d]) => {
                const c = TAG_COLORS[t];
                return (<div key={t}><span style={{ display: 'inline-block', minWidth: 78, textAlign: 'center', padding: '1px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: c.bg, color: c.fg, marginRight: 6 }}>{t}</span>{d}</div>);
              })}
            </div></div>
          <div style={{ marginBottom: 6 }}><b>⑦ 사유 읽는 법</b> — 사유 칸은 아래 순서로 읽으면 됩니다(숫자는 정수 표기).
            <div style={{ marginTop: 6, marginLeft: 14, padding: '8px 12px', background: '#fff', border: '1px solid #e8eaed', borderRadius: 8, fontSize: 12, color: '#5f6368' }}>
              <div style={{ fontFamily: 'monospace', color: '#3c4043' }}>우하향 추세 4주예측 필요재고 84개·시즌피크 ×1.2 → 커버 41일(리드 30) 수요 148 − 재고 132 = 16</div>
              <div style={{ marginTop: 4 }}>= [예측방식] · 4주예측 <u>필요재고 F</u> · [시즌계수] → 커버 <u>총일수</u>(리드 <u>일</u>) · <u>환산수요</u> − <u>O열 총재고</u> = <b>추천량</b></div>
            </div></div>
          <div><b>⑧ 제외 대상 & 표 보기</b> — 최종마감 · 품질확인서 · 마감대상 · 덤핑 상태는 발주추천에서 제외됩니다.
            표의 <b>재고주수(W)</b> 값이 <b>4 미만</b>이면 셀이 연한 빨강으로 표시(재고 부족 경고)되고, <b>현재 총재고</b> 컬럼에서 O열 총재고를 바로 볼 수 있습니다.</div>
        </div>
      </details>

          <details className="dd" style={{ position: 'relative' }}>
            <summary style={{ cursor: 'pointer', listStyle: 'none', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: '1px solid #d2e8d8', background: '#fff', color: '#1e8e3e', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
              </svg>
              Holt 계산 기준 & 계산법
            </summary>
            <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 20, width: 560, maxWidth: '88vw', maxHeight: '70vh', overflowY: 'auto', background: '#fff', border: '1px solid #e8eaed', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: '14px 16px', fontSize: 12.5, color: '#3c4043', lineHeight: 1.7 }}>
          <div style={{ marginBottom: 10, padding: '8px 12px', background: '#f8faf9', border: '1px solid #e8eaed', borderRadius: 8 }}>
            <b>현재 계산 기준</b> — 레벨 평활계수 α = <b>{HOLT_ALPHA}</b>, 트렌드 평활계수 β = <b>{HOLT_BETA}</b>, 예측 기간 <b>{HORIZON_WEEKS}주</b>.
            적용 조건: <u>우하향 추세 + 완전한 7일 주 데이터 3주 이상</u>일 때만 Holt 사용(그 외 가중평균).
            주간 판매는 반품·보정으로 음수가 나오면 0으로 정리하고, 완전하지 않은(7일 미만) 마지막 주는 제외하며,
            최종 예측치는 <u>최근 4주 가중평균을 넘지 않도록 캡</u>합니다.
          </div>

          <div style={{ marginBottom: 6 }}><b>두 값이 뭘 추정하나</b></div>
          <div style={{ marginBottom: 4, marginLeft: 8 }}>• <b>레벨(level, L)</b> = 지금 현재의 판매 "수준" (이번 주 대략 몇 개 팔리는가)</div>
          <div style={{ marginBottom: 10, marginLeft: 8 }}>• <b>트렌드(trend, T)</b> = 주마다 늘거나 줄어드는 "변화량" (매주 몇 개씩 빠지는가)</div>

          <div style={{ marginBottom: 4 }}><b>α = {HOLT_ALPHA} (레벨 평활계수)</b> — 매주 새 판매량이 들어올 때 레벨을 이렇게 갱신합니다.</div>
          <div style={{ marginLeft: 8, marginBottom: 4, fontFamily: 'monospace', fontSize: 12, color: '#1a73e8' }}>새 레벨 = 0.3 × (이번 주 실제 판매) + 0.7 × (지난 주 예상치)</div>
          <div style={{ marginLeft: 8, marginBottom: 10, color: '#5f6368' }}>이번 주 실제값을 30%만 반영하고 과거 흐름을 70% 유지 → α가 작을수록(0.3) 한 주 튀는 값에 둔감하게 <b>부드럽게</b> 따라갑니다.</div>

          <div style={{ marginBottom: 4 }}><b>β = {HOLT_BETA} (트렌드 평활계수)</b> — 변화량(추세)을 이렇게 갱신합니다.</div>
          <div style={{ marginLeft: 8, marginBottom: 4, fontFamily: 'monospace', fontSize: 12, color: '#1a73e8' }}>새 트렌드 = 0.1 × (이번 주 레벨 − 지난 주 레벨) + 0.9 × (기존 트렌드)</div>
          <div style={{ marginLeft: 8, marginBottom: 10, color: '#5f6368' }}>새로 관측된 증감폭을 10%만 반영하고 기존 추세를 90% 유지 → β가 작을수록(0.1) 추세 방향이 <b>잘 안 흔들리고 안정적</b>입니다.</div>

          <div style={{ marginBottom: 4 }}><b>4주 예측</b> — 위로 구한 L, T로 미래를 직선 연장해 4주치를 더합니다.</div>
          <div style={{ marginLeft: 8, marginBottom: 10, fontFamily: 'monospace', fontSize: 12, color: '#1a73e8' }}>
            (L+1×T) + (L+2×T) + (L+3×T) + (L+4×T) = 향후 4주 예측 판매량
          </div>

          <div style={{ padding: '8px 12px', background: '#f8faf9', border: '1px solid #e8eaed', borderRadius: 8 }}>
            <b>숫자 예시</b> — 주간 판매가 <code>40 → 34 → 30 → 26</code>(매주 감소)이면 L ≈ 26, T ≈ −4(매주 4개씩 감소).
            4주 예측 = 22+18+14+10 = <b>약 64개</b>. 감소세가 그대로 반영돼 과발주를 막습니다.
            (α=0.3·β=0.1은 "최근 흐름은 따라가되 한 주 튐에는 둔감하게" 맞춘 보수적 세팅)
          </div>
            </div>
          </details>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          {spikes.length > 0 && (
            <button
              onClick={() => setShowCorrModal(true)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
                border: '1px solid ' + (pendingSpikeCount > 0 ? '#f0b429' : '#dadce0'),
                background: pendingSpikeCount > 0 ? '#fef7e0' : '#fff',
                color: pendingSpikeCount > 0 ? '#b06000' : '#5f6368',
                cursor: 'pointer', boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
              }}
            >
              ⚠ 판매 보정 {pendingSpikeCount > 0 ? `${pendingSpikeCount}건` : `(${spikes.length})`}
            </button>
          )}
          <button
            onClick={load}
            disabled={loading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              border: '1px solid #dadce0', background: '#fff', color: '#3c4043',
              cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1,
              transition: 'all 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
            }}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ animation: loading ? 'spin 0.8s linear infinite' : 'none' }}>
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
            {loading ? '계산 중…' : '새로고침'}
          </button>
          <button
            onClick={exportExcel}
            disabled={loading || rows.length === 0}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              border: 'none', background: '#1e8e3e', color: '#fff',
              cursor: (loading || rows.length === 0) ? 'not-allowed' : 'pointer',
              opacity: (loading || rows.length === 0) ? 0.5 : 1,
              transition: 'all 0.15s', boxShadow: '0 1px 3px rgba(30,142,62,0.3)',
            }}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <path d="M7 10l5 5 5-5M12 15V3" />
            </svg>
            엑셀 다운로드
          </button>
        </div>
      </div>

      {error &&<div style={{ background: '#fce8e6', color: '#c5221f', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{error}</div>}

      {rows.length > 0 && (
        <div style={{ fontSize: 13, color: '#5f6368', marginBottom: 10 }}>
          총 <b>{productCount}</b>개 품목 · 발주 필요 <b style={{ color: '#1e8e3e' }}>{orderCount}</b>개
          {dataDays > 0 && <> · 수요예측 데이터 {dataDays}일</>}
          {lastUpdated && <> · {lastUpdated.toLocaleTimeString('ko-KR')} 기준</>}
        </div>
      )}

      <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto', border: '1px solid #e0e0e0', borderRadius: 6 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 1 }}>
            <tr>
              {['쿠팡바코드', '상품명', '옵션명', '상태', '추천 발주량', '태그', 'S열', 'T열', '비고', '재고주수', '현재 총재고', '발주추천 사유'].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '2px solid #e0e0e0', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={idx} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{r.barcode}</td>
                <td style={{ padding: '6px 10px' }}>{r.productName}</td>
                <td style={{ padding: '6px 10px' }}>{r.optionName}</td>
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{r.status}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: r.recQty ? 700 : 400, color: r.recQty ? '#1e8e3e' : '#bbb' }}>{r.recQty}</td>
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                  {r.tag && (() => {
                    const c = TAG_COLORS[r.tag] || { bg: '#f1f3f4', fg: '#5f6368' };
                    return <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: c.bg, color: c.fg, whiteSpace: 'nowrap' }}>{r.tag}</span>;
                  })()}
                </td>
                <td style={{ padding: '6px 10px', textAlign: 'right', color: '#5f6368' }}>{r.sPos || ''}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right', color: '#5f6368' }}>{r.tPos || ''}</td>
                <td style={{ padding: '6px 10px', color: '#c5221f' }}>{r.note}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right', color: '#5f6368', whiteSpace: 'nowrap', background: (typeof r.weeksStock === 'number' && r.weeksStock < 4) ? '#fce8e6' : undefined }}>{r.weeksStock}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right', color: '#3c4043', whiteSpace: 'nowrap' }}>{r.totalStock}</td>
                <td style={{ padding: '6px 10px', color: '#5f6368', fontSize: 12, minWidth: 320 }}>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* 판매량 보정 모달 (유형1 대량구매 / 유형2 주의품목 0판매) */}
      {showCorrModal && (
        <div onClick={() => setShowCorrModal(false)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 9999, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div onClick={e => e.stopPropagation()} style={{ background: '#fff', borderRadius: 12, padding: 20, width: '95%', maxWidth: 1200, maxHeight: '85vh', display: 'flex', flexDirection: 'column', boxShadow: '0 8px 32px rgba(0,0,0,0.2)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <h3 style={{ margin: 0, fontSize: 16 }}>⚠ 판매량 보정 ({spikes.length}건)</h3>
              <button onClick={() => setShowCorrModal(false)} style={{ background: 'none', border: 'none', fontSize: 20, cursor: 'pointer', color: '#666' }}>✕</button>
            </div>
            <div style={{ fontSize: 12, color: '#5f6368', marginBottom: 10, textAlign: 'center', lineHeight: 1.6 }}>
              🔴 대량구매 의심 = 1인 몰아사기로 튄 날 → <b>실제값으로 낮춰</b> 입력 · 🟠 주의품목 0판매 = 품절 등으로 0인 날 → <b>실제 판매량</b> 입력<br />
              입력값은 <b>표시된 대상 날짜 전부에 일괄 적용</b>되며, 저장 시 추천 발주량·엑셀에 반영됩니다.
            </div>
            {spikes.length === 0 ? (
              <p style={{ textAlign: 'center', color: '#999', padding: 20 }}>보정할 항목이 없습니다.</p>
            ) : (
              <div style={{ overflowY: 'auto', border: '1px solid #e0e0e0', borderRadius: 8 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, textAlign: 'center' }}>
                  <thead style={{ position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 1 }}>
                    <tr>
                      {['유형', '옵션ID', '상품/옵션'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '2px solid #e0e0e0', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                      <th style={{ padding: '6px 10px', textAlign: 'center', borderBottom: '2px solid #e0e0e0', whiteSpace: 'nowrap' }}>
                        <div style={{ marginBottom: 5 }}>이번주 일별 판매 (강조=대상)</div>
                        <div style={{ display: 'inline-flex', border: '1px solid #dadce0', borderRadius: 6, overflow: 'hidden' }}>
                          {spikes[0].week.map((d, di) => (
                            <div key={di} style={{ width: 40, borderLeft: di ? '1px solid #e8eaed' : 'none', fontSize: 10, fontWeight: 600, color: '#5f6368', padding: '4px 0', background: '#f1f3f4', textAlign: 'center', whiteSpace: 'nowrap' }}>
                              {d.key.slice(4, 6)}-{d.key.slice(6, 8)}
                            </div>
                          ))}
                        </div>
                      </th>
                      {['실제 판매량', '무시'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '2px solid #e0e0e0', whiteSpace: 'nowrap' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {spikes.map(sp => {
                      const flaggedKeys = new Set(sp.flagged.map(f => f.key));
                      // flagged 전 날짜의 저장 상태 — 대표값은 먼저 보정된 날 기준, 커버 판정은 전 날짜 기준
                      const savedList = sp.flagged.map(f => corrections[`${f.key}_${sp.optionId}`]);
                      const saved = savedList.find(Boolean);
                      const allCovered = savedList.every(Boolean);
                      const draft = corrDraft[sp.id];
                      const isIgnored = draft ? !!draft.ignored : !!saved?.ignored;
                      const inputVal = draft && 'value' in draft ? draft.value
                        : (saved && typeof saved.corrected === 'number' ? String(saved.corrected) : '');
                      const isBulk = sp.type === 'bulk';
                      // 현재 입력/저장 상태로 이 행이 해소됐는지 — flagged 전 날짜가 커버돼야 함
                      const draftResolves = draft && (draft.ignored || (draft.value !== undefined && draft.value !== '' && !isNaN(Number(draft.value)) && Number(draft.value) >= 0));
                      const needsAttention = draft ? (draft.reset ? true : !draftResolves) : !allCovered;
                      return (
                        <tr key={sp.id} style={{ borderBottom: '1px solid #f0f0f0', background: isIgnored ? '#f5f5f5' : (needsAttention ? '#fffbe6' : undefined), opacity: isIgnored ? 0.6 : 1, boxShadow: needsAttention && !isIgnored ? 'inset 3px 0 0 #f0b429' : undefined }}>
                          <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>
                            <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: isBulk ? '#fce8e6' : '#fef7e0', color: isBulk ? '#c5221f' : '#b06000' }}>{isBulk ? '🔴 대량구매' : '🟠 주의품목0'}</span>
                            {needsAttention && !isIgnored && <div style={{ marginTop: 4, display: 'inline-block', padding: '1px 6px', borderRadius: 8, fontSize: 10, fontWeight: 700, background: '#fef7e0', color: '#b06000', border: '1px solid #f0b429' }}>미처리</div>}
                          </td>
                          <td style={{ padding: '6px 10px', textAlign: 'center', fontFamily: 'monospace', fontSize: 12, color: '#5f6368', whiteSpace: 'nowrap' }}>{sp.optionId}</td>
                          <td style={{ padding: '6px 14px', textAlign: 'left', minWidth: 320 }}>
                            <div style={{ fontWeight: 600 }}>{sp.productName}</div>
                            <div style={{ fontSize: 11, color: '#5f6368' }}>{sp.optionName}</div>
                          </td>
                          <td style={{ padding: '6px 10px' }}>
                            <div style={{ display: 'inline-flex', border: '1px solid #dadce0', borderRadius: 6, overflow: 'hidden' }}>
                              {sp.week.map((d, di) => {
                                const isFlagged = flaggedKeys.has(d.key);
                                const bg = isFlagged ? (isBulk ? '#fce8e6' : '#fef7e0') : '#fff';
                                const fg = isFlagged ? (isBulk ? '#c5221f' : '#b06000') : '#3c4043';
                                return (
                                  <div key={di} style={{ width: 40, borderLeft: di ? '1px solid #e8eaed' : 'none', padding: '6px 0', textAlign: 'center', fontFamily: 'monospace', fontSize: 13, fontWeight: isFlagged ? 700 : 400, background: bg, color: fg }}>
                                    {d.qty}
                                  </div>
                                );
                              })}
                            </div>
                          </td>
                          <td style={{ padding: '6px 10px' }}>
                            <input type="number" min="0" value={inputVal} disabled={isIgnored}
                              onChange={e => setCorrDraft(d => ({ ...d, [sp.id]: { value: e.target.value } }))}
                              placeholder={isBulk ? '낮춰서' : '실제값'}
                              style={{ width: 72, padding: '5px 8px', textAlign: 'center', border: '1px solid #dadce0', borderRadius: 6, fontSize: 13 }} />
                          </td>
                          <td style={{ padding: '6px 10px' }}>
                            {isIgnored ? (
                              <button onClick={() => setCorrDraft(d => ({ ...d, [sp.id]: { reset: true } }))} style={{ border: '1px solid #dadce0', background: '#fff', borderRadius: 6, padding: '4px 8px', fontSize: 12, cursor: 'pointer' }}>↺ 되돌리기</button>
                            ) : (
                              <button onClick={() => setCorrDraft(d => ({ ...d, [sp.id]: { ignored: true } }))} style={{ border: '1px solid #dadce0', background: '#fff', borderRadius: 6, padding: '4px 8px', fontSize: 12, cursor: 'pointer' }}>정상</button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div style={{ display: 'flex', justifyContent: 'center', gap: 10, marginTop: 14 }}>
              <button onClick={() => setShowCorrModal(false)} disabled={savingCorr} style={{ padding: '9px 18px', borderRadius: 8, border: '1px solid #dadce0', background: '#fff', color: '#3c4043', fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>닫기</button>
              <button onClick={applyCorrections} disabled={savingCorr} style={{ padding: '9px 18px', borderRadius: 8, border: 'none', background: '#1e8e3e', color: '#fff', fontSize: 13, fontWeight: 600, cursor: savingCorr ? 'not-allowed' : 'pointer', opacity: savingCorr ? 0.6 : 1 }}>{savingCorr ? '저장 중…' : '보정 완료 · 재계산'}</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
