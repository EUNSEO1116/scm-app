const express = require('express');
const cors = require('cors');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const PORT = 3100;

const db = new Database(path.join(__dirname, 'scm.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS soldout_reasons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT NOT NULL,
    product_name TEXT,
    option_name TEXT,
    date TEXT,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS caution_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT UNIQUE NOT NULL,
    product_name TEXT,
    option_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS calendar_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS fbc_savings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS soldout_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS soldout_exclude (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    barcode TEXT UNIQUE NOT NULL,
    product_name TEXT,
    option_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS new_product_stock (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS orderbook_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS supplies_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS issue_special_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS soldout_rate (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS soldout_reasons_obj (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    data TEXT NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action_type TEXT NOT NULL,
    description TEXT NOT NULL,
    target TEXT,
    before_data TEXT,
    after_data TEXT,
    reverted INTEGER DEFAULT 0,
    group_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// group_id 컬럼 없으면 추가 (기존 DB 호환)
try { db.exec('ALTER TABLE activity_log ADD COLUMN group_id TEXT'); } catch {}
// 기존 쓸모없는 로그 정리
try { db.exec("DELETE FROM activity_log WHERE description LIKE '%tracker%' OR description LIKE '%cached%' OR description LIKE '%sync%' OR description LIKE '%dashboard_cache%' OR description LIKE '%dismissed%' OR description LIKE '%캘린더 이벤트 저장%'"); } catch {}

app.use(cors());
app.use(express.json({ limit: '10mb' }));

// 활동 로그 — 자동 저장은 완전 제외
const SKIP_LOG_STORES = new Set([
  'dashboard_cache',
  'soldout_analysis_tracker',
  'soldout_analysis_rate_snapshots',
  'pending_sync_alerts',
  'imp_pending_sync_alerts',
  'dismissed_sync_barcodes',
]);
const SKIP_LOG_PREFIXES = ['dashboard_history_', 'soldout_analysis_cached_'];

function shouldSkipLog(storeName) {
  if (SKIP_LOG_STORES.has(storeName)) return true;
  return SKIP_LOG_PREFIXES.some(p => storeName.startsWith(p));
}

const STORE_NAMES_KR = {
  soldout_analysis_exclude: '(NEW)품절 제외 항목',
  soldout_exclude: '품절 제외 항목',
  soldout_stock_corrections: '품절 재고 수정',
  soldout_reasons_obj: '품절 사유',
  soldout_history: '품절 기록',
  soldout_rate: '품절률 스냅샷',
  new_product_stock: '신규 상품 재고',
  issue_special_items: '특별 관리 품목',
  issue_img_data: '이슈 이미지',
  issue_img_counts: '이미지 개수',
  imp_watch_barcodes: '상품개선 감시 목록',
  improvement_items: '상품개선 항목',
  improvement_images: '상품개선 이미지',
  orderbook_notes: '발주장부 메모',
  closed_products: '마감 상품',
  supplies_orders: '자재 주문',
  fbc_savings: 'FBC 절감',
  sales_memos: '매출 메모',
};

// 5초 내 연속 저장은 같은 그룹으로 묶기
let lastGroupId = null;
let lastLogTime = 0;
const GROUP_WINDOW_MS = 5000;

function logActivity(actionType, description, target, beforeData, afterData) {
  try {
    const now = Date.now();
    if (now - lastLogTime > GROUP_WINDOW_MS || !lastGroupId) {
      lastGroupId = String(now);
    }
    lastLogTime = now;
    db.prepare('INSERT INTO activity_log (action_type, description, target, before_data, after_data, group_id) VALUES (?, ?, ?, ?, ?, ?)')
      .run(actionType, description, target,
        beforeData != null ? JSON.stringify(beforeData) : null,
        afterData != null ? JSON.stringify(afterData) : null,
        lastGroupId);
  } catch (e) {
    console.error('Activity log error:', e);
  }
}

// 품절 사유
app.post('/api/soldout/reasons', (req, res) => {
  const { items } = req.body;
  const stmt = db.prepare('INSERT INTO soldout_reasons (barcode, product_name, option_name, date, reason) VALUES (?, ?, ?, ?, ?)');
  const insertMany = db.transaction((items) => {
    for (const item of items) {
      stmt.run(item.barcode, item.productName, item.optionName, item.date, item.reason);
    }
  });
  insertMany(items || []);
  if (items && items.length > 0) {
    const desc = items.length === 1
      ? `품절 사유 추가: ${items[0].productName || items[0].barcode}`
      : `품절 사유 ${items.length}건 추가`;
    logActivity('soldout_add', desc, 'soldout_reasons', null, items);
  }
  res.json({ ok: true, added: (items || []).length });
});

app.get('/api/soldout/reasons', (req, res) => {
  const rows = db.prepare('SELECT barcode, product_name as productName, option_name as optionName, date, reason FROM soldout_reasons ORDER BY id').all();
  const reasons = {};
  const history = {};
  for (const row of rows) {
    reasons[row.barcode] = { reason: row.reason, date: row.date };
    if (!history[row.barcode]) history[row.barcode] = [];
    history[row.barcode].push(row);
  }
  res.json({ reasons, history });
});

app.delete('/api/soldout/reasons/:barcode', (req, res) => {
  const { barcode } = req.params;
  const row = db.prepare('SELECT barcode, product_name, option_name, date, reason FROM soldout_reasons WHERE barcode = ? ORDER BY id DESC LIMIT 1').get(barcode);
  if (row) {
    db.prepare('DELETE FROM soldout_reasons WHERE barcode = ? AND date = ? AND reason = ?').run(row.barcode, row.date, row.reason);
    logActivity('soldout_delete', `품절 사유 삭제: ${row.product_name || barcode}`, 'soldout_reasons',
      { barcode: row.barcode, productName: row.product_name, optionName: row.option_name, date: row.date, reason: row.reason }, null);
  }
  res.json({ ok: true });
});

// 주의 품목
app.post('/api/caution', (req, res) => {
  const { barcode, productName, optionName } = req.body;
  try {
    const result = db.prepare('INSERT OR IGNORE INTO caution_items (barcode, product_name, option_name) VALUES (?, ?, ?)').run(barcode, productName, optionName);
    if (result.changes > 0) {
      logActivity('caution_add', `주의 품목 추가: ${productName || barcode}`, 'caution_items',
        null, { barcode, productName, optionName });
    }
    res.json({ ok: true });
  } catch (e) {
    res.json({ ok: true, msg: 'already exists' });
  }
});

app.get('/api/caution', (req, res) => {
  const rows = db.prepare('SELECT barcode, product_name as productName, option_name as optionName FROM caution_items').all();
  res.json(rows);
});

app.delete('/api/caution/:barcode', (req, res) => {
  const row = db.prepare('SELECT barcode, product_name, option_name FROM caution_items WHERE barcode = ?').get(req.params.barcode);
  db.prepare('DELETE FROM caution_items WHERE barcode = ?').run(req.params.barcode);
  if (row) {
    logActivity('caution_delete', `주의 품목 제거: ${row.product_name || req.params.barcode}`, 'caution_items',
      { barcode: row.barcode, productName: row.product_name, optionName: row.option_name }, null);
  }
  res.json({ ok: true });
});

// 캘린더 이벤트
app.post('/api/calendar', (req, res) => {
  const { events } = req.body;
  const skipLog = req.query.skipLog === '1';
  const currentRow = db.prepare('SELECT event_data FROM calendar_events ORDER BY id DESC LIMIT 1').get();
  const beforeEvents = currentRow ? JSON.parse(currentRow.event_data) : [];
  db.prepare('DELETE FROM calendar_events').run();
  db.prepare('INSERT INTO calendar_events (event_data) VALUES (?)').run(JSON.stringify(events));
  if (!skipLog) {
    logActivity('calendar_save', '캘린더 이벤트 저장', 'calendar', beforeEvents, events);
  }
  res.json({ ok: true });
});

app.get('/api/calendar', (req, res) => {
  const row = db.prepare('SELECT event_data FROM calendar_events ORDER BY id DESC LIMIT 1').get();
  res.json({ events: row ? JSON.parse(row.event_data) : [] });
});

// 범용 저장소 (localStorage 대체) — 이름 형식만 검증 (영소문자+숫자+언더스코어)
const isValidStore = (name) => /^[a-z][a-z0-9_]*$/.test(name);

app.post('/api/store/:name', (req, res) => {
  const { name } = req.params;
  if (!isValidStore(name)) return res.status(400).json({ error: 'invalid store name' });
  const { data } = req.body;
  // 변경 전 데이터 읽기 (로그용)
  let beforeData = null;
  try {
    const currentRow = db.prepare(`SELECT data FROM ${name} ORDER BY id DESC LIMIT 1`).get();
    beforeData = currentRow ? JSON.parse(currentRow.data) : null;
  } catch { /* 테이블 미존재 */ }
  try {
    db.prepare(`DELETE FROM ${name}`).run();
  } catch {
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    db.prepare(`DELETE FROM ${name}`).run();
  }
  db.prepare(`INSERT INTO ${name} (data) VALUES (?)`).run(JSON.stringify(data));
  const skipLog = req.query.skipLog === '1';
  if (!skipLog && !shouldSkipLog(name)) {
    const krName = STORE_NAMES_KR[name] || name;
    const desc = req.query.logDesc || `${krName} 저장`;
    logActivity('store_set', desc, name, beforeData, data);
  }
  res.json({ ok: true });
});

app.get('/api/store/:name', (req, res) => {
  const { name } = req.params;
  if (!isValidStore(name)) return res.status(400).json({ error: 'invalid store name' });
  try {
    const row = db.prepare(`SELECT data FROM ${name} ORDER BY id DESC LIMIT 1`).get();
    res.json({ data: row ? JSON.parse(row.data) : null });
  } catch {
    db.exec(`CREATE TABLE IF NOT EXISTS ${name} (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
    res.json({ data: null });
  }
});

// ===== 활동 로그 (그룹 기반) =====
app.get('/api/activity-log', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const offset = parseInt(req.query.offset) || 0;
  // group_id가 없는 레거시 로그는 각각 자기 id를 group_id로 사용
  const rows = db.prepare(`
    SELECT COALESCE(group_id, CAST(id AS TEXT)) as gid,
           GROUP_CONCAT(id) as ids,
           GROUP_CONCAT(description, '||') as descriptions,
           MIN(created_at) as created_at,
           MAX(reverted) as reverted,
           COUNT(*) as count
    FROM activity_log
    GROUP BY gid
    ORDER BY MAX(id) DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);
  const total = db.prepare('SELECT COUNT(DISTINCT COALESCE(group_id, CAST(id AS TEXT))) as count FROM activity_log').get().count;
  res.json({ logs: rows, total });
});

// 단일 로그 되돌리기 (내부 함수)
function revertSingleLog(log) {
  const beforeData = log.before_data ? JSON.parse(log.before_data) : null;
  const afterData = log.after_data ? JSON.parse(log.after_data) : null;
  switch (log.action_type) {
    case 'store_set': {
      if (!isValidStore(log.target)) throw new Error('invalid store');
      try { db.prepare(`DELETE FROM ${log.target}`).run(); } catch {
        db.exec(`CREATE TABLE IF NOT EXISTS ${log.target} (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
      }
      if (beforeData !== null) {
        db.prepare(`INSERT INTO ${log.target} (data) VALUES (?)`).run(JSON.stringify(beforeData));
      }
      break;
    }
    case 'calendar_save': {
      db.prepare('DELETE FROM calendar_events').run();
      if (beforeData) {
        db.prepare('INSERT INTO calendar_events (event_data) VALUES (?)').run(JSON.stringify(beforeData));
      }
      break;
    }
    case 'soldout_add': {
      if (afterData && Array.isArray(afterData)) {
        const del = db.prepare('DELETE FROM soldout_reasons WHERE barcode = ? AND date = ? AND reason = ?');
        for (const item of afterData) del.run(item.barcode, item.date, item.reason);
      }
      break;
    }
    case 'soldout_delete': {
      if (beforeData) {
        db.prepare('INSERT INTO soldout_reasons (barcode, product_name, option_name, date, reason) VALUES (?, ?, ?, ?, ?)')
          .run(beforeData.barcode, beforeData.productName, beforeData.optionName, beforeData.date, beforeData.reason);
      }
      break;
    }
    case 'caution_add': {
      if (afterData) db.prepare('DELETE FROM caution_items WHERE barcode = ?').run(afterData.barcode);
      break;
    }
    case 'caution_delete': {
      if (beforeData) {
        db.prepare('INSERT OR IGNORE INTO caution_items (barcode, product_name, option_name) VALUES (?, ?, ?)')
          .run(beforeData.barcode, beforeData.productName, beforeData.optionName);
      }
      break;
    }
  }
}

// 그룹 단위 되돌리기
app.post('/api/activity-log/revert-group/:groupId', (req, res) => {
  const { groupId } = req.params;
  const logs = db.prepare('SELECT * FROM activity_log WHERE (group_id = ? OR CAST(id AS TEXT) = ?) AND reverted = 0 ORDER BY id DESC').all(groupId, groupId);
  if (logs.length === 0) return res.status(404).json({ error: 'not found or already reverted' });

  try {
    const revertTx = db.transaction(() => {
      for (const log of logs) {
        revertSingleLog(log);
        db.prepare('UPDATE activity_log SET reverted = 1 WHERE id = ?').run(log.id);
      }
    });
    revertTx();
    // 되돌리기 로그 기록
    const descs = logs.map(l => l.description).join(', ');
    logActivity('revert', `[되돌리기] ${descs}`, null, null, null);
    res.json({ ok: true, reverted: logs.length });
  } catch (e) {
    console.error('Revert group error:', e);
    res.status(500).json({ error: 'revert failed', message: e.message });
  }
});

// 기존 단일 되돌리기 (호환용)
app.post('/api/activity-log/revert/:id', (req, res) => {
  const log = db.prepare('SELECT * FROM activity_log WHERE id = ?').get(req.params.id);
  if (!log) return res.status(404).json({ error: 'not found' });
  if (log.reverted) return res.status(400).json({ error: 'already reverted' });
  try {
    revertSingleLog(log);
    db.prepare('UPDATE activity_log SET reverted = 1 WHERE id = ?').run(log.id);
    logActivity('revert', `[되돌리기] ${log.description}`, log.target, null, null);
    res.json({ ok: true });
  } catch (e) {
    console.error('Revert error:', e);
    res.status(500).json({ error: 'revert failed', message: e.message });
  }
});

// ===== 이슈관리 사진 복구 (활동로그 스냅샷 → 바코드별 개별 저장소) =====
// 과거 단일 블롭(issue_img_data) 저장 로그의 before/after 스냅샷에서
// 바코드별 최대 이미지 세트를 복원한다. (한 번 호출로 안전하게 복구)
app.get('/api/recover-issue-images', (req, res) => {
  try {
    const rows = db.prepare("SELECT before_data, after_data FROM activity_log WHERE target = 'issue_img_data'").all();
    // 바코드별로 이력 전체에서 가장 많은 사진을 가진 버전을 채택 (합집합 복구)
    const merged = {};
    for (const row of rows) {
      for (const raw of [row.after_data, row.before_data]) {
        if (!raw) continue;
        let obj;
        try { obj = JSON.parse(raw); } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;
        for (const [barcode, imgs] of Object.entries(obj)) {
          if (Array.isArray(imgs) && imgs.length > 0) {
            if (!merged[barcode] || imgs.length > merged[barcode].length) merged[barcode] = imgs;
          }
        }
      }
    }
    if (Object.keys(merged).length === 0) {
      return res.json({ ok: false, message: '활동로그에 복구할 사진 스냅샷이 없습니다.', recoveredBarcodes: 0, recoveredImages: 0 });
    }
    // 기존 counts 유지 + 복구분 병합
    let counts = {};
    try { const r = db.prepare('SELECT data FROM issue_img_counts ORDER BY id DESC LIMIT 1').get(); if (r) counts = JSON.parse(r.data) || {}; } catch {}
    let barcodes = 0, images = 0;
    for (const [barcode, imgs] of Object.entries(merged)) {
      const name = `issue_img_${barcode.toLowerCase()}`;
      if (!isValidStore(name)) continue;
      try { db.prepare(`DELETE FROM ${name}`).run(); }
      catch { db.exec(`CREATE TABLE IF NOT EXISTS ${name} (id INTEGER PRIMARY KEY AUTOINCREMENT, data TEXT NOT NULL, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP)`); }
      db.prepare(`INSERT INTO ${name} (data) VALUES (?)`).run(JSON.stringify(imgs));
      counts[barcode] = imgs.length;
      barcodes++; images += imgs.length;
    }
    db.prepare('DELETE FROM issue_img_counts').run();
    db.prepare('INSERT INTO issue_img_counts (data) VALUES (?)').run(JSON.stringify(counts));
    res.json({ ok: true, recoveredBarcodes: barcodes, recoveredImages: images });
  } catch (e) {
    console.error('Recover issue images error:', e);
    res.status(500).json({ error: 'recover failed', message: e.message });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('SCM API server running on port ' + PORT);
});
