import { useState, useMemo, useEffect, useCallback } from 'react';

const STORAGE_KEY = 'supplies_orders';
const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('부자재목록 최신')}`;

function loadOrders() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY)) || []; }
  catch { return []; }
}

function saveOrders(orders) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(orders));
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function parseCSV(text) {
  const rows = [];
  let current = '';
  let inQuotes = false;
  const lines = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') { current += '"'; i++; }
      else inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      rows.push(current); current = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (current || rows.length > 0) { rows.push(current); lines.push(rows.splice(0)); current = ''; }
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else { current += ch; }
  }
  if (current || rows.length > 0) { rows.push(current); lines.push(rows.splice(0)); }
  return lines;
}

export default function SuppliesOrder() {
  const [orders, setOrders] = useState(loadOrders);
  const [barcodes, setBarcodes] = useState([]);
  const [barcodeMap, setBarcodeMap] = useState({});

  // Form state
  const [orderNo, setOrderNo] = useState('');
  const [cnBarcode, setCnBarcode] = useState('');
  const [qty, setQty] = useState('');
  const [eta, setEta] = useState('');
  const [search, setSearch] = useState('');

  // Load barcode list from sheet
  useEffect(() => {
    fetch(CSV_URL).then(r => r.text()).then(text => {
      const lines = parseCSV(text);
      const map = {};
      const codes = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i];
        const barcode = (cols[8] || '').trim();
        const cnName = (cols[4] || '').trim();
        const category = (cols[1] || '').trim();
        if (barcode) {
          map[barcode] = { cnName, category };
          codes.push(barcode);
        }
      }
      setBarcodes(codes);
      setBarcodeMap(map);
    }).catch(() => {});
  }, []);

  const addOrder = () => {
    if (!orderNo.trim() || !cnBarcode.trim() || !qty || !eta) return;
    const order = {
      id: Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      orderNo: orderNo.trim(),
      cnBarcode: cnBarcode.trim(),
      qty: Number(qty),
      remainingQty: Number(qty),
      eta,
      createdAt: today(),
      arrived: false,
    };
    const updated = [order, ...orders];
    setOrders(updated);
    saveOrders(updated);
    setOrderNo('');
    setCnBarcode('');
    setQty('');
    setEta('');
  };

  const deleteOrder = (id) => {
    if (!confirm('이 발주 기록을 삭제하시겠습니까?')) return;
    const updated = orders.filter(o => o.id !== id);
    setOrders(updated);
    saveOrders(updated);
  };

  // Auto-arrive: mark orders as arrived if ETA has passed
  useEffect(() => {
    const now = today();
    let changed = false;
    const updated = orders.map(o => {
      if (!o.arrived && o.eta <= now) {
        changed = true;
        return { ...o, arrived: true };
      }
      return o;
    });
    if (changed) {
      setOrders(updated);
      saveOrders(updated);
    }
  }, [orders]);

  const filtered = useMemo(() => {
    if (!search) return orders;
    const q = search.toLowerCase();
    return orders.filter(o =>
      o.orderNo.toLowerCase().includes(q) ||
      o.cnBarcode.toLowerCase().includes(q) ||
      (barcodeMap[o.cnBarcode]?.cnName || '').toLowerCase().includes(q)
    );
  }, [orders, search, barcodeMap]);

  const pendingCount = orders.filter(o => !o.arrived).length;
  const arrivedCount = orders.filter(o => o.arrived && o.remainingQty > 0).length;

  return (
    <div>
      {/* Order Form */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 12 }}>발주 등록</h3>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: '#5f6368', fontWeight: 500 }}>발주번호</label>
              <input
                className="filter-input"
                value={orderNo}
                onChange={e => setOrderNo(e.target.value)}
                placeholder="PO-001"
                style={{ padding: '7px 10px', border: '1px solid #dadce0', borderRadius: 6, fontSize: 13, width: 140 }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: '#5f6368', fontWeight: 500 }}>CN바코드</label>
              <input
                list="barcode-list"
                className="filter-input"
                value={cnBarcode}
                onChange={e => setCnBarcode(e.target.value)}
                placeholder="바코드 입력/선택"
                style={{ padding: '7px 10px', border: '1px solid #dadce0', borderRadius: 6, fontSize: 13, width: 180 }}
              />
              <datalist id="barcode-list">
                {barcodes.map(b => (
                  <option key={b} value={b}>{barcodeMap[b]?.cnName || ''}</option>
                ))}
              </datalist>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: '#5f6368', fontWeight: 500 }}>발주수량</label>
              <input
                type="number"
                className="filter-input"
                value={qty}
                onChange={e => setQty(e.target.value)}
                placeholder="0"
                min="1"
                style={{ padding: '7px 10px', border: '1px solid #dadce0', borderRadius: 6, fontSize: 13, width: 100 }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <label style={{ fontSize: 12, color: '#5f6368', fontWeight: 500 }}>예상입고예정일</label>
              <input
                type="date"
                className="filter-input"
                value={eta}
                onChange={e => setEta(e.target.value)}
                style={{ padding: '7px 10px', border: '1px solid #dadce0', borderRadius: 6, fontSize: 13, width: 160 }}
              />
            </div>
            <button
              className="btn btn-primary"
              onClick={addOrder}
              disabled={!orderNo.trim() || !cnBarcode.trim() || !qty || !eta}
              style={{ padding: '8px 20px', fontSize: 13, opacity: (!orderNo.trim() || !cnBarcode.trim() || !qty || !eta) ? 0.5 : 1 }}
            >
              등록
            </button>
          </div>
          {cnBarcode && barcodeMap[cnBarcode] && (
            <div style={{ marginTop: 8, fontSize: 12, color: '#1967d2' }}>
              {barcodeMap[cnBarcode].category} — {barcodeMap[cnBarcode].cnName}
            </div>
          )}
        </div>
      </div>

      {/* Filter + Summary */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className="filter-bar">
            <input
              className="search-input"
              placeholder="발주번호, 바코드, 상품명 검색..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ maxWidth: 300 }}
            />
            <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginLeft: 'auto', fontSize: 13 }}>
              <span style={{ color: '#e8710a' }}>입고대기 <strong>{pendingCount}</strong>건</span>
              <span style={{ color: '#1967d2' }}>입고완료 <strong>{arrivedCount}</strong>건</span>
              <span style={{ color: '#5f6368' }}>전체 <strong>{orders.length}</strong>건</span>
            </div>
          </div>
        </div>
      </div>

      {/* Orders Table */}
      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-wrap" style={{ maxHeight: 'calc(100vh - 400px)' }}>
            <table className="data-table supplies-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>상태</th>
                  <th>발주번호</th>
                  <th>CN바코드</th>
                  <th>상품명</th>
                  <th>발주수량</th>
                  <th>남은수량</th>
                  <th>예상입고일</th>
                  <th>발주일</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr>
                    <td colSpan={10} style={{ textAlign: 'center', padding: 40, color: '#9aa0a6' }}>
                      발주 기록이 없습니다
                    </td>
                  </tr>
                ) : filtered.map((o, i) => {
                  const info = barcodeMap[o.cnBarcode];
                  const isArrived = o.arrived;
                  const isDepleted = o.remainingQty <= 0;
                  return (
                    <tr key={o.id} style={isDepleted ? { opacity: 0.4 } : undefined}>
                      <td className="num">{i + 1}</td>
                      <td>
                        {isDepleted ? (
                          <span style={{ fontSize: 12, color: '#9aa0a6', fontWeight: 500 }}>소진</span>
                        ) : isArrived ? (
                          <span style={{ fontSize: 12, color: '#1967d2', fontWeight: 500 }}>입고완료</span>
                        ) : (
                          <span style={{ fontSize: 12, color: '#e8710a', fontWeight: 500 }}>입고대기</span>
                        )}
                      </td>
                      <td style={{ fontWeight: 500 }}>{o.orderNo}</td>
                      <td style={{ fontSize: 12 }}>{o.cnBarcode}</td>
                      <td>{info?.cnName || '-'}</td>
                      <td className="num">{o.qty.toLocaleString()}</td>
                      <td className="num" style={{ fontWeight: 600, color: o.remainingQty > 0 ? '#1967d2' : '#9aa0a6' }}>
                        {o.remainingQty.toLocaleString()}
                      </td>
                      <td>{o.eta}</td>
                      <td style={{ fontSize: 12, color: '#9aa0a6' }}>{o.createdAt}</td>
                      <td>
                        <button
                          onClick={() => deleteOrder(o.id)}
                          style={{ border: 'none', background: 'none', color: '#d93025', cursor: 'pointer', fontSize: 14, padding: '2px 6px' }}
                          title="삭제"
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
