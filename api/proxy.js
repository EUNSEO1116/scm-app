const VULTR_API = 'http://158.247.239.161:3100';

export default async function handler(req, res) {
  // /api/proxy/soldout/reasons → /api/soldout/reasons
  const path = req.url.replace(/^\/api\/proxy/, '/api');

  const url = `${VULTR_API}${path}`;

  try {
    const options = {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
    };

    if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
      options.body = JSON.stringify(req.body);
    }

    const response = await fetch(url, options);
    const data = await response.json();

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    res.status(response.status).json(data);
  } catch (e) {
    res.status(500).json({ error: 'proxy error', message: e.message });
  }
}
