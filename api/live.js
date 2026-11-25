// GET /api/live
// Live, public market signals on AI-infrastructure credit, gathered server-side and cached briefly:
//  - Polymarket: "CoreWeave announces bankruptcy by ...?" market ladder, with 45 days of daily history
//  - Pendle: implied fixed rate on PT-sUSDai (USD.AI's GPU-loan vault) minus PT-USDai (same protocol, same expiry, no
//    GPU-loan exposure) = the onchain GPU-loan premium, with 45 days of history; and the vault rate over SOFR
//  - NY Fed: SOFR
//  - Hyperliquid HIP-3: 24/7 perpetual futures on AI-infrastructure equities
// Every block is optional: a block that fails is null and is listed in `skipped`.

const TIMEOUT_MS = 6500;
const UA = 'ACSI/0.3 (AI Credit Stress Index; +https://github.com/gagattzo/ai-credit-stress-index-)';
const DAY = 86400000;

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
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
const r4 = (v) => (v === null || !Number.isFinite(v) ? null : Math.round(v * 10000) / 10000);
const day = (ms) => new Date(ms).toISOString().slice(0, 10);
const lastPerDay = (pts) => {
  const m = new Map();
  pts.forEach((p) => m.set(p.date, p));
  return [...m.values()];
};

// --- Polymarket -------------------------------------------------------------
const PM_SLUG = 'coreweave-announces-bankruptcy-by';
async function polymarket() {
  const ev = await getJSON(`https://gamma-api.polymarket.com/events?slug=${PM_SLUG}`);
  const e = Array.isArray(ev) ? ev[0] : ev;
  if (!e || !Array.isArray(e.markets)) throw new Error('no event');
  const now = Date.now();
  const resolvedYes = e.markets.some((m) => m.closed && JSON.parse(m.outcomePrices || '[]').map(Number)[0] > 0.99);
  if (resolvedYes) return { title: e.title, url: `https://polymarket.com/event/${PM_SLUG}`, resolved_yes: true, markets: [], history_first_market: [] };
  const markets = e.markets
    .filter((m) => !m.closed && Date.parse(m.endDate) > now + 30 * DAY)
    .map((m) => {
      const prices = JSON.parse(m.outcomePrices || '[]').map(Number);
      const bid = num(m.bestBid), ask = num(m.bestAsk);
      const mid = bid !== null && ask !== null && ask > 0 ? (bid + ask) / 2 : prices[0];
      const end = Date.parse(m.endDate);
      const years = Math.max(0.05, (end - now) / (365.25 * DAY));
      // Rough conversion of the cumulative probability into an annual default intensity and a CDS-like spread (40% recovery).
      const lambda = mid > 0 && mid < 1 ? -Math.log(1 - mid) / years : null;
      const tokens = JSON.parse(m.clobTokenIds || '[]');
      const dl = /by ([A-Z][a-z]+ \d{1,2}, \d{4})/.exec(m.question || '');
      const deadline = dl ? new Date(`${dl[1]} UTC`).toISOString().slice(0, 10) : new Date(end - DAY).toISOString().slice(0, 10);
      return {
        question: m.question, deadline, end_date: (m.endDate || '').slice(0, 10), yes: r4(mid), bid, ask,
        liquidity_usd: Math.round(num(m.liquidityNum) || 0), volume_usd: Math.round(num(m.volumeNum) || 0),
        implied_annual_default: r4(lambda), implied_spread_bp: lambda === null ? null : Math.round(lambda * 0.6 * 10000),
        token: tokens[0] || null,
      };
    })
    .sort((a, b) => (a.deadline < b.deadline ? -1 : 1));
  if (!markets.length) throw new Error('no open markets');
  let history = [];
  const first = markets[0];
  if (first.token) {
    try {
      const h = await getJSON(`https://clob.polymarket.com/prices-history?market=${first.token}&interval=max&fidelity=1440`);
      history = lastPerDay((h.history || []).map((x) => ({ date: day(x.t * 1000), p: Number(x.p) }))).filter((x) => Date.parse(x.date) >= now - 45 * DAY);
    } catch (err) { /* history is optional */ }
  }
  markets.forEach((m) => delete m.token);
  return {
    title: e.title, url: `https://polymarket.com/event/${PM_SLUG}`,
    liquidity_usd: Math.round(num(e.liquidity) || 0), volume_usd: Math.round(num(e.volume) || 0),
    markets, history_first_market: history,
  };
}

// --- Pendle: USD.AI vault (PT-sUSDai, GPU-loan exposure) vs plain USDai (PT-USDai), same expiry ---------------
const PENDLE_CHAIN = 42161;
const DAYS_MIN_TO_EXPIRY = 60;
const MIN_LIQUIDITY = 1e6;
async function pendleHistory(address) {
  const h = await getJSON(`https://api-v2.pendle.finance/core/v2/${PENDLE_CHAIN}/markets/${address}/historical-data?time_frame=day`);
  const cutoff = Date.now() - 45 * DAY;
  return (h.results || []).filter((x) => Date.parse(x.timestamp) >= cutoff).map((x) => ({ date: x.timestamp.slice(0, 10), implied_apy: r4(Number(x.impliedApy)) }));
}
async function pendle() {
  const list = await getJSON(`https://api-v2.pendle.finance/core/v1/${PENDLE_CHAIN}/markets/active`);
  const ms = (list.markets || []).filter((m) => Date.parse(m.expiry) > Date.now() + DAYS_MIN_TO_EXPIRY * DAY);
  const pick = (name) => ms.filter((m) => m.name === name).sort((a, b) => (b.details?.liquidity || 0) - (a.details?.liquidity || 0))[0];
  const vault = pick('sUSDai');
  if (!vault || (vault.details?.liquidity || 0) < MIN_LIQUIDITY) throw new Error('no liquid sUSDai market');
  const plain = ms.find((m) => m.name === 'USDai' && m.expiry === vault.expiry) || null;
  const [vh, ph] = await Promise.all([pendleHistory(vault.address).catch(() => []), plain ? pendleHistory(plain.address).catch(() => []) : Promise.resolve([])]);
  const pmap = new Map(ph.map((x) => [x.date, x.implied_apy]));
  const premium_history = vh.filter((x) => pmap.has(x.date)).map((x) => ({ date: x.date, bp: Math.round((x.implied_apy - pmap.get(x.date)) * 10000) }));
  const v = Number(vault.details.impliedApy), u = plain ? Number(plain.details.impliedApy) : null;
  return {
    protocol: 'USD.AI on Pendle (Arbitrum)', expiry: (vault.expiry || '').slice(0, 10),
    vault: { name: 'PT-sUSDai', market: vault.address, implied_apy: r4(v), liquidity_usd: Math.round(vault.details.liquidity || 0), url: `https://app.pendle.finance/trade/markets/${vault.address}/swap?chain=arbitrum` },
    plain: plain ? { name: 'PT-USDai', market: plain.address, implied_apy: r4(u), liquidity_usd: Math.round(plain.details.liquidity || 0), url: `https://app.pendle.finance/trade/markets/${plain.address}/swap?chain=arbitrum` } : null,
    premium_bp: u === null ? null : Math.round((v - u) * 10000),
    premium_history,
    vault_history: vh,
  };
}
// APY (compounded) -> simple Act/360 rate, comparable with SOFR.
const apyToSimple360 = (apy) => 365 * (Math.pow(1 + apy, 1 / 365) - 1) * (360 / 365);
async function sofr() {
  const j = await getJSON('https://markets.newyorkfed.org/api/rates/secured/sofr/last/1.json');
  const r = (j.refRates || [])[0];
  if (!r) throw new Error('no SOFR');
  return { rate: Number(r.percentRate) / 100, date: r.effectiveDate, url: 'https://www.newyorkfed.org/markets/reference-rates/sofr' };
}

// --- Hyperliquid HIP-3 equity perps ------------------------------------------
const PERPS = [
  ['xyz', 'xyz:CRWV', 'CoreWeave'], ['xyz', 'xyz:NBIS', 'Nebius'], ['xyz', 'xyz:IREN', 'IREN'],
  ['para', 'para:CIFR', 'Cipher Digital'], ['xyz', 'xyz:ORCL', 'Oracle'], ['xyz', 'xyz:NVDA', 'Nvidia'],
];
async function hyperliquid() {
  const dexes = [...new Set(PERPS.map((p) => p[0]))];
  const books = {};
  await Promise.all(dexes.map(async (dex) => {
    const [meta, ctxs] = await getJSON('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'metaAndAssetCtxs', dex }) });
    meta.universe.forEach((a, i) => { books[a.name] = { meta: a, ctx: ctxs[i] }; });
  }));
  const rows = PERPS.map(([dex, sym, name]) => {
    const b = books[sym];
    if (!b || b.meta.isDelisted) return null;
    const mark = num(b.ctx.markPx), prev = num(b.ctx.prevDayPx);
    return { symbol: sym.split(':')[1], venue: dex, name, mark, change_24h: mark && prev ? r4(mark / prev - 1) : null, volume_24h_usd: Math.round(num(b.ctx.dayNtlVlm) || 0), funding_hourly: num(b.ctx.funding) };
  }).filter(Boolean);
  const gpuPerps = Object.keys(books).filter((k) => /:H100$/i.test(k)).map((k) => ({ symbol: k, delisted: !!books[k].meta.isDelisted, last_mark: num(books[k].ctx.markPx) }));
  if (!rows.length) throw new Error('no perps');
  return { rows, gpu_rent_perps: gpuPerps, url: 'https://app.hyperliquid.xyz/trade' };
}

module.exports = async (req, res) => {
  const jobs = { polymarket, pendle, sofr, hyperliquid };
  const keys = Object.keys(jobs);
  const settled = await Promise.allSettled(keys.map((k) => jobs[k]()));
  const out = { updated: new Date().toISOString(), skipped: [] };
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') out[keys[i]] = r.value;
    else { out[keys[i]] = null; out.skipped.push({ id: keys[i], reason: String(r.reason && r.reason.message ? r.reason.message : r.reason).slice(0, 80) }); }
  });
  if (out.pendle && out.sofr && Number.isFinite(out.pendle.vault.implied_apy)) {
    out.pendle.vault_over_sofr_bp = Math.round((apyToSimple360(out.pendle.vault.implied_apy) - out.sofr.rate) * 10000);
  }
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'public, s-maxage=60, stale-while-revalidate=600');
  res.setHeader('access-control-allow-origin', '*');
  res.status(200).send(JSON.stringify(out));
};
