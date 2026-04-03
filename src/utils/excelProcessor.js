import * as XLSX from 'xlsx';

/**
 * Parse the uploaded Excel file and compute inventory calculator data.
 *
 * Source sheets:
 * - "데이터 입력": raw Coupang inventory data (옵션ID, 재고, 입고중, 7일/30일 판매, etc.)
 * - "쿠팡바코드": product reference (바코드, 리드타임, 발주단위, 시즌성지수, 브랜드, 상태, 원가)
 * - "박스히어로": warehouse inventory (바코드 in 메모 field, 수량)
 * - "출고내역서": shipment records (SKU, 출고수량, 구분=FBC/일반)
 * - "발주장부": pending orders (SKU, 수량, CN 상태)
 * - "일일 판매량": daily sales (6 days of data)
 * - "센터 재고": center inventory breakdown
 */

function safeNum(v) {
  if (v === '' || v === '-' || v === undefined || v === null) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function parseSheet(wb, name) {
  const ws = wb.Sheets[name];
  if (!ws) return [];
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
}

function buildMap(rows, keyCol, valueCols) {
  const map = {};
  for (let i = 1; i < rows.length; i++) {
    const key = String(rows[i][keyCol] || '').trim();
    if (!key) continue;
    if (!map[key]) map[key] = {};
    for (const [col, name] of valueCols) {
      if (map[key][name] === undefined || map[key][name] === '' || map[key][name] === 0) {
        map[key][name] = rows[i][col];
      }
    }
  }
  return map;
}

export function processExcel(buffer) {
  const wb = XLSX.read(buffer, { type: 'array' });

  // Parse all needed sheets
  const dataInput = parseSheet(wb, '데이터 입력');
  const barcodes = parseSheet(wb, '쿠팡바코드');
  const boxhero = parseSheet(wb, '박스히어로');
  const shipments = parseSheet(wb, '출고내역서');
  const orders = parseSheet(wb, '발주장부');
  const dailySales = parseSheet(wb, '일일 판매량');
  const centerStock = parseSheet(wb, '센터 재고');

  // Build lookup maps

  // 쿠팡바코드: key=옵션ID (col 1), values: 바코드(5), 원가(6), 브랜드(8), 상태(9), 리드타임(10), 입고센터(11), 발주단위(12), 시즌성지수(15)
  const barcodeMap = {};
  for (let i = 1; i < barcodes.length; i++) {
    const optionId = String(barcodes[i][1] || '').trim();
    if (!optionId) continue;
    barcodeMap[optionId] = {
      barcode: String(barcodes[i][5] || ''),
      cost: safeNum(barcodes[i][6]),
      brand: String(barcodes[i][8] || ''),
      status: String(barcodes[i][9] || ''),
      leadTime: safeNum(barcodes[i][10]) || 30,
      center: String(barcodes[i][11] || ''),
      orderUnit: barcodes[i][12],
      seasonIndex: safeNum(barcodes[i][15]) || 1,
    };
  }

  // 박스히어로: key=바코드 (in 메모/col 7), value=수량(col 10)
  const boxheroMap = {};
  for (let i = 1; i < boxhero.length; i++) {
    const barcodeVal = String(boxhero[i][7] || '').trim(); // 메모 column has barcode
    const barcode2 = String(boxhero[i][1] || '').trim(); // 바코드 column
    const qty = safeNum(boxhero[i][10]);
    const key = barcodeVal || barcode2;
    if (key) {
      boxheroMap[key] = (boxheroMap[key] || 0) + qty;
    }
  }

  // 출고내역서: aggregate by SKU and 구분(FBC/일반)
  const shipmentMap = {};
  for (let i = 2; i < shipments.length; i++) {
    const sku = String(shipments[i][2] || '').trim();
    const qty = safeNum(shipments[i][4]);
    const type = String(shipments[i][6] || '');
    if (!sku) continue;
    if (!shipmentMap[sku]) shipmentMap[sku] = { fbc: 0, normal: 0 };
    if (type.includes('FBC') || type.includes('fbc')) {
      shipmentMap[sku].fbc += qty;
    } else {
      shipmentMap[sku].normal += qty;
    }
  }

  // 발주장부: aggregate by SKU, only pending orders
  const orderMap = {};
  for (let i = 1; i < orders.length; i++) {
    const sku = String(orders[i][2] || '').trim();
    const qty = safeNum(orders[i][3]);
    const status = String(orders[i][9] || '');
    if (!sku) continue;
    if (!orderMap[sku]) orderMap[sku] = { fbc: 0, normal: 0 };
    // Check if it's FBC or normal based on 발주번호
    const orderNum = String(orders[i][0] || '');
    if (orderNum.startsWith('FBC')) {
      orderMap[sku].fbc += qty;
    } else {
      orderMap[sku].normal += qty;
    }
  }

  // 일일 판매량: key=옵션ID (col 0), values: 6일전~1일전 (cols 5-10)
  const dailyMap = {};
  for (let i = 1; i < dailySales.length; i++) {
    const optionId = String(dailySales[i][0] || '').trim();
    if (!optionId) continue;
    const sales = [];
    for (let d = 5; d <= 10; d++) {
      sales.push(safeNum(dailySales[i][d]));
    }
    dailyMap[optionId] = sales;
  }

  // Process 데이터 입력 rows → inventory calculator output
  // Headers: col0=순번, 1=등록상품ID, 2=옵션ID, 3=SKU ID, 4=등록상품명, 5=옵션명,
  //          6=상품등급, 7=재고, 8=입고중, 9=아이템위너, 10=7일매출, 11=30일매출,
  //          12=7일판매, 13=30일판매
  const results = [];

  for (let i = 1; i < dataInput.length; i++) {
    const row = dataInput[i];
    const optionId = String(row[2] || '').trim();
    if (!optionId) continue;

    const bc = barcodeMap[optionId] || {};
    const barcode = bc.barcode || '';
    const productName = String(row[4] || '');
    const optionName = String(row[5] || '');
    const status = bc.status || String(row[6] || '');
    const stock = safeNum(row[7]);
    const incoming = safeNum(row[8]);
    const itemWinner = String(row[9] || '');
    const sales7d = safeNum(row[12]);
    const sales30d = safeNum(row[13]);
    const revenue7d = safeNum(row[10]);
    const revenue30d = safeNum(row[11]);

    // 박스히어로 재고
    const bhStock = boxheroMap[barcode] || 0;

    // 출고 (by barcode/SKU)
    const ship = shipmentMap[barcode] || { fbc: 0, normal: 0 };

    // 발주 (by barcode/SKU)
    const ord = orderMap[barcode] || { fbc: 0, normal: 0 };

    // 총재고 = 쿠팡재고 + 입고예정 + 박스히어로
    const totalStock = stock + incoming + bhStock;

    // 일일 판매량
    const dailySalesArr = dailyMap[optionId] || [0,0,0,0,0,0];
    const avg3d = dailySalesArr.slice(-3).reduce((a, b) => a + b, 0) / 3;
    const avg7d = sales7d !== 0 ? sales7d / 7 : 0;
    const avg30d = sales30d !== 0 ? sales30d / 30 : 0;

    const leadTime = bc.leadTime || 30;
    const orderUnit = bc.orderUnit || '';
    const seasonIndex = bc.seasonIndex || 1;

    // 발주량 계산 (리드타임 동안 필요한 수량 - 현재 총재고)
    const orderQty3d = Math.ceil(avg3d * leadTime) - totalStock;
    const orderQty7d = Math.ceil(avg7d * leadTime) - totalStock;
    const orderQty30d = Math.ceil(avg30d * leadTime) - totalStock;

    // 예상 판매 주 (총재고 / 일평균판매량 / 7)
    const weeksStockOnly = avg7d > 0 ? (stock + incoming) / avg7d / 7 : null;
    const weeksTotalStock = avg7d > 0 ? totalStock / avg7d / 7 : null;

    // 증감률
    const sumRecent3 = dailySalesArr.slice(-3).reduce((a,b) => a+b, 0);
    const sumPrev3 = dailySalesArr.slice(0, 3).reduce((a,b) => a+b, 0);
    const trendRatio = sumPrev3 > 0 ? (sumRecent3 / sumPrev3) : (sumRecent3 > 0 ? 999 : 0);
    const trend30v7 = avg30d > 0 ? avg7d / avg30d : (avg7d > 0 ? 999 : 0);

    // 안전재고 (리드타임 기간 필요량)
    const safeStock3d = Math.ceil(avg3d * leadTime);
    const safeStock7d = Math.ceil(avg7d * leadTime);
    const safeStock30d = Math.ceil(avg30d * leadTime);

    // 발주 추천
    let recommendation = '';
    if (orderQty7d > 0 && totalStock < safeStock7d) {
      recommendation = orderQty7d;
    }

    // 알림 결정
    let alert = '';
    if (status === '최종마감') {
      alert = sales7d > 0 ? '판매없음' : '판매없음';
    } else if (avg7d === 0 && avg30d === 0 && sales7d === 0) {
      alert = '판매없음';
    } else if (totalStock <= avg3d * 3 && avg3d > 0) {
      alert = '긴급';
    } else if (totalStock <= safeStock7d * 0.5 && avg7d > 0) {
      alert = '잠재긴급';
    } else if (totalStock > safeStock30d * 3 && avg30d > 0) {
      alert = '과잉재고';
    } else if (totalStock > safeStock7d * 2 && avg7d > 0) {
      alert = '과잉주의';
    } else if (avg7d > 0) {
      alert = '정상';
    } else {
      alert = '판매없음';
    }

    results.push({
      optionId,
      barcode,
      productName,
      optionName,
      status,
      stock,
      incoming,
      bhStock,
      fbcShipment: ship.fbc,
      normalShipment: ship.normal,
      fbcOrder: ord.fbc,
      normalOrder: ord.normal,
      totalStock,
      orderUnit,
      orderQty3d,
      orderQty7d,
      orderQty30d,
      weeksStockOnly,
      weeksTotalStock,
      trendRatio,
      trend30v7,
      avg3d: Math.round(avg3d * 10) / 10,
      recommendation,
      safeStock3d,
      safeStock7d,
      safeStock30d,
      leadTime,
      seasonIndex,
      alert,
      itemWinner,
      revenue7d,
      revenue30d,
      sales7d,
      sales30d,
      brand: bc.brand || '',
      cost: bc.cost || 0,
      dailySales: dailySalesArr,
    });
  }

  return results;
}
