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
`);

app.use(cors());
app.use(express.json({ limit: '10mb' }));

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
  const row = db.prepare('SELECT id FROM soldout_reasons WHERE barcode = ? ORDER BY id DESC LIMIT 1').get(barcode);
  if (row) db.prepare('DELETE FROM soldout_reasons WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// 주의 품목
app.post('/api/caution', (req, res) => {
  const { barcode, productName, optionName } = req.body;
  try {
    db.prepare('INSERT OR IGNORE INTO caution_items (barcode, product_name, option_name) VALUES (?, ?, ?)').run(barcode, productName, optionName);
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
  db.prepare('DELETE FROM caution_items WHERE barcode = ?').run(req.params.barcode);
  res.json({ ok: true });
});

// 캘린더 이벤트
app.post('/api/calendar', (req, res) => {
  const { events } = req.body;
  db.prepare('DELETE FROM calendar_events').run();
  db.prepare('INSERT INTO calendar_events (event_data) VALUES (?)').run(JSON.stringify(events));
  res.json({ ok: true });
});

app.get('/api/calendar', (req, res) => {
  const row = db.prepare('SELECT event_data FROM calendar_events ORDER BY id DESC LIMIT 1').get();
  res.json({ events: row ? JSON.parse(row.event_data) : [] });
});

// 범용 저장소 (localStorage 대체)
const VALID_STORES = ['fbc_savings', 'soldout_history', 'soldout_exclude', 'new_product_stock', 'orderbook_notes', 'supplies_orders', 'issue_special_items', 'soldout_rate'];

app.post('/api/store/:name', (req, res) => {
  const { name } = req.params;
  if (!VALID_STORES.includes(name)) return res.status(400).json({ error: 'invalid store' });
  const { data } = req.body;
  db.prepare(`DELETE FROM ${name}`).run();
  db.prepare(`INSERT INTO ${name} (data) VALUES (?)`).run(JSON.stringify(data));
  res.json({ ok: true });
});

app.get('/api/store/:name', (req, res) => {
  const { name } = req.params;
  if (!VALID_STORES.includes(name)) return res.status(400).json({ error: 'invalid store' });
  const row = db.prepare(`SELECT data FROM ${name} ORDER BY id DESC LIMIT 1`).get();
  res.json({ data: row ? JSON.parse(row.data) : null });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('SCM API server running on port ' + PORT);
});
