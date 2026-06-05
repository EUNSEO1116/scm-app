import { useState, useRef, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

const VALID_TYPES = ['오더 지불', '환불', '추가비용'];
const DB_KEY = 'cn_settlement_data';
const RATE_KEY = 'cn_settlement_rate';

export default function CnSettlementUpload() {
  const [exchangeRate, setExchangeRate] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [message, setMessage] = useState(null); // { type: 'success'|'error', text }
  const [uploadHistory, setUploadHistory] = useState([]); // 업로드 이력
  const fileRef = useRef();

  // DB에서 기존 데이터 + 환율 로드
  useEffect(() => {
    dbStoreGet(DB_KEY).then(data => {
      if (data && Array.isArray(data)) setUploadHistory(data);
    });
    dbStoreGet(RATE_KEY).then(data => {
      if (data && data.rate) setExchangeRate(String(data.rate));
    });
  }, []);

  const parseExcel = (file) => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const wb = XLSX.read(e.target.result, { type: 'array' });
          const ws = wb.Sheets[wb.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(ws, { header: 1 });
          resolve(rows);
        } catch (err) {
          reject(err);
        }
      };
      reader.onerror = () => reject(new Error('파일 읽기 실패'));
      reader.readAsArrayBuffer(file);
    });
  };

  const processAndSave = async (file) => {
    if (!exchangeRate || isNaN(Number(exchangeRate)) || Number(exchangeRate) <= 0) {
      setMessage({ type: 'error', text: '환율을 먼저 입력해 주세요 (예: 195.5)' });
      return;
    }

    setUploading(true);
    setMessage(null);

    try {
      const rows = await parseExcel(file);
      if (rows.length < 2) {
        setMessage({ type: 'error', text: '엑셀에 데이터가 없습니다' });
        setUploading(false);
        return;
      }

      // 헤더 인덱스 매핑
      const header = rows[0];
      const idx = {
        date: header.indexOf('날짜'),
        type: header.indexOf('거래유형'),
        amount: header.indexOf('입/출금'),
        orderNo: header.indexOf('발주번호'),
        status: header.indexOf('상태'),
      };

      // 필수 컬럼 확인
      const missing = Object.entries(idx).filter(([, v]) => v === -1).map(([k]) => k);
      if (missing.length > 0) {
        setMessage({ type: 'error', text: `엑셀에 필수 컬럼이 없습니다: ${missing.join(', ')}` });
        setUploading(false);
        return;
      }

      // 필터링: 거래유형 3종 + 승인만
      const filtered = [];
      for (let i = 1; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        const type = (row[idx.type] || '').trim();
        const status = (row[idx.status] || '').trim();

        if (!VALID_TYPES.includes(type)) continue;
        if (status !== '승인') continue;

        const rawDate = row[idx.date] || '';
        const dateStr = typeof rawDate === 'string' ? rawDate.slice(0, 10) : '';

        filtered.push({
          date: dateStr,
          type,
          amount: Number(row[idx.amount]) || 0,
          orderNo: (row[idx.orderNo] || '').trim(),
        });
      }

      if (filtered.length === 0) {
        setMessage({ type: 'error', text: '필터 조건에 맞는 거래가 없습니다' });
        setUploading(false);
        return;
      }

      // 날짜 범위 계산
      const dates = filtered.map(t => t.date).filter(Boolean).sort();
      const minDate = dates[0] || '';
      const maxDate = dates[dates.length - 1] || '';
      const fmt = (d) => { const m = d.split('-'); return m[1] ? `${parseInt(m[1])}/${parseInt(m[2])}` : d; };
      const dateLabel = minDate && maxDate ? `${fmt(minDate)}~${fmt(maxDate)} 발주내역` : file.name;

      // 이번 업로드 기록
      const rate = Number(exchangeRate);
      const uploadRecord = {
        id: Date.now(),
        uploadedAt: new Date().toISOString(),
        fileName: file.name,
        dateLabel,
        exchangeRate: rate,
        transactions: filtered,
        summary: {
          total: filtered.length,
          orderPayment: filtered.filter(t => t.type === '오더 지불').length,
          refund: filtered.filter(t => t.type === '환불').length,
          extraCost: filtered.filter(t => t.type === '추가비용').length,
          totalAmount: Math.round(filtered.reduce((s, t) => s + t.amount, 0) * 100) / 100,
        },
      };

      // 기존 데이터에 추가
      const existing = uploadHistory || [];
      const updated = [...existing, uploadRecord];

      // DB 저장
      const ok1 = await dbStoreSet(DB_KEY, updated, { logDesc: `CN결산 거래데이터 업로드 (${filtered.length}건)` });
      const ok2 = await dbStoreSet(RATE_KEY, { rate, updatedAt: new Date().toISOString() }, { skipLog: true });

      if (ok1 && ok2) {
        setUploadHistory(updated);
        setMessage({ type: 'success', text: `${filtered.length}건 저장 완료 (오더 지불 ${uploadRecord.summary.orderPayment} / 환불 ${uploadRecord.summary.refund} / 추가비용 ${uploadRecord.summary.extraCost})` });
      } else {
        setMessage({ type: 'error', text: 'DB 저장 실패. 다시 시도해 주세요.' });
      }
    } catch (err) {
      console.error('CN 결산 업로드 에러:', err);
      setMessage({ type: 'error', text: `파일 처리 실패: ${err.message}` });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  const handleFile = (file) => {
    if (!file) return;
    if (!file.name.match(/\.xlsx?$/i)) {
      setMessage({ type: 'error', text: '엑셀 파일(.xlsx)만 업로드 가능합니다' });
      return;
    }
    processAndSave(file);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    handleFile(e.dataTransfer.files[0]);
  };

  const handleDeleteRecord = async (id) => {
    if (!window.confirm('이 업로드 기록을 삭제하시겠습니까?')) return;
    const updated = uploadHistory.filter(r => r.id !== id);
    const ok = await dbStoreSet(DB_KEY, updated, { logDesc: 'CN결산 업로드 기록 삭제' });
    if (ok) {
      setUploadHistory(updated);
      setMessage({ type: 'success', text: '삭제 완료' });
    }
  };

  return (
    <div>
      {/* 상단: 업로드 + 환율 입력 */}
      <div style={{ display: 'flex', gap: 16, marginBottom: 20, alignItems: 'stretch' }}>
        {/* 엑셀 업로드 영역 */}
        <div
          className={`upload-area ${isDragOver ? 'drag-over' : ''}`}
          style={{ flex: 1, padding: '40px 24px', opacity: uploading ? 0.6 : 1 }}
          onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={handleDrop}
          onClick={() => !uploading && fileRef.current?.click()}
        >
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.xls"
            style={{ display: 'none' }}
            onChange={(e) => handleFile(e.target.files[0])}
          />
          <div className="icon">{uploading ? '⏳' : '📊'}</div>
          <h3>{uploading ? '처리 중...' : '주별 거래내역 엑셀 업로드'}</h3>
          <p>플로우 내보내기 파일을 드래그하거나 클릭하여 업로드</p>
        </div>

        {/* 환율 입력 */}
        <div className="card" style={{ minWidth: 220, display: 'flex', flexDirection: 'column', justifyContent: 'center', padding: 24 }}>
          <label style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-secondary)', marginBottom: 8 }}>
            현재 환율 (CNY→KRW)
          </label>
          <input
            type="number"
            step="0.1"
            value={exchangeRate}
            onChange={(e) => setExchangeRate(e.target.value)}
            placeholder="예: 195.5"
            style={{
              fontSize: 24, fontWeight: 700, textAlign: 'center',
              padding: '12px 16px', border: '2px solid var(--border)',
              borderRadius: 8, outline: 'none', width: '100%',
            }}
            onFocus={(e) => e.target.style.borderColor = 'var(--primary)'}
            onBlur={(e) => e.target.style.borderColor = 'var(--border)'}
          />
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, textAlign: 'center' }}>
            1 CNY = {exchangeRate ? `${Number(exchangeRate).toLocaleString()}원` : '—'}
          </div>
        </div>
      </div>

      {/* 메시지 */}
      {message && (
        <div style={{
          padding: '12px 16px', borderRadius: 8, marginBottom: 16,
          background: message.type === 'success' ? '#e8f5e9' : '#ffeef0',
          color: message.type === 'success' ? '#2e7d32' : '#d32f2f',
          fontSize: 14, fontWeight: 500,
        }}>
          {message.type === 'success' ? '✓' : '✕'} {message.text}
        </div>
      )}

      {/* 업로드 이력 */}
      {uploadHistory.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2>업로드 이력</h2>
            <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              총 {uploadHistory.length}회 업로드 / {uploadHistory.reduce((s, r) => s + r.transactions.length, 0)}건 거래
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>업로드 일시</th>
                  <th>파일명</th>
                  <th>환율</th>
                  <th>오더 지불</th>
                  <th>환불</th>
                  <th>추가비용</th>
                  <th>총 건수</th>
                  <th>총 금액 (CNY)</th>
                  <th>총 금액 (KRW)</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {[...uploadHistory].reverse().map(record => (
                  <tr key={record.id}>
                    <td>{new Date(record.uploadedAt).toLocaleString('ko-KR')}</td>
                    <td style={{ fontSize: 12, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {record.fileName}
                    </td>
                    <td style={{ textAlign: 'right' }}>{record.exchangeRate}</td>
                    <td style={{ textAlign: 'right' }}>{record.summary.orderPayment}</td>
                    <td style={{ textAlign: 'right' }}>{record.summary.refund}</td>
                    <td style={{ textAlign: 'right' }}>{record.summary.extraCost}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{record.summary.total}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      ¥{record.summary.totalAmount.toLocaleString()}
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--primary)' }}>
                      ₩{Math.round(record.summary.totalAmount * record.exchangeRate).toLocaleString()}
                    </td>
                    <td>
                      <button
                        className="btn btn-sm"
                        style={{ color: '#d32f2f', background: 'none', border: 'none', cursor: 'pointer' }}
                        onClick={() => handleDeleteRecord(record.id)}
                        title="삭제"
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
