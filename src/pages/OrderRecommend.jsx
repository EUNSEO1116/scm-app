import { useState, useEffect, useCallback } from 'react';
import XLSX from 'xlsx-js-style';
import { dbStoreGet } from '../utils/dbApi';

// ───────── 상수 ─────────
const SHEET_ID = '1NXhW_gG0b-gXuVqrhbY9ErWi8uO_7pXIy-NTo4FbE1I';
const TSV_CALC = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/export?format=tsv&gid=1349677364`; // 재고 계산기
const CSV_BARCODE = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent('쿠팡바코드')}`;

const STORE_PREFIX = 'soldout_analysis_';
const SEASONS_STORE = 'sales_forecast_seasons';
const IMPROVE_STORE = 'improvement_items';

const FORECAST_DAYS = 90;     // 수요예측 일별 데이터 로딩 기간
const HORIZON_WEEKS = 4;      // 발주 커버 기간 (4주)
const HOLT_ALPHA = 0.3;       // 레벨 평활 계수
const HOLT_BETA = 0.1;        // 트렌드 평활 계수
const PEAK_MULT = 1.2;        // 시즌피크 버퍼
const ENDING_MULT = 0.7;      // 시즌종료 4주전 축소
const ENDING_DAYS = 28;       // 시즌 막달 말일까지 남은 일수 ≤ 이 값이면 종료임박

const VOC_ACTIVE_STATUS = ['처리중', '시작전'];
const VOC_TARGET_TYPE = ['상품문제', '재수배'];

// 판매중이 아닌 제외 대상(발주추천 안 함) — 수요예측과 동일 기준
const EXCLUDE_KEYWORDS = ['최종마감', '품질확인서', '마감대상', '덤핑'];
function shouldExclude(s) { return s ? EXCLUDE_KEYWORDS.some(kw => s.includes(kw)) : false; }

// ───────── helpers ─────────
function safeNum(v) { if (v === '' || v === '-' || v == null) return 0; const n = Number(v); return isNaN(n) ? 0 : n; }
function pad2(n) { return String(n).padStart(2, '0'); }
function dateToKey(d) { return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}`; }

function parseCsvRow(line) {
  const result = []; let current = ''; let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) { if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; } else if (ch === '"') inQuotes = false; else current += ch; }
    else { if (ch === '"') inQuotes = true; else if (ch === ',') { result.push(current); current = ''; } else current += ch; }
  }
  result.push(current); return result;
}

// 시즌기간("12~2 / 6~8") → 해당 월 Set. 숫자 없으면 null(=상시).
function parseSeasonMonths(str) {
  if (!str) return null;
  const ranges = str.match(/\d+\s*~\s*\d+/g) || [];
  const singles = str.match(/\d+/g) || [];
  if (ranges.length === 0 && singles.length === 0) return null;
  const months = new Set();
  for (const r of ranges) {
    const m = r.match(/(\d+)\s*~\s*(\d+)/);
    let a = +m[1], b = +m[2];
    if (a < 1 || a > 12 || b < 1 || b > 12) continue;
    if (a <= b) { for (let x = a; x <= b; x++) months.add(x); }
    else { for (let x = a; x <= 12; x++) months.add(x); for (let x = 1; x <= b; x++) months.add(x); }
  }
  if (months.size === 0) { for (const s of singles) { const v = +s; if (v >= 1 && v <= 12) months.add(v); } }
  return months.size ? months : null;
}

// 이동평균 (들쭉날쭉한 일별값 평탄화)
function movingAvg(vals, w) {
  if (w <= 1) return vals.slice();
  const out = [];
  for (let i = 0; i < vals.length; i++) {
    const start = Math.max(0, i - w + 1);
    let s = 0; for (let j = start; j <= i; j++) s += vals[j];
    out.push(s / (i - start + 1));
  }
  return out;
}

// 추세 판정: 7일 이동평균 방향. 우상향/우하향/보합.
function computeTrend(vals, smoothWindow) {
  const ma = movingAvg(vals, smoothWindow);
  const n = ma.length;
  if (n < 2) return { dir: 'flat', streak: 0 };
  const mean = ma.reduce((s, v) => s + Math.abs(v), 0) / n;
  const EPS = Math.max(0.5, mean * 0.2);
  const back = Math.min(smoothWindow, n - 1);
  const netDiff = ma[n - 1] - ma[n - 1 - back];
  if (Math.abs(netDiff) < EPS) return { dir: 'flat', streak: 0 };
  const dir = netDiff > 0 ? 'up' : 'down';
  let streak = 1;
  for (let i = n - 2; i >= 1; i--) {
    const d = ma[i] - ma[i - 1];
    if (dir === 'up' ? d > -EPS : d < EPS) streak++;
    else break;
  }
  return { dir, streak };
}

// 가장 최근 데이터일을 기준으로 bucketDays씩 뒤로 끊는 롤링 윈도우.
// 첫 데이터일 기준이 아니라 "오늘 기준 최근 7일/8~14일/…"로 묶어, 최근 며칠이 항상 포함되게 한다.
// 반환: 오래된→최근 순의 [[keys],...]
function makeRecentWindows(availKeys, bucketDays) {
  if (availKeys.length === 0) return [];
  const last = availKeys[availKeys.length - 1]; // 최근 데이터일을 앵커로
  const anchor = new Date(+last.slice(0, 4), +last.slice(4, 6) - 1, +last.slice(6, 8));
  const map = new Map();
  for (const k of availKeys) {
    const d = new Date(+k.slice(0, 4), +k.slice(4, 6) - 1, +k.slice(6, 8));
    const daysAgo = Math.floor((anchor - d) / 86400000);
    const wi = Math.floor(daysAgo / bucketDays); // 0 = 최근 윈도우
    if (!map.has(wi)) map.set(wi, []);
    map.get(wi).push(k);
  }
  // wi 큰값(오래됨) → 작은값(최근) 순으로 정렬 = 오래된→최근
  return [...map.entries()].sort((a, b) => b[0] - a[0]).map(([, keys]) => keys);
}

// 트렌드보정 지수평활(Holt 선형) → 4주 누적 예측.
//  L = α·실제 + (1-α)(전L + 전T),  T = β(L - 전L) + (1-β)·전T,  예측 = L + k·T (k=1..4) 누적
function holtCumForecast(weekly) {
  const n = weekly.length;
  if (n < 2) return null;
  let L = weekly[0];
  let T = 0; // 초기 추세 0 — 런치 램프/노이즈로 인한 추세 폭주 방지
  for (let t = 1; t < n; t++) {
    const prevL = L;
    L = HOLT_ALPHA * weekly[t] + (1 - HOLT_ALPHA) * (L + T);
    T = HOLT_BETA * (L - prevL) + (1 - HOLT_BETA) * T;
  }
  let sum = 0;
  for (let k = 1; k <= HORIZON_WEEKS; k++) sum += Math.max(0, L + k * T);
  return sum;
}

// 최근 4주 가중평균 × 4주. 최근 주에 큰 가중치 — 4주전→1주전 = 1 / 1.5 / 2.5 / 4
const RECENT_WEIGHTS = [1, 1.5, 2.5, 4]; // 오래된→최근 (HORIZON_WEEKS=4 기준)
function weightedCumForecast(weekly) {
  const recent = weekly.slice(-HORIZON_WEEKS);
  const n = recent.length;
  if (n === 0) return 0;
  const w = RECENT_WEIGHTS.slice(-n); // 데이터가 4주 미만이면 최근쪽 가중치만 사용
  let wsum = 0, vsum = 0;
  for (let i = 0; i < n; i++) { wsum += w[i]; vsum += recent[i] * w[i]; }
  return (vsum / wsum) * HORIZON_WEEKS;
}

export default function OrderRecommend() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [dataDays, setDataDays] = useState(0);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const dayList = [];
      for (let i = FORECAST_DAYS - 1; i >= 0; i--) { const d = new Date(); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - i); dayList.push(d); }

      const [calcRes, barcodeRes, dbSeasons, dbImprove, ...stores] = await Promise.all([
        fetch(TSV_CALC),
        fetch(CSV_BARCODE),
        dbStoreGet(SEASONS_STORE).catch(() => null),
        dbStoreGet(IMPROVE_STORE).catch(() => null),
        ...dayList.map(d => dbStoreGet(`${STORE_PREFIX}${dateToKey(d)}`).catch(() => null)),
      ]);

      // 일별 판매 (옵션id → 판매량)
      const itemsByKey = {};
      const availKeys = [];
      const appeared = new Set();
      dayList.forEach((d, i) => {
        const st = stores[i];
        if (!st?.items) return;
        const key = dateToKey(d);
        const m = new Map();
        for (const it of st.items) { m.set(it.optionId, it.salesQty || 0); appeared.add(it.optionId); }
        itemsByKey[key] = m;
        availKeys.push(key);
      });
      setDataDays(availKeys.length);
      // 최근 데이터일 기준 7일 롤링 윈도우 [[keys],...] 오래된→최근.
      // 최근 며칠(진행 중 주)도 항상 포함된다 — 예전처럼 부분 주를 잘라내지 않음.
      const useBuckets = makeRecentWindows(availKeys, 7);

      // 시즌기간 시드: 쿠팡바코드 시트 Q(16) → 옵션id별 period
      const seedPeriod = {};
      try {
        const bcCsv = await barcodeRes.text();
        const bcLines = bcCsv.split('\n').filter(l => l.trim());
        for (let i = 1; i < bcLines.length; i++) {
          const c = parseCsvRow(bcLines[i]);
          const oid = (c[1] || '').trim();
          if (oid) seedPeriod[oid] = (c[16] || '').trim();
        }
      } catch { /* 시즌 시드 실패 시 DB값만 사용 */ }
      const seasons = dbSeasons || {};
      const periodOf = (oid) => (seasons[oid]?.period) || seedPeriod[oid] || '';

      // VOC: 쿠팡바코드 → 상품문제/재수배 & 처리중/시작전
      const vocBarcodes = new Set();
      for (const it of (Array.isArray(dbImprove) ? dbImprove : [])) {
        if (!it.barcode) continue;
        if (VOC_ACTIVE_STATUS.includes(it.status) && VOC_TARGET_TYPE.includes(it.type)) {
          vocBarcodes.add(it.barcode);
        }
      }

      // 시즌 보정 계수 계산
      const now = new Date();
      const curM = now.getMonth() + 1;
      const nextM = curM === 12 ? 1 : curM + 1;
      const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
      const daysLeftInMonth = lastDay - now.getDate();
      function seasonMult(period) {
        const months = parseSeasonMonths(period);
        if (!months) return 1; // 상시(시즌 미지정) → 보정 없음
        const inNow = months.has(curM);
        const endingSoon = inNow && !months.has(nextM) && daysLeftInMonth <= ENDING_DAYS;
        if (endingSoon) return ENDING_MULT; // 시즌종료 4주전 우선
        if (inNow) return PEAK_MULT;        // 시즌피크
        return 1;
      }

      // 재고 계산기: 시트 순서 그대로 전 품목
      const calcText = await calcRes.text();
      const calcLines = calcText.split('\n');
      const out = [];
      // 마지막 실제 상품 행 위치(이후 빈 패딩 행은 출력 제외)
      let lastProductIdx = 0;
      for (let i = 1; i < calcLines.length; i++) {
        if ((calcLines[i].split('\t')[2] || '').trim()) lastProductIdx = i;
      }
      for (let i = 1; i <= lastProductIdx; i++) {
        const line = calcLines[i];
        const c = line.split('\t');
        const barcode = (c[2] || '').trim();
        const productName = (c[3] || '').trim();
        // 시트의 상품 간 간격(빈 행)은 그대로 유지 — 세로 복붙 정렬용
        if (!barcode && !productName) {
          out.push({ spacer: true, barcode: '', productName: '', optionName: '', status: '', recQty: '', sPos: '', tPos: '', note: '', weeksStock: '', reason: '' });
          continue;
        }
        if (!barcode) continue; // 바코드 없는 비정상 행 제외
        const optionId = (c[1] || '').trim();
        const optionName = (c[4] || '').trim();
        const status = (c[5] || '').trim();
        const totalStock = safeNum(c[14]);          // O열 총재고
        const orderUnit = (c[17] || '').trim();      // R열 발주단위
        const sRaw = safeNum(c[18]);
        const tRaw = safeNum(c[19]);
        const sPos = sRaw < 0 ? Math.abs(sRaw) : ''; // S열: 음수(발주필요)만 양수화, 양수는 공백
        const tPos = tRaw < 0 ? Math.abs(tRaw) : ''; // T열: 음수(발주필요)만 양수화, 양수는 공백
        const wRaw = (c[22] || '').trim();           // W열 총재고 주치
        const weeksStock = (wRaw === '' || isNaN(Number(wRaw))) ? '' : Number(wRaw);

        let recQty = '';
        let reason = '';

        // 최종마감·품질확인서 등 판매중 아닌 대상은 발주추천 제외
        if (!shouldExclude(status)) {
          // 6주 판매 예측치 F
          let baseF = null;
          let method = '';
          if (optionId && appeared.has(optionId)) {
            const dailyVals = availKeys.map(k => itemsByKey[k].get(optionId) || 0);
            // 주간 판매 합 (음수=반품/보정은 0으로 정리)
            const weeklyVals = useBuckets.map(ks => Math.max(0, ks.reduce((s, k) => s + (itemsByKey[k].get(optionId) || 0), 0)));
            const down = computeTrend(dailyVals, 7).dir === 'down';
            const weighted = weightedCumForecast(weeklyVals);
            if (down && weeklyVals.length >= 3) {
              const holt = holtCumForecast(weeklyVals);
              // 우하향: Holt 예측이 평탄 가중평균을 넘지 못하게 캡 — 감소 상품 과발주 방지
              baseF = (holt == null) ? weighted : Math.min(holt, weighted);
              method = 'Holt';
            } else {
              baseF = weighted;
              method = '가중평균';
            }
          }

          if (baseF != null) {
            const mult = seasonMult(periodOf(optionId));
            const q = Math.ceil(baseF * mult - totalStock);
            if (q > 0) {
              recQty = q;
              // 사유는 추천발주량이 있는 행에만 표시
              const fRound = Math.round(baseF * 10) / 10;
              const adjRound = Math.round(baseF * mult * 10) / 10;
              const methodTxt = method === 'Holt'
                ? `우하향 추세·Holt ${HORIZON_WEEKS}주예측 ${fRound}`
                : `최근${HORIZON_WEEKS}주 가중평균·${HORIZON_WEEKS}주예측 ${fRound}`;
              let seasonTxt = '';
              if (mult === PEAK_MULT) seasonTxt = ` → 시즌피크 ×1.2 = ${adjRound}`;
              else if (mult === ENDING_MULT) seasonTxt = ` → 시즌종료 4주전 ×0.7 = ${adjRound}`;
              reason = `${methodTxt}${seasonTxt} − 재고 ${totalStock} = ${q}`;
            }
          }
        }

        // 비고
        const noteParts = [];
        if (orderUnit) noteParts.push(orderUnit);
        if (vocBarcodes.has(barcode)) noteParts.push('voc 확인');
        const note = noteParts.join(', ');

        out.push({ barcode, productName, optionName, status, recQty, sPos, tPos, note, weeksStock, reason });
      }

      setRows(out);
      setLastUpdated(new Date());
      if (availKeys.length === 0) setError('수요예측 일별 데이터가 없어 계산 발주량은 모두 공백입니다. (S/T 열은 시트값으로 표시)');
    } catch (e) {
      setError('데이터 로딩 실패: ' + (e?.message || e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const exportExcel = () => {
    const header = ['쿠팡바코드', '상품명', '옵션명', '상태', '추천 발주량', 'S열 발주필요', 'T열 발주필요', '비고', '재고주수(W)', '발주추천 사유'];
    const aoa = [header, ...rows.map(r => [r.barcode, r.productName, r.optionName, r.status, r.recQty, r.sPos, r.tPos, r.note, r.weeksStock, r.reason])];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 16 }, { wch: 28 }, { wch: 20 }, { wch: 10 }, { wch: 12 }, { wch: 12 }, { wch: 12 }, { wch: 22 }, { wch: 11 }, { wch: 48 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '발주추천');
    XLSX.writeFile(wb, `발주추천_${dateToKey(new Date())}.xlsx`);
  };

  const orderCount = rows.filter(r => r.recQty !== '' && r.recQty > 0).length;
  const productCount = rows.filter(r => r.barcode).length;

  return (
    <div className="card">
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } details.dd > summary::-webkit-details-marker { display: none; }`}</style>

      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, marginBottom: 16 }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <details className="dd" style={{ position: 'relative' }}>
            <summary style={{ cursor: 'pointer', listStyle: 'none', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: '1px solid #d2e8d8', background: '#fff', color: '#1e8e3e', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" />
              </svg>
              추천 발주량 계산 로직
            </summary>
            <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 20, width: 560, maxWidth: '88vw', maxHeight: '70vh', overflowY: 'auto', background: '#fff', border: '1px solid #e8eaed', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: '14px 16px', fontSize: 12.5, color: '#3c4043', lineHeight: 1.7 }}>
          <div style={{ marginBottom: 6 }}><b>① 데이터 매칭</b> — 재고계산기 시트의 각 상품을 <b>옵션ID</b>로 수요예측 일별 판매 데이터와 매칭합니다.</div>
          <div style={{ marginBottom: 6 }}><b>② 4주 판매 예측 (F)</b> — <b>오늘 기준 최근 7일/8~14일/15~21일/22~28일</b>로 묶어(진행 중인 최근 며칠도 항상 포함),
            우하향(감소) 추세 상품은 <b>Holt 선형추세 지수평활</b>로, 그 외는 <b>최근 4주 가중평균</b>(최근일수록 가중)으로 향후 4주 판매량을 예측합니다.
            (우하향 상품의 Holt 예측은 과발주 방지를 위해 가중평균을 넘지 않도록 캡)
            <div style={{ marginTop: 6, marginLeft: 14, padding: '8px 12px', background: '#fff', border: '1px solid #e8eaed', borderRadius: 8, color: '#5f6368', fontSize: 12 }}>
              <div style={{ marginBottom: 4 }}>• <b>최근 4주 가중평균</b> : 4주전→1주전에 <u>가중치 1 / 1.5 / 2.5 / 4</u>를 줘서 평균냅니다(최근 1주가 4주전의 4배).
                예) 4주 전부터 <code>10·20·30·40</code>개 팔렸으면 단순평균은 25지만, 이 가중이면 <b>약 31개</b> 쪽으로 계산 → 최근 흐름을 강하게 반영.</div>
              <div>• <b>Holt 선형추세 지수평활</b> : 판매가 꾸준히 줄고 있는(우하향) 상품에 쓰는 방식으로,
                현재 <u>판매 수준(level)</u>과 <u>주마다 늘거나 줄어드는 변화량(trend)</u> 두 가지를 함께 추정해서
                "<b>지금 추세대로 가면 4주 뒤엔 얼마나 팔릴까</b>"를 예측합니다. 감소세가 이어지면 예측치도 따라 낮아져 과발주를 막습니다.</div>
            </div></div>
          <div style={{ marginBottom: 6 }}><b>③ 시즌 보정</b> — 시즌 피크 기간 <b>×1.2</b>, 시즌 종료 4주 전 <b>×0.7</b>(종료 우선 적용), 상시 상품은 보정 없음.</div>
          <div style={{ marginBottom: 6 }}><b>④ 추천 발주량</b> = 올림( 예측 F × 시즌계수 − O열 총재고 ). 0 이하거나 예측 데이터 없으면 공백.</div>
          <div><b>⑤ 제외 대상</b> — 최종마감 · 품질확인서 · 마감대상 · 덤핑 상태 상품은 발주추천에서 제외됩니다. 사유는 추천 발주량이 있는 행에만 표시됩니다.</div>
        </div>
      </details>

          <details className="dd" style={{ position: 'relative' }}>
            <summary style={{ cursor: 'pointer', listStyle: 'none', userSelect: 'none', display: 'inline-flex', alignItems: 'center', gap: 6, padding: '9px 14px', borderRadius: 8, fontSize: 13, fontWeight: 600, border: '1px solid #d2e8d8', background: '#fff', color: '#1e8e3e', boxShadow: '0 1px 2px rgba(0,0,0,0.04)' }}>
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M9 11l3 3L22 4" /><path d="M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11" />
              </svg>
              Holt 계산 기준 & 계산법
            </summary>
            <div style={{ position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 20, width: 560, maxWidth: '88vw', maxHeight: '70vh', overflowY: 'auto', background: '#fff', border: '1px solid #e8eaed', borderRadius: 10, boxShadow: '0 4px 16px rgba(0,0,0,0.12)', padding: '14px 16px', fontSize: 12.5, color: '#3c4043', lineHeight: 1.7 }}>
          <div style={{ marginBottom: 10, padding: '8px 12px', background: '#f8faf9', border: '1px solid #e8eaed', borderRadius: 8 }}>
            <b>현재 계산 기준</b> — 레벨 평활계수 α = <b>{HOLT_ALPHA}</b>, 트렌드 평활계수 β = <b>{HOLT_BETA}</b>, 예측 기간 <b>{HORIZON_WEEKS}주</b>.
            적용 조건: <u>우하향 추세 + 완전한 7일 주 데이터 3주 이상</u>일 때만 Holt 사용(그 외 가중평균).
            주간 판매는 반품·보정으로 음수가 나오면 0으로 정리하고, 완전하지 않은(7일 미만) 마지막 주는 제외하며,
            최종 예측치는 <u>최근 4주 가중평균을 넘지 않도록 캡</u>합니다.
          </div>

          <div style={{ marginBottom: 6 }}><b>두 값이 뭘 추정하나</b></div>
          <div style={{ marginBottom: 4, marginLeft: 8 }}>• <b>레벨(level, L)</b> = 지금 현재의 판매 "수준" (이번 주 대략 몇 개 팔리는가)</div>
          <div style={{ marginBottom: 10, marginLeft: 8 }}>• <b>트렌드(trend, T)</b> = 주마다 늘거나 줄어드는 "변화량" (매주 몇 개씩 빠지는가)</div>

          <div style={{ marginBottom: 4 }}><b>α = {HOLT_ALPHA} (레벨 평활계수)</b> — 매주 새 판매량이 들어올 때 레벨을 이렇게 갱신합니다.</div>
          <div style={{ marginLeft: 8, marginBottom: 4, fontFamily: 'monospace', fontSize: 12, color: '#1a73e8' }}>새 레벨 = 0.3 × (이번 주 실제 판매) + 0.7 × (지난 주 예상치)</div>
          <div style={{ marginLeft: 8, marginBottom: 10, color: '#5f6368' }}>이번 주 실제값을 30%만 반영하고 과거 흐름을 70% 유지 → α가 작을수록(0.3) 한 주 튀는 값에 둔감하게 <b>부드럽게</b> 따라갑니다.</div>

          <div style={{ marginBottom: 4 }}><b>β = {HOLT_BETA} (트렌드 평활계수)</b> — 변화량(추세)을 이렇게 갱신합니다.</div>
          <div style={{ marginLeft: 8, marginBottom: 4, fontFamily: 'monospace', fontSize: 12, color: '#1a73e8' }}>새 트렌드 = 0.1 × (이번 주 레벨 − 지난 주 레벨) + 0.9 × (기존 트렌드)</div>
          <div style={{ marginLeft: 8, marginBottom: 10, color: '#5f6368' }}>새로 관측된 증감폭을 10%만 반영하고 기존 추세를 90% 유지 → β가 작을수록(0.1) 추세 방향이 <b>잘 안 흔들리고 안정적</b>입니다.</div>

          <div style={{ marginBottom: 4 }}><b>4주 예측</b> — 위로 구한 L, T로 미래를 직선 연장해 4주치를 더합니다.</div>
          <div style={{ marginLeft: 8, marginBottom: 10, fontFamily: 'monospace', fontSize: 12, color: '#1a73e8' }}>
            (L+1×T) + (L+2×T) + (L+3×T) + (L+4×T) = 향후 4주 예측 판매량
          </div>

          <div style={{ padding: '8px 12px', background: '#f8faf9', border: '1px solid #e8eaed', borderRadius: 8 }}>
            <b>숫자 예시</b> — 주간 판매가 <code>40 → 34 → 30 → 26</code>(매주 감소)이면 L ≈ 26, T ≈ −4(매주 4개씩 감소).
            4주 예측 = 22+18+14+10 = <b>약 64개</b>. 감소세가 그대로 반영돼 과발주를 막습니다.
            (α=0.3·β=0.1은 "최근 흐름은 따라가되 한 주 튐에는 둔감하게" 맞춘 보수적 세팅)
          </div>
            </div>
          </details>
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={load}
            disabled={loading}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              border: '1px solid #dadce0', background: '#fff', color: '#3c4043',
              cursor: loading ? 'not-allowed' : 'pointer', opacity: loading ? 0.6 : 1,
              transition: 'all 0.15s', boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
            }}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2"
              style={{ animation: loading ? 'spin 0.8s linear infinite' : 'none' }}>
              <path d="M23 4v6h-6M1 20v-6h6" />
              <path d="M3.51 9a9 9 0 0114.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0020.49 15" />
            </svg>
            {loading ? '계산 중…' : '새로고침'}
          </button>
          <button
            onClick={exportExcel}
            disabled={loading || rows.length === 0}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '9px 16px', borderRadius: 8, fontSize: 13, fontWeight: 600,
              border: 'none', background: '#1e8e3e', color: '#fff',
              cursor: (loading || rows.length === 0) ? 'not-allowed' : 'pointer',
              opacity: (loading || rows.length === 0) ? 0.5 : 1,
              transition: 'all 0.15s', boxShadow: '0 1px 3px rgba(30,142,62,0.3)',
            }}
          >
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
              <path d="M7 10l5 5 5-5M12 15V3" />
            </svg>
            엑셀 다운로드
          </button>
        </div>
      </div>

      {error &&<div style={{ background: '#fce8e6', color: '#c5221f', padding: '8px 12px', borderRadius: 6, marginBottom: 12, fontSize: 13 }}>{error}</div>}

      {rows.length > 0 && (
        <div style={{ fontSize: 13, color: '#5f6368', marginBottom: 10 }}>
          총 <b>{productCount}</b>개 품목 · 발주 필요 <b style={{ color: '#1e8e3e' }}>{orderCount}</b>개
          {dataDays > 0 && <> · 수요예측 데이터 {dataDays}일</>}
          {lastUpdated && <> · {lastUpdated.toLocaleTimeString('ko-KR')} 기준</>}
        </div>
      )}

      <div style={{ overflowX: 'auto', maxHeight: '70vh', overflowY: 'auto', border: '1px solid #e0e0e0', borderRadius: 6 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead style={{ position: 'sticky', top: 0, background: '#f8f9fa', zIndex: 1 }}>
            <tr>
              {['쿠팡바코드', '상품명', '옵션명', '상태', '추천 발주량', 'S열', 'T열', '비고', '재고주수', '발주추천 사유'].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: 'left', borderBottom: '2px solid #e0e0e0', whiteSpace: 'nowrap' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={idx} style={{ borderBottom: '1px solid #f0f0f0' }}>
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap', fontFamily: 'monospace' }}>{r.barcode}</td>
                <td style={{ padding: '6px 10px' }}>{r.productName}</td>
                <td style={{ padding: '6px 10px' }}>{r.optionName}</td>
                <td style={{ padding: '6px 10px', whiteSpace: 'nowrap' }}>{r.status}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right', fontWeight: r.recQty ? 700 : 400, color: r.recQty ? '#1e8e3e' : '#bbb' }}>{r.recQty}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right', color: '#5f6368' }}>{r.sPos || ''}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right', color: '#5f6368' }}>{r.tPos || ''}</td>
                <td style={{ padding: '6px 10px', color: '#c5221f' }}>{r.note}</td>
                <td style={{ padding: '6px 10px', textAlign: 'right', color: '#5f6368', whiteSpace: 'nowrap' }}>{r.weeksStock}</td>
                <td style={{ padding: '6px 10px', color: '#5f6368', fontSize: 12, minWidth: 320 }}>{r.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
