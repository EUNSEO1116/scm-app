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

export async function dbReplaceReasons(items) {
  try {
    const res = await fetch(`${API_BASE}/soldout/reasons`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    return (await res.json()).ok;
  } catch (e) {
    console.error('DB replaceReasons error:', e);
    return false;
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
export async function dbSaveCalendar(events, { skipLog } = {}) {
  try {
    const res = await fetch(`${API_BASE}/calendar${skipLog ? '?skipLog=1' : ''}`, {
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
export async function dbStoreSet(name, data, { skipLog, logDesc } = {}) {
  try {
    const params = new URLSearchParams();
    if (skipLog) params.set('skipLog', '1');
    if (logDesc) params.set('logDesc', logDesc);
    const qs = params.toString();
    const res = await fetch(`${API_BASE}/store/${name}${qs ? '?' + qs : ''}`, {
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

// ===== 활동 로그 =====
export async function dbGetActivityLog(limit = 100, offset = 0) {
  try {
    const res = await fetch(`${API_BASE}/activity-log?limit=${limit}&offset=${offset}`);
    return await res.json(); // { logs, total }
  } catch (e) {
    console.error('DB getActivityLog error:', e);
    return { logs: [], total: 0 };
  }
}

export async function dbRevertActivity(id) {
  try {
    const res = await fetch(`${API_BASE}/activity-log/revert/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return await res.json();
  } catch (e) {
    console.error('DB revertActivity error:', e);
    return { error: e.message };
  }
}

export async function dbRevertActivityGroup(groupId) {
  try {
    const res = await fetch(`${API_BASE}/activity-log/revert-group/${encodeURIComponent(groupId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });
    return await res.json();
  } catch (e) {
    console.error('DB revertActivityGroup error:', e);
    return { error: e.message };
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
