// GET /api/cds
// Daily 5-year CDS levels for Oracle, CoreWeave and Meta, computed from single-name CDS trades that dealers must report and
// that DTCC publishes free of charge under the SEC's security-based swap rules (Regulation SBSR public dissemination).
// Source files: https://pddata.dtcc.com/ppd/api/report/cumulative/sec/SEC_CUMULATIVE_CREDITS_YYYY_MM_DD.zip (end of day)
// and, for days whose end-of-day file is not out yet, the intraday files
// https://pddata.dtcc.com/ppd/api/report/intraday/sec/SEC_SLICE_CREDITS_YYYY_MM_DD_N.zip (N = 1, 2, ... a few per minute).
// Method: see `method` in the response. Trades are cleaned (EROR removed, CORR applied, same-day execution only) and
// restricted to the on-the-run 5-year maturity; the daily level is the median across that day's trades.

const zlib = require('zlib');

const TIMEOUT_MS = 12000;
const UA = 'ACSI/0.3 (AI Credit Stress Index; +https://github.com/gagattzo/ai-credit-stress-index-)';
const DAYS_BACK = 12;
const SLICE_WAVE = 40;   // intraday files fetched in parallel per wave
const SLICE_MAX = 8000;  // hard stop
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
const RATE = 0.045; // flat discount rate; reprices quoted-spread trades on the tape to within ~1 bp
function lastIMM(ms) {
  const d = new Date(ms);
  for (let y = d.getUTCFullYear(); y >= d.getUTCFullYear() - 1; y -= 1) {
    for (const m of [11, 8, 5, 2]) { const c = Date.UTC(y, m, 20); if (c <= ms) return c; }
  }
  return ms;
}
// On-the-run 5-year maturity for a trade date (CDS roll dates 20 Mar / 20 Sep).
function onTheRun5Y(ms) {
  const d = new Date(ms), y = d.getUTCFullYear();
  if (ms >= Date.UTC(y, 8, 20)) return Date.UTC(y + 5, 11, 20);
  if (ms >= Date.UTC(y, 2, 20)) return Date.UTC(y + 5, 5, 20);
  return Date.UTC(y + 4, 11, 20);
}
// Simplified ISDA-style legs: flat hazard, quarterly Act/360 premiums, accrual on default, mid-period discounting.
function legs(lam, T, R = 0.4, r = RATE) {
  let prot = 0, rpv = 0, q0 = 1;
  const n = Math.max(1, Math.round(T * 4));
  for (let i = 1; i <= n; i += 1) {
    const t0 = (i - 1) / 4, t1 = i < n ? i / 4 : T, q1 = Math.exp(-lam * t1), dm = Math.exp((-r * (t0 + t1)) / 2);
    rpv += (t1 - t0) * (365 / 360) * (Math.exp(-r * t1) * q1 + 0.5 * dm * (q0 - q1));
    prot += (1 - R) * dm * (q0 - q1);
    q0 = q1;
  }
  return { prot, rpv };
}
// Upfront (fraction of notional, paid by the protection buyer when positive) -> par spread.
function spreadFromUpfront(upfront, C, T, accr) {
  const target = upfront + C * accr;
  let lo = 1e-6, hi = 3;
  for (let i = 0; i < 90; i += 1) {
    const m = (lo + hi) / 2, L = legs(m, T);
    if (L.prot - C * L.rpv < target) lo = m; else hi = m;
  }
  const L = legs((lo + hi) / 2, T);
  return L.prot / L.rpv;
}
const median = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; };
const isCdsRow = (r) => {
  const id = String(r['Underlier ID-Leg 1'] || ''), nm = `${r['Underlying Asset Name'] || ''} ${r['UPI Underlier Name'] || ''}`.toUpperCase();
  if (/^LX/i.test(id) || /\bTRS\b|DDTL/.test(nm)) return false;
  return Number(r['Fixed rate-Leg 1']) > 0 || Number(r['Spread-Leg 1']) > 0; // a standard coupon (1%/5%) or a quoted spread
};

// Clean one day's file: drop cancelled (EROR) trades, let corrections (CORR) replace the original record,
// keep only trades executed on the file date.
function cleanRows(rows, fileDate) {
  const cancelled = new Set(rows.filter((r) => r['Action type'] === 'EROR').map((r) => r['Original Dissemination Identifier'] || r['Dissemination Identifier']));
  const byId = new Map();
  for (const r of rows) {
    const act = r['Action type'];
    if (act !== 'NEWT' && act !== 'CORR') continue;
    const key = act === 'CORR' ? (r['Original Dissemination Identifier'] || r['Dissemination Identifier']) : r['Dissemination Identifier'];
    if (cancelled.has(key) || cancelled.has(r['Dissemination Identifier'])) continue;
    if (act === 'NEWT' && byId.has(key)) continue; // a correction already replaced it
    byId.set(key, r);
  }
  return [...byId.values()].filter((r) => String(r['Execution Timestamp']).slice(0, 10) === fileDate);
}

function calibrate(rows) {
  // Model check on every on-the-run 5Y trade that reports both a quoted spread and an upfront (any reference entity).
  const errs = [];
  for (const r of rows) {
    if (!r['Spread-Leg 1'] || !r['Other payment amount']) continue;
    const exec = Date.parse(r['Execution Timestamp']), exp = Date.parse(`${r['Expiration Date']}T00:00:00Z`);
    if (Number.isNaN(exec) || exp !== onTheRun5Y(exec)) continue;
    const q = Number(r['Spread-Leg 1']), N = Number(String(r['Notional amount-Leg 1']).replace(/[,+]/g, ''));
    const pct = Number(r['Other payment amount']) / N;
    if (!(q > 0 && q < 1 && pct > 0)) continue;
    const T = (exp - exec - DAY_MS) / (365.25 * DAY_MS), accr = (exec + DAY_MS - lastIMM(exec)) / (360 * DAY_MS);
    const C0 = Number(r['Fixed rate-Leg 1']);
    errs.push(Math.min(...(C0 > 0 ? [C0] : [0.01, 0.05]).map((Cc) => Math.abs(spreadFromUpfront(q > Cc ? pct : -pct, Cc, T, accr) - q))));
  }
  return errs.length ? { n: errs.length, median_abs_error_bp: Math.round(median(errs) * 10000 * 10) / 10 } : null;
}

function levelsForDay(rawRows, fileDate, prev) {
  const rows = cleanRows(rawRows, fileDate);
  const out = {};
  const calib = [];
  for (const e of ENTITIES) {
    const mine = rows.filter((r) => {
      const t = `${r['Underlying Asset Name'] || ''} ${r['UPI Underlier Name'] || ''} ${r['Underlier ID-Leg 1'] || ''}`.toUpperCase();
      return (t.includes(e.match) || t.includes(e.red)) && isCdsRow(r);
    });
    const quoted = [], fromUpfront = [];
    let last = null;
    for (const r of mine) {
      const exec = Date.parse(r['Execution Timestamp']);
      const exp = Date.parse(`${r['Expiration Date']}T00:00:00Z`);
      if (Number.isNaN(exec) || Number.isNaN(exp) || exp !== onTheRun5Y(exec)) continue;
      const C = Number(r['Fixed rate-Leg 1']);
      const stepIn = exec + DAY_MS, T = (exp - stepIn) / (365.25 * DAY_MS);
      const accr = (stepIn - lastIMM(exec)) / (360 * DAY_MS);
      const N = Number(String(r['Notional amount-Leg 1']).replace(/[,+]/g, ''));
      const amt = Number(r['Other payment amount']);
      const pct = N > 0 && Number.isFinite(amt) ? amt / N : null;
      if (r['Spread-Leg 1']) {
        const q = Number(r['Spread-Leg 1']);
        if (q > 0 && q < 1) {
          quoted.push({ s: q, exec });
          // Calibration: trades that report both a quoted spread and an upfront (coupon inferred as 1% or 5%).
          if (pct !== null && pct > 0) {
            const errs = (C > 0 ? [C] : [0.01, 0.05]).map((Cc) => Math.abs(spreadFromUpfront(q > Cc ? pct : -pct, Cc, T, accr) - q));
            calib.push(Math.min(...errs));
          }
        }
      } else if (pct !== null && C) {
        // DTCC upfronts are unsigned: compute both readings and resolve below.
        fromUpfront.push({ hi: spreadFromUpfront(Math.abs(pct), C, T, accr), lo: spreadFromUpfront(-Math.abs(pct), C, T, accr), pct: Math.abs(pct), exec });
      }
    }
    const ref = quoted.length ? median(quoted.map((q) => q.s)) : (prev && prev[e.id] ? prev[e.id].bp / 10000 : null);
    const vals = quoted.map((q) => q.s);
    let resolvedByRef = 0;
    for (const u of fromUpfront) {
      let s = null;
      if (ref !== null) { s = Math.abs(u.hi - ref) <= Math.abs(u.lo - ref) ? u.hi : u.lo; resolvedByRef += 1; }
      else if (u.pct >= 0.02) s = u.hi; // without a reference, only take clearly one-sided upfronts
      if (s !== null && s > 0 && s < 1) vals.push(s);
    }
    [...quoted, ...fromUpfront].forEach((x) => { if (!last || x.exec > last) last = x.exec; });
    out[e.id] = vals.length ? { bp: Math.round(median(vals) * 10000), trades: vals.length, quoted: quoted.length, last_trade: new Date(last).toISOString() } : null;
  }
  out._calibration = calibrate(rows);
  return out;
}

// All intraday files published so far for one day, concatenated. Files are numbered from 1 with no gaps;
// a wave whose last file is missing is the end. Returns null if there are none.
async function intradayFor(iso) {
  const stem = `https://pddata.dtcc.com/ppd/api/report/intraday/sec/SEC_SLICE_CREDITS_${iso.replace(/-/g, '_')}_`;
  const rows = [];
  let n = 1, count = 0;
  while (n <= SLICE_MAX) {
    const batch = await Promise.all(Array.from({ length: SLICE_WAVE }, (_, i) => n + i).map(async (k) => {
      const buf = await getBuffer(stem + k + '.zip');
      if (!buf) return null;
      try { return parseCSV(unzipFirst(buf).toString('utf8')); } catch (e) { return null; }
    }));
    batch.forEach((b) => { if (b) { count += 1; rows.push(...b); } });
    if (!batch[batch.length - 1]) break;
    n += SLICE_WAVE;
  }
  return count ? { rows, slices: count } : null;
}

module.exports = async (req, res) => {
  const today = new Date();
  const days = [];
  for (let k = 0; k < DAYS_BACK; k += 1) {
    const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - k));
    if (d.getUTCDay() === 0 || d.getUTCDay() === 6) continue;
    days.push(d.toISOString().slice(0, 10));
  }
  const recent = days.slice(0, 2); // the two latest weekdays may not have an end-of-day file yet
  const intraday = {};
  const [files] = await Promise.all([
    Promise.all(days.map(async (iso) => {
      const name = `SEC_CUMULATIVE_CREDITS_${iso.replace(/-/g, '_')}.zip`;
      const buf = await getBuffer(`https://pddata.dtcc.com/ppd/api/report/cumulative/sec/${name}`);
      if (!buf) return null;
      try { return { date: iso, rows: parseCSV(unzipFirst(buf).toString('utf8')) }; } catch (e) { return null; }
    })),
    Promise.all(recent.map(async (iso) => { intraday[iso] = await intradayFor(iso); })),
  ]);
  recent.forEach((iso) => {
    const i = days.indexOf(iso);
    if (!files[i] && intraday[iso]) files[i] = { date: iso, rows: intraday[iso].rows, intraday: true, slices: intraday[iso].slices };
  });
  const got = [];
  let prev = null;
  files.filter(Boolean).sort((a, b) => (a.date < b.date ? -1 : 1)).forEach((f) => {
    const levels = levelsForDay(f.rows, f.date, prev);
    got.push({ date: f.date, levels, intraday: !!f.intraday, slices: f.slices || null });
    prev = Object.assign({}, prev || {}, ...ENTITIES.filter((e) => levels[e.id]).map((e) => ({ [e.id]: levels[e.id] })));
  });
  const entities = ENTITIES.map((e) => {
    const series = got.filter((f) => f.levels[e.id]).map((f) => Object.assign({ date: f.date, bp: f.levels[e.id].bp, trades: f.levels[e.id].trades }, f.intraday ? { intraday: true } : {}));
    const latest = series[series.length - 1] || null;
    const lastFile = got.filter((f) => f.levels[e.id]).pop();
    return { id: e.id, name: e.name, red: e.red, tenor: '5Y', latest, last_trade: lastFile ? lastFile.levels[e.id].last_trade : null, series };
  });
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const anyIntraday = got.some((f) => f.intraday);
  res.setHeader('cache-control', !got.length ? 'public, s-maxage=120' : anyIntraday ? 'public, s-maxage=300, stale-while-revalidate=86400' : 'public, s-maxage=1800, stale-while-revalidate=86400');
  res.setHeader('access-control-allow-origin', '*');
  res.status(200).send(JSON.stringify({
    updated: new Date().toISOString(),
    source: 'DTCC Data Repository (U.S.) LLC, SEC public dissemination of security-based swaps',
    source_url: 'https://pddata.dtcc.com/ppd/secdashboard',
    files: got.map((f) => f.date),
    intraday: got.filter((f) => f.intraday).map((f) => ({ date: f.date, files: f.slices })),
    calibration: (() => { const full = got.filter((f) => !f.intraday && f.levels._calibration); const f = full[full.length - 1]; return f ? Object.assign({ date: f.date }, f.levels._calibration) : null; })(),
    entities,
    method: 'Median of the day’s new 5-year trades; quoted spreads used as reported, upfront prices converted with a flat-hazard model (40% recovery). Days marked intraday use the trades published so far that day.',
  }));
};
