// 품절 기록 시트에서 데이터 읽기 (Google Sheets CSV export)
const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const SHEET_NAME = '품절 기록';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

const SOLDOUT_REASONS_KEY = 'soldout_reasons_v2';
const SOLDOUT_HISTORY_KEY = 'soldout_history';
// 하위호환용 (사용하지 않지만 import 에러 방지)
export function markLocalSave() {}
export function getProtectedBarcodes() { return new Set(); }

function parseCsvRow(line) {
  const result = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuotes = true; }
      else if (ch === ',') { result.push(current); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current);
  return result;
}

// 시트에서 품절 기록 읽어서 reasons + history 구성
export async function fetchFromSheet() {
  try {
    const res = await fetch(CSV_URL);
    if (!res.ok) return null;
    const csv = await res.text();
    const lines = csv.split('\n').filter(l => l.trim());
    if (lines.length < 2) return { reasons: {}, history: {} };

    const reasons = {}; // barcode → { reason, date }  (최신 1건)
    const history = {}; // barcode → [{ reason, date, productName, optionName }]

    // 헤더: 바코드, 상품명, 옵션명, 품절일, 사유
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvRow(lines[i]);
      const barcode = (cols[0] || '').trim();
      const productName = (cols[1] || '').trim();
      const optionName = (cols[2] || '').trim();
      const date = (cols[3] || '').trim();
      const reason = (cols[4] || '').trim();

      if (!barcode) continue;

      // history 누적
      if (!history[barcode]) history[barcode] = [];
      history[barcode].push({ reason, date, productName, optionName });

      // reasons: 같은 바코드면 최신(나중 행)이 덮어쓰기
      reasons[barcode] = { reason, date };
    }

    // localStorage 우선: 로컬에 있는 건 유지, 시트에만 있는 건 추가
    const localReasons = JSON.parse(localStorage.getItem(SOLDOUT_REASONS_KEY) || '{}');
    const localHistory = JSON.parse(localStorage.getItem(SOLDOUT_HISTORY_KEY) || '{}');

    const mergedReasons = { ...reasons, ...localReasons };
    const mergedHistory = { ...history };
    for (const [bc, entries] of Object.entries(localHistory)) {
      if (!mergedHistory[bc]) mergedHistory[bc] = entries;
      else if (entries.length > mergedHistory[bc].length) mergedHistory[bc] = entries;
    }

    localStorage.setItem(SOLDOUT_REASONS_KEY, JSON.stringify(mergedReasons));
    localStorage.setItem(SOLDOUT_HISTORY_KEY, JSON.stringify(mergedHistory));

    return { reasons: mergedReasons, history: mergedHistory };
  } catch (e) {
    console.error('Sheet sync fetch error:', e);
    return null;
  }
}

// Google Apps Script Web App URL (쓰기용)
const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx1PHUwqLsAaceIBpTZFu8DAKrRaVeHqwIeTO4NYMxqvnBdsxDhc3dYQEsTY8PzCGgpvA/exec';

export async function saveReasonsToSheet(items) {
  if (!APPS_SCRIPT_URL) return false;
  try {
    // GET URL 길이 제한 방지: 3개씩 배치 전송
    const BATCH = 3;
    for (let i = 0; i < items.length; i += BATCH) {
      const batch = items.slice(i, i + BATCH);
      const url = `${APPS_SCRIPT_URL}?action=saveReasons&data=${encodeURIComponent(JSON.stringify(batch))}`;
      const res = await fetch(url);
      if (!res.ok) console.error('Sheet save batch failed:', i);
    }
    return true;
  } catch (e) {
    console.error('Sheet sync save error:', e);
    return false;
  }
}

export async function deleteReasonFromSheet(barcode) {
  if (!APPS_SCRIPT_URL) return false;
  try {
    const url = `${APPS_SCRIPT_URL}?action=deleteReason&barcode=${encodeURIComponent(barcode)}`;
    await fetch(url);
    return true;
  } catch (e) {
    console.error('Sheet sync delete error:', e);
    return false;
  }
}

export function isSheetSyncEnabled() {
  return !!APPS_SCRIPT_URL;
}

// ===== 주의 품목 동기화 =====
const CAUTION_SHEET_NAME = '주의 품목';
const CAUTION_CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(CAUTION_SHEET_NAME)}`;

export async function fetchCautionItems() {
  try {
    const res = await fetch(CAUTION_CSV_URL);
    if (!res.ok) return new Set();
    const csv = await res.text();
    const lines = csv.split('\n').filter(l => l.trim());
    const barcodes = new Set();
    for (let i = 1; i < lines.length; i++) {
      const cols = parseCsvRow(lines[i]);
      const barcode = (cols[0] || '').trim();
      if (barcode) barcodes.add(barcode);
    }
    return barcodes;
  } catch (e) {
    console.error('Caution fetch error:', e);
    return new Set();
  }
}

export async function saveCautionItem(barcode, productName, optionName) {
  if (!APPS_SCRIPT_URL) return false;
  try {
    const url = `${APPS_SCRIPT_URL}?action=addCaution&barcode=${encodeURIComponent(barcode)}&productName=${encodeURIComponent(productName)}&optionName=${encodeURIComponent(optionName)}`;
    await fetch(url);
    return true;
  } catch (e) {
    console.error('Caution save error:', e);
    return false;
  }
}

export async function deleteCautionItem(barcode) {
  if (!APPS_SCRIPT_URL) return false;
  try {
    const url = `${APPS_SCRIPT_URL}?action=removeCaution&barcode=${encodeURIComponent(barcode)}`;
    await fetch(url);
    return true;
  } catch (e) {
    console.error('Caution delete error:', e);
    return false;
  }
}
