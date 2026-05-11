import { useState, useEffect, useCallback } from 'react';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`;
const DB_KEY = 'closed_products';

export default function ClosedProducts() {
  const [keyword, setKeyword] = useState('');
  const [closedList, setClosedList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [sheetRows, setSheetRows] = useState([]);
  const [dupModal, setDupModal] = useState(null); // { duplicates: [...] }

  // 재고계산기 시트 로드
  const loadSheet = useCallback(async () => {
    try {
      const res = await fetch(TSV_CALC);
      if (!res.ok) return [];
      const text = await res.text();
      const lines = text.split('\n').filter(l => l.trim());
      const rows = [];
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split('\t');
        const barcode = (cols[2] || '').trim();
        const productName = (cols[3] || '').trim();
        const totalStock = Number(cols[14]) || 0;
        if (barcode || productName) rows.push({ barcode, productName, totalStock });
      }
      return rows;
    } catch { return []; }
  }, []);

  // 초기 로드
  useEffect(() => {
    (async () => {
      setLoading(true);
      const [rows, stored] = await Promise.all([loadSheet(), dbStoreGet(DB_KEY)]);
      setSheetRows(rows);
      if (Array.isArray(stored)) setClosedList(stored);
      setLoading(false);
    })();
  }, [loadSheet]);

  // 키워드 추가
  const handleAdd = async () => {
    // 쉼표 또는 줄바꿈으로 분리하여 여러 키워드 지원
    const keywords = keyword.split(/\n/).map(k => k.trim()).filter(k => k);
    if (keywords.length === 0) return;

    const existingKeys = closedList.map(item => item.keyword);
    const duplicates = keywords.filter(kw => existingKeys.includes(kw));
    const newKeywords = keywords.filter(kw => !existingKeys.includes(kw));

    // 입력 내에서도 중복 제거
    const uniqueNew = [...new Set(newKeywords)];

    if (duplicates.length > 0) {
      setDupModal({ duplicates });
      return;
    }
    if (uniqueNew.length === 0) return;

    setLoading(true);
    let rows = sheetRows;
    if (rows.length === 0) {
      rows = await loadSheet();
      setSheetRows(rows);
    }

    const additions = uniqueNew.map(kw => ({
      keyword: kw,
      products: rows
        .filter(r => r.productName.includes(kw))
        .map(r => ({ barcode: r.barcode, name: r.productName, stock: r.totalStock })),
    }));

    const newList = [...closedList, ...additions];
    setClosedList(newList);
    await dbStoreSet(DB_KEY, newList);
    setKeyword('');
    setLoading(false);
  };

  // 키워드 삭제
  const handleDelete = async (kw) => {
    const newList = closedList.filter(item => item.keyword !== kw);
    setClosedList(newList);
    await dbStoreSet(DB_KEY, newList);
  };

  // 키워드 데이터 새로고침 (시트 재조회)
  const handleRefresh = async () => {
    setLoading(true);
    const rows = await loadSheet();
    setSheetRows(rows);
    const updated = closedList.map(item => {
      const matched = rows
        .filter(r => r.productName.includes(item.keyword))
        .map(r => ({ barcode: r.barcode, name: r.productName, stock: r.totalStock }));
      return { ...item, products: matched };
    });
    setClosedList(updated);
    await dbStoreSet(DB_KEY, updated);
    setLoading(false);
  };

  const totalProducts = closedList.reduce((sum, item) => sum + item.products.length, 0);
  const totalStock = closedList.reduce((sum, item) => sum + item.products.reduce((s, p) => s + p.stock, 0), 0);

  return (
    <div style={{ padding: 24, maxWidth: 1000, margin: '0 auto' }}>
      {/* 키워드 입력 */}
      <div style={{
        display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center',
      }}>
        <textarea
          value={keyword}
          onChange={e => setKeyword(e.target.value)}
          placeholder="마감 상품 키워드 입력 (줄바꿈으로 여러 개 가능)"
          rows={keyword.includes('\n') ? 4 : 1}
          style={{
            flex: 1, padding: '10px 14px', fontSize: 14,
            border: '1px solid #d0d0d0', borderRadius: 8, outline: 'none',
            resize: 'vertical', fontFamily: 'inherit',
          }}
        />
        <button
          onClick={handleAdd}
          disabled={loading || !keyword.trim()}
          style={{
            padding: '10px 20px', fontSize: 14, fontWeight: 700,
            background: '#2563eb', color: '#fff', border: 'none', borderRadius: 8,
            cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1,
          }}
        >추가</button>
        <button
          onClick={handleRefresh}
          disabled={loading}
          style={{
            padding: '10px 16px', fontSize: 13, fontWeight: 600,
            background: '#f0f0f0', color: '#333', border: '1px solid #d0d0d0', borderRadius: 8,
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
        >새로고침</button>
      </div>

      {/* 요약 */}
      <div style={{
        display: 'flex', gap: 16, marginBottom: 20,
      }}>
        <div style={{
          flex: 1, background: '#f0f7ff', borderRadius: 10, padding: '14px 18px',
          border: '1px solid #d0e3f7',
        }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>등록 키워드</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#222' }}>{closedList.length}개</div>
        </div>
        <div style={{
          flex: 1, background: '#fff8f0', borderRadius: 10, padding: '14px 18px',
          border: '1px solid #f0dcc0',
        }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>장기재고 상품</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#222' }}>{totalProducts}개</div>
        </div>
        <div style={{
          flex: 1, background: '#fff5f5', borderRadius: 10, padding: '14px 18px',
          border: '1px solid #f0d0d0',
        }}>
          <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>장기재고 총 수량</div>
          <div style={{ fontSize: 22, fontWeight: 700, color: '#222' }}>{totalStock.toLocaleString()}개</div>
        </div>
      </div>

      {loading && <div style={{ textAlign: 'center', padding: 20, color: '#888' }}>로딩 중...</div>}

      {/* 키워드별 상품 목록 */}
      {closedList.map(item => (
        <div key={item.keyword} style={{
          marginBottom: 16, background: '#fff', borderRadius: 10,
          border: '1px solid #e0e0e0', overflow: 'hidden',
          boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
        }}>
          {/* 키워드 헤더 */}
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            padding: '12px 18px', background: '#f8f8f8', borderBottom: '1px solid #e0e0e0',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: '#222' }}>{item.keyword}</span>
              <span style={{ fontSize: 12, color: '#888' }}>
                매칭 {item.products.length}개 / 재고 {item.products.reduce((s, p) => s + p.stock, 0).toLocaleString()}개
              </span>
            </div>
            <button
              onClick={() => handleDelete(item.keyword)}
              style={{
                padding: '4px 12px', fontSize: 12, fontWeight: 600,
                background: '#fee', color: '#c00', border: '1px solid #fcc', borderRadius: 6,
                cursor: 'pointer',
              }}
            >삭제</button>
          </div>
          {/* 상품 테이블 */}
          {item.products.length > 0 ? (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#fafafa' }}>
                  <th style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid #eee' }}>바코드</th>
                  <th style={{ padding: '8px 14px', textAlign: 'left', fontWeight: 600, borderBottom: '1px solid #eee' }}>상품명</th>
                  <th style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 600, borderBottom: '1px solid #eee' }}>재고</th>
                </tr>
              </thead>
              <tbody>
                {item.products.map((p, idx) => (
                  <tr key={idx} style={{ borderBottom: '1px solid #f0f0f0' }}>
                    <td style={{ padding: '8px 14px', color: '#555' }}>{p.barcode}</td>
                    <td style={{ padding: '8px 14px', color: '#222' }}>{p.name}</td>
                    <td style={{ padding: '8px 14px', textAlign: 'right', fontWeight: 600 }}>{p.stock.toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div style={{ padding: 16, textAlign: 'center', color: '#999', fontSize: 13 }}>
              매칭되는 상품이 없습니다
            </div>
          )}
        </div>
      ))}

      {!loading && closedList.length === 0 && (
        <div style={{ textAlign: 'center', padding: 40, color: '#999', fontSize: 14 }}>
          등록된 마감 상품 키워드가 없습니다
        </div>
      )}

      {/* 중복 키워드 모달 */}
      {dupModal && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
          background: 'rgba(0,0,0,0.4)', display: 'flex', justifyContent: 'center', alignItems: 'center',
          zIndex: 9999,
        }} onClick={() => setDupModal(null)}>
          <div style={{
            background: '#fff', borderRadius: 14, padding: '28px 32px', minWidth: 320, maxWidth: 420,
            boxShadow: '0 8px 30px rgba(0,0,0,0.18)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ fontSize: 16, fontWeight: 700, color: '#c00', marginBottom: 16 }}>
              중복된 키워드가 있습니다
            </div>
            <div style={{ fontSize: 13, color: '#666', marginBottom: 12 }}>
              아래 키워드가 이미 등록되어 있어 추가되지 않았습니다.
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
              {dupModal.duplicates.map(kw => (
                <span key={kw} style={{
                  padding: '6px 14px', background: '#fee', color: '#c00',
                  borderRadius: 20, fontSize: 14, fontWeight: 600, border: '1px solid #fcc',
                }}>{kw}</span>
              ))}
            </div>
            <div style={{ fontSize: 12, color: '#999', marginBottom: 16 }}>
              중복 키워드를 제거한 후 다시 시도해주세요.
            </div>
            <button onClick={() => setDupModal(null)} style={{
              width: '100%', padding: '10px 0', fontSize: 14, fontWeight: 700,
              background: '#222', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer',
            }}>확인</button>
          </div>
        </div>
      )}
    </div>
  );
}
