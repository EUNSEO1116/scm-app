import { useState, useMemo } from 'react';

// ─── 상수 ──────────────────────────────────────────────────────────────────
const COST_NORMAL = 8050;       // 일반택배 (카톤당)
const COST_MILKRUN_BOX = 6400;  // 밀크런 택배 (카톤당)
const COST_MILKRUN_PALLET = 66880; // 밀크런 파레트 (파레트당)
const CARTON_WEIGHT_LIMIT = 20; // kg, 20kg까지 OK
const PALLET_FLOOR = 110;       // cm (1100mm)
const PALLET_BASE = 15;         // cm (깔판 150mm)
const PALLET_TOTAL_H = 170;     // cm (1700mm)
const PALLET_STACK_H = PALLET_TOTAL_H - PALLET_BASE; // 155cm

function formatWon(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return Number(n).toLocaleString('ko-KR') + '원';
}

// 카톤(w×d×h)을 파레트에 최적 단일 방향으로 적재했을 때 최대 카톤 수
function cartonsPerPallet(w, d, h) {
  if (!(w > 0 && d > 0 && h > 0)) return 0;
  // 6방향: 어느 면을 위로 세울지(3) × 바닥 90° 회전(2)
  const orientations = [
    [w, d, h], [d, w, h], // h가 높이
    [w, h, d], [h, w, d], // d가 높이
    [d, h, w], [h, d, w], // w가 높이
  ];
  let best = 0;
  for (const [bw, bd, bh] of orientations) {
    const perLayer = Math.floor(PALLET_FLOOR / bw) * Math.floor(PALLET_FLOOR / bd);
    const layers = Math.floor(PALLET_STACK_H / bh);
    best = Math.max(best, perLayer * layers);
  }
  return best;
}

const initialForm = {
  prodW: '', prodD: '', prodH: '',
  cartonW: '', cartonD: '', cartonH: '',
  unitWeight: '',
  totalQty: '',
  perPalletInput: '', // 파레트당 카톤 수 직접 입력 (선택)
};

export default function FbcPalletCalculator() {
  const [form, setForm] = useState(initialForm);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const result = useMemo(() => {
    const cw = parseFloat(form.cartonW);
    const cd = parseFloat(form.cartonD);
    const ch = parseFloat(form.cartonH);
    const weight = parseFloat(form.unitWeight);
    const totalQty = parseInt(form.totalQty, 10);

    if (!(weight > 0) || !(totalQty > 0) || !(cw > 0 && cd > 0 && ch > 0)) {
      return null;
    }

    // 카톤당 개수 = 무게로 자동 계산 (20kg까지 OK)
    const qtyPerCarton = Math.floor(CARTON_WEIGHT_LIMIT / weight);
    if (qtyPerCarton < 1) {
      return { error: '제품 1개가 20kg을 초과합니다. 카톤에 담을 수 없습니다.' };
    }

    const cartonWeight = qtyPerCarton * weight;
    const cartonCount = Math.ceil(totalQty / qtyPerCarton);

    // 파레트당 카톤 수: 직접 입력값이 있으면 우선, 없으면 자동 추정값 사용
    const perPalletEstimate = cartonsPerPallet(cw, cd, ch);
    const inputPerPallet = parseInt(form.perPalletInput, 10);
    const perPalletUsed = inputPerPallet > 0 ? inputPerPallet : perPalletEstimate;
    const usingManual = inputPerPallet > 0;

    const palletCount = perPalletUsed > 0 ? Math.ceil(cartonCount / perPalletUsed) : null;

    const costNormal = cartonCount * COST_NORMAL;
    const costMilkBox = cartonCount * COST_MILKRUN_BOX;
    const costMilkPallet = palletCount !== null ? palletCount * COST_MILKRUN_PALLET : null;

    const options = [
      { key: 'normal', label: '일반택배', cost: costNormal, detail: `카톤 ${cartonCount}개 × ${formatWon(COST_NORMAL)}` },
      { key: 'milkBox', label: '밀크런 택배', cost: costMilkBox, detail: `카톤 ${cartonCount}개 × ${formatWon(COST_MILKRUN_BOX)}` },
      { key: 'milkPallet', label: '밀크런 파레트', cost: costMilkPallet,
        detail: palletCount !== null ? `파레트 ${palletCount}개 × ${formatWon(COST_MILKRUN_PALLET)}` : '파레트당 카톤 수를 알 수 없음 — 직접 입력 필요' },
    ];
    // 최저가 강조는 일반택배·밀크런파레트 둘 중에서만 (밀크런택배 제외)
    const cheapestPool = options.filter((o) => o.cost !== null && o.key !== 'milkBox');
    const cheapest = cheapestPool.length
      ? cheapestPool.reduce((a, b) => (b.cost < a.cost ? b : a), cheapestPool[0])
      : null;

    // 발주량 안내 (파레트 채움 기준)
    const notes = [];
    if (perPalletUsed > 0) {
      const unitsFor1Pallet = perPalletUsed * qtyPerCarton;
      if (cartonCount < perPalletUsed) {
        // 1파레트도 못 채움
        notes.push({
          type: 'warn',
          text: `현재 발주량으론 1파레트를 못 채웁니다 (카톤 ${cartonCount}/${perPalletUsed}개). `
            + `1파레트 = 제품 ${unitsFor1Pallet.toLocaleString()}개 → 총 ${unitsFor1Pallet.toLocaleString()}개 발주하면 1파레트가 채워집니다 `
            + `(지금보다 +${(unitsFor1Pallet - totalQty).toLocaleString()}개).`,
        });
      } else if (cartonCount % perPalletUsed !== 0) {
        // 마지막 파레트가 덜 참
        const nextFullCartons = Math.ceil(cartonCount / perPalletUsed) * perPalletUsed;
        const nextFullUnits = nextFullCartons * qtyPerCarton;
        notes.push({
          type: 'info',
          text: `마지막 파레트가 덜 찼습니다 (카톤 ${cartonCount}개 = 파레트 ${palletCount}개 중 일부 빈공간). `
            + `총 ${nextFullUnits.toLocaleString()}개 발주하면 파레트 ${palletCount}개를 꽉 채웁니다 `
            + `(지금보다 +${(nextFullUnits - totalQty).toLocaleString()}개).`,
        });
      }
    }

    return {
      qtyPerCarton, cartonWeight, cartonCount,
      perPalletEstimate, perPalletUsed, usingManual, palletCount,
      unitsFor1Pallet: perPalletUsed > 0 ? perPalletUsed * qtyPerCarton : null,
      options, cheapestKey: cheapest ? cheapest.key : null, notes,
    };
  }, [form]);

  const inputStyle = { width: '100%', padding: '8px 10px', border: '1px solid #d0d0d0', borderRadius: 6, fontSize: 14, boxSizing: 'border-box' };
  const labelStyle = { fontSize: 12, color: '#666', fontWeight: 500, marginBottom: 4, display: 'block' };
  const dimRow = { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 };

  return (
    <div className="card">
      <div className="card-header">
        <h2 style={{ fontSize: 15, fontWeight: 600 }}>📦 FBC 사전계산기</h2>
        <span style={{ fontSize: 12, color: '#666' }}>일반택배 · 밀크런택배 · 밀크런파레트 비용 비교</span>
      </div>
      <div className="card-body">
        {/* 입력 */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: 16, marginBottom: 20 }}>
          <div>
            <label style={labelStyle}>제품 1개 사이즈 (cm) · 참고용</label>
            <div style={dimRow}>
              <input style={inputStyle} type="number" placeholder="가로" value={form.prodW} onChange={set('prodW')} />
              <input style={inputStyle} type="number" placeholder="세로" value={form.prodD} onChange={set('prodD')} />
              <input style={inputStyle} type="number" placeholder="높이" value={form.prodH} onChange={set('prodH')} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>1카톤 사이즈 (cm) <span style={{ color: '#d9534f' }}>*</span></label>
            <div style={dimRow}>
              <input style={inputStyle} type="number" placeholder="가로" value={form.cartonW} onChange={set('cartonW')} />
              <input style={inputStyle} type="number" placeholder="세로" value={form.cartonD} onChange={set('cartonD')} />
              <input style={inputStyle} type="number" placeholder="높이" value={form.cartonH} onChange={set('cartonH')} />
            </div>
          </div>
          <div>
            <label style={labelStyle}>제품 1개당 무게 (kg) <span style={{ color: '#d9534f' }}>*</span></label>
            <input style={inputStyle} type="number" placeholder="예: 4" value={form.unitWeight} onChange={set('unitWeight')} />
          </div>
          <div>
            <label style={labelStyle}>총 발주 수량 (개) <span style={{ color: '#d9534f' }}>*</span></label>
            <input style={inputStyle} type="number" placeholder="예: 1000" value={form.totalQty} onChange={set('totalQty')} />
          </div>
          <div>
            <label style={labelStyle}>파레트당 카톤 수 (직접 입력 · 선택)</label>
            <input style={inputStyle} type="number" placeholder="비우면 자동 추정값 사용" value={form.perPalletInput} onChange={set('perPalletInput')} />
          </div>
        </div>

        {/* 결과 */}
        {result && result.error && (
          <div style={{ padding: 16, background: '#fdecea', color: '#d9534f', borderRadius: 8, fontSize: 14 }}>
            {result.error}
          </div>
        )}

        {result && !result.error && (
          <>
            <div className="summary-grid" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 12, marginBottom: 20 }}>
              <div className="summary-item" style={{ background: '#f7f7f8', borderRadius: 10, padding: '14px 16px', border: '1px solid #ececef' }}>
                <span style={{ fontSize: 12, color: '#666' }}>카톤당 개수 (20kg 기준)</span>
                <span style={{ fontSize: 22, fontWeight: 700, display: 'block' }}>{result.qtyPerCarton.toLocaleString()}</span>
                <span style={{ fontSize: 11, color: '#888' }}>≈ {result.cartonWeight.toFixed(1)}kg / 카톤</span>
              </div>
              <div className="summary-item" style={{ background: '#f7f7f8', borderRadius: 10, padding: '14px 16px', border: '1px solid #ececef' }}>
                <span style={{ fontSize: 12, color: '#666' }}>총 카톤 수</span>
                <span style={{ fontSize: 22, fontWeight: 700, display: 'block' }}>{result.cartonCount.toLocaleString()}</span>
                <span style={{ fontSize: 11, color: '#888' }}>카톤</span>
              </div>
              <div className="summary-item" style={{ background: '#f7f7f8', borderRadius: 10, padding: '14px 16px', border: '1px solid #ececef' }}>
                <span style={{ fontSize: 12, color: '#666' }}>파레트당 카톤 {result.usingManual ? '(직접 입력)' : '(자동 추정)'}</span>
                <span style={{ fontSize: 22, fontWeight: 700, display: 'block' }}>{result.perPalletUsed > 0 ? result.perPalletUsed.toLocaleString() : '-'}</span>
                <span style={{ fontSize: 11, color: '#888' }}>
                  {result.usingManual
                    ? `자동 추정값: ${result.perPalletEstimate}개`
                    : '110×110×155cm 기준 · 직접 입력 가능'}
                </span>
              </div>
              <div className="summary-item" style={{ background: '#f7f7f8', borderRadius: 10, padding: '14px 16px', border: '1px solid #ececef' }}>
                <span style={{ fontSize: 12, color: '#666' }}>총 파레트 수</span>
                <span style={{ fontSize: 22, fontWeight: 700, display: 'block' }}>{result.palletCount !== null ? result.palletCount.toLocaleString() : '-'}</span>
                <span style={{ fontSize: 11, color: '#888' }}>파레트</span>
              </div>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
              {result.options.map((o) => {
                const isCheapest = o.key === result.cheapestKey && o.cost !== null;
                return (
                  <div key={o.key} style={{
                    border: isCheapest ? '2px solid #2e7d32' : '1px solid #e0e0e0',
                    background: isCheapest ? '#edf7ee' : '#fff',
                    borderRadius: 12, padding: 18, position: 'relative',
                  }}>
                    {isCheapest && (
                      <span style={{ position: 'absolute', top: 12, right: 12, fontSize: 11, fontWeight: 700, color: '#2e7d32', background: '#e8f5e9', padding: '2px 8px', borderRadius: 99 }}>최저가</span>
                    )}
                    <div style={{ fontSize: 13, color: '#666', fontWeight: 600, marginBottom: 8 }}>{o.label}</div>
                    <div style={{ fontSize: 26, fontWeight: 700, color: o.cost === null ? '#bbb' : (isCheapest ? '#2e7d32' : '#222') }}>
                      {formatWon(o.cost)}
                    </div>
                    <div style={{ fontSize: 12, color: '#888', marginTop: 6 }}>{o.detail}</div>
                  </div>
                );
              })}
            </div>

            {/* 발주량 / 파레트 채움 안내 */}
            {result.unitsFor1Pallet !== null && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontSize: 13, color: '#444', marginBottom: 8 }}>
                  🧮 1파레트 = 제품 <b>{result.unitsFor1Pallet.toLocaleString()}개</b>
                  <span style={{ color: '#888' }}> (파레트당 카톤 {result.perPalletUsed}개 × 카톤당 {result.qtyPerCarton}개)</span>
                </div>
                {result.notes.map((n, i) => (
                  <div key={i} style={{
                    padding: '10px 14px', borderRadius: 8, fontSize: 13, marginTop: 6,
                    background: n.type === 'warn' ? '#fff4e5' : '#eef4ff',
                    color: n.type === 'warn' ? '#a15c00' : '#2b5dad',
                    border: `1px solid ${n.type === 'warn' ? '#ffd8a8' : '#cfe0ff'}`,
                  }}>
                    {n.type === 'warn' ? '⚠️ ' : 'ℹ️ '}{n.text}
                  </div>
                ))}
              </div>
            )}
          </>
        )}

        {!result && (
          <p style={{ color: '#999', fontSize: 13 }}>카톤 사이즈 · 제품 무게 · 총 발주 수량을 입력하면 비용이 계산됩니다.</p>
        )}
      </div>
    </div>
  );
}
