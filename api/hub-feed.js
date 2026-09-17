// apday-hub 알림 연동용 공개 읽기전용 피드 (범용 엔드포인트)
//
// 사용법:  GET /api/hub-feed?source=<이름>   (source 생략 시 기본값 'remarket')
// 응답:    { "data": [ { "id", "title", "reason", "days" } ] }
//
// ▶ 새 알림 피드를 추가하려면 아래 SOURCES 에 항목 하나만 추가하면 됩니다.
//   - store  : Vultr /api/store 에서 읽을 store 이름
//   - select : 원본 배열에서 알림으로 띄울 항목만 걸러내는 함수 (true 인 것만)
//   - map    : 각 항목을 { id, title, reason, days } 로 변환하는 함수
//   민감·내부 수치(가격·재고·개인정보 등)는 map 에서 넣지 말 것.
const VULTR_API = 'http://158.247.239.161:3100';

const SOURCES = {
  // 재마케팅: 미조치(pending) = 재입고돼 재마케팅 검토가 필요한 신규 건
  remarket: {
    store: 'soldout_remarket_events',
    select: (e) => e && e.status === 'pending',
    map: (e) => ({
      id: String(e.key || `${e.barcode || ''}_${e.soldoutStart || ''}`),
      title: [e.productName, e.optionName].filter(Boolean).join(' ') || '(이름 없음)',
      reason: (e.reason && String(e.reason).trim()) || '재입고 · 재마케팅 검토 필요',
      days: Number(e.days) || 1,
    }),
  },
};

async function fetchStore(name) {
  const r = await fetch(`${VULTR_API}/api/store/${name}`);
  if (!r.ok) throw new Error(`store ${r.status}`);
  const json = await r.json();
  return Array.isArray(json.data) ? json.data : [];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // 알림 신선도를 위해 캐시 짧게(60초) 허용
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return res.status(405).json({ error: 'method not allowed' });
  }

  // req.query 가 없는 런타임 대비: URL 에서 직접 파싱
  const sourceName =
    (req.query && req.query.source) ||
    new URL(req.url, 'http://x').searchParams.get('source') ||
    'remarket';

  const cfg = SOURCES[sourceName];
  if (!cfg) {
    return res.status(400).json({
      error: 'unknown source',
      message: `source '${sourceName}' 없음`,
      available: Object.keys(SOURCES),
    });
  }

  try {
    const rows = await fetchStore(cfg.store);
    const data = rows.filter(cfg.select).map(cfg.map);
    return res.status(200).json({ data });
  } catch (e) {
    return res.status(500).json({ error: 'hub-feed error', message: e.message });
  }
}
