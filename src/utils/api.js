const APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbx1PHUwqLsAaceIBpTZFu8DAKrRaVeHqwIeTO4NYMxqvnBdsxDhc3dYQEsTY8PzCGgpvA/exec';

export function sheetUrl(sheetName) {
  return `${APPS_SCRIPT_URL}?sheet=${encodeURIComponent(sheetName)}`;
}

export const SHEET_CALC = () => sheetUrl('재고 계산기');
export const SHEET_DATA_INPUT = () => sheetUrl('데이터 입력');
export const SHEET_BARCODE = () => sheetUrl('쿠팡바코드');
export const SHEET_ORDER_BOOK = () => sheetUrl('발주장부');
