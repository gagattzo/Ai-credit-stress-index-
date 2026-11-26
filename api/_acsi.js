// Shared helpers for the share card and share pages (files starting with "_" are not routes).
// The index arithmetic mirrors index.html exactly (method v0.1).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DAY = 864e5;
let DATA = null;

function loadData() {
  if (DATA) return DATA;
  const src = fs.readFileSync(path.join(__dirname, '..', 'data.js'), 'utf8');
  const ctx = { window: {} };
  vm.runInNewContext(src, ctx, { timeout: 1000 });
  DATA = ctx.window.ACSI_DATA;
  return DATA;
}

const band = (s) => (s < 25 ? 'Calm' : s < 50 ? 'Elevated' : s < 75 ? 'Stressed' : 'Distressed');

function computeIndex(D) {
  const ED = D.edition[0];
  const asOf = new Date(ED.as_of + 'T00:00:00Z');
  const loans = D.loan_prints.filter((l) => (asOf - new Date(l.date + 'T00:00:00Z')) / DAY <= 56)
    .map((l) => Number(l.price)).sort((a, b) => a - b);
  const n = loans.length;
  const loanMedian = n === 0 ? null : n % 2 ? loans[(n - 1) / 2] : (loans[n / 2 - 1] + loans[n / 2]) / 2;
  const loanDate = D.loan_prints.filter((l) => (asOf - new Date(l.date + 'T00:00:00Z')) / DAY <= 56).map((l) => l.date).sort().pop() || null;

  const scores = D.inputs.map((r) => {
    let raw = r.raw === null || r.raw === undefined || r.raw === '' ? null : Number(r.raw);
    let obs = r.obs_date;
    if (r.id === 'F3') { raw = loanMedian; obs = loanDate; }
    const calm = Number(r.calm), distress = Number(r.distress);
    const age = obs ? Math.round((asOf - new Date(obs + 'T00:00:00Z')) / DAY) : null;
    const excluded = raw === null || age === null || age > Number(r.window_days);
    const s = raw === null ? null : Math.max(0, Math.min(100, (100 * (raw - calm)) / (distress - calm)));
    return { id: r.id, side: r.side, score: s, excluded };
  });
  const live = (side) => scores.filter((r) => r.side === side && !r.excluded);
  const mean = (a) => a.reduce((t, r) => t + r.score, 0) / a.length;
  const fin = live('financing'), ast = live('asset');
  const F = fin.length >= 2 ? mean(fin) : null;
  const A = ast.some((r) => r.id === 'A1') ? mean(ast) : null;
  const G = F !== null && A !== null ? F - A : null;
  const dead = Number(ED.dead_band);
  const state = G === null ? 'Insufficient data' : G >= dead ? 'Stress sits in the debt' : G <= -dead ? 'Stress sits in the GPUs' : 'Aligned';
  const r0 = (v) => (v === null ? null : Math.round(v));
  const signed = (v) => (v === null ? '—' : (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v));
  return {
    asOf: ED.as_of, method: ED.method, label: ED.label,
    F, A, G, Fi: r0(F), Ai: r0(A), Gi: r0(G), gapText: signed(r0(G)),
    Fb: F === null ? 'Insufficient data' : band(F), Ab: A === null ? 'Insufficient data' : band(A), state,
    fin, dead, inputs: D.inputs,
  };
}

// ACSI Live, as on the page: the same method re-priced with the latest DTCC 5Y CDS levels.
// F2 takes Oracle's; F1 takes CoreWeave's as a live proxy for the bond spread (same anchors).
// Loans and GPU rents hold at the edition. Returns null when there is nothing to re-price.
function liveIndex(I, cds) {
  if (!cds || !Array.isArray(cds.entities) || I.A === null || !I.fin || I.fin.length < 2) return null;
  const ent = (id) => cds.entities.find((e) => e.id === id && e.latest);
  const o = ent('ORCL'), c = ent('CRWV');
  if (!o) return null;
  const sc = (id, raw) => { const r = I.inputs.find((x) => x.id === id); const calm = Number(r.calm), dis = Number(r.distress); return Math.max(0, Math.min(100, (100 * (raw - calm)) / (dis - calm))); };
  const s = I.fin.map((r) => (r.id === 'F1' && c ? sc('F1', c.latest.bp) : r.id === 'F2' ? sc('F2', o.latest.bp) : r.score));
  const F = s.reduce((t, v) => t + v, 0) / s.length, G = F - I.A;
  const one = (v) => (v >= 0.05 ? '+' : v <= -0.05 ? '\u2212' : '') + Math.abs(v).toFixed(1);
  const state = G >= I.dead ? 'Stress sits in the debt' : G <= -I.dead ? 'Stress sits in the GPUs' : 'Aligned';
  return { F, A: I.A, G, gapText: one(G), closeText: one(I.G), Fb: band(F), state, date: [o.latest.date, c && c.latest.date].filter(Boolean).sort().pop() };
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtDay = (iso) => { const d = new Date(String(iso).slice(0, 10) + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()]; };

// Live context for the card, read from this deployment's own cached endpoints. Never required.
// Kept short: X's crawler gives up on slow images, so a fast card beats a complete one.
async function getLiveContext(base, ms = 1800) {
  const get = async (p) => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try { const r = await fetch(base + p, { signal: ctrl.signal }); return r.ok ? await r.json() : null; }
    catch (e) { return null; } finally { clearTimeout(t); }
  };
  const [live, cds] = await Promise.all([get('/api/live'), get('/api/cds')]);
  const out = { updated: null, items: [] };
  const m0 = live && live.polymarket && live.polymarket.markets && live.polymarket.markets[0];
  if (m0 && typeof m0.yes === 'number') {
    out.items.push({ k: 'odds', label: 'CRWV bankruptcy odds ' + String(m0.deadline || '').slice(0, 4), long: 'CoreWeave bankruptcy odds by end-' + String(m0.deadline || '').slice(0, 4) + ' (Polymarket)', value: Math.round(m0.yes * 100) + '%' });
    out.updated = live.updated;
  }
  const ent = (id) => cds && Array.isArray(cds.entities) ? cds.entities.find((e) => e.id === id && e.latest) : null;
  const fmtBp = (v) => Math.round(v).toLocaleString('en-US') + ' bp';
  const cw = ent('CRWV'), oc = ent('ORCL');
  if (cw) out.items.push({ k: 'crwv', label: 'CRWV 5Y CDS', long: 'CoreWeave 5Y CDS ' + fmtBp(cw.latest.bp) + ' (' + fmtDay(cw.latest.date) + ')', value: fmtBp(cw.latest.bp) });
  if (oc) out.items.push({ k: 'orcl', label: 'ORCL 5Y CDS', long: 'Oracle 5Y CDS ' + fmtBp(oc.latest.bp) + ' (' + fmtDay(oc.latest.date) + ')', value: fmtBp(oc.latest.bp) });
  if (!out.updated && cds) out.updated = cds.updated;
  out.cds = cds;
  return out;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function baseUrl(req) {
  if (process.env.ACSI_BASE) return process.env.ACSI_BASE.replace(/\/$/, '');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'aistress.si').split(',')[0].trim();
  return (/^(localhost|127\.)/.test(host) ? 'http://' : 'https://') + host;
}

module.exports = { loadData, computeIndex, liveIndex, getLiveContext, fmtDay, esc, baseUrl, MON };
