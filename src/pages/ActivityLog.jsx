import { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { dbGetActivityLog, dbRevertActivityGroup } from '../utils/dbApi';

const STORE_NAMES_KR = {
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
  calendar: '캘린더',
  soldout_reasons: '품절 사유',
  caution_items: '주의 품목',
};

const PAGE_SIZE = 50;

// 그룹 설명을 사람이 읽기 쉽게 정리
function formatGroupDescription(rawDescs) {
  if (!rawDescs) return '-';
  const parts = rawDescs.split('||').map(d => {
    // 영어 store명을 한글로 변환
    let desc = d.trim();
    for (const [eng, kr] of Object.entries(STORE_NAMES_KR)) {
      if (desc.includes(eng)) desc = desc.replace(eng, kr);
    }
    desc = desc.replace(' 데이터 저장', ' 저장');
    return desc;
  });
  // 중복 제거
  const unique = [...new Set(parts)];
  if (unique.length <= 2) return unique.join(', ');
  return `${unique[0]} 외 ${unique.length - 1}건`;
}

export default function ActivityLog() {
  const navigate = useNavigate();
  const [logs, setLogs] = useState([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [reverting, setReverting] = useState(null);

  const load = useCallback(async (off = 0) => {
    setLoading(true);
    const data = await dbGetActivityLog(PAGE_SIZE, off);
    setLogs(data.logs || []);
    setTotal(data.total || 0);
    setOffset(off);
    setLoading(false);
  }, []);

  useEffect(() => { load(0); }, [load]);

  const handleRevert = async (log) => {
    const desc = formatGroupDescription(log.descriptions);
    let msg = `"${desc}" 작업을 되돌리시겠습니까?`;
    if (log.count > 1) {
      msg += `\n\n이 작업에 포함된 ${log.count}개의 변경사항이 모두 원래대로 돌아갑니다.`;
    }
    msg += '\n\n주의: 이 작업 이후에 같은 데이터를 또 변경했다면, 최근 변경이 덮어씌워질 수 있습니다.';
    if (!window.confirm(msg)) return;

    setReverting(log.gid);
    const result = await dbRevertActivityGroup(log.gid);
    setReverting(null);

    if (result.ok) {
      alert('되돌리기 완료');
      load(offset);
    } else {
      alert(`되돌리기 실패: ${result.error || '알 수 없는 오류'}`);
    }
  };

  const formatTime = (ts) => {
    if (!ts) return '-';
    const d = new Date(ts + 'Z');
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const min = String(d.getMinutes()).padStart(2, '0');
    if (isToday) return `오늘 ${h}:${min}`;
    return `${m}/${day} ${h}:${min}`;
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const currentPage = Math.floor(offset / PAGE_SIZE) + 1;

  return (
    <div style={{ maxWidth: 900, margin: '0 auto' }}>
      {/* 헤더 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={() => navigate('/')}
            style={{
              background: 'none', border: '1px solid #ddd', borderRadius: 8,
              padding: '6px 12px', fontSize: 13, color: '#555', cursor: 'pointer',
            }}
          >
            ← 홈
          </button>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700 }}>활동 로그</h2>
          <span style={{ fontSize: 12, color: '#999' }}>총 {total}건</span>
        </div>
        <button
          onClick={() => load(offset)}
          style={{
            background: '#f5f5f5', border: '1px solid #ddd', borderRadius: 8,
            padding: '6px 14px', fontSize: 12, color: '#555', cursor: 'pointer',
          }}
        >
          새로고침
        </button>
      </div>

      {/* 로그 목록 — 카드 형태 */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#999', background: '#fff', borderRadius: 12 }}>로딩 중...</div>
        ) : logs.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: '#999', background: '#fff', borderRadius: 12 }}>아직 기록된 활동이 없습니다.</div>
        ) : logs.map(log => {
          const desc = formatGroupDescription(log.descriptions);
          const isReverted = log.reverted > 0;
          const isRevertLog = desc.includes('[되돌리기]');
          return (
            <div
              key={log.gid}
              style={{
                background: isReverted ? '#fafafa' : '#fff',
                borderRadius: 10,
                border: isReverted ? '1px solid #eee' : '1px solid #e8e8e8',
                padding: '14px 18px',
                display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                opacity: isReverted ? 0.5 : 1,
                boxShadow: isReverted ? 'none' : '0 1px 4px rgba(0,0,0,0.04)',
              }}
            >
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 4 }}>
                  <span style={{ fontSize: 15, fontWeight: 600, color: isRevertLog ? '#f57c00' : '#333' }}>
                    {desc}
                  </span>
                  {log.count > 1 && (
                    <span style={{
                      fontSize: 10, background: '#e3f2fd', color: '#1565c0',
                      padding: '1px 6px', borderRadius: 8, fontWeight: 600,
                    }}>
                      {log.count}개 변경
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: '#999' }}>
                  {formatTime(log.created_at)}
                  {isReverted && <span style={{ marginLeft: 8, color: '#bbb' }}>되돌림 완료</span>}
                </div>
              </div>
              {!isReverted && !isRevertLog && (
                <button
                  onClick={() => handleRevert(log)}
                  disabled={reverting === log.gid}
                  style={{
                    background: reverting === log.gid ? '#eee' : '#fff',
                    border: '1px solid #ff7043',
                    borderRadius: 8, padding: '8px 16px',
                    fontSize: 13, color: '#e64a19', cursor: reverting === log.gid ? 'default' : 'pointer',
                    fontWeight: 600, whiteSpace: 'nowrap',
                  }}
                >
                  {reverting === log.gid ? '처리중...' : '되돌리기'}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8, marginTop: 20 }}>
          <button
            onClick={() => load(offset - PAGE_SIZE)}
            disabled={offset === 0}
            style={{
              background: '#fff', border: '1px solid #ddd', borderRadius: 6,
              padding: '6px 12px', fontSize: 12, cursor: offset === 0 ? 'default' : 'pointer',
              color: offset === 0 ? '#ccc' : '#555',
            }}
          >
            이전
          </button>
          <span style={{ fontSize: 12, color: '#666' }}>{currentPage} / {totalPages}</span>
          <button
            onClick={() => load(offset + PAGE_SIZE)}
            disabled={offset + PAGE_SIZE >= total}
            style={{
              background: '#fff', border: '1px solid #ddd', borderRadius: 6,
              padding: '6px 12px', fontSize: 12,
              cursor: offset + PAGE_SIZE >= total ? 'default' : 'pointer',
              color: offset + PAGE_SIZE >= total ? '#ccc' : '#555',
            }}
          >
            다음
          </button>
        </div>
      )}
    </div>
  );
}
