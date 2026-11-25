// GET /api/cds
// Daily 5-year CDS levels for Oracle, CoreWeave and Meta, computed from single-name CDS trades that dealers must report and
// that DTCC publishes free of charge under the SEC's security-based swap rules (Regulation SBSR public dissemination).
// Source files: https://pddata.dtcc.com/ppd/api/report/cumulative/sec/SEC_CUMULATIVE_CREDITS_YYYY_MM_DD.zip
// Method: new trades (action NEWT) maturing 4.6–5.4 years out. Where the record carries a quoted spread it is used as is;
// otherwise the upfront payment is converted to a par spread with a flat-hazard model (40% recovery, 3.9% discount rate,
// quarterly premiums, accrued from the last IMM date). The daily level is the median across that day's trades.

const zlib = require('zlib');

const TIMEOUT_MS = 12000;
const UA = 'ACSI/0.3 (AI Credit Stress Index; +https://github.com/gagattzo/ai-credit-stress-index-)';
const DAYS_BACK = 12;
const ENTITIES = [
  { id: 'ORCL', name: 'Oracle', match: 'ORACLE', red: '6EC42L' },
  { id: 'CRWV', name: 'CoreWeave', match: 'COREWEAVE', red: '239FAV' },
  { id: 'META', name: 'Meta', match: 'META PLATFORMS', red: 'UZEAAG' },
];

async function getBuffer(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': UA } });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Minimal ZIP reader: returns the first entry's bytes (DEFLATE or STORED) using the central directory.
function unzipFirst(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cdOffset) !== 0x02014b50) throw new Error('bad central directory');
  const method = buf.readUInt16LE(cdOffset + 10);
  const compSize = buf.readUInt32LE(cdOffset + 20);
  const localOffset = buf.readUInt32LE(cdOffset + 42);
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const start = localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compSize);
  if (method === 0) return data;
  if (method === 8) return zlib.inflateRawSync(data);
  throw new Error('unsupported zip method ' + method);
}

// RFC 4180-style CSV parser (quoted fields, doubled quotes, commas and newlines inside quotes).
function parseCSV(text) {
  const rows = [];
  let row = [], field = '', q = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 1; } else q = false; }
      else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (ch !== '\r') field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  const head = rows.shift() || [];
  return rows.map((r) => { const o = {}; head.forEach((h, i) => { o[h] = r[i] === undefined ? '' : r[i]; }); return o; });
}

const DAY_MS = 86400000;
function lastIMM(d) {
  for (let y = d.getUTCFullYear(); y >= d.getUTCFullYear() - 1; y -= 1) {
    for (const m of [11, 8, 5, 2]) { const c = Date.UTC(y, m, 20); if (c <= d.getTime()) return c; }
  }
  return d.getTime();
}
function rpv01(S, T, r = 0.039, R = 0.4) {
  const k = r + S / (1 - R);
  const n = Math.max(1, Math.round(T * 4));
  let tot = 0;
  for (let i = 1; i <= n; i += 1) { const t = i < n ? i / 4 : T; tot += 0.25 * Math.exp(-k * t); }
  return tot;
}
function spreadFromUpfront(pct, C, T, accr) {
  const target = pct + C * accr;
  let lo = 0.0001, hi = 0.6;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if ((mid - C) * rpv01(mid, T) < target) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };

function levelsForDay(rows) {
  const out = {};
  for (const e of ENTITIES) {
    const vals = [];
    let last = null;
    for (const r of rows) {
      const t = `${r['Underlying Asset Name'] || ''} ${r['UPI Underlier Name'] || ''} ${r['Underlier ID-Leg 1'] || ''}`.toUpperCase();
      if (!t.includes(e.match) && !t.includes(e.red)) continue;
      if (r['Action type'] !== 'NEWT') continue;
      const exec = new Date(r['Execution Timestamp']);
      const exp = Date.parse(`${r['Expiration Date']}T00:00:00Z`);
      if (Number.isNaN(exec.getTime()) || Number.isNaN(exp)) continue;
      const T = (exp - exec.getTime()) / (365.25 * DAY_MS);
      if (T < 4.6 || T > 5.4) continue;
      const C = Number(r['Fixed rate-Leg 1'] || 0);
      let s = null;
      if (r['Spread-Leg 1']) s = Number(r['Spread-Leg 1']);
      else if (r['Other payment amount'] && C) {
        const N = Number(String(r['Notional amount-Leg 1']).replace(/[,+]/g, ''));
        const pct = Number(r['Other payment amount']) / N;
        if (!(N > 0) || !Number.isFinite(pct)) continue;
        if (Math.abs(pct) < 0.02) continue; // near the coupon the sign of the upfront is ambiguous: skip
        const accr = (exec.getTime() + DAY_MS - lastIMM(exec)) / (360 * DAY_MS);
        s = spreadFromUpfront(pct, C, T, accr);
      }
      if (!(s > 0 && s < 0.6)) continue;
      vals.push(s);
      if (!last || exec > last) last = exec;
    }
    out[e.id] = vals.length ? { bp: Math.round(median(vals) * 10000), trades: vals.length, last_trade: last.toISOString() } : null;
  }
  return out;
}

module.exports = async (req, res) => {
  const today = new Date();
  const days = [];
  for (let k = 0; k < DAYS_BACK; k += 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - k));
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    days.push(d.toISOString().slice(0, 10));
  }
  const files = await Promise.all(days.map(async (iso) => {
    const name = `SEC_CUMULATIVE_CREDITS_${iso.replace(/-/g, '_')}.zip`;
    const buf = await getBuffer(`https://pddata.dtcc.com/ppd/api/report/cumulative/sec/${name}`);
    if (!buf) return null;
    try { return { date: iso, levels: levelsForDay(parseCSV(unzipFirst(buf).toString('utf8'))) }; } catch (e) { return null; }
  }));
  const got = files.filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : 1));
  const entities = ENTITIES.map((e) => {
    const series = got.filter((f) => f.levels[e.id]).map((f) => ({ date: f.date, bp: f.levels[e.id].bp, trades: f.levels[e.id].trades }));
    const latest = series[series.length - 1] || null;
    const lastFile = got.filter((f) => f.levels[e.id]).pop();
    return { id: e.id, name: e.name, red: e.red, tenor: '5Y', latest, last_trade: lastFile ? lastFile.levels[e.id].last_trade : null, series };
  });
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', got.length ? 'public, s-maxage=1800, stale-while-revalidate=86400' : 'public, s-maxage=120');
  res.setHeader('access-control-allow-origin', '*');
  res.status(200).send(JSON.stringify({
    updated: new Date().toISOString(),
    source: 'DTCC Data Repository (U.S.) LLC, SEC public dissemination of security-based swaps',
    source_url: 'https://pddata.dtcc.com/ppd/secdashboard',
    files: got.map((f) => f.date),
    entities,
    method: 'Median of the day’s new 5-year trades; quoted spreads used as reported, upfront prices converted with a flat-hazard model (40% recovery).',
  }));
};
