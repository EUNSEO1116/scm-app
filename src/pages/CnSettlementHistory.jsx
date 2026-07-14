import { useState, useEffect, useMemo } from 'react';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

const DB_KEY = 'cn_settlement_data';
const BRAND_KEY = 'cn_brand_mapping';
const EXCLUDE_CODES = ['BS'];

const DEFAULT_BRANDS = [
  { code: 'SH', name: '생활기준' },
  { code: 'S', name: '어리플' },
  { code: 'I', name: '일상포인트' },
  { code: 'I2', name: '일상포인트' },
  { code: 'M', name: '일상포인트' },
  { code: 'HM', name: '하루모음' },
  { code: 'HM2', name: '하루모음' },
  { code: 'B', name: '로즈바운드' },
  { code: 'O', name: '원데이홈' },
  { code: 'T', name: '토글리' },
  { code: 'L', name: '리빙스타일' },
  { code: 'P', name: '펄빈' },
  { code: 'E', name: '타플벨' },
];

// 발주번호에서 브랜드 코드 추출: AE-SH-260605 → SH, AE-I-Z-260582 → I
function extractBrandCode(orderNo) {
  if (!orderNo) return null;
  const parts = orderNo.split('-');
  if (parts.length < 2 || parts[0] !== 'AE') return null;
  return parts[1].toUpperCase();
}

// 발주번호에서 신규/기존 판별: -NEW 포함 → 신규
function isNewProduct(orderNo) {
  if (!orderNo) return false;
  const parts = orderNo.split('-');
  return parts.some(p => p.toUpperCase() === 'NEW');
}

// 업로드 기록을 브랜드별로 집계
function aggregateByBrand(record, brandMap) {
  const rate = record.exchangeRate;
  const result = {}; // { brandName: { existing: krw, new: krw, extraCost: krw } }

  for (const tx of record.transactions) {
    const code = extractBrandCode(tx.orderNo);
    if (!code || EXCLUDE_CODES.includes(code.toUpperCase())) continue;

    const brandName = brandMap[code] || `미분류(${code})`;
    if (!result[brandName]) result[brandName] = { existing: 0, new: 0, extraCost: 0 };

    const krw = Math.round(tx.amount * rate);

    if (tx.type === '추가비용') {
      result[brandName].extraCost += krw;
    } else if (tx.type === '오더 지불') {
      if (isNewProduct(tx.orderNo)) {
        result[brandName].new += krw;
      } else {
        result[brandName].existing += krw;
      }
    } else if (tx.type === '환불') {
      // 환불은 발주금액에서 차감
      if (isNewProduct(tx.orderNo)) {
        result[brandName].new -= krw;
      } else {
        result[brandName].existing -= krw;
      }
    }
  }

  return result;
}

export default function CnSettlementHistory() {
  const [uploads, setUploads] = useState([]);
  const [brandMappings, setBrandMappings] = useState(DEFAULT_BRANDS);
  const [showSettings, setShowSettings] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [expandedId, setExpandedId] = useState(null);

  useEffect(() => {
    dbStoreGet(DB_KEY).then(data => {
      if (data && Array.isArray(data)) setUploads(data);
    });
    dbStoreGet(BRAND_KEY).then(data => {
      if (data && Array.isArray(data) && data.length > 0) setBrandMappings(data);
    });
  }, []);

  // 브랜드 매핑을 { CODE: name } 형태로 변환 (대문자 통일)
  const brandMap = {};
  for (const b of brandMappings) {
    brandMap[b.code.toUpperCase()] = b.name;
  }

  const saveBrandMappings = async (updated) => {
    setBrandMappings(updated);
    await dbStoreSet(BRAND_KEY, updated, { logDesc: 'CN결산 브랜드 매핑 수정' });
  };

  const handleAddMapping = () => {
    const code = newCode.trim().toUpperCase();
    const name = newName.trim();
    if (!code || !name) return;
    if (brandMappings.some(b => b.code === code)) {
      alert(`코드 "${code}"는 이미 등록되어 있습니다.`);
      return;
    }
    const updated = [...brandMappings, { code, name }];
    saveBrandMappings(updated);
    setNewCode('');
    setNewName('');
  };

  const handleDeleteMapping = (code) => {
    const updated = brandMappings.filter(b => b.code !== code);
    saveBrandMappings(updated);
  };

  const handleEditMapping = (code, newName) => {
    const updated = brandMappings.map(b => b.code === code ? { ...b, name: newName } : b);
    saveBrandMappings(updated);
  };

  const handleDeleteRecord = async (id) => {
    if (!window.confirm('이 업로드 기록을 삭제하시겠습니까? DB에서도 완전히 삭제됩니다.')) return;
    const updated = uploads.filter(r => r.id !== id);
    const ok = await dbStoreSet(DB_KEY, updated, { logDesc: 'CN결산 업로드 기록 삭제' });
    if (ok) {
      setUploads(updated);
      if (expandedId === id) setExpandedId(null);
    } else {
      alert('삭제 실패. 다시 시도해 주세요.');
    }
  };

  // 환불 이월 포함 브랜드별 집계 (brandMappings, uploads 변경 시 재계산)
  const processedData = useMemo(() => {
    const bm = {};
    for (const b of brandMappings) bm[b.code.toUpperCase()] = b.name;

    const carryOver = {};
    return uploads.map(record => {
      const agg = aggregateByBrand(record, bm);
      const carried = {};

      for (const brand of Object.keys(carryOver)) {
        if (carryOver[brand].existing >= 0 && carryOver[brand].new >= 0) continue;
        if (!agg[brand]) agg[brand] = { existing: 0, new: 0, extraCost: 0 };
        if (carryOver[brand].existing < 0) {
          carried[brand] = carried[brand] || { existing: 0, new: 0 };
          carried[brand].existing = carryOver[brand].existing;
          agg[brand].existing += carryOver[brand].existing;
          carryOver[brand].existing = 0;
        }
        if (carryOver[brand].new < 0) {
          carried[brand] = carried[brand] || { existing: 0, new: 0 };
          carried[brand].new = carryOver[brand].new;
          agg[brand].new += carryOver[brand].new;
          carryOver[brand].new = 0;
        }
      }

      for (const brand of Object.keys(agg)) {
        if (agg[brand].existing < 0 || agg[brand].new < 0) {
          if (!carryOver[brand]) carryOver[brand] = { existing: 0, new: 0 };
          if (agg[brand].existing < 0) carryOver[brand].existing += agg[brand].existing;
          if (agg[brand].new < 0) carryOver[brand].new += agg[brand].new;
        }
      }

      return { record, agg, carried };
    });
  }, [uploads, brandMappings]);

  return (
    <div>
      {/* 좌측 상단: 브랜드 설정 버튼 */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <button
          className="btn btn-outline"
          onClick={() => setShowSettings(!showSettings)}
          style={{ display: 'flex', alignItems: 'center', gap: 6 }}
        >
          <span style={{ fontSize: 16 }}>&#9881;</span> 브랜드 매핑 설정
        </button>
        <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
          {uploads.length}건 업로드 기록
        </span>
      </div>

      {/* 브랜드 매핑 설정 패널 */}
      {showSettings && (
        <div className="card" style={{ marginBottom: 20, padding: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <h3 style={{ margin: 0, fontSize: 15 }}>브랜드 코드 매핑</h3>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
              발주번호의 AE-<b>코드</b>-... 에서 코드를 브랜드명으로 변환
            </span>
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 }}>
            {brandMappings.map(b => (
              <div key={b.code} style={{
                display: 'flex', alignItems: 'center', gap: 6,
                background: '#f0f4f8', borderRadius: 6, padding: '4px 10px', fontSize: 13,
              }}>
                <span style={{ fontWeight: 600, color: 'var(--primary)' }}>{b.code}</span>
                <span style={{ color: '#666' }}>&rarr;</span>
                <input
                  value={b.name}
                  onChange={(e) => handleEditMapping(b.code, e.target.value)}
                  style={{
                    border: 'none', background: 'transparent', fontSize: 13,
                    width: Math.max(60, b.name.length * 14), fontWeight: 500,
                    outline: 'none', padding: '2px 4px', borderRadius: 4,
                  }}
                  onFocus={(e) => e.target.style.background = '#fff'}
                  onBlur={(e) => e.target.style.background = 'transparent'}
                />
                <button
                  onClick={() => handleDeleteMapping(b.code)}
                  style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer', fontSize: 14, padding: '0 2px' }}
                  title="삭제"
                >&times;</button>
              </div>
            ))}
          </div>

          {/* 새 매핑 추가 */}
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              value={newCode}
              onChange={(e) => setNewCode(e.target.value)}
              placeholder="코드 (예: F)"
              style={{ width: 100, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }}
            />
            <span style={{ color: '#666' }}>&rarr;</span>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="브랜드명 (예: 새브랜드)"
              style={{ width: 160, padding: '6px 10px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 13 }}
              onKeyDown={(e) => e.key === 'Enter' && handleAddMapping()}
            />
            <button className="btn btn-primary btn-sm" onClick={handleAddMapping}>추가</button>
          </div>
        </div>
      )}

      {/* 업로드 기록별 결산 */}
      {uploads.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>
          거래 데이터를 먼저 업로드해 주세요
        </div>
      ) : (
        [...processedData].reverse().map(({ record, agg, carried }) => {
            const brands = Object.keys(agg).filter(b => !b.startsWith('미분류')).sort();
            const totals = { existing: 0, new: 0, extraCost: 0 };
            brands.forEach(b => {
              totals.existing += agg[b].existing;
              totals.new += agg[b].new;
              totals.extraCost += agg[b].extraCost;
            });
            const isExpanded = expandedId === record.id;

            return (
              <div key={record.id} className="card" style={{ marginBottom: 16 }}>
                {/* 헤더 */}
                <div
                  className="card-header"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setExpandedId(isExpanded ? null : record.id)}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 12, transition: 'transform 0.2s', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)' }}>&#9654;</span>
                    <div>
                      <h2 style={{ margin: 0 }}>{record.dateLabel || record.fileName}</h2>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 2 }}>
                        {new Date(record.uploadedAt).toLocaleString('ko-KR')} | 환율 {record.exchangeRate} | {record.transactions.length}건
                      </div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: 'var(--primary)' }}>
                        발주 합계 ₩{(totals.existing + totals.new).toLocaleString()}
                      </div>
                      {totals.extraCost > 0 && (
                        <div style={{ fontSize: 12, color: '#e65100' }}>
                          추가비용 ₩{totals.extraCost.toLocaleString()}
                        </div>
                      )}
                    </div>
                    <button
                      className="btn btn-sm"
                      style={{ color: '#d32f2f', background: 'none', border: '1px solid #eee', borderRadius: 6, padding: '4px 8px', cursor: 'pointer' }}
                      onClick={(e) => { e.stopPropagation(); handleDeleteRecord(record.id); }}
                      title="이 기록 삭제"
                    >
                      ✕
                    </button>
                  </div>
                </div>

                {/* 브랜드별 상세 */}
                {isExpanded && (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="data-table">
                      <thead>
                        <tr>
                          <th>브랜드</th>
                          <th style={{ textAlign: 'right' }}>기존 발주 (KRW)</th>
                          <th style={{ textAlign: 'right' }}>신규 발주 (KRW)</th>
                          <th style={{ textAlign: 'right' }}>발주 소계</th>
                          <th style={{ textAlign: 'right' }}>추가비용 (KRW)</th>
                          <th style={{ textAlign: 'right' }}>합계</th>
                        </tr>
                      </thead>
                      <tbody>
                        {brands.map(brandName => {
                          const d = agg[brandName];
                          const c = carried[brandName];
                          const subtotal = d.existing + d.new;

                          const renderAmount = (val, carryVal, type) => {
                            const hasCarry = c && carryVal && carryVal < 0;
                            if (val === 0 && !hasCarry) return '—';
                            return (
                              <div>
                                <span style={{ color: val < 0 ? '#c62828' : undefined }}>
                                  ₩{val.toLocaleString()}
                                </span>
                                {val < 0 && (
                                  <span style={{ fontSize: 10, color: '#c62828', marginLeft: 4 }}>(환불)</span>
                                )}
                                {hasCarry && (
                                  <div style={{ fontSize: 10, color: '#7b1fa2', marginTop: 2 }}>
                                    전주 환불 ₩{Math.abs(carryVal).toLocaleString()} 반영
                                  </div>
                                )}
                              </div>
                            );
                          };

                          return (
                            <tr key={brandName}>
                              <td style={{ fontWeight: 600 }}>{brandName}</td>
                              <td style={{ textAlign: 'right' }}>{renderAmount(d.existing, c?.existing, 'existing')}</td>
                              <td style={{ textAlign: 'right' }}>{renderAmount(d.new, c?.new, 'new')}</td>
                              <td style={{ textAlign: 'right', fontWeight: 600, color: subtotal < 0 ? '#c62828' : undefined }}>
                                ₩{subtotal.toLocaleString()}
                                {subtotal < 0 && <span style={{ fontSize: 10, marginLeft: 4 }}>(환불)</span>}
                              </td>
                              <td style={{ textAlign: 'right', color: d.extraCost > 0 ? '#e65100' : undefined }}>
                                {d.extraCost > 0 ? `₩${d.extraCost.toLocaleString()}` : '—'}
                              </td>
                              <td style={{ textAlign: 'right', fontWeight: 700 }}>
                                ₩{(subtotal + d.extraCost).toLocaleString()}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                      <tfoot>
                        <tr style={{ background: '#f5f7fa', fontWeight: 700 }}>
                          <td>전체 합계</td>
                          <td style={{ textAlign: 'right' }}>₩{totals.existing.toLocaleString()}</td>
                          <td style={{ textAlign: 'right', color: '#1565c0' }}>₩{totals.new.toLocaleString()}</td>
                          <td style={{ textAlign: 'right' }}>₩{(totals.existing + totals.new).toLocaleString()}</td>
                          <td style={{ textAlign: 'right', color: '#e65100' }}>₩{totals.extraCost.toLocaleString()}</td>
                          <td style={{ textAlign: 'right', fontSize: 15 }}>
                            ₩{(totals.existing + totals.new + totals.extraCost).toLocaleString()}
                          </td>
                        </tr>
                      </tfoot>
                    </table>

                    {/* 개별 거래 내역 토글 */}
                    <details style={{ padding: '12px 16px' }}>
                      <summary style={{ cursor: 'pointer', fontSize: 13, color: 'var(--text-secondary)', marginBottom: 8 }}>
                        개별 거래 내역 ({record.transactions.length}건)
                      </summary>
                      <table className="data-table" style={{ fontSize: 12 }}>
                        <thead>
                          <tr>
                            <th>날짜</th>
                            <th>거래유형</th>
                            <th>브랜드</th>
                            <th>신규/기존</th>
                            <th>발주번호</th>
                            <th style={{ textAlign: 'right' }}>금액 (CNY)</th>
                            <th style={{ textAlign: 'right' }}>금액 (KRW)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {record.transactions.map((tx, i) => {
                            const code = extractBrandCode(tx.orderNo);
                            const excluded = code && EXCLUDE_CODES.includes(code.toUpperCase());
                            const brand = excluded ? `${code} (제외)` : (code ? (brandMap[code] || `미분류(${code})`) : '—');
                            const isNew = isNewProduct(tx.orderNo);
                            return (
                              <tr key={i} style={excluded ? { opacity: 0.4 } : undefined}>
                                <td>{tx.date}</td>
                                <td>
                                  <span style={{
                                    padding: '2px 6px', borderRadius: 4, fontSize: 11, fontWeight: 600,
                                    background: tx.type === '오더 지불' ? '#e3f2fd' : tx.type === '환불' ? '#fce4ec' : '#fff3e0',
                                    color: tx.type === '오더 지불' ? '#1565c0' : tx.type === '환불' ? '#c62828' : '#e65100',
                                  }}>
                                    {tx.type}
                                  </span>
                                </td>
                                <td style={{ fontWeight: 500 }}>{brand}</td>
                                <td>
                                  {tx.type !== '추가비용' && !excluded && (
                                    <span style={{
                                      padding: '2px 6px', borderRadius: 4, fontSize: 11,
                                      background: isNew ? '#e8eaf6' : '#f5f5f5',
                                      color: isNew ? '#283593' : '#666',
                                      fontWeight: isNew ? 600 : 400,
                                    }}>
                                      {isNew ? '신규' : '기존'}
                                    </span>
                                  )}
                                </td>
                                <td style={{ fontSize: 11, color: '#666' }}>{tx.orderNo}</td>
                                <td style={{ textAlign: 'right' }}>¥{tx.amount.toLocaleString()}</td>
                                <td style={{ textAlign: 'right', fontWeight: 500 }}>
                                  ₩{Math.round(tx.amount * record.exchangeRate).toLocaleString()}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </details>
                  </div>
                )}
              </div>
            );
          })
      )}
    </div>
  );
}
