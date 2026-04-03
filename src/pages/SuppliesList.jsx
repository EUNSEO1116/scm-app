import { useState, useMemo, useEffect, useCallback } from 'react';

const ORDERS_KEY = 'supplies_orders';
const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const CSV_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('부자재목록 최신')}`;
const CSV_ORDERBOOK = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('발주장부')}`;

function parseCSV(text) {
  const rows = [];
  let current = '';
  let inQuotes = false;
  const lines = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      rows.push(current);
      current = '';
    } else if ((ch === '\n' || ch === '\r') && !inQuotes) {
      if (current || rows.length > 0) {
        rows.push(current);
        lines.push(rows.splice(0));
        current = '';
      }
      if (ch === '\r' && text[i + 1] === '\n') i++;
    } else {
      current += ch;
    }
  }
  if (current || rows.length > 0) {
    rows.push(current);
    lines.push(rows.splice(0));
  }
  return lines;
}

function fmt(n) {
  if (n === null || n === undefined || n === '' || n === '-') return '-';
  const num = Number(n);
  if (isNaN(num)) return n;
  return num.toLocaleString('ko-KR');
}

function ProductCell({ products }) {
  const [open, setOpen] = useState(false);
  if (!products.length) return <span style={{ color: '#9aa0a6' }}>-</span>;
  if (products.length === 1) return <span>{products[0]}</span>;

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span>{products[0]}</span>
        <button
          onClick={() => setOpen(!open)}
          style={{
            border: 'none', background: 'none', cursor: 'pointer',
            color: '#1967d2', fontSize: 12, fontWeight: 500,
            padding: '2px 0', whiteSpace: 'nowrap',
          }}
        >
          외 {products.length - 1}건 {open ? '−' : '+'}
        </button>
      </div>
      {open && products.slice(1).map((p, i) => (
        <div key={i} style={{ fontSize: 12, color: '#5f6368', marginTop: 2, paddingLeft: 2 }}>
          {p}
        </div>
      ))}
    </div>
  );
}

export default function SuppliesList() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [sortKey, setSortKey] = useState(null);
  const [sortDir, setSortDir] = useState('asc');
  const [showCnName, setShowCnName] = useState(true);
  const [showProduct, setShowProduct] = useState(true);

  const [orderbook, setOrderbook] = useState([]);

  // 발주장부의 "X월 Y일" → "YYYY-MM-DD" 문자열 파싱
  const parseOrderDate = (str) => {
    if (!str) return null;
    const m = str.trim().match(/(\d+)월\s*(\d+)일/);
    if (!m) return null;
    const year = new Date().getFullYear();
    const mm = String(parseInt(m[1])).padStart(2, '0');
    const dd = String(parseInt(m[2])).padStart(2, '0');
    return `${year}-${mm}-${dd}`;
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [res, obRes] = await Promise.all([
        fetch(CSV_URL),
        fetch(CSV_ORDERBOOK).catch(() => null),
      ]);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      const lines = parseCSV(text);
      if (lines.length < 2) throw new Error('데이터가 없습니다');

      const results = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i];
        const category = (cols[1] || '').trim();
        const productRaw = (cols[3] || '').trim();
        const products = productRaw ? productRaw.split('\n').map(s => s.trim()).filter(Boolean) : [];
        const product = products[0] || '';
        const cnName = (cols[4] || '').trim();
        const usage1 = (cols[5] || '').trim();
        const usage2 = (cols[6] || '').trim();
        const size = (cols[7] || '').trim();
        const cnBarcode = (cols[8] || '').trim();
        const moq = (cols[9] || '').trim();
        const priceRaw = (cols[13] || '').trim();
        const price = priceRaw && !isNaN(Number(priceRaw)) ? Number(priceRaw) : null;
        const setQtyRaw = (cols[17] || '').trim();
        const setQty = parseInt(setQtyRaw) || 1;

        if (!category && !cnName && !product) continue;

        results.push({
          id: i, category, product, products, cnName,
          usage1, usage2, size, cnBarcode, moq, price, setQty,
        });
      }
      setData(results);

      // 발주장부 파싱
      if (obRes && obRes.ok) {
        const obText = await obRes.text();
        const obLines = parseCSV(obText);
        const obData = [];
        for (let i = 1; i < obLines.length; i++) {
          const cols = obLines[i];
          const optionName = (cols[1] || '').trim(); // 한글옵션명*
          const qty = Number(cols[3]) || 0;           // 수량*
          const dateStr = (cols[16] || '').trim();     // 발주일 (Q열)
          const orderDate = parseOrderDate(dateStr);
          if (optionName && qty > 0) {
            obData.push({ optionName, qty, orderDate });
          }
        }
        setOrderbook(obData);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // 남은 수량 계산: 부자재 발주 입고량 - 발주장부 소모량
  const remainingByBarcode = useMemo(() => {
    // 1) 부자재 발주에서 바코드별 입고 수량 + 입고일 기록
    let supplyOrders = [];
    try {
      supplyOrders = JSON.parse(localStorage.getItem(ORDERS_KEY) || '[]');
    } catch {}

    // 바코드별 입고된 수량 합산
    const stockByBarcode = {};
    // 바코드별 가장 빠른 입고일 (발주장부 차감 기준)
    const earliestArrivalByBarcode = {};
    supplyOrders.forEach(o => {
      if (o.arrived && o.remainingQty > 0) {
        const bc = (o.cnBarcode || '').toLowerCase();
        stockByBarcode[bc] = (stockByBarcode[bc] || 0) + o.remainingQty;
        const arrDate = o.eta;
        if (!earliestArrivalByBarcode[bc] || arrDate < earliestArrivalByBarcode[bc]) {
          earliestArrivalByBarcode[bc] = arrDate;
        }
      }
    });

    if (!data || !orderbook.length) return stockByBarcode;

    // 2) 부자재 목록에서 바코드 → { 이용중인 제품, 세트구성 } 매핑
    const barcodeInfo = {};
    data.forEach(r => {
      if (r.cnBarcode && r.products.length > 0) {
        barcodeInfo[r.cnBarcode.toLowerCase()] = { products: r.products, setQty: r.setQty || 1 };
      }
    });

    // 3) 발주장부에서 소모량 차감
    //    한글옵션명이 이용중인 제품에 포함되면, 해당 바코드의 재고에서 차감
    //    발주일이 부자재 입고일 이후인 것만 차감
    //    차감량 = 발주수량 × 세트구성 (예: 4세트짜리 제품 1개 발주 → 부자재 4개 소모)
    Object.keys(stockByBarcode).forEach(barcode => {
      const info = barcodeInfo[barcode];
      if (!info) return;
      const { products, setQty } = info;
      const arrivalDate = earliestArrivalByBarcode[barcode];

      orderbook.forEach(ob => {
        if (!ob.orderDate) return;
        // 둘 다 "YYYY-MM-DD" 문자열이므로 직접 비교
        if (ob.orderDate < arrivalDate) return;

        const matched = products.some(p => p === ob.optionName || ob.optionName.includes(p) || p.includes(ob.optionName));
        if (matched) {
          stockByBarcode[barcode] = Math.max(0, (stockByBarcode[barcode] || 0) - (ob.qty * setQty));
        }
      });
    });

    return stockByBarcode;
  }, [data, orderbook]);

  const categories = useMemo(() => {
    if (!data) return [];
    const s = new Set();
    data.forEach(r => { if (r.category) s.add(r.category); });
    return [...s].sort();
  }, [data]);

  const filtered = useMemo(() => {
    if (!data) return [];
    let rows = data;

    if (search) {
      const q = search.toLowerCase();
      rows = rows.filter(r =>
        r.product.toLowerCase().includes(q) ||
        r.cnName.toLowerCase().includes(q) ||
        r.cnBarcode.toLowerCase().includes(q) ||
        r.usage1.toLowerCase().includes(q) ||
        r.usage2.toLowerCase().includes(q)
      );
    }

    if (categoryFilter !== 'all') {
      rows = rows.filter(r => r.category === categoryFilter);
    }

    if (sortKey) {
      rows = [...rows].sort((a, b) => {
        let va = a[sortKey], vb = b[sortKey];
        if (va === null || va === undefined) va = '';
        if (vb === null || vb === undefined) vb = '';
        if (typeof va === 'string') va = va.toLowerCase();
        if (typeof vb === 'string') vb = vb.toLowerCase();
        if (va < vb) return sortDir === 'asc' ? -1 : 1;
        if (va > vb) return sortDir === 'asc' ? 1 : -1;
        return 0;
      });
    }

    return rows;
  }, [data, search, categoryFilter, sortKey, sortDir]);

  const handleSort = (key) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const SortIcon = ({ col }) => (
    <span className="sort-icon">
      {sortKey === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
    </span>
  );


  if (loading && !data) {
    return (
      <div className="loading" style={{ padding: 80, flexDirection: 'column', gap: 12 }}>
        <div className="spinner" />
        <p>부자재 목록을 불러오는 중...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="card" style={{ margin: 24 }}>
        <div className="card-body" style={{ textAlign: 'center', padding: 40 }}>
          <p style={{ color: '#d93025', marginBottom: 12 }}>데이터 로드 실패: {error}</p>
          <button className="btn btn-primary" onClick={fetchData}>다시 시도</button>
        </div>
      </div>
    );
  }

  if (!data) return null;

  return (
    <div>
      {/* Filters */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className="filter-bar">
            <input
              className="search-input"
              placeholder="상품명, CN상품명, 바코드, 용도 검색..."
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
            <select
              className="filter-select"
              value={categoryFilter}
              onChange={e => setCategoryFilter(e.target.value)}
            >
              <option value="all">전체 분류</option>
              {categories.map(c => (
                <option key={c} value={c}>{c}</option>
              ))}
            </select>
            <button className="btn btn-outline" onClick={() => { setSearch(''); setCategoryFilter('all'); }}>
              초기화
            </button>
            <button
              className={`btn ${showProduct ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setShowProduct(!showProduct)}
              style={{ padding: '6px 10px', fontSize: 12 }}
            >
              이용제품 {showProduct ? 'ON' : 'OFF'}
            </button>
            <button
              className={`btn ${showCnName ? 'btn-primary' : 'btn-outline'}`}
              onClick={() => setShowCnName(!showCnName)}
              style={{ padding: '6px 10px', fontSize: 12 }}
            >
              CN상품명 {showCnName ? 'ON' : 'OFF'}
            </button>
            <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 13, color: '#5f6368' }}>{filtered.length}개 상품</span>
              <button className="btn btn-primary" onClick={fetchData} style={{ padding: '6px 12px', fontSize: 13 }}>
                🔄 새로고침
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="card">
        <div className="card-body" style={{ padding: 0 }}>
          <div className="table-wrap">
            <table className="data-table supplies-table">
              <thead>
                <tr>
                  <th className="col-num">#</th>
                  <th onClick={() => handleSort('category')} className={sortKey === 'category' ? 'sorted' : ''}>
                    분류<SortIcon col="category" />
                  </th>
                  <th onClick={() => handleSort('usage1')} className={sortKey === 'usage1' ? 'sorted' : ''}>
                    용도1<SortIcon col="usage1" />
                  </th>
                  {showProduct && (
                    <th onClick={() => handleSort('product')} className={sortKey === 'product' ? 'sorted' : ''}>
                      이용중인 제품<SortIcon col="product" />
                    </th>
                  )}
                  {showCnName && (
                    <th onClick={() => handleSort('cnName')} className={sortKey === 'cnName' ? 'sorted' : ''}>
                      CN상품명<SortIcon col="cnName" />
                    </th>
                  )}
                  <th onClick={() => handleSort('usage2')} className={sortKey === 'usage2' ? 'sorted' : ''}>
                    용도2<SortIcon col="usage2" />
                  </th>
                  <th onClick={() => handleSort('size')} className={sortKey === 'size' ? 'sorted' : ''}>
                    사이즈<SortIcon col="size" />
                  </th>
                  <th onClick={() => handleSort('cnBarcode')} className={sortKey === 'cnBarcode' ? 'sorted' : ''}>
                    CN바코드<SortIcon col="cnBarcode" />
                  </th>
                  <th onClick={() => handleSort('moq')} className={sortKey === 'moq' ? 'sorted' : ''}>
                    MOQ<SortIcon col="moq" />
                  </th>
                  <th onClick={() => handleSort('setQty')} className={sortKey === 'setQty' ? 'sorted' : ''}>
                    세트<SortIcon col="setQty" />
                  </th>
                  <th onClick={() => handleSort('price')} className={sortKey === 'price' ? 'sorted' : ''}>
                    가격<SortIcon col="price" />
                  </th>
                  <th>남은수량</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r, i) => (
                  <tr key={r.id}>
                    <td className="num">{i + 1}</td>
                    <td><span className="category-badge">{r.category || '-'}</span></td>
                    <td>{r.usage1 || '-'}</td>
                    {showProduct && <td><ProductCell products={r.products} /></td>}
                    {showCnName && <td>{r.cnName || '-'}</td>}
                    <td>{r.usage2 || '-'}</td>
                    <td>{r.size || '-'}</td>
                    <td style={{ fontSize: 12 }}>{r.cnBarcode || '-'}</td>
                    <td className="num">{r.moq || '-'}</td>
                    <td className="num">{r.setQty > 1 ? r.setQty + 'p' : '-'}</td>
                    <td className="num">{r.price !== null ? fmt(r.price) + '원' : '-'}</td>
                    {(() => {
                      const rem = remainingByBarcode[(r.cnBarcode || '').toLowerCase()];
                      return (
                        <td className="num" style={{ fontWeight: rem ? 600 : 400, color: rem ? '#1967d2' : '#9aa0a6' }}>
                          {rem ? rem.toLocaleString() : '-'}
                        </td>
                      );
                    })()}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
