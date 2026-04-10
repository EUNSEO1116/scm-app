// Vultr DB API 연동 (Vercel 프록시 경유)
const API_BASE = '/api/proxy';

// ===== 품절 사유 =====
export async function dbSaveReasons(items) {
  try {
    const res = await fetch(`${API_BASE}/soldout/reasons`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    return (await res.json()).ok;
  } catch (e) {
    console.error('DB saveReasons error:', e);
    return false;
  }
}

export async function dbGetReasons() {
  try {
    const res = await fetch(`${API_BASE}/soldout/reasons`);
    return await res.json(); // { reasons, history }
  } catch (e) {
    console.error('DB getReasons error:', e);
    return { reasons: {}, history: {} };
  }
}

export async function dbDeleteReason(barcode) {
  try {
    const res = await fetch(`${API_BASE}/soldout/reasons/${encodeURIComponent(barcode)}`, {
      method: 'DELETE',
    });
    return (await res.json()).ok;
  } catch (e) {
    console.error('DB deleteReason error:', e);
    return false;
  }
}

// ===== 주의 품목 =====
export async function dbAddCaution(barcode, productName, optionName) {
  try {
    const res = await fetch(`${API_BASE}/caution`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ barcode, productName, optionName }),
    });
    return (await res.json()).ok;
  } catch (e) {
    console.error('DB addCaution error:', e);
    return false;
  }
}

export async function dbGetCaution() {
  try {
    const res = await fetch(`${API_BASE}/caution`);
    const rows = await res.json();
    return new Set(rows.map(r => r.barcode));
  } catch (e) {
    console.error('DB getCaution error:', e);
    return new Set();
  }
}

export async function dbRemoveCaution(barcode) {
  try {
    const res = await fetch(`${API_BASE}/caution/${encodeURIComponent(barcode)}`, {
      method: 'DELETE',
    });
    return (await res.json()).ok;
  } catch (e) {
    console.error('DB removeCaution error:', e);
    return false;
  }
}

// ===== 캘린더 이벤트 =====
export async function dbSaveCalendar(events) {
  try {
    const res = await fetch(`${API_BASE}/calendar`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ events }),
    });
    return (await res.json()).ok;
  } catch (e) {
    console.error('DB saveCalendar error:', e);
    return false;
  }
}

export async function dbGetCalendar() {
  try {
    const res = await fetch(`${API_BASE}/calendar`);
    const data = await res.json();
    return data.events || [];
  } catch (e) {
    console.error('DB getCalendar error:', e);
    return [];
  }
}

// ===== 범용 저장소 (localStorage 대체) =====
export async function dbStoreSet(name, data) {
  try {
    const res = await fetch(`${API_BASE}/store/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    });
    return (await res.json()).ok;
  } catch (e) {
    console.error(`DB store set(${name}) error:`, e);
    return false;
  }
}

export async function dbStoreGet(name) {
  try {
    const res = await fetch(`${API_BASE}/store/${name}`);
    const result = await res.json();
    return result.data;
  } catch (e) {
    console.error(`DB store get(${name}) error:`, e);
    return null;
  }
}
