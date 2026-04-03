// ===== Google Apps Script 코드 =====
// 스프레드시트 > 확장 프로그램 > Apps Script에 붙여넣기
// 모든 쓰기 작업을 doGet으로 처리 (브라우저 CORS/리다이렉트 문제 방지)

const SHEET_NAME = '품절 기록';

function getCalendarSheet() {
  return SpreadsheetApp.getActiveSpreadsheet().getSheetByName('달력데이터')
    || SpreadsheetApp.getActiveSpreadsheet().insertSheet('달력데이터');
}

function writeCalendarData(data) {
  var sheet = getCalendarSheet();
  sheet.clear();
  sheet.appendRow(['dateKey', 'orderNo', 'productName', 'qty', 'moved', 'memo']);
  for (var dateKey in data) {
    var items = data[dateKey];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      sheet.appendRow(["d:" + dateKey, item.orderNo || '', item.productName || '', item.qty || '', item.moved || false, item.memo || false]);
    }
  }
}

function doGet(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var action = e.parameter.action || '';

  // ===== 달력 데이터 쓰기 =====
  if (action === 'calendarWrite') {
    var data = JSON.parse(e.parameter.data || '{}');
    writeCalendarData(data);
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  }

  // ===== 달력 데이터 읽기 =====
  if (action === 'calendarRead') {
    var calSheet = getCalendarSheet();
    var rows = calSheet.getDataRange().getDisplayValues();
    var events = {};
    for (var i = 1; i < rows.length; i++) {
      var rawKey = String(rows[i][0]).replace(/^d:/, '');
      var orderNo = rows[i][1], productName = rows[i][2], qty = rows[i][3], moved = rows[i][4], memo = rows[i][5];
      if (!rawKey) continue;
      if (!events[rawKey]) events[rawKey] = [];
      events[rawKey].push({
        orderNo: String(orderNo),
        productName: String(productName),
        qty: String(qty),
        moved: moved === 'TRUE' || moved === true,
        memo: memo === 'TRUE' || memo === true
      });
    }
    return ContentService.createTextOutput(JSON.stringify(events)).setMimeType(ContentService.MimeType.JSON);
  }

  // ===== 품절 기록 저장 (saveReasons) =====
  if (action === 'saveReasons') {
    var sheet = ss.getSheetByName(SHEET_NAME);
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'sheet not found' })).setMimeType(ContentService.MimeType.JSON);
    }
    var items = JSON.parse(e.parameter.data || '[]');
    var rows = items.map(function(item) {
      return [item.barcode || '', item.productName || '', item.optionName || '', item.date || '', item.reason || ''];
    });
    if (rows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, added: rows.length })).setMimeType(ContentService.MimeType.JSON);
  }

  // ===== 품절 기록 삭제 (deleteReason) =====
  if (action === 'deleteReason') {
    var sheet2 = ss.getSheetByName(SHEET_NAME);
    if (!sheet2) {
      return ContentService.createTextOutput(JSON.stringify({ error: 'sheet not found' })).setMimeType(ContentService.MimeType.JSON);
    }
    var barcode = e.parameter.barcode;
    var data = sheet2.getDataRange().getValues();
    for (var i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]) === String(barcode)) {
        sheet2.deleteRow(i + 1);
        break;
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  }

  // ===== 주의 품목 추가 (addCaution) =====
  if (action === 'addCaution') {
    var cautionSheet = ss.getSheetByName('주의 품목');
    if (!cautionSheet) {
      cautionSheet = ss.insertSheet('주의 품목');
      cautionSheet.getRange(1, 1, 1, 3).setValues([['바코드', '상품명', '옵션명']]);
    }
    var cautionData = cautionSheet.getDataRange().getValues();
    for (var i = 1; i < cautionData.length; i++) {
      if (String(cautionData[i][0]) === String(e.parameter.barcode)) {
        return ContentService.createTextOutput(JSON.stringify({ ok: true, msg: 'already exists' })).setMimeType(ContentService.MimeType.JSON);
      }
    }
    cautionSheet.appendRow([e.parameter.barcode || '', e.parameter.productName || '', e.parameter.optionName || '']);
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  }

  // ===== 주의 품목 삭제 (removeCaution) =====
  if (action === 'removeCaution') {
    var cautionSheet2 = ss.getSheetByName('주의 품목');
    if (cautionSheet2) {
      var cautionData2 = cautionSheet2.getDataRange().getValues();
      for (var i = cautionData2.length - 1; i >= 1; i--) {
        if (String(cautionData2[i][0]) === String(e.parameter.barcode)) {
          cautionSheet2.deleteRow(i + 1);
          break;
        }
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  }

  // ===== 기존: 시트 데이터 TSV 읽기 =====
  var sheetName = e.parameter.sheet || '재고 계산기';
  var tsvSheet = ss.getSheetByName(sheetName);
  if (!tsvSheet) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'Sheet not found: ' + sheetName }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  var tsvData = tsvSheet.getDataRange().getDisplayValues();
  var tsv = tsvData.map(function(row) { return row.join('\t'); }).join('\n');
  return ContentService.createTextOutput(tsv).setMimeType(ContentService.MimeType.TEXT);
}

// doPost는 하위호환을 위해 유지하되, doGet으로 동일하게 라우팅
function doPost(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var body = JSON.parse(e.postData.contents);
  var action = body.action;

  if (action === 'calendarWrite') {
    writeCalendarData(body.data);
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'addCaution') {
    var cautionSheet = ss.getSheetByName('주의 품목');
    if (!cautionSheet) {
      cautionSheet = ss.insertSheet('주의 품목');
      cautionSheet.getRange(1, 1, 1, 3).setValues([['바코드', '상품명', '옵션명']]);
    }
    var cautionData = cautionSheet.getDataRange().getValues();
    for (var i = 1; i < cautionData.length; i++) {
      if (String(cautionData[i][0]) === String(body.barcode)) {
        return ContentService.createTextOutput(JSON.stringify({ ok: true, msg: 'already exists' })).setMimeType(ContentService.MimeType.JSON);
      }
    }
    cautionSheet.appendRow([body.barcode || '', body.productName || '', body.optionName || '']);
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'removeCaution') {
    var cautionSheet2 = ss.getSheetByName('주의 품목');
    if (cautionSheet2) {
      var cautionData2 = cautionSheet2.getDataRange().getValues();
      for (var i = cautionData2.length - 1; i >= 1; i--) {
        if (String(cautionData2[i][0]) === String(body.barcode)) {
          cautionSheet2.deleteRow(i + 1);
          break;
        }
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  }

  var sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'sheet not found' })).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'saveReasons') {
    var items = body.items || [];
    var rows = items.map(function(item) {
      return [item.barcode || '', item.productName || '', item.optionName || '', item.date || '', item.reason || ''];
    });
    if (rows.length > 0) {
      sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 5).setValues(rows);
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true, added: rows.length })).setMimeType(ContentService.MimeType.JSON);
  }

  if (action === 'deleteReason') {
    var barcode = body.barcode;
    var data = sheet.getDataRange().getValues();
    for (var i = data.length - 1; i >= 1; i--) {
      if (String(data[i][0]) === String(barcode)) {
        sheet.deleteRow(i + 1);
        break;
      }
    }
    return ContentService.createTextOutput(JSON.stringify({ ok: true })).setMimeType(ContentService.MimeType.JSON);
  }

  return ContentService.createTextOutput(JSON.stringify({ error: 'unknown action' })).setMimeType(ContentService.MimeType.JSON);
}
