import { useState, useMemo, useEffect, useCallback } from 'react';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';

const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`;
const TSV_DATA = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=0`;

const EXCLUDE_KEYWORDS = ['최종마감', '품질확인서', '마감대상'];
const STORAGE_KEY = 'soldout_rate_snapshots';
const EXCLUDE_ITEMS_KEY = 'soldout_exclude_items';
const MONTHS_KR = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월'];

function safeNum(v) {
  if (v === '' || v === '-' || v === undefined || v === null) return 0;
  const n = Number(v);
  return isNaN(n) ? 0 : n;
}

function todayKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function monthKey(dateStr) {
  // "2026-03-25" → "2026-03"
  return dateStr.slice(0, 7);
}

function loadSnapshots() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}'); }
  catch { return {}; }
}

function saveSnapshots(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  dbStoreSet('soldout_rate', data).catch(() => {});
}

function shouldExclude(status) {
  if (!status) return false;
  return EXCLUDE_KEYWORDS.some(kw => status.includes(kw));
}

function loadExcludeItems() {
  try { return JSON.parse(localStorage.getItem(EXCLUDE_ITEMS_KEY) || '[]'); }
  catch { return []; }
}

function isExcludedBarcode(barcode, excludeItems) {
  const today = todayKey();
  return excludeItems.some(item =>
    item.barcode === barcode && (!item.endDate || item.endDate >= today)
  );
}

// 오늘 스냅샷 계산
function calcTodaySnapshot(calcTsv, dataTsv) {
  const excludeItems = loadExcludeItems();

  // 상태 매핑
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
  let totalProducts = 0;
  let soldoutCount = 0;
  let excludedCount = 0;

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split('\t');
    if (!cols[1] && !cols[2]) continue;

    const optionId = cols[1] || '';
    const barcode = cols[2] || '';
    const rawStatus = cols[5] || '';
    const status = rawStatus || statusMap[optionId] || '';
    const stock = safeNum(cols[6]);
    const incoming = safeNum(cols[7]); // 그로스 입고예정

    if (shouldExclude(status)) continue;

    // 신규 + 입고예정 있으면 제외 (아직 입고된 적 없는 상품)
    if (status === 'NEW' && incoming > 0) continue;
    if (status === '신규' && incoming > 0) continue;

    // 제외 품목 체크
    if (isExcludedBarcode(barcode, excludeItems)) {
      excludedCount++;
      continue;
    }

    totalProducts++;
    if (stock === 0) soldoutCount++;
  }

  const rate = totalProducts > 0 ? (soldoutCount / totalProducts * 100) : 0;

  return {
    date: todayKey(),
    total: totalProducts,
    soldout: soldoutCount,
    excluded: excludedCount,
    rate: Math.round(rate * 100) / 100,
  };
}

export default function SoldOutRate() {
  const [snapshots, setSnapshots] = useState(loadSnapshots);
  const [loading, setLoading] = useState(false);
  const [todayData, setTodayData] = useState(null);
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());
  const [hoveredBar, setHoveredBar] = useState(null);
  const [dbLoaded, setDbLoaded] = useState(false);

  // 1단계: DB에서 초기 데이터 로드 → 로컬과 병합
  useEffect(() => {
    dbStoreGet('soldout_rate').then(data => {
      if (data && typeof data === 'object' && Object.keys(data).length > 0) {
        // DB 데이터와 로컬 데이터 병합 (DB 우선)
        const local = loadSnapshots();
        const merged = { ...local, ...data };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
        setSnapshots(merged);
        // 오늘 데이터가 DB에 이미 있으면 todayData로 표시
        const today = todayKey();
        if (merged[today]) {
          setTodayData(merged[today]);
        }
      }
    }).catch(() => {}).finally(() => setDbLoaded(true));
  }, []);

  const fetchAndSave = useCallback(async () => {
    setLoading(true);
    try {
      const existing = loadSnapshots();
      const today = todayKey();

      // 이미 오늘 데이터가 DB에서 로드되었으면 새로 계산하지 않음
      if (existing[today]) {
        setTodayData(existing[today]);
        setSnapshots(existing);
        setLoading(false);
        return;
      }

      // 오늘 데이터가 없을 때만 TSV에서 새로 계산
      const [calcRes, dataRes] = await Promise.all([
        fetch(TSV_CALC), fetch(TSV_DATA),
      ]);
      if (!calcRes.ok) throw new Error('fetch failed');
      const calcTsv = await calcRes.text();
      const dataTsv = dataRes.ok ? await dataRes.text() : null;

      const snapshot = calcTodaySnapshot(calcTsv, dataTsv);
      setTodayData(snapshot);

      // DB에 저장 (병합 방식)
      const updated = { ...existing, [snapshot.date]: snapshot };
      saveSnapshots(updated);
      setSnapshots(updated);
    } catch (err) {
      console.error('Snapshot fetch error:', err);
    }
    setLoading(false);
  }, []);

  // 3/31 데이터 복구 (1회성)
  useEffect(() => {
    const snaps = loadSnapshots();
    if (snaps['2026-03-31'] && snaps['2026-03-31'].rate !== 0.88) {
      snaps['2026-03-31'] = { ...snaps['2026-03-31'], rate: 0.88, soldout: Math.round(snaps['2026-03-31'].total * 0.0088) };
      saveSnapshots(snaps);
      setSnapshots(snaps);
    }
  }, []);

  // 2단계: DB 로드 완료 후에 fetchAndSave 실행
  useEffect(() => { if (dbLoaded) fetchAndSave(); }, [dbLoaded, fetchAndSave]);

  // 월별 집계
  const monthlyData = useMemo(() => {
    const buckets = Array.from({ length: 12 }, (_, i) => ({
      month: i,
      label: MONTHS_KR[i],
      days: 0,
      totalSum: 0,
      soldoutSum: 0,
      rateSum: 0,
      rates: [],
    }));

    for (const [date, snap] of Object.entries(snapshots)) {
      if (!date.startsWith(String(selectedYear))) continue;
      const m = parseInt(date.slice(5, 7), 10) - 1;
      if (m < 0 || m > 11) continue;
      buckets[m].days++;
      buckets[m].totalSum += snap.total || 0;
      buckets[m].soldoutSum += snap.soldout || 0;
      buckets[m].rateSum += snap.rate || 0;
      buckets[m].rates.push(snap.rate || 0);
    }

    // 평균 품절률 계산
    return buckets.map(b => ({
      ...b,
      avgRate: b.days > 0 ? Math.round(b.rateSum / b.days * 100) / 100 : null,
      avgTotal: b.days > 0 ? Math.round(b.totalSum / b.days) : 0,
      avgSoldout: b.days > 0 ? Math.round(b.soldoutSum / b.days) : 0,
    }));
  }, [snapshots, selectedYear]);

  const maxRate = Math.max(...monthlyData.map(b => b.avgRate || 0), 1);

  // 전체 기록된 날짜 수
  const totalDays = Object.keys(snapshots).length;

  // 이번 달 평균
  const currentMonth = new Date().getMonth();
  const thisMonthData = monthlyData[currentMonth];

  // 전체 평균
  const allRates = Object.values(snapshots).map(s => s.rate || 0);
  const overallAvg = allRates.length > 0 ? Math.round(allRates.reduce((a,b) => a+b, 0) / allRates.length * 100) / 100 : 0;

  return (
    <div>
      {/* 안내 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body" style={{ padding: '12px 20px', fontSize: 13, color: '#5f6368', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 16 }}>💡</span>
          누군가 한 번만 방문하면 오늘의 품절률이 자동 기록되어 모든 컴퓨터에서 공유됩니다.
          <span style={{ marginLeft: 'auto', fontWeight: 600 }}>
            누적 {totalDays}일 기록
          </span>
        </div>
      </div>

      {/* Stats */}
      <div className="stats-grid">
        <div className="stat-card info">
          <div className="label">오늘 품절률</div>
          <div className="value">{todayData ? todayData.rate + '%' : loading ? '...' : '-'}</div>
          <div className="sub">
            {todayData ? `${todayData.soldout}개 품절 / ${todayData.total}개 전체` : ''}
          </div>
        </div>
        <div className="stat-card" style={{ background: thisMonthData?.avgRate != null ? '#fff3e0' : '#f5f5f5' }}>
          <div className="label">{MONTHS_KR[currentMonth]} 평균 품절률</div>
          <div className="value" style={{ color: '#e65100' }}>
            {thisMonthData?.avgRate != null ? thisMonthData.avgRate + '%' : '-'}
          </div>
          <div className="sub">
            {thisMonthData?.days > 0 ? `${thisMonthData.days}일 기록` : '데이터 없음'}
          </div>
        </div>
        <div className="stat-card" style={{ background: '#e8f5e9' }}>
          <div className="label">전체 평균 품절률</div>
          <div className="value" style={{ color: '#2e7d32' }}>{overallAvg}%</div>
          <div className="sub">전체 {totalDays}일 기준</div>
        </div>
        <div className="stat-card">
          <div className="label">목표 품절률</div>
          <div className="value" style={{ color: '#1a73e8' }}>5%</div>
          <div className="sub">권장 기준</div>
        </div>
      </div>

      {/* 월별 차트 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>월별 평균 품절률</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <button className="btn btn-outline btn-sm" onClick={() => setSelectedYear(y => y - 1)}>◀</button>
            <span style={{ fontWeight: 600, minWidth: 50, textAlign: 'center' }}>{selectedYear}</span>
            <button className="btn btn-outline btn-sm" onClick={() => setSelectedYear(y => y + 1)}>▶</button>
          </div>
        </div>
        <div className="card-body">
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 8, height: 200, padding: '0 8px' }}>
            {monthlyData.map((bar, idx) => {
              const h = bar.avgRate != null ? Math.max((bar.avgRate / maxRate) * 160, 8) : 0;
              const isHovered = hoveredBar === idx;
              const color = bar.avgRate != null
                ? bar.avgRate > 10 ? '#d93025'
                : bar.avgRate > 5 ? '#e65100'
                : '#2e7d32'
                : '#e0e0e0';

              return (
                <div
                  key={idx}
                  style={{
                    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
                    position: 'relative', cursor: bar.days > 0 ? 'pointer' : 'default',
                  }}
                  onMouseEnter={() => setHoveredBar(idx)}
                  onMouseLeave={() => setHoveredBar(null)}
                >
                  {/* Tooltip */}
                  {isHovered && bar.days > 0 && (
                    <div style={{
                      position: 'absolute', bottom: h + 40, left: '50%', transform: 'translateX(-50%)',
                      background: '#333', color: '#fff', padding: '8px 12px', borderRadius: 8,
                      fontSize: 12, whiteSpace: 'nowrap', zIndex: 10, lineHeight: 1.6,
                    }}>
                      <strong>{bar.label}</strong><br/>
                      평균 품절률: {bar.avgRate}%<br/>
                      평균 품절: {bar.avgSoldout}개 / {bar.avgTotal}개<br/>
                      기록: {bar.days}일
                    </div>
                  )}

                  {/* Rate label */}
                  {bar.avgRate != null && (
                    <div style={{ fontSize: 11, fontWeight: 600, color, marginBottom: 4 }}>
                      {bar.avgRate}%
                    </div>
                  )}

                  {/* Bar */}
                  <div style={{
                    width: '100%', maxWidth: 40, height: bar.days > 0 ? h : 4,
                    background: bar.days > 0 ? color : '#f0f0f0',
                    borderRadius: '4px 4px 0 0',
                    opacity: isHovered ? 1 : 0.85,
                    transition: 'all 0.15s',
                  }} />

                  {/* 5% 기준선은 별도로 그리기 어려우니 생략 */}

                  {/* Month label */}
                  <div style={{ fontSize: 11, color: '#666', marginTop: 6 }}>{bar.label}</div>
                  {bar.days > 0 && (
                    <div style={{ fontSize: 10, color: '#999' }}>{bar.days}일</div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 범례 */}
          <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 16, fontSize: 12, color: '#666' }}>
            <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#2e7d32', borderRadius: 2, marginRight: 4, verticalAlign: -1 }} />5% 이하 (양호)</span>
            <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#e65100', borderRadius: 2, marginRight: 4, verticalAlign: -1 }} />5~10% (주의)</span>
            <span><span style={{ display: 'inline-block', width: 12, height: 12, background: '#d93025', borderRadius: 2, marginRight: 4, verticalAlign: -1 }} />10% 이상 (위험)</span>
          </div>
        </div>
      </div>

      {/* 일별 기록 테이블 */}
      <div className="card">
        <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h2 style={{ fontSize: 16, fontWeight: 600 }}>일별 기록</h2>
          <button
            className="btn btn-outline btn-sm"
            onClick={() => {
              if (window.confirm('모든 기록을 삭제하시겠습니까?')) {
                saveSnapshots({});
                setSnapshots({});
              }
            }}
          >🗑️ 기록 초기화</button>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          {totalDays === 0 ? (
            <div style={{ padding: 40, textAlign: 'center', color: '#999' }}>
              아직 기록이 없습니다. 페이지 방문 시 자동 기록됩니다.
            </div>
          ) : (
            <div className="table-wrapper" style={{ maxHeight: 400, overflowY: 'auto' }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>날짜</th>
                    <th className="num">전체 품목</th>
                    <th className="num">품절 수</th>
                    <th className="num">품절률</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(snapshots)
                    .sort((a, b) => b[0].localeCompare(a[0]))
                    .map(([date, snap]) => {
                      const color = snap.rate > 10 ? '#d93025' : snap.rate > 5 ? '#e65100' : '#2e7d32';
                      return (
                        <tr key={date}>
                          <td>{date}</td>
                          <td className="num">{(snap.total || 0).toLocaleString()}</td>
                          <td className="num">{(snap.soldout || 0).toLocaleString()}</td>
                          <td className="num" style={{ fontWeight: 600, color }}>{snap.rate}%</td>
                        </tr>
                      );
                    })
                  }
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {loading && (
        <div style={{ position: 'fixed', bottom: 20, right: 20, background: '#333', color: '#fff', padding: '8px 16px', borderRadius: 8, fontSize: 13 }}>
          데이터 수집 중...
        </div>
      )}
    </div>
  );
}
