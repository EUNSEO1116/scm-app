import { useState, useEffect } from 'react';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

export default function SoldOutAnalysisExclude() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  const showToast = (type, title, message) => {
    setToast({ type, title, message });
    setTimeout(() => setToast(null), 3500);
  };

  useEffect(() => {
    (async () => {
      const data = await dbStoreGet('soldout_analysis_exclude') || [];
      setItems(data);
      setLoading(false);
    })();
  }, []);

  const removeExclude = async (optionId) => {
    const removed = items.find(i => i.optionId === optionId);
    const updated = items.filter(i => i.optionId !== optionId);
    setItems(updated);
    const desc = removed ? `(NEW)품절 제외 해제: ${removed.productName} - ${removed.optionName}` : '(NEW)품절 제외 해제';
    await dbStoreSet('soldout_analysis_exclude', updated, { logDesc: desc });
    showToast('success', '해제 완료', '품절률 제외가 해제되었습니다.');
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: 80, color: 'var(--text-secondary)' }}>
        <div style={{ fontSize: 32, marginBottom: 12 }}>⏳</div>
        데이터를 불러오는 중...
      </div>
    );
  }

  return (
    <div>
      {toast && (
        <div style={{
          position: 'fixed', top: 32, right: 32, zIndex: 9999,
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '16px 20px', borderRadius: 12,
          background: '#e6f4ea', border: '1px solid #1e8e3e',
          boxShadow: '0 8px 24px rgba(0,0,0,0.15)',
          animation: 'slideIn 0.3s ease', minWidth: 300,
        }}>
          <div style={{
            width: 32, height: 32, borderRadius: '50%', background: '#1e8e3e',
            display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          }}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5"><path d="M20 6L9 17l-5-5"/></svg>
          </div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 14, color: '#1e8e3e' }}>{toast.title}</div>
            <div style={{ fontSize: 13, color: '#333', marginTop: 2 }}>{toast.message}</div>
          </div>
        </div>
      )}

      <div style={{ marginBottom: 12, fontSize: 12, color: 'var(--text-secondary)' }}>
        품절 현황에서 제외된 품목입니다. 해제하면 품절률 계산에 다시 포함됩니다.
      </div>

      <div className="table-wrapper">
        <table className="data-table">
          <thead>
            <tr>
              <th style={{ width: 40 }}>#</th>
              <th>옵션ID</th>
              <th>상품명</th>
              <th>옵션명</th>
              <th>등급</th>
              <th>바코드</th>
              <th>제외일시</th>
              <th style={{ width: 80 }}>해제</th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr><td colSpan={8} style={{ textAlign: 'center', padding: 40, color: 'var(--text-secondary)' }}>
                제외된 품목이 없습니다
              </td></tr>
            ) : items.map((item, i) => (
              <tr key={item.optionId}>
                <td className="num">{i + 1}</td>
                <td style={{ fontSize: 11, color: '#888' }}>{item.optionId}</td>
                <td>{item.productName}</td>
                <td>{item.optionName}</td>
                <td>
                  <span className={`alert-badge ${item.status === '효자' ? 'normal' : item.status?.includes('신규') ? 'excess' : 'no-sales'}`}
                    style={{ fontSize: 10, padding: '1px 6px' }}>
                    {item.status || '-'}
                  </span>
                </td>
                <td style={{ fontSize: 11, color: '#888' }}>{item.barcode}</td>
                <td style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                  {item.excludedAt ? new Date(item.excludedAt).toLocaleDateString('ko-KR') : '-'}
                </td>
                <td className="center">
                  <button
                    onClick={() => removeExclude(item.optionId)}
                    className="btn btn-outline btn-sm"
                    style={{ fontSize: 11, padding: '3px 10px', color: '#d93025', borderColor: '#d93025' }}
                  >해제</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <style>{`
        @keyframes slideIn {
          from { opacity: 0; transform: translateX(40px); }
          to { opacity: 1; transform: translateX(0); }
        }
      `}</style>
    </div>
  );
}
