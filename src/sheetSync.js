// 품절 기록 - Vultr DB API 연동
import { dbSaveReasons, dbGetReasons, dbDeleteReason, dbAddCaution, dbGetCaution, dbRemoveCaution } from './utils/dbApi';

const SOLDOUT_REASONS_KEY = 'soldout_reasons_v2';
const SOLDOUT_HISTORY_KEY = 'soldout_history';

// DB에서 품절 기록 읽어서 reasons + history 구성
export async function fetchReasons() {
  try {
    const { reasons, history } = await dbGetReasons();

    // localStorage에도 캐시 (오프라인 대비)
    localStorage.setItem(SOLDOUT_REASONS_KEY, JSON.stringify(reasons));
    localStorage.setItem(SOLDOUT_HISTORY_KEY, JSON.stringify(history));

    return { reasons, history };
  } catch (e) {
    console.error('DB sync fetch error:', e);
    return null;
  }
}

export async function saveReasons(items) {
  return await dbSaveReasons(items);
}

export async function deleteReason(barcode) {
  return await dbDeleteReason(barcode);
}


// ===== 주의 품목 동기화 =====
export async function fetchCautionItems() {
  return await dbGetCaution();
}

export async function saveCautionItem(barcode, productName, optionName) {
  return await dbAddCaution(barcode, productName, optionName);
}

export async function deleteCautionItem(barcode) {
  return await dbRemoveCaution(barcode);
}
