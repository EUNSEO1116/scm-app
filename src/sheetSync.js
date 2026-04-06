// 품절 기록 시트에서 데이터 읽기 (Google Sheets CSV export)
const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const SHEET_NAME = '품절 기록';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(SHEET_NAME)}`;

const SOLDOUT_REASONS_KEY = 'soldout_reasons_v2';
const SOLDOUT_HISTORY_KEY = 'soldout_history';
const SAVE_TIMESTAMPS_KEY = 'soldout_save_timestamps';
const PROTECT_MINUTES = 30; // 저장 후 30분간 시트 덮어쓰기 방지

// 로컬 저장 타임스탬프 기록 (barcode → timestamp)
export function markLocalSave(barcodes) {
  try {
    const ts = JSON.parse(localStorage.getItem(SAVE_TIMESTAMPS_KEY) || '{}');
    const now = Date.now();
    for (const bc of barcodes) ts[bc] = now;
    localStorage.setItem(SAVE_TIMESTAMPS_KEY, JSON.stringify(ts));
  } catch {}
}

export function getProtectedBarcodes() {
  try {
    const ts = JSON.parse(localStorage.getItem(SAVE_TIMESTAMPS_KEY) || '{}');
    const cutoff = Date.now() - PROTECT_MINUTES * 60 * 1000;
    const protected_ = new Set();
    for (const [bc, t] of Object.entries(ts)) {
      if (t > cutoff) protected_.add(bc);
    }
    return protected_;
  } catch { return new Set(); }
}

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

    // localStorage에 동기화 (최근 로컬 저장 항목은 보호)
    const protected_ = getProtectedBarcodes();
    const localReasons = JSON.parse(localStorage.getItem(SOLDOUT_REASONS_KEY) || '{}');
    const localHistory = JSON.parse(localStorage.getItem(SOLDOUT_HISTORY_KEY) || '{}');

    // 시트 데이터를 기본으로 하되, 보호 대상은 로컬 데이터 유지
    const mergedReasons = { ...reasons };
    const mergedHistory = { ...history };
    for (const bc of protected_) {
      if (localReasons[bc]) mergedReasons[bc] = localReasons[bc];
      if (localHistory[bc]) mergedHistory[bc] = localHistory[bc];
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
