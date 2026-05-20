import { useState, useEffect, useMemo } from 'react';
import { dbStoreGet } from '../utils/dbApi';

function keyToDisplay(k) {
  return `${k.slice(0, 4)}-${k.slice(4, 6)}-${k.slice(6, 8)}`;
}

export default function SoldOutAnalysisRate() {
  const [snapshots, setSnapshots] = useState({});
  const [loading, setLoading] = useState(true);
  const [viewMode, setViewMode] = useState('monthly'); // monthly, quarterly, half
  const [selectedYear, setSelectedYear] = useState(new Date().getFullYear());

  useEffect(() => {
    (async () => {
      const data = await dbStoreGet('soldout_analysis_rate_snapshots') || {};
      setSnapshots(data);
      setLoading(false);
    })();
  }, []);

  // 일별 데이터 → 정렬
  const dailyData = useMemo(() => {
    return Object.values(snapshots)
      .filter(s => s.date && s.date.startsWith(String(selectedYear)))
      .sort((a, b) => a.date.localeCompare(b.date));
  }, [snapshots, selectedYear]);

  // 월별 집계
  const monthlyData = useMemo(() => {
    const months = {};
    for (const s of dailyData) {
      const m = s.date.slice(0, 6); // YYYYMM
      if (!months[m]) months[m] = { days: 0, totalSum: 0, soldoutSum: 0 };
      months[m].days++;
      months[m].totalSum += s.total;
      months[m].soldoutSum += s.soldout;
    }
    return Object.entries(months).map(([key, v]) => ({
      key,
      label: `${key.slice(0, 4)}년 ${parseInt(key.slice(4))}월`,
      days: v.days,
      avgTotal: Math.round(v.totalSum / v.days),
      avgSoldout: Math.round(v.soldoutSum / v.days),
      rate: v.totalSum > 0 ? Math.round(v.soldoutSum / v.totalSum * 10000) / 100 : 0,
    })).sort((a, b) => a.key.localeCompare(b.key));
  }, [dailyData]);

  // 분기별 집계
  const quarterlyData = useMemo(() => {
    const quarters = {};
    for (const s of dailyData) {
      const month = parseInt(s.date.slice(4, 6));
      const q = Math.ceil(month / 3);
      const key = `${s.date.slice(0, 4)}Q${q}`;
      if (!quarters[key]) quarters[key] = { days: 0, totalSum: 0, soldoutSum: 0, q };
      quarters[key].days++;
      quarters[key].totalSum += s.total;
      quarters[key].soldoutSum += s.soldout;
    }
    return Object.entries(quarters).map(([key, v]) => ({
      key,
      label: `${key.slice(0, 4)}년 ${v.q}분기`,
      days: v.days,
      avgTotal: Math.round(v.totalSum / v.days),
      avgSoldout: Math.round(v.soldoutSum / v.days),
      rate: v.totalSum > 0 ? Math.round(v.soldoutSum / v.totalSum * 10000) / 100 : 0,
    })).sort((a, b) => a.key.localeCompare(b.key));
  }, [dailyData]);

  // 반기별 집계
  const halfData = useMemo(() => {
    const halves = {};
    for (const s of dailyData) {
      const month = parseInt(s.date.slice(4, 6));
      const h = month <= 6 ? 1 : 2;
      const key = `${s.date.slice(0, 4)}H${h}`;
      if (!halves[key]) halves[key] = { days: 0, totalSum: 0, soldoutSum: 0, h };
      halves[key].days++;
      halves[key].totalSum += s.total;
      halves[key].soldoutSum += s.soldout;
    }
    return Object.entries(halves).map(([key, v]) => ({
      key,
      label: `${key.slice(0, 4)}년 ${v.h === 1 ? '상반기' : '하반기'}`,
      days: v.days,
      avgTotal: Math.round(v.totalSum / v.days),
      avgSoldout: Math.round(v.soldoutSum / v.days),
      rate: v.totalSum > 0 ? Math.round(v.soldoutSum / v.totalSum * 10000) / 100 : 0,
    })).sort((a, b) => a.key.localeCompare(b.key));
  }, [dailyData]);

  const currentData = viewMode === 'monthly' ? monthlyData : viewMode === 'quarterly' ? quarterlyData : halfData;

  // 연도 목록
  const years = useMemo(() => {
    const set = new Set(Object.keys(snapshots).map(k => parseInt(k.slice(0, 4))));
    if (set.size === 0) set.add(new Date().getFullYear());
    return [...set].sort();
  }, [snapshots]);

  const rateColor = (rate) => rate > 10 ? '#d93025' : rate > 5 ? '#e65100' : '#2e7d32';
  const rateLabel = (rate) => rate > 10 ? '위험' : rate > 5 ? '주의' : '양호';

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
      {/* 컨트롤 */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-body">
          <div className="filter-bar">
            <select
              value={selectedYear}
              onChange={e => setSelectedYear(Number(e.target.value))}
              style={{
                padding: '6px 10px', borderRadius: 8, border: '1px solid var(--border)',
                fontSize: 13, fontWeight: 600, outline: 'none', cursor: 'pointer',
              }}
            >
              {years.map(y => <option key={y} value={y}>{y}년</option>)}
            </select>
            <button className={`filter-btn${viewMode === 'monthly' ? ' active' : ''}`}
              onClick={() => setViewMode('monthly')}>월별</button>
            <button className={`filter-btn${viewMode === 'quarterly' ? ' active' : ''}`}
              onClick={() => setViewMode('quarterly')}>분기별</button>
            <button className={`filter-btn${viewMode === 'half' ? ' active' : ''}`}
              onClick={() => setViewMode('half')}>반기별</button>
          </div>
        </div>
      </div>

      {/* 기간별 카드 */}
      {currentData.length === 0 ? (
        <div className="card" style={{ padding: 40, textAlign: 'center', color: 'var(--text-secondary)' }}>
          {selectedYear}년 데이터가 없습니다. 품절 현황 페이지에서 데이터를 업로드하면 자동으로 기록됩니다.
        </div>
      ) : (
        <div className="stats-grid" style={{ marginBottom: 16 }}>
          {currentData.map(d => (
            <div key={d.key} className="stat-card" style={{ gap: 8 }}>
              <div className="label">{d.label}</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
                <span className="value" style={{ color: rateColor(d.rate) }}>{d.rate}%</span>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: '2px 6px', borderRadius: 6,
                  background: d.rate > 10 ? '#fef0ef' : d.rate > 5 ? '#fff8f0' : '#f0faf0',
                  color: rateColor(d.rate),
                }}>{rateLabel(d.rate)}</span>
              </div>
              <div className="sub">
                품절 {d.avgSoldout} / {d.avgTotal} (일평균) · {d.days}일 기록
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 일별 상세 (최근 30일) */}
      {dailyData.length > 0 && (
        <>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', padding: '0 0 8px' }}>
            일별 품절률 (최근 30일)
          </div>
          <div className="table-wrapper" style={{ maxHeight: 'calc(100vh - 380px)', overflowY: 'auto' }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>날짜</th>
                  <th>전체 품목</th>
                  <th>품절 품목</th>
                  <th>품절률</th>
                  <th>상태</th>
                </tr>
              </thead>
              <tbody>
                {[...dailyData].reverse().slice(0, 30).map(s => (
                  <tr key={s.date}>
                    <td>{keyToDisplay(s.date)}</td>
                    <td className="num">{s.total.toLocaleString()}</td>
                    <td className="num" style={{ color: '#c5221f', fontWeight: 600 }}>{s.soldout.toLocaleString()}</td>
                    <td className="num" style={{ color: rateColor(s.rate), fontWeight: 700 }}>{s.rate}%</td>
                    <td>
                      <span className="alert-badge" style={{
                        background: s.rate > 10 ? '#fce8e6' : s.rate > 5 ? '#fff3e0' : '#e6f4ea',
                        color: rateColor(s.rate),
                      }}>{rateLabel(s.rate)}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
