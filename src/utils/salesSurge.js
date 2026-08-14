import { dbStoreGet, dbStoreSet } from './dbApi.js';

export const SURGE_SNAPSHOT_KEY = 'sales_surge_snapshot';

// 일일 매출 순위(SoldOutAnalysisHistory)와 동일한 제외 규칙:
//   상태 제외 키워드 + 옵션명 '반품' + 상품명 '바디스윗' → 순위·급증에서 완전 제외.
//   → "일일 매출 순위에 계산되는 항목"만 급증 대상.
const EXCLUDE_KEYWORDS = ['최종마감', '품질확인서', '마감대상', '덤핑', '반출'];
function shouldExclude(s) { return s ? EXCLUDE_KEYWORDS.some(kw => s.includes(kw)) : false; }
function isRankExcluded(it) {
  return shouldExclude(it.status)
    || (it.optionName || '').includes('반품')
    || (it.productName || '').includes('바디스윗');
}

// 급증 기준: 1일전 >= 4
//   AND (1일전 >= 이전일자평균 * 2 OR 1일전 >= 이전일자 최대값 + maxBonus)
//   minAvgMult: 평균×2 조건이 적용되는 최소 평균값. 신규 제외 탭은 10(평균<10이면 ×2로는 급증 판정 안 함).
//   이전 일자 데이터가 하나도 없으면(신규 업로드 첫날 등) 급증 판정하지 않음.
function isSurge(d1, prevDays, maxBonus = 3, minAvgMult = 0) {
  if (d1 < 4) return false;
  if (prevDays.length === 0) return false;
  const avg = prevDays.reduce((a, b) => a + b, 0) / prevDays.length;
  const max = Math.max(...prevDays);
  const multOk = avg > 0 && avg >= minAvgMult && d1 >= avg * 2;
  return multOk || d1 >= max + maxBonus;
}

// offset일 전의 'YYYYMMDD' 키 (업로드 저장 시 todayKey()와 동일한 UTC 기준으로 생성)
function uploadDateKey(offsetDays) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - offsetDays);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

// 오늘부터 거꾸로 훑어 실제 업로드가 존재하는 최근 maxDays개(신·구 순)를 로드.
//   빈 날짜(주말·공휴일 등 미업로드)는 건너뛰고, lookback일 이내에서만 탐색.
//   반환: [{ key, items }] — 최신이 [0].
async function loadRecentUploads(maxDays = 6, lookback = 30) {
  const result = [];
  for (let i = 0; i < lookback && result.length < maxDays; i++) {
    const key = uploadDateKey(i);
    const data = await dbStoreGet(`soldout_analysis_${key}`).catch(() => null);
    if (data && Array.isArray(data.items) && data.items.length) {
      result.push({ key, items: data.items });
    }
  }
  return result;
}

// 업로드된 DB(soldout_analysis_*)의 판매수량(salesQty)에서 급증 품목을 계산해
//   { count, items, otherCount, otherItems, calculatedAt } 반환.
//   items      : 상태 '신규' 급증(최대값+3 기준) — 배지/기본 화면
//   otherItems : 신규 제외 + 제외키워드 미포함 급증(최대값+8 기준) — 추가 탭
//   가장 최근 업로드일 = d1(1일전), 그 이전 업로드분 = d2..d6.
export async function computeSurgeSnapshot() {
  const days = await loadRecentUploads(6, 30);
  if (days.length === 0) {
    return { count: 0, items: [], otherCount: 0, otherItems: [], calculatedAt: Date.now() };
  }

  const newest = days[0];
  // 이전 일자(최신 제외)들의 optionId → salesQty 맵. 배열 순서: [d2, d3, d4, d5, d6]
  const prevMaps = days.slice(1).map(d => {
    const m = new Map();
    for (const it of d.items) m.set(String(it.optionId), Number(it.salesQty) || 0);
    return m;
  });

  const items = [];
  const otherItems = [];
  for (const it of newest.items) {
    // 일일 매출 순위에서 빠지는 항목(제외키워드·반품·바디스윗)은 급증에서도 제외
    if (isRankExcluded(it)) continue;
    const status = (it.status || '').trim();
    const isNew = status === '신규';

    const oid = String(it.optionId);
    const d1 = Number(it.salesQty) || 0;
    // 이전 일자별 판매수량(해당 날 업로드에 상품이 없으면 0). [d2, d3, d4, d5, d6]
    const prev = prevMaps.map(m => m.get(oid) || 0);
    const maxBonus = isNew ? 3 : 8;
    const minAvgMult = isNew ? 0 : 10;
    if (!isSurge(d1, prev, maxBonus, minAvgMult)) continue;

    const avg = prev.length ? prev.reduce((a, b) => a + b, 0) / prev.length : 0;
    const max = prev.length ? Math.max(...prev) : 0;
    const [d2 = 0, d3 = 0, d4 = 0, d5 = 0, d6 = 0] = prev;
    const item = {
      barcode: (it.barcode || '').trim(),
      productName: (it.productName || '').trim(),
      optionName: (it.optionName || '').trim(),
      d6, d5, d4, d3, d2, d1,
      avg: Math.round(avg * 10) / 10,
      max,
      diff: d1 - Math.round(avg),
    };
    if (isNew) items.push(item);
    else otherItems.push(item);
  }
  items.sort((a, b) => b.diff - a.diff);
  otherItems.sort((a, b) => b.diff - a.diff);
  return { count: items.length, items, otherCount: otherItems.length, otherItems, calculatedAt: Date.now() };
}

// 급증 스냅샷 계산 후 DB에 저장(최신 1개 유지, 날짜 무관). 저장된 스냅샷 반환.
export async function recordSurgeSnapshot() {
  const snap = await computeSurgeSnapshot();
  await dbStoreSet(SURGE_SNAPSHOT_KEY, snap, { skipLog: true });
  return snap;
}

// 저장된 급증 스냅샷 읽기. 없으면 null.
export async function getSurgeSnapshot() {
  return dbStoreGet(SURGE_SNAPSHOT_KEY).catch(() => null);
}

// 화면 표시용: 저장된 스냅샷만 반환(로딩 시 재계산하지 않음).
// → 계산은 오늘자 데이터 업로드로 급증 스냅샷이 갱신되는 순간(recordSurgeSnapshot) 1회만.
//   그 전까지는 마지막 저장분을 그대로 유지하고, 저장분이 없으면 빈 결과.
export async function getSurgeForDisplay() {
  const snap = await getSurgeSnapshot();
  if (snap) return snap;
  return { count: 0, items: [], otherCount: 0, otherItems: [], calculatedAt: null };
}
