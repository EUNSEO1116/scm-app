import { dbStoreGet, dbStoreSet } from './dbApi.js';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const CSV_DAILY = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('일일 판매량')}`;

export const SURGE_SNAPSHOT_KEY = 'sales_surge_snapshot';

// CSV indices:
// 0=empty, 1=barcode, 2=S-code, 3=product name, 4=option name, 5=status,
// 6=6일전, 7=5일전, 8=4일전, 9=3일전, 10=2일전, 11=1일전, 12=total, 13=리뷰갯수(6일)
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

function safeNum(v) {
  if (v === '' || v === '-' || v === undefined || v === null) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

// 신규 제외 탭에서 빼는 상태 키워드(다른 페이지들과 통일, 부분포함 매칭)
const EXCLUDE_KEYWORDS = ['최종마감', '품질확인서', '마감대상', '덤핑', '반출', '지재권'];
function shouldExclude(s) { return s ? EXCLUDE_KEYWORDS.some(kw => s.includes(kw)) : false; }

// 급증 기준: 1일전 >= 4
//   AND (1일전 >= 이전5일(6일전~2일전)평균 * 2 OR 1일전 >= 이전5일 최대값 + maxBonus)
//   minAvgMult: 평균×2 조건이 적용되는 최소 평균값. 신규 제외 탭은 10(평균<10이면 ×2로는 급증 판정 안 함).
function isSurge(d1, prevDays, maxBonus = 3, minAvgMult = 0) {
  if (d1 < 4) return false;
  const avg = prevDays.reduce((a, b) => a + b, 0) / prevDays.length;
  const max = Math.max(...prevDays);
  const multOk = avg > 0 && avg >= minAvgMult && d1 >= avg * 2;
  return multOk || d1 >= max + maxBonus;
}

// CSV_DAILY(일일 판매량)에서 급증 품목을 계산해
//   { count, items, otherCount, otherItems, calculatedAt } 반환.
//   items      : 상태 '신규' 급증(최대값+3 기준) — 배지/기본 화면
//   otherItems : 신규 제외 + 제외키워드 미포함 급증(최대값+8 기준) — 추가 탭
// 각 item은 매출 카드 렌더링 필드(바코드/상품명/옵션명/d6~d1/avg/max/diff) 포함.
export async function computeSurgeSnapshot() {
  const res = await fetch(CSV_DAILY);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const csv = await res.text();
  const lines = csv.split('\n').filter(l => l.trim());
  if (lines.length < 2) return { count: 0, items: [], otherCount: 0, otherItems: [], calculatedAt: Date.now() };

  const items = [];
  const otherItems = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvRow(lines[i]);
    const status = (cols[5] || '').trim();
    const isNew = status === '신규';
    // 신규도 아니고 신규 제외 대상(제외키워드 포함)도 아니면 → 신규 제외 탭 후보
    const isOther = !isNew && !shouldExclude(status);
    if (!isNew && !isOther) continue;

    const d6 = safeNum(cols[6]);
    const d5 = safeNum(cols[7]);
    const d4 = safeNum(cols[8]);
    const d3 = safeNum(cols[9]);
    const d2 = safeNum(cols[10]);
    const d1 = safeNum(cols[11]);
    const prevDays = [d6, d5, d4, d3, d2];
    const maxBonus = isNew ? 3 : 8;
    const minAvgMult = isNew ? 0 : 10;
    if (!isSurge(d1, prevDays, maxBonus, minAvgMult)) continue;

    const avg = prevDays.reduce((a, b) => a + b, 0) / prevDays.length;
    const max = Math.max(...prevDays);
    const item = {
      barcode: (cols[1] || '').trim(),
      productName: (cols[3] || '').trim(),
      optionName: (cols[4] || '').trim(),
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

// 화면 표시용: 저장된 스냅샷이 있으면 그대로(고정값), 없으면 현재 시트 기준으로 즉석 계산(저장 X).
// → 업로드로 스냅샷이 만들어지기 전에도 오늘치가 비지 않고 표시됨. 배지/카드가 동일 소스 사용.
export async function getSurgeForDisplay() {
  const snap = await getSurgeSnapshot();
  if (snap) return snap;
  try {
    return await computeSurgeSnapshot();
  } catch {
    return { count: 0, items: [], calculatedAt: Date.now() };
  }
}
