import { useState, useRef, useCallback, useEffect } from 'react';
import * as XLSX from 'xlsx';
import { dbStoreGet, dbStoreSet } from '../utils/dbApi';
import './FbcCalculator.css';

// ─── Constants ───────────────────────────────────────────────────────────────
const DELIVERY_COST_PER_BOX = 5000;
const PALLET_WORK_COST = 35000;
const MILKRUN_COSTS = { 1: 25800, 2: 51600, 3: 73530, 4: 91460 };
const TRUCKS = [
  { id: 'truck1t',  name: '1톤',      maxCbm: 6,  cost: 60000 },
  { id: 'truck14t', name: '1.4톤',    maxCbm: 7,  cost: 70000 },
  { id: 'truck25t', name: '2.5톤',    maxCbm: 12, cost: 100000 },
  { id: 'truck35t', name: '3.5톤',    maxCbm: 13, cost: 130000 },
  { id: 'truck35l', name: '3.5톤 장축', maxCbm: 15, cost: 150000 },
];
const DEFAULT_PALLET_SIZES = [
  { size: '60.0*50.0*40.0', boxesPerPallet: 12 },
  { size: '57.0*45.0*37.0', boxesPerPallet: 16 },
  { size: '50.0*40.0*30.0', boxesPerPallet: 16 },
  { size: '40.0*30.0*30.0', boxesPerPallet: 22 },
  { size: '72.0*55.0*30.0', boxesPerPallet: 12 },
  { size: '62.0*32.0*47.0', boxesPerPallet: 12 },
];
const COLOR_NAMES = {
  'FFFF00': '노란색', 'FF0000': '빨간색', '0000FF': '파란색',
  '00FF00': '초록색', '00B050': '초록색', '92D050': '연두색',
  'FFC000': '주황색', 'FF00FF': '보라색', '00B0F0': '하늘색',
  'FFFF99': '연노랑', 'BDD7EE': '연파랑', 'C6EFCE': '연초록',
  'F8CBAD': '연분홍', 'D9E2F3': '연보라',
};

// ─── Utility functions ────────────────────────────────────────────────────────
function formatWon(n) {
  if (n === null || n === undefined || isNaN(n)) return '-';
  return Number(n).toLocaleString('ko-KR') + '원';
}

function selectTruck(cbm, trucks) {
  const sorted = [...trucks].sort((a, b) => a.maxCbm - b.maxCbm);
  const fit = sorted.find(t => cbm <= t.maxCbm);
  if (fit) return { truck: fit, count: 1 };
  const largest = sorted[sorted.length - 1];
  const count = Math.ceil(cbm / largest.maxCbm);
  return { truck: largest, count };
}

function calcMilkrun(pallets) {
  if (pallets <= 4) return MILKRUN_COSTS[pallets] || 0;
  const rate = MILKRUN_COSTS[4] / 4;
  return Math.round(rate * pallets);
}

function getCellColor(sheet, row, col) {
  const cellAddr = XLSX.utils.encode_cell({ r: row, c: col });
  const cell = sheet[cellAddr];
  if (!cell) return null;
  const fgColor =
    cell.s?.fill?.fgColor?.rgb ||
    cell.s?.fill?.patternFill?.fgColor?.rgb ||
    null;
  return fgColor || null;
}

function parseDateFromFilename(name) {
  const m = name.match(/[A-Z]{2}(\d{6})/);
  if (!m) return null;
  const raw = m[1];
  const yy = parseInt(raw.slice(0, 2), 10);
  const mm = parseInt(raw.slice(2, 4), 10);
  const dd = parseInt(raw.slice(4, 6), 10);
  const year = yy + 2000;
  return new Date(year, mm - 1, dd);
}

// ─── Excel parsing ────────────────────────────────────────────────────────────
function parseWorkbook(buffer, existingPalletSizes) {
  const wb = XLSX.read(buffer, { type: 'array', cellStyles: true });
  const bundles = {};
  const newSizes = new Set(existingPalletSizes.map(p => p.size));
  const additionalSizes = [];

  for (const sheetName of wb.SheetNames) {
    const sheet = wb.Sheets[sheetName];
    if (!sheet || !sheet['!ref']) continue;

    const range = XLSX.utils.decode_range(sheet['!ref']);
    let headerRow = -1;

    // Find header row by scanning first 5 rows for "상자" or "번호"
    for (let r = range.s.r; r <= Math.min(range.s.r + 4, range.e.r); r++) {
      for (let c = range.s.c; c <= range.e.c; c++) {
        const cell = sheet[XLSX.utils.encode_cell({ r, c })];
        const val = cell?.v?.toString() || '';
        if (val.includes('상자') || val.includes('번호')) {
          headerRow = r;
          break;
        }
      }
      if (headerRow !== -1) break;
    }

    if (headerRow === -1) continue;

    const boxes = [];
    const products = {};
    let totalBoxes = 0;
    let totalCbm = 0;
    let totalQty = 0;
    const colorGroups = {};
    const palletsByColor = {};

    for (let r = headerRow + 1; r <= range.e.r; r++) {
      const getCell = (c) => sheet[XLSX.utils.encode_cell({ r, c })];
      const boxNo = getCell(0)?.v;
      if (!boxNo && boxNo !== 0) continue;

      const sku = getCell(2)?.v?.toString()?.trim() || '';
      const productName = getCell(3)?.v?.toString()?.trim() || '';
      const qty = Number(getCell(4)?.v) || 0;
      const sizeRaw = getCell(5)?.v?.toString()?.trim() || '';
      const cbm = Number(getCell(6)?.v) || 0;

      // Normalize size string
      const size = sizeRaw.replace(/\s+/g, '');

      const color = getCellColor(sheet, r, 0) ||
                    getCellColor(sheet, r, 2) ||
                    getCellColor(sheet, r, 3);

      const boxEntry = { boxNo, sku, productName, qty, size, cbm, color };
      boxes.push(boxEntry);
      totalBoxes++;
      totalCbm += cbm;
      totalQty += qty;

      if (sku) {
        if (!products[sku]) {
          products[sku] = { sku, productName, totalQty: 0, boxCount: 0 };
        }
        products[sku].totalQty += qty;
        products[sku].boxCount++;
      }

      if (color) {
        if (!colorGroups[color]) colorGroups[color] = 0;
        colorGroups[color]++;
      }

      if (size && !newSizes.has(size)) {
        newSizes.add(size);
        additionalSizes.push({ size, boxesPerPallet: 12 });
      }
    }

    // Build pallets by color
    for (const [color, count] of Object.entries(colorGroups)) {
      palletsByColor[color] = count;
    }

    bundles[sheetName] = {
      boxes,
      products,
      totalBoxes,
      totalCbm: Math.round(totalCbm * 1000) / 1000,
      totalQty,
      colorGroups,
      palletsByColor,
    };
  }

  return { bundles, additionalSizes };
}

// ─── Cost calculation ─────────────────────────────────────────────────────────
function calcCosts(bundle, palletSizes, trucks) {
  const { boxes, totalBoxes, totalCbm, colorGroups } = bundle;

  // Normal cost
  const { truck, count: truckCount } = selectTruck(totalCbm, trucks);
  const truckCost = truck.cost * truckCount;
  const deliveryCost = totalBoxes * DELIVERY_COST_PER_BOX;
  const normalTotal = truckCost + deliveryCost;
  const normalDetail = {
    truckCost,
    truckName: truckCount > 1 ? `${truck.name} x${truckCount}` : truck.name,
    deliveryCost,
    total: normalTotal,
    cbm: totalCbm,
  };

  // FBC cost
  let totalPallets = 0;
  let palletDetails = [];

  const hasColors = Object.keys(colorGroups).length > 0;
  if (hasColors) {
    totalPallets = Object.keys(colorGroups).length;
    palletDetails = Object.entries(colorGroups).map(([color, count]) => ({
      key: COLOR_NAMES[color] || color,
      boxes: count,
      pallets: 1,
    }));
  } else {
    // Group boxes by size, count pallets
    const bySize = {};
    for (const box of boxes) {
      if (!box.size) continue;
      if (!bySize[box.size]) bySize[box.size] = 0;
      bySize[box.size]++;
    }

    for (const [size, boxCount] of Object.entries(bySize)) {
      const cfg = palletSizes.find(p => p.size === size);
      const perPallet = cfg ? cfg.boxesPerPallet : 12;
      const pallets = Math.ceil(boxCount / perPallet);
      totalPallets += pallets;
      palletDetails.push({ key: size, boxes: boxCount, pallets });
    }
  }

  const milkrunCost = calcMilkrun(totalPallets);
  const palletWorkCost = totalPallets * PALLET_WORK_COST;
  const fbcTotal = milkrunCost + palletWorkCost;
  const fbcDetail = {
    milkrunCost,
    palletWorkCost,
    totalPallets,
    palletDetails,
    total: fbcTotal,
  };

  return {
    normal: normalDetail,
    fbc: fbcDetail,
    diff: normalTotal - fbcTotal,
  };
}

// ─── Component ────────────────────────────────────────────────────────────────
export default function FbcCalculator() {
  const [fileName, setFileName] = useState('');
  const [bundles, setBundles] = useState({});
  const [activeBundle, setActiveBundle] = useState('');
  const [palletSizes, setPalletSizes] = useState(DEFAULT_PALLET_SIZES);
  const [trucks, setTrucks] = useState(TRUCKS);
  const [results, setResults] = useState(null);
  const [selectedResult, setSelectedResult] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const fileRef = useRef(null);

  // DB에서 기존 기록 로드 → localStorage 동기화 (덮어쓰기 방지)
  useEffect(() => {
    dbStoreGet('fbc_savings').then(data => {
      if (data && Array.isArray(data) && data.length > 0) {
        const local = JSON.parse(localStorage.getItem('fbc_savings_history') || '[]');
        if (local.length < data.length) {
          localStorage.setItem('fbc_savings_history', JSON.stringify(data));
        }
      }
    }).catch(() => {});
  }, []);

  const processFile = useCallback(async (file) => {
    if (!file) return;
    setFileName(file.name);
    try {
      const buffer = await file.arrayBuffer();
      const { bundles: parsed, additionalSizes } = parseWorkbook(new Uint8Array(buffer), palletSizes);

      if (additionalSizes.length > 0) {
        setPalletSizes(prev => [...prev, ...additionalSizes]);
      }

      setBundles(parsed);
      const firstKey = Object.keys(parsed)[0] || '';
      setActiveBundle(firstKey);
      setResults(null);
    } catch (err) {
      alert('파일 처리 중 오류: ' + err.message);
    }
  }, [palletSizes]);

  const handleFileChange = (e) => processFile(e.target.files?.[0]);
  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    processFile(e.dataTransfer.files?.[0]);
  };
  const handleDragOver = (e) => { e.preventDefault(); setIsDragOver(true); };
  const handleDragLeave = () => setIsDragOver(false);

  const handleCalculate = () => {
    const computed = {};
    let totalNormal = 0, totalFbc = 0;
    let combinedBoxes = 0, combinedCbm = 0;

    for (const [name, bundle] of Object.entries(bundles)) {
      const result = calcCosts(bundle, palletSizes, trucks);
      computed[name] = {
        bundleName: name,
        totalBoxes: bundle.totalBoxes,
        totalCbm: bundle.totalCbm,
        ...result,
      };
      totalNormal += result.normal.total;
      totalFbc += result.fbc.total;
      combinedBoxes += bundle.totalBoxes;
      combinedCbm += bundle.totalCbm;
    }

    const keys = Object.keys(computed);
    if (keys.length > 1) {
      computed['__total__'] = {
        bundleName: '전체 합계',
        totalBoxes: combinedBoxes,
        totalCbm: Math.round(combinedCbm * 1000) / 1000,
        normal: { total: totalNormal },
        fbc: { total: totalFbc },
        diff: totalNormal - totalFbc,
        isTotal: true,
      };
    }

    setResults(computed);
    const firstKey = keys[0] || '';
    setSelectedResult(firstKey);

    // Save to localStorage
    const date = parseDateFromFilename(fileName);
    const dateStr = date
      ? date.toLocaleDateString('ko-KR')
      : new Date().toLocaleDateString('ko-KR');

    const history = JSON.parse(localStorage.getItem('fbc_savings_history') || '[]');
    for (const [name, r] of Object.entries(computed)) {
      if (r.isTotal) continue;
      history.push({
        id: Date.now() + '_' + name,
        date: dateStr,
        fileName,
        bundleName: name,
        totalBoxes: r.totalBoxes,
        totalCbm: r.totalCbm,
        normalTotal: r.normal.total,
        fbcTotal: r.fbc.total,
        savings: r.diff,
        detail: { normal: r.normal, fbc: r.fbc, diff: r.diff },
      });
    }
    localStorage.setItem('fbc_savings_history', JSON.stringify(history));
    dbStoreSet('fbc_savings', history).catch(() => {});
  };

  const updateTruckCost = (id, newCost) => {
    setTrucks(prev => prev.map(t => t.id === id ? { ...t, cost: Number(newCost) || t.cost } : t));
  };

  const updatePalletBpp = (idx, val) => {
    setPalletSizes(prev => prev.map((p, i) => i === idx ? { ...p, boxesPerPallet: Number(val) || p.boxesPerPallet } : p));
  };

  const updatePalletSize = (idx, val) => {
    setPalletSizes(prev => prev.map((p, i) => i === idx ? { ...p, size: val } : p));
  };

  const removePalletRow = (idx) => {
    setPalletSizes(prev => prev.filter((_, i) => i !== idx));
  };

  const addPalletRow = () => {
    setPalletSizes(prev => [...prev, { size: '', boxesPerPallet: 12 }]);
  };

  const bundleKeys = Object.keys(bundles);
  const currentBundle = bundles[activeBundle];
  const resultKeys = results ? Object.keys(results) : [];
  const currentResult = results?.[selectedResult];

  return (
    <div>
      {/* ① 서류 업로드 */}
      <div className="fbc-section">
        <div className="fbc-section-header">
          <h2>① 서류 업로드</h2>
        </div>
        <div className="fbc-section-body">
          <div
            className={`upload-area${isDragOver ? ' dragover' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <span className="upload-icon">📦</span>
            <h3>FBC 발송 서류를 업로드하세요</h3>
            <p>xlsx 파일을 드래그하거나 클릭하여 선택</p>
            <p>각 시트가 하나의 묶음(Bundle)으로 처리됩니다</p>
            {fileName && (
              <div className="upload-filename">
                ✅ {fileName}
              </div>
            )}
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls"
              onChange={handleFileChange}
              style={{ display: 'none' }}
            />
          </div>
        </div>
      </div>

      {/* ② 서류 분석 결과 */}
      {bundleKeys.length > 0 && (
        <div className="fbc-section">
          <div className="fbc-section-header">
            <h2>② 서류 분석 결과</h2>
            <span className="tag">{bundleKeys.length}개 묶음</span>
          </div>
          <div className="fbc-section-body">
            <div className="bundle-tabs">
              {bundleKeys.map(key => (
                <button
                  key={key}
                  className={`bundle-tab${activeBundle === key ? ' active' : ''}`}
                  onClick={() => setActiveBundle(key)}
                >
                  {key}
                </button>
              ))}
            </div>

            {currentBundle && (
              <>
                <div className="summary-grid">
                  <div className="summary-item">
                    <span className="s-label">총 박스 수</span>
                    <span className="s-value">{currentBundle.totalBoxes.toLocaleString()}</span>
                    <span className="s-sub">박스</span>
                  </div>
                  <div className="summary-item">
                    <span className="s-label">총 CBM</span>
                    <span className="s-value">{currentBundle.totalCbm.toFixed(2)}</span>
                    <span className="s-sub">㎥</span>
                  </div>
                  <div className="summary-item">
                    <span className="s-label">총 수량</span>
                    <span className="s-value">{currentBundle.totalQty.toLocaleString()}</span>
                    <span className="s-sub">개</span>
                  </div>
                  <div className="summary-item">
                    <span className="s-label">상품 종류</span>
                    <span className="s-value">{Object.keys(currentBundle.products).length.toLocaleString()}</span>
                    <span className="s-sub">SKU</span>
                  </div>
                  <div className="summary-item">
                    <span className="s-label">색상 그룹</span>
                    <span className="s-value">{Object.keys(currentBundle.colorGroups).length}</span>
                    <span className="s-sub">{Object.keys(currentBundle.colorGroups).length > 0 ? '그룹 감지됨' : '미감지'}</span>
                  </div>
                </div>

                {Object.keys(currentBundle.colorGroups).length > 0 && (
                  <div className="color-legend">
                    <div className="color-legend-title">색상 파레트 그룹 감지됨 - 색상별 1파레트로 계산</div>
                    {Object.entries(currentBundle.colorGroups).map(([color, count]) => (
                      <span key={color} className="color-chip">
                        <span className="chip-dot" style={{ backgroundColor: '#' + color }} />
                        {COLOR_NAMES[color] || color} ({count}박스)
                      </span>
                    ))}
                  </div>
                )}

                <div className="table-wrapper" style={{ maxHeight: 320, overflowY: 'auto' }}>
                  <table className="product-table">
                    <thead>
                      <tr>
                        <th>SKU</th>
                        <th>상품명</th>
                        <th className="num">수량</th>
                        <th className="num">박스 수</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.values(currentBundle.products).map(p => (
                        <tr key={p.sku}>
                          <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{p.sku}</td>
                          <td>{p.productName}</td>
                          <td className="num">{p.totalQty.toLocaleString()}</td>
                          <td className="num">{p.boxCount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* ③ 비용 단가 설정 */}
      {bundleKeys.length > 0 && (
        <div className="fbc-section">
          <div className="fbc-section-header">
            <h2>③ 비용 단가 설정</h2>
          </div>
          <div className="fbc-section-body">
            <div className="cost-section">
              <div className="cost-section-title">차량 비용</div>
              <div className="table-wrapper">
                <table className="pallet-table">
                  <thead>
                    <tr>
                      <th>차량</th>
                      <th>최대 CBM</th>
                      <th className="num">비용 (원)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {trucks.map(t => (
                      <tr key={t.id}>
                        <td>{t.name}</td>
                        <td>{t.maxCbm} ㎥</td>
                        <td className="num">
                          <input
                            className="editable-input"
                            type="number"
                            value={t.cost}
                            onChange={e => updateTruckCost(t.id, e.target.value)}
                            style={{ maxWidth: 100 }}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="fbc-divider" />

            <div className="cost-section">
              <div className="cost-section-title">밀크런 기준 비용 (참고)</div>
              <div className="table-wrapper">
                <table className="pallet-table">
                  <thead>
                    <tr>
                      <th>파레트 수</th>
                      <th className="num">밀크런 비용</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(MILKRUN_COSTS).map(([pal, cost]) => (
                      <tr key={pal}>
                        <td>{pal}파레트</td>
                        <td className="num">{formatWon(cost)}</td>
                      </tr>
                    ))}
                    <tr>
                      <td>5파레트 이상</td>
                      <td className="num">{formatWon(MILKRUN_COSTS[4])} / 4 × 파레트 수</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            <div className="fbc-divider" />

            <div className="section-note">
              박스당 배송비: {formatWon(DELIVERY_COST_PER_BOX)} &nbsp;|&nbsp; 파레트 작업비: {formatWon(PALLET_WORK_COST)}/파레트
            </div>
          </div>
        </div>
      )}

      {/* ④ 박스 크기별 파레트 적재 설정 */}
      {bundleKeys.length > 0 && (
        <div className="fbc-section">
          <div className="fbc-section-header">
            <h2>④ 박스 크기별 파레트 적재 설정</h2>
          </div>
          <div className="fbc-section-body">
            <div className="section-note">
              색상 그룹이 감지되지 않은 경우, 박스 크기별 파레트 수를 계산에 사용합니다.
            </div>
            <div className="table-wrapper">
              <table className="pallet-table">
                <thead>
                  <tr>
                    <th>박스 크기 (mm)</th>
                    <th className="num">박스/파레트</th>
                    <th>삭제</th>
                  </tr>
                </thead>
                <tbody>
                  {palletSizes.map((p, i) => (
                    <tr key={i}>
                      <td>
                        <input
                          className="editable-input"
                          style={{ textAlign: 'left' }}
                          value={p.size}
                          onChange={e => updatePalletSize(i, e.target.value)}
                        />
                      </td>
                      <td className="num">
                        <input
                          className="editable-input"
                          type="number"
                          value={p.boxesPerPallet}
                          onChange={e => updatePalletBpp(i, e.target.value)}
                          style={{ maxWidth: 80 }}
                        />
                      </td>
                      <td>
                        <button className="remove-btn" onClick={() => removePalletRow(i)}>삭제</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <button className="add-row-btn" onClick={addPalletRow}>+ 크기 추가</button>
          </div>
        </div>
      )}

      {/* Calculate button */}
      {bundleKeys.length > 0 && (
        <button className="calc-btn" onClick={handleCalculate}>
          💰 비용 비교 계산
        </button>
      )}

      {/* ⑤ 비용 비교 결과 */}
      {results && (
        <div className="fbc-section">
          <div className="fbc-section-header">
            <h2>⑤ 비용 비교 결과</h2>
          </div>
          <div className="fbc-section-body">
            <div className="bundle-tabs">
              {resultKeys.map(key => (
                <button
                  key={key}
                  className={`bundle-tab${selectedResult === key ? ' active' : ''}`}
                  onClick={() => setSelectedResult(key)}
                >
                  {key === '__total__' ? '전체 합계' : key}
                </button>
              ))}
            </div>

            {currentResult && !currentResult.isTotal && (
              <>
                {/* Savings banner */}
                <div className={`savings-banner ${currentResult.diff >= 0 ? 'fbc-wins' : 'normal-wins'}`}>
                  <div>
                    <div className="banner-label">
                      {currentResult.diff >= 0 ? '✅ FBC가 더 저렴합니다' : '⚠️ 일반배송이 더 저렴합니다'}
                    </div>
                    <div className="banner-amount">
                      {currentResult.diff >= 0 ? '절감 ' : '추가 '}{formatWon(Math.abs(currentResult.diff))}
                    </div>
                    {currentResult.normal.total > 0 && (
                      <div className="banner-pct">
                        {Math.abs(Math.round(currentResult.diff / currentResult.normal.total * 100))}% 차이
                      </div>
                    )}
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 13, color: '#5f6368' }}>박스 {currentResult.totalBoxes}개 / CBM {currentResult.totalCbm?.toFixed(2)} ㎥</div>
                  </div>
                </div>

                {/* Cost cards */}
                <div className="result-container">
                  <div className={`result-card${currentResult.diff < 0 ? ' winner' : ''}`}>
                    <div className="result-card-header normal-header">
                      <span className="result-card-title">일반 배송</span>
                      {currentResult.diff < 0 && <span className="winner-badge">✓ 절약</span>}
                    </div>
                    <div className="result-card-body">
                      <div className="cost-row">
                        <span className="cost-label">차량 ({currentResult.normal.truckName})</span>
                        <span className="cost-value">{formatWon(currentResult.normal.truckCost)}</span>
                      </div>
                      <div className="cost-row">
                        <span className="cost-label">배송비 ({currentResult.totalBoxes}박스 × {formatWon(DELIVERY_COST_PER_BOX)})</span>
                        <span className="cost-value">{formatWon(currentResult.normal.deliveryCost)}</span>
                      </div>
                      <div className="cost-row total-row">
                        <span className="cost-label">합계</span>
                        <span className="cost-value">{formatWon(currentResult.normal.total)}</span>
                      </div>
                    </div>
                  </div>

                  <div className={`result-card${currentResult.diff >= 0 ? ' winner' : ''}`}>
                    <div className="result-card-header fbc-header">
                      <span className="result-card-title">FBC 배송</span>
                      {currentResult.diff >= 0 && <span className="winner-badge">✓ 절약</span>}
                    </div>
                    <div className="result-card-body">
                      <div className="cost-row">
                        <span className="cost-label">밀크런 ({currentResult.fbc.totalPallets}파레트)</span>
                        <span className="cost-value">{formatWon(currentResult.fbc.milkrunCost)}</span>
                      </div>
                      <div className="cost-row">
                        <span className="cost-label">파레트 작업비 ({currentResult.fbc.totalPallets} × {formatWon(PALLET_WORK_COST)})</span>
                        <span className="cost-value">{formatWon(currentResult.fbc.palletWorkCost)}</span>
                      </div>
                      <div className="cost-row total-row">
                        <span className="cost-label">합계</span>
                        <span className="cost-value">{formatWon(currentResult.fbc.total)}</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Pallet detail */}
                {currentResult.fbc.palletDetails?.length > 0 && (
                  <div>
                    <div className="cost-section-title" style={{ marginBottom: 8 }}>파레트 상세</div>
                    <div className="table-wrapper">
                      <table className="pallet-detail-table">
                        <thead>
                          <tr>
                            <th>구분</th>
                            <th className="num">박스 수</th>
                            <th className="num">파레트 수</th>
                          </tr>
                        </thead>
                        <tbody>
                          {currentResult.fbc.palletDetails.map((d, i) => (
                            <tr key={i}>
                              <td>{d.key}</td>
                              <td className="num">{d.boxes}</td>
                              <td className="num">{d.pallets}</td>
                            </tr>
                          ))}
                          <tr style={{ fontWeight: 700, borderTop: '2px solid #e0e0e0' }}>
                            <td>합계</td>
                            <td className="num">{currentResult.fbc.palletDetails.reduce((s, d) => s + d.boxes, 0)}</td>
                            <td className="num">{currentResult.fbc.totalPallets}</td>
                          </tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </>
            )}

            {currentResult?.isTotal && (
              <div className={`savings-banner ${currentResult.diff >= 0 ? 'fbc-wins' : 'normal-wins'}`}>
                <div>
                  <div className="banner-label">전체 합계</div>
                  <div style={{ display: 'flex', gap: 32, marginTop: 8 }}>
                    <div>
                      <div style={{ fontSize: 12, color: '#5f6368' }}>일반 배송 합계</div>
                      <div style={{ fontSize: 20, fontWeight: 700 }}>{formatWon(currentResult.normal.total)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: '#5f6368' }}>FBC 배송 합계</div>
                      <div style={{ fontSize: 20, fontWeight: 700 }}>{formatWon(currentResult.fbc.total)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 12, color: '#5f6368' }}>{currentResult.diff >= 0 ? '총 절감액' : '추가 비용'}</div>
                      <div className="banner-amount">{formatWon(Math.abs(currentResult.diff))}</div>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
