// 원천 업로드(soldout_analysis_<날짜>)로 "품절" 분석 캐시를 생성/보정하는 유틸.
// 주말 등 "업데이트" 버튼을 못 누른 날은 정식 분석 캐시(soldout_analysis_cached_<날짜>)가
// 없지만 원천 업로드는 있으므로, 실제 분석과 동일한 필터(쿠팡바코드+재고계산기 시트,
// 제외등급, 신규상품, 수동제외)를 적용해 품절을 계산하고 캐시를 1회 저장한다.
// 이후 기간 집계/엑셀은 저장된 캐시를 읽어 매번 재계산하지 않는다.
//
// 정확도 메모: 시트(쿠팡바코드/재고계산기)는 "현재값"을 사용한다.
// 수동제외 목록은 가장 가까운 평일(정식 분석) 캐시의 excludeSnapshot(그날 기록된 제외목록)을
// 사용해 그 시점의 품절률을 재현한다. 없으면 현재 제외목록으로 폴백한다.
// 품절 판정(쿠팡재고=0)은 그 날짜 원천 업로드 기준이라 품절 수는 실제와 일치하고,
// 품절률/입고예정 등 시트 의존 항목은 현재 시트 기준의 근사값이다.
import { dbStoreGet, dbStoreSet } from './dbApi';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const CSV_BARCODE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('쿠팡바코드')}`;
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`;
const EXCLUDE_KEYWORDS = ['최종마감', '품질확인서', '마감대상', '덤핑', '반출', '지재권'];
const STORE_KEY_PREFIX = 'soldout_analysis_';
const SOLDOUT_TRACKER_KEY = 'soldout_analysis_tracker';

function shouldExclude(s) { return s ? EXCLUDE_KEYWORDS.some(kw => s.includes(kw)) : false; }
function safeNum(v) { if (v === '' || v === '-' || v == null) return 0; const n = Number(v); return isNaN(n) ? 0 : n; }
function parseCsvRow(line) {
  const result = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) { if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; } else if (ch === '"') inQuotes = false; else current += ch; }
    else { if (ch === '"') inQuotes = true; else if (ch === ',') { result.push(current); current = ''; } else current += ch; }
  }
  result.push(current); return result;
}
function dateToKey(d) { return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`; }
function keyToDate(k) { return new Date(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8)); }

// 시트(쿠팡바코드/재고계산기) 맵 — 여러 날짜를 한 번에 채울 때 60초간 메모이즈해 재요청 방지
let _sheetsCache = null;
let _sheetsAt = 0;
async function loadSheets() {
  if (_sheetsCache && Date.now() - _sheetsAt < 60000) return _sheetsCache;
  const [bcRes, calcRes] = await Promise.all([fetch(CSV_BARCODE), fetch(TSV_CALC)]);
  const bcCsv = await bcRes.text();
  const bcLines = bcCsv.split('\n').filter(l => l.trim());
  const bcMap = {};
  for (let i = 1; i < bcLines.length; i++) {
    const c = parseCsvRow(bcLines[i]); const oid = (c[1] || '').trim();
    if (oid) bcMap[oid] = { status: (c[9] || '').trim(), barcode: (c[5] || '').trim() };
  }
  const calcTsv = await calcRes.text();
  const cLines = calcTsv.split('\n').filter(l => l.trim());
  const cMap = {};
  for (let i = 1; i < cLines.length; i++) {
    const c = cLines[i].split('\t'); const oid = (c[1] || '').trim();
    if (oid) cMap[oid] = { barcode: (c[2] || '').trim(), incoming: safeNum(c[7]), ipgo: safeNum(c[8]) };
  }
  _sheetsCache = { bcMap, cMap }; _sheetsAt = Date.now();
  return _sheetsCache;
}

// 그 시점의 수동제외 목록을 재현한다.
// dateKey에서 가장 가까운 날짜부터 바깥으로 스캔(±1~7일)하며,
// 정식 분석 캐시(source !== 'upload')의 excludeSnapshot(배열)을 찾으면 그것을 사용한다.
// 하나도 없으면 현재 제외목록(soldout_analysis_exclude)으로 폴백한다.
async function resolveExcludeSet(dateKey) {
  const y = +dateKey.slice(0, 4), m = +dateKey.slice(4, 6) - 1, d = +dateKey.slice(6, 8);
  // 자기 날짜 우선, 이후 가까운 순서(어제/내일, 그제/모레 …)로 후보 생성
  const candidates = [dateKey];
  for (let i = 1; i <= 7; i++) {
    candidates.push(dateToKey(new Date(y, m, d - i)));
    candidates.push(dateToKey(new Date(y, m, d + i)));
  }
  for (const k of candidates) {
    const c = await dbStoreGet(`soldout_analysis_cached_${k}`).catch(() => null);
    if (c && c.source !== 'upload' && Array.isArray(c.excludeSnapshot)) {
      return new Set(c.excludeSnapshot.filter(Boolean));
    }
  }
  const exData = await dbStoreGet('soldout_analysis_exclude').catch(() => null);
  return new Set((exData || []).map(i => i.optionId));
}

// 특정 날짜의 분석 캐시를 보장한다.
// - 정식 "업데이트" 캐시(source !== 'upload')가 있으면 절대 덮지 않고 그대로 반환
// - 원천 기반 캐시(source === 'upload')가 있으면 force일 때만 재계산
// - 캐시가 없고 원천 업로드가 있으면 시트 필터를 적용해 품절을 계산·저장 후 반환
// - 원천도 없으면 null
export async function ensureUploadSoldoutCache(dateKey, { force = false } = {}) {
  const cacheKey = `soldout_analysis_cached_${dateKey}`;
  const existing = await dbStoreGet(cacheKey).catch(() => null);

  // 당일(오늘·미래)은 자동 계산하지 않는다 — 정식 "업데이트" 버튼으로만 분석한다.
  // (날짜가 지난 과거 업로드만 원천 기반 자동 계산 대상. 당일 원천 캐시는 무시.)
  const todayK = dateToKey(new Date());
  if (dateKey >= todayK) {
    return (existing?.items && existing.source !== 'upload') ? existing : null;
  }

  // 정식 분석 캐시는 원천 기반으로 절대 덮어쓰지 않는다
  if (existing?.items && existing.source !== 'upload') return existing;
  // 이미 원천 캐시가 있고 강제 재계산이 아니면 그대로 사용 (집계 속도 유지)
  if (existing?.items && existing.source === 'upload' && !force) return existing;

  const raw = await dbStoreGet(`${STORE_KEY_PREFIX}${dateKey}`).catch(() => null);
  if (!raw?.items) return existing?.items ? existing : null;

  const [{ bcMap, cMap }, exSet, trk] = await Promise.all([
    loadSheets(),
    resolveExcludeSet(dateKey),
    dbStoreGet(SOLDOUT_TRACKER_KEY).catch(() => null),
  ]);
  const tracker = trk || {};
  // 재계산(재업로드) 시 그 날짜 화면에서 직접 제외한 항목이 사라지지 않도록 기존 캐시의 제외목록을 합친다
  if (Array.isArray(existing?.excludeSnapshot)) {
    for (const oid of existing.excludeSnapshot) if (oid) exSet.add(oid);
  }

  // 신규 상품 재고 추적: dateKey 기준 최근 30일 원천 업로드 스캔 (전역 저장 안 함)
  const stKeys = [];
  for (let i = 0; i < 30; i++) {
    const d = new Date(+dateKey.slice(0, 4), +dateKey.slice(4, 6) - 1, +dateKey.slice(6, 8) - i);
    stKeys.push(dateToKey(d));
  }
  const stSets = await Promise.all(stKeys.map(k => dbStoreGet(`${STORE_KEY_PREFIX}${k}`).catch(() => null)));
  const stockTracker = {};
  for (const ds of stSets) {
    if (!ds?.items) continue;
    for (const it of ds.items) {
      const bc = bcMap[it.optionId];
      if (!bc || !bc.status.includes('신규')) continue;
      if (!stockTracker[it.optionId]) stockTracker[it.optionId] = { records: [] };
      stockTracker[it.optionId].records.push({ stock: it.coupangStock });
    }
  }

  const results = [];
  const excludeSnapshot = [];
  const trackerSnapshot = {};
  const validItems = [];
  for (const item of raw.items) {
    const bc = bcMap[item.optionId]; if (!bc) continue;      // 쿠팡바코드에 없으면 제외
    if (!cMap[item.optionId]) continue;                       // 재고계산기에 없으면 제외
    if (shouldExclude(bc.status)) continue;                   // 제외등급 완전 제외
    // 신규 상품: 30일간 한 번도 재고 > 0이 된 적 없으면 제외
    if (bc.status.includes('신규') && item.coupangStock === 0) {
      const entry = stockTracker[item.optionId];
      if (!entry || !entry.records.some(r => r.stock > 0)) continue;
    }
    validItems.push({ optionId: item.optionId, coupangStock: item.coupangStock });
    if (item.coupangStock !== 0) continue; // 품절만
    if (exSet.has(item.optionId)) excludeSnapshot.push(item.optionId); // 수동 제외 표시
    const calc = cMap[item.optionId];
    // 재계산(재업로드) 시 화면에서 직접 입력한 사유가 날아가지 않도록 기존 캐시 사유를 우선 보존
    const prevReason = existing?.trackerSnapshot?.[item.optionId]?.reason;
    trackerSnapshot[item.optionId] = { days: 1, startDate: dateKey, reason: prevReason || tracker[item.optionId]?.reason || '' };
    results.push({
      optionId: item.optionId,
      barcode: bc.barcode || calc.barcode || '',
      productName: item.productName || '',
      optionName: item.optionName || '',
      status: bc.status || '',
      coupangStock: 0,
      calcStock: 0, incoming: calc.incoming || 0, ipgo: calc.ipgo || 0, bhStock: 0, totalStock: 0,
      avg3d: 0, weeksStockIncoming: 0,
      salesQty: item.salesQty || 0,
      riskLevel: '품절',
      riskReason: (calc.incoming || calc.ipgo) ? `입고예정 ${(calc.incoming || 0) + (calc.ipgo || 0)}개` : '재고 없음',
      orderStatus: null,
      arrivalEst: '',
      mismatch: false,
    });
  }

  // 품절률 = (수동 제외 아닌 품절 수) / 전체 유효 상품 수
  const rateSoldout = results.filter(r => !exSet.has(r.optionId)).length;
  const rate = validItems.length > 0 ? Math.round(rateSoldout / validItems.length * 10000) / 100 : 0;

  const cache = {
    items: results,
    updatedAt: raw.uploadedAt || new Date().toISOString(),
    rate,
    trackerSnapshot,
    validItems,
    excludeSnapshot,
    correctionsSnapshot: {},
    source: 'upload', // 원천 업로드 기반 자동 생성 표시
  };
  await dbStoreSet(cacheKey, cache, { skipLog: true });
  return cache;
}

// 기간 [startKey, endKey] 동안 "데이터가 실제로 들어간 날짜만"의 일별 품절률을 계산한다.
// - 달력을 훑는 건 어느 날에 데이터가 있는지 찾기 위함일 뿐, 데이터 없는 날은 완전히 스킵
// - 일별 품절률 = (그 날 제외 아닌 품절수) / (그 날 판매중 유효품목수)
// - 제외는 그 날짜 excludeSnapshot 그대로 사용 (전역/실시간 union 안 함 — 그날 제외였던 게 오늘은 아닐 수 있으므로)
// - endKey는 오늘 이하로 clamp (미래 제외)
// 반환: { [YYYYMMDD]: { date, total, soldout, rate } } — 데이터 있는 날만 키로 존재
// 월/기간 집계는 이 일별 rate들의 "평균"으로 낸다 (분모 = 데이터 있는 날 수).
export async function computeSoldoutRateSnapshots(startKey, endKey) {
  const todayK = dateToKey(new Date());
  const clampEnd = endKey > todayK ? todayK : endKey;
  if (clampEnd < startKey) return {};

  const dayKeys = [];
  let d = keyToDate(startKey);
  const end = keyToDate(clampEnd);
  while (d <= end) {
    dayKeys.push(dateToKey(d));
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }

  const result = {};
  const CHUNK = 40; // 서버 부하 방지: 40일씩 병렬 처리
  for (let i = 0; i < dayKeys.length; i += CHUNK) {
    const batch = dayKeys.slice(i, i + CHUNK);
    const caches = await Promise.all(batch.map(k => ensureUploadSoldoutCache(k).catch(() => null)));
    batch.forEach((k, j) => {
      const c = caches[j];
      if (!c?.validItems) return; // 데이터 없는 날 스킵
      const daySnap = new Set(c.excludeSnapshot || []); // 그 날짜 제외목록 그대로
      const total = c.validItems.length;
      const soldout = c.validItems.filter(it => !daySnap.has(it.optionId) && it.coupangStock === 0).length;
      const rate = total > 0 ? Math.round(soldout / total * 10000) / 100 : 0;
      result[k] = { date: k, total, soldout, rate };
    });
  }
  return result;
}
