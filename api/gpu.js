// GET /api/gpu
// Live H100 on-demand asking prices from public GPU marketplaces, normalised to $ per GPU-hour.
// Each source is optional: a source that fails or returns nothing usable is skipped and listed in `skipped`.
// Optional environment variables: VAST_API_KEY (Vast.ai search needs a key), RUNPOD_API_KEY.

const TIMEOUT_MS = 6000;
const UA = 'ACSI/0.2 (AI Credit Stress Index; +https://github.com/gagattzo/ai-credit-stress-index-)';

async function getJSON(url, opts = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json', ...(opts.headers || {}) } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

const median = (arr) => {
  const s = arr.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  const n = s.length;
  if (!n) return null;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};
const sane = (v) => Number.isFinite(v) && v > 0.3 && v < 25; // $/GPU-hr guard against unit mix-ups
const round2 = (v) => Math.round(v * 100) / 100;

// Akash Network (decentralized GPU marketplace): public console API, no key.
async function akash() {
  const j = await getJSON('https://console-api.akash.network/v1/gpu-prices');
  const models = Array.isArray(j?.models) ? j.models : [];
  const h100 = models.filter((m) => /h100/i.test(`${m.model || ''} ${m.name || ''}`));
  const vals = [];
  let available = 0;
  for (const m of h100) {
    const p = m.price || {};
    const v = Number(p.med ?? p.median ?? p.weightedAverage ?? p.avg);
    if (sane(v)) vals.push(v);
    available += Number(m.availability?.total || 0);
  }
  const v = median(vals);
  if (v === null) throw new Error('no H100 price');
  return { id: 'akash', name: 'Akash Network', kind: 'decentralized marketplace, median ask', usd_per_gpu_hr: round2(v), offers: available || null, url: 'https://akash.network/pricing/gpus/' };
}

// RunPod: public GraphQL GPU catalogue (on-demand "secure cloud" list price for H100 SXM).
async function runpod() {
  const key = process.env.RUNPOD_API_KEY;
  const url = 'https://api.runpod.io/graphql' + (key ? `?api_key=${encodeURIComponent(key)}` : '');
  const query = 'query { gpuTypes { id displayName securePrice communityPrice } }';
  const j = await getJSON(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }) });
  const types = j?.data?.gpuTypes || [];
  const sxm = types.filter((g) => /h100/i.test(`${g.id} ${g.displayName}`) && /(sxm|hbm3)/i.test(`${g.id} ${g.displayName}`));
  // Community-cloud price: the marketplace tier (secure-cloud list prices sit well above market asks).
  const vals = sxm.map((g) => Number(g.communityPrice)).filter(sane);
  const v = median(vals);
  if (v === null) throw new Error('no H100 SXM price');
  return { id: 'runpod', name: 'RunPod', kind: 'community-cloud price', usd_per_gpu_hr: round2(v), offers: null, url: 'https://www.runpod.io/pricing' };
}

// Vast.ai: marketplace asks (needs VAST_API_KEY). Median per-GPU price of verified, rentable H100 SXM on-demand offers.
async function vast() {
  const key = process.env.VAST_API_KEY;
  if (!key) throw new Error('no VAST_API_KEY');
  const body = {
    gpu_name: { in: ['H100 SXM'] },
    verified: { eq: true },
    rentable: { eq: true },
    rented: { eq: false },
    type: 'on-demand',
    limit: 300,
  };
  const j = await getJSON('https://console.vast.ai/api/v0/bundles/', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const offers = Array.isArray(j?.offers) ? j.offers : [];
  const vals = offers.map((o) => Number(o.dph_total) / Math.max(1, Number(o.num_gpus) || 1)).filter(sane);
  const v = median(vals);
  if (v === null) throw new Error('no H100 SXM offers');
  return { id: 'vast', name: 'Vast.ai', kind: 'peer marketplace asks', usd_per_gpu_hr: round2(v), offers: vals.length, url: 'https://vast.ai/pricing' };
}

const SOURCES = [akash, runpod, vast];

module.exports = async (req, res) => {
  const settled = await Promise.allSettled(SOURCES.map((f) => f()));
  const sources = [];
  const skipped = [];
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') sources.push(r.value);
    else skipped.push({ id: SOURCES[i].name, reason: String(r.reason && r.reason.message ? r.reason.message : r.reason).slice(0, 80) });
  });
  const med = median(sources.map((s) => s.usd_per_gpu_hr));
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=900');
  res.setHeader('access-control-allow-origin', '*');
  res.status(200).send(JSON.stringify({
    updated: new Date().toISOString(),
    gpu: 'H100',
    unit: 'USD per GPU-hour',
    median_usd_per_gpu_hr: med === null ? null : round2(med),
    sources,
    skipped,
    note: 'Asking or list prices on public GPU marketplaces right now; not negotiated contract rates and not an input to the index.',
  }));
};
