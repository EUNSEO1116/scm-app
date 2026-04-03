import { useState, useMemo, useEffect, useCallback } from 'react';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`;
const TSV_DATA = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=0`;
const STORAGE_KEY = 'soldout_exclude_items';
const EXCLUDE_KEYWORDS = ['최종마감', '품질확인서', '마감대상'];

function safeNum(v) {
  if (v === '' || v === '-' || v === undefined || v === null) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function loadExcludes() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]'); }
  catch { return []; }
}

function saveExcludes(list) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
}

function shouldExclude(status) {
  if (!status) return false;
  return EXCLUDE_KEYWORDS.some(kw => status.includes(kw));
}

function parseProducts(calcTsv, dataTsv) {
  const statusMap = {};
  if (dataTsv) {
    const lines = dataTsv.split('\n').filter(l => l.trim());
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split('\t');
      const optionId = (cols[2] || '').trim();
      const grade = (cols[6] || '').trim();
      if (optionId) statusMap[optionId] = grade;
    }
  }
  const lines = calcTsv.split('\n').filter(l => l.trim());
  const results = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (!cols[1] && !cols[2]) continue;
    const optionId = cols[1] || '';
    const barcode = cols[2] || '';
    const productName = cols[3] || '';
    const optionName = cols[4] || '';
    const rawStatus = cols[5] || '';
    const status = rawStatus || statusMap[optionId] || '';
    const stock = safeNum(cols[6]);
    if (shouldExclude(status)) continue;
    results.push({ optionId, barcode, productName, optionName, stock });
  }
  return results;
}

export default function SoldOutExclude() {
  const [products, setProducts] = useState([]);
  const [excludes, setExcludes] = useState(loadExcludes);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState('');

  // 다중 선택
  const [selected, setSelected] = useState(new Set());

  // 등록 모달
  const [showModal, setShowModal] = useState(false);
  const [endDate, setEndDate] = useState('');
  const [reason, setReason] = useState('');

  const fetchProducts = useCallback(async () => {
    setLoading(true);
    try {
      const [calcRes, dataRes] = await Promise.all([fetch(TSV_CALC), fetch(TSV_DATA)]);
      if (!calcRes.ok) throw new Error('fetch failed');
      const calcTsv = await calcRes.text();
      const dataTsv = dataRes.ok ? await dataRes.text() : null;
      setProducts(parseProducts(calcTsv, dataTsv));
    } catch (e) { console.error(e); }
    setLoading(false);
  }, []);

  useEffect(() => { fetchProducts(); }, [fetchProducts]);

  const today = todayStr();

  // 활성: endDate 없거나(무기한) 또는 endDate >= today
  const activeExcludes = useMemo(() =>
    excludes.filter(e => !e.endDate || e.endDate >= today), [excludes, today]);
  const expiredExcludes = useMemo(() =>
    excludes.filter(e => e.endDate && e.endDate < today), [excludes, today]);

  const excludedBarcodes = useMemo(() => new Set(activeExcludes.map(e => e.barcode)), [activeExcludes]);

  const filteredProducts = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    return products.filter(p =>
      p.productName.toLowerCase().includes(q) ||
      p.optionName.toLowerCase().includes(q) ||
      p.barcode.toLowerCase().includes(q)
    ).slice(0, 100);
  }, [products, search]);

  const toggleSelect = (barcode) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(barcode)) next.delete(barcode);
      else next.add(barcode);
      return next;
    });
  };

  const toggleSelectAll = () => {
    const selectable = filteredProducts.filter(p => !excludedBarcodes.has(p.barcode));
    if (selectable.every(p => selected.has(p.barcode))) {
      // 전체 해제
      setSelected(prev => {
        const next = new Set(prev);
        selectable.forEach(p => next.delete(p.barcode));
        return next;
      });
    } else {
      // 전체 선택
      setSelected(prev => {
        const next = new Set(prev);
        selectable.forEach(p => next.add(p.barcode));
        return next;
      });
    }
  };

  // 선택된 상품 정보 (모달에서 표시용)
  const selectedProducts = useMemo(() =>
    products.filter(p => selected.has(p.barcode)), [products, selected]);

  const handleBulkAdd = () => {
    if (selected.size === 0) return;
    const newItems = selectedProducts.map(p => ({
      barcode: p.barcode,
      productName: p.productName,
      optionName: p.optionName,
      addedDate: today,
      endDate: endDate || '', // 빈 문자열 = 무기한
      reason: reason.trim(),
    }));
    const existingBarcodes = new Set(newItems.map(i => i.barcode));
    const updated = [
      ...excludes.filter(e => !existingBarcodes.has(e.barcode)),
      ...newItems,
    ];
    saveExcludes(updated);
    setExcludes(updated);
    setSelected(new Set());
    setShowModal(false);
    setEndDate('');
    setReason('');
  };

  const handleRemove = (barcode) => {
    const updated = excludes.filter(e => e.barcode !== barcode);
    saveExcludes(updated);
    setExcludes(updated);
  };

  const handleClearExpired = () => {
    const updated = excludes.filter(e => !e.endDate || e.endDate >= today);
    saveExcludes(updated);
    setExcludes(updated);
  };

  return (
    <div>
      {/* 현재 제외 목록 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header">
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>
            품절률 제외 품목 ({activeExcludes.length}개 활성)
          </h2>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          {activeExcludes.length === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>
              제외 등록된 품목이 없습니다. 아래에서 상품을 검색하여 추가하세요.
            </div>
          ) : (
            <div className="table-wrapper">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>바코드</th>
                    <th>상품명</th>
                    <th>옵션명</th>
                    <th>등록일</th>
                    <th>종료일</th>
                    <th>사유</th>
                    <th>해제</th>
                  </tr>
                </thead>
                <tbody>
                  {activeExcludes.map(e => {
                    const isPermanent = !e.endDate;
                    const daysLeft = isPermanent ? null : Math.ceil((new Date(e.endDate) - new Date(today)) / 86400000);
                    return (
                      <tr key={e.barcode}>
                        <td style={{ fontSize: 11, color: '#666' }}>{e.barcode}</td>
                        <td>{e.productName}</td>
                        <td>{e.optionName}</td>
                        <td style={{ fontSize: 12 }}>{e.addedDate}</td>
                        <td style={{ fontSize: 12 }}>
                          {isPermanent ? (
                            <span style={{ color: '#1a73e8', fontWeight: 600 }}>무기한</span>
                          ) : (
                            <>
                              {e.endDate}
                              <span style={{ fontSize: 11, color: daysLeft <= 3 ? '#d93025' : '#666', marginLeft: 4 }}>
                                (D-{daysLeft})
                              </span>
                            </>
                          )}
                        </td>
                        <td style={{ fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }} title={e.reason}>
                          {e.reason || '-'}
                        </td>
                        <td>
                          <button
                            className="btn btn-outline btn-sm"
                            style={{ color: '#d93025', borderColor: '#d93025', padding: '2px 8px', fontSize: 11 }}
                            onClick={() => handleRemove(e.barcode)}
                          >해제</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 만료된 목록 */}
      {expiredExcludes.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-header">
            <h2 style={{ fontSize: 14, fontWeight: 600, color: '#999' }}>
              만료된 제외 ({expiredExcludes.length}개)
            </h2>
            <button className="btn btn-outline btn-sm" onClick={handleClearExpired}>만료 기록 삭제</button>
          </div>
          <div className="card-body" style={{ padding: 0 }}>
            <div className="table-wrapper" style={{ maxHeight: 200, overflowY: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>바코드</th>
                    <th>상품명</th>
                    <th>종료일</th>
                    <th>사유</th>
                  </tr>
                </thead>
                <tbody>
                  {expiredExcludes.map(e => (
                    <tr key={e.barcode} style={{ opacity: 0.5 }}>
                      <td style={{ fontSize: 11 }}>{e.barcode}</td>
                      <td>{e.productName} {e.optionName}</td>
                      <td style={{ fontSize: 12 }}>{e.endDate}</td>
                      <td style={{ fontSize: 12 }}>{e.reason || '-'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 상품 검색 & 다중 선택 */}
      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>상품 검색 & 제외 등록</h2>
          {selected.size > 0 && (
            <button
              className="btn btn-primary btn-sm"
              onClick={() => { setShowModal(true); setEndDate(''); setReason(''); }}
            >
              {selected.size}개 선택 — 제외 등록
            </button>
          )}
        </div>
        <div className="card-body">
          <input
            className="search-input"
            style={{ width: '100%', marginBottom: 12 }}
            placeholder="상품명, 옵션명, 바코드로 검색하세요..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />

          {loading && <div className="loading"><div className="spinner" /> 상품 목록 로딩 중...</div>}

          {!loading && search.trim() && filteredProducts.length === 0 && (
            <div style={{ padding: 20, textAlign: 'center', color: '#999' }}>검색 결과가 없습니다.</div>
          )}

          {filteredProducts.length > 0 && (
            <>
              {selected.size > 0 && (
                <div style={{ padding: '8px 0', fontSize: 13, color: '#1a73e8', fontWeight: 600 }}>
                  {selected.size}개 선택됨
                </div>
              )}
              <div className="table-wrapper" style={{ maxHeight: 400, overflowY: 'auto' }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th style={{ width: 36 }}>
                        <input
                          type="checkbox"
                          checked={
                            filteredProducts.filter(p => !excludedBarcodes.has(p.barcode)).length > 0 &&
                            filteredProducts.filter(p => !excludedBarcodes.has(p.barcode)).every(p => selected.has(p.barcode))
                          }
                          onChange={toggleSelectAll}
                        />
                      </th>
                      <th>바코드</th>
                      <th>상품명</th>
                      <th>옵션명</th>
                      <th className="num">쿠팡재고</th>
                      <th>상태</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredProducts.map(p => {
                      const isExcluded = excludedBarcodes.has(p.barcode);
                      const isChecked = selected.has(p.barcode);
                      return (
                        <tr
                          key={p.barcode + p.optionId}
                          style={{ background: isChecked ? '#e8f0fe' : '', cursor: isExcluded ? 'default' : 'pointer' }}
                          onClick={() => { if (!isExcluded) toggleSelect(p.barcode); }}
                        >
                          <td onClick={e => e.stopPropagation()}>
                            {isExcluded ? (
                              <span style={{ fontSize: 11, color: '#999' }}>—</span>
                            ) : (
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={() => toggleSelect(p.barcode)}
                              />
                            )}
                          </td>
                          <td style={{ fontSize: 11, color: '#666' }}>{p.barcode}</td>
                          <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{p.productName}</td>
                          <td>{p.optionName}</td>
                          <td className="num" style={{ color: p.stock === 0 ? '#d93025' : '', fontWeight: p.stock === 0 ? 600 : 400 }}>
                            {p.stock.toLocaleString()}
                          </td>
                          <td>
                            {isExcluded ? (
                              <span className="alert-badge" style={{ background: '#e8f5e9', color: '#2e7d32' }}>제외 중</span>
                            ) : p.stock === 0 ? (
                              <span className="alert-badge soldout">품절</span>
                            ) : null}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {!search.trim() && !loading && (
            <div style={{ padding: 20, textAlign: 'center', color: '#999', fontSize: 13 }}>
              상품명, 옵션명 또는 바코드를 입력하면 검색 결과가 나타납니다.
            </div>
          )}
        </div>
      </div>

      {/* 일괄 등록 모달 */}
      {showModal && (
        <div className="modal-overlay" onClick={e => { if (e.target === e.currentTarget) setShowModal(false); }}>
          <div className="modal-content" style={{ maxWidth: 520 }}>
            <div className="modal-header">
              <h3>품절률 제외 등록 ({selected.size}개)</h3>
              <button className="modal-close" onClick={() => setShowModal(false)}>✕</button>
            </div>
            <div className="modal-body" style={{ padding: 20 }}>
              {/* 선택 품목 리스트 */}
              <div style={{ marginBottom: 16, background: '#f8f9fa', borderRadius: 8, padding: 12, maxHeight: 180, overflowY: 'auto' }}>
                {selectedProducts.map(p => (
                  <div key={p.barcode} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', fontSize: 12, borderBottom: '1px solid #eee' }}>
                    <span style={{ flex: 1 }}>{p.productName}</span>
                    <span style={{ color: '#666', marginLeft: 8 }}>{p.optionName}</span>
                  </div>
                ))}
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
                  종료일 <span style={{ color: '#999', fontWeight: 400 }}>(선택)</span>
                </label>
                <input
                  type="date"
                  className="search-input"
                  style={{ width: '100%', minWidth: 0 }}
                  value={endDate}
                  min={today}
                  onChange={e => setEndDate(e.target.value)}
                />
                <div style={{ fontSize: 11, color: '#999', marginTop: 4 }}>
                  비워두면 해제할 때까지 무기한 제외됩니다.
                </div>
              </div>

              <div style={{ marginBottom: 16 }}>
                <label style={{ display: 'block', fontSize: 13, fontWeight: 600, marginBottom: 6 }}>공통 사유</label>
                <textarea
                  className="search-input"
                  style={{ width: '100%', minWidth: 0, minHeight: 60, resize: 'vertical', fontFamily: 'inherit' }}
                  placeholder="제외 사유를 입력하세요 (선택)"
                  value={reason}
                  onChange={e => setReason(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button className="btn btn-outline" onClick={() => setShowModal(false)}>취소</button>
                <button className="btn btn-primary" onClick={handleBulkAdd}>
                  {selected.size}개 제외 등록
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
