// GET /api/tape
// The latest single-name CDS trades as DTCC publishes them under the SEC's swap rules (Regulation SBSR),
// read from DTCC's public ticker (the feed behind https://pddata.dtcc.com/ppd/secdashboard), newest first.
// Trades in AI-infrastructure names are flagged. Shown as context; nothing here feeds the index.

const TIMEOUT_MS = 10000;
const UA = 'ACSI/0.4 (AI Credit Stress Index; +https://github.com/gagattzo/ai-credit-stress-index-)';
const SRC = 'https://pddata.dtcc.com/ppd/api/ticker/SEC/CREDITS';

// Reference entities we follow, by RED code, by the issuer part of a reference bond's ISIN (chars 3-8 = CUSIP issuer),
// and by name. Index names first.
const AI = [
  { name: 'CoreWeave', key: 'CRWV', red: ['239FAV'], cusip: [], re: /COREWEAVE/ },
  { name: 'Oracle', key: 'ORCL', red: ['6EC42L'], cusip: ['68389X'], re: /\bORACLE\b/ },
  { name: 'Meta Platforms', key: 'META', red: ['UZEAAG'], cusip: ['30303M'], re: /META PLATFORMS/ },
  { name: 'Nvidia', key: 'NVDA', red: ['6D76CM'], cusip: ['67066G'], re: /\bNVIDIA\b|^NVDA\b/ },
  { name: 'Microsoft', key: 'MSFT', red: [], cusip: ['594918'], re: /\bMICROSOFT\b/ },
  { name: 'Amazon', key: 'AMZN', red: [], cusip: ['023135'], re: /\bAMAZON\b/ },
  { name: 'Alphabet', key: 'GOOGL', red: [], cusip: ['02079K'], re: /\bALPHABET\b|\bGOOGLE\b/ },
  { name: 'Broadcom', key: 'AVGO', red: [], cusip: ['11135F'], re: /\bBROADCOM\b/ },
  { name: 'Intel', key: 'INTC', red: [], cusip: ['458140'], re: /\bINTEL CORP/ },
  { name: 'AMD', key: 'AMD', red: [], cusip: ['007903'], re: /ADVANCED MICRO DEVICES/ },
  { name: 'Equinix', key: 'EQIX', red: [], cusip: ['29444U'], re: /\bEQUINIX\b/ },
  { name: 'Digital Realty', key: 'DLR', red: [], cusip: ['25389J'], re: /DIGITAL REALTY/ },
];
const INDEX_KEYS = new Set(['CRWV', 'ORCL', 'META']);
const ISIN = /^[A-Z]{2}[A-Z0-9]{9}\d$/;

function cleanName(raw) {
  let s = String(raw || '').toUpperCase().replace(/;/g, ', ').replace(/\s+/g, ' ').trim();
  s = s.replace(/\s+CDS\s+USD.*$/, '').replace(/\s+(SR|SUB)\s+(NT|NTS|BD|UNSEC).*$/, '').replace(/\s+(GLOBAL\s+)?(BD|BDS|NT|NTS)\b.*$/, '').replace(/\s+144A\b.*$/, '');
  s = s.replace(/,?\s+(INC|INCORPORATED|CORPORATION|CORP|COMPANY|CO|LLC|L\.L\.C|PLC|S\.P\.A|SPA|AG|AKTIENGESELLSCHAFT|SA|S\.A|NV|N\.V|LTD|LIMITED|LP|L\.P)\.?$/, '').replace(/,\s*$/, '');
  return s.length > 34 ? s.slice(0, 33) + '…' : s;
}

// Identifier fields can hold an ISIN, a 6-character RED entity code, a 9-character RED pair code, or several of these
// separated by ';'.
function identify(r) {
  const nm = String(r.underlyingAssetName || '').toUpperCase().trim();
  const toks = [nm, String(r.underlierIDLeg1 || '').toUpperCase()].join(';').split(';').map((t) => t.trim()).filter(Boolean);
  const isins = toks.filter((t) => ISIN.test(t));
  const reds = toks.filter((t) => !ISIN.test(t) && /^[0-9A-Z]{6}([0-9A-Z]{3})?$/.test(t)).map((t) => t.slice(0, 6));
  const named = nm && !ISIN.test(nm) && !nm.split(';').every((t) => /^[0-9A-Z]{6}([0-9A-Z]{3})?$/.test(t.trim()) || ISIN.test(t.trim()));
  for (const a of AI) {
    if (reds.some((x) => a.red.includes(x)) || isins.some((x) => a.cusip.includes(x.slice(2, 8))) || (named && a.re.test(nm))) {
      return { name: a.name, key: a.key, ai: true, index: INDEX_KEYS.has(a.key) };
    }
  }
  if (named) return { name: cleanName(nm), ai: false };
  if (isins.length) return { name: 'ISIN ' + isins[0], ai: false };
  return { name: reds.length ? 'RED ' + reds[0] : 'UNNAMED', ai: false };
}

const num = (v) => { const n = Number(String(v == null ? '' : v).replace(/[,+]/g, '')); return Number.isFinite(n) ? n : null; };

const { model } = require('./cds');
// Names that trade well wide of their standard coupon (CoreWeave on 5%, Oracle on 1%): a clearly one-sided upfront
// (2% or more) is paid by the protection buyer, so it converts to a spread without a reference level.
const CONVERT = new Set(['CRWV', 'ORCL']);

function terms(r, who) {
  const spread = num(r.spreadLeg1);
  let cpn = num(r.fixedRateLeg1);
  if (cpn !== null && cpn >= 0.5) cpn = cpn / 100; // some records give the coupon in percent
  if (cpn !== null && !(cpn > 0 && cpn <= 0.1)) cpn = null; // standard CDS coupons are 0.25% to 10%
  const capped = /\+/.test(String(r.notionalAmountLeg1 || ''));
  const N = num(r.notionalAmountLeg1), amt = num(r.otherPaymentAmount);
  const out = { coupon_pct: cpn !== null ? Math.round(cpn * 10000) / 100 : null };
  // The spread field sometimes carries a price or a mis-scaled value; only plausible spreads (10 to 2,000 bp) are shown.
  if (spread !== null && spread >= 0.001 && spread < 0.2) out.spread_bp = Math.round(spread * 10000);
  else if (!capped && N && amt !== null && /UFRO/.test(r.otherPaymentType || '')) {
    const pct = amt / N;
    out.upfront_pct = Math.round(pct * 10000) / 100;
    if (who && CONVERT.has(who.key) && cpn && Math.abs(pct) >= 0.02) {
      const exec = Date.parse(r.executionTimestamp), exp = Date.parse(r.expirationDate + 'T00:00:00Z'), D = 864e5;
      if (!Number.isNaN(exec) && !Number.isNaN(exp) && exp > exec + D) {
        const T = (exp - exec - D) / (365.25 * D), accr = (exec + D - model.lastIMM(exec)) / (360 * D);
        const s = model.spreadFromUpfront(Math.abs(pct), cpn, T, accr);
        if (s > 0 && s < 1) out.implied_spread_bp = Math.round(s * 10000);
      }
    }
  }
  return out;
}

function sizeText(v) {
  const s = String(v || ''), capped = s.includes('+'), n = num(s);
  if (n === null) return '—';
  const t = n >= 1e6 ? (n / 1e6).toFixed(n % 1e6 ? 1 : 0).replace(/\.0$/, '') + 'M' : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);
  return '$' + t + (capped ? '+' : '');
}

function tenorYears(exec, exp) {
  const a = Date.parse(exec), b = Date.parse(exp + 'T00:00:00Z');
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round(((b - a) / (365.25 * 864e5)) * 4) / 4;
}

module.exports = async (req, res) => {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let list = null;
  try {
    const r = await fetch(SRC, { signal: ctrl.signal, headers: { 'user-agent': UA, accept: 'application/json' } });
    if (r.ok) { const j = await r.json(); list = Array.isArray(j.tradeList) ? j.tradeList : null; }
  } catch (e) { list = null; } finally { clearTimeout(timer); }

  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('access-control-allow-origin', '*');
  if (!list) {
    res.setHeader('cache-control', 'public, s-maxage=15');
    res.status(200).send(JSON.stringify({ updated: new Date().toISOString(), trades: [], error: 'DTCC ticker unavailable' }));
    return;
  }
  const trades = list
    .filter((r) => r.actionType === 'NEWT' && /^NA\/CDS\b/.test(r.uniqueProductIdentifierShortName || '') && !/\bTRS\b|DDTL|_LOAN_/i.test(r.underlyingAssetName || ''))
    .map((r) => {
      const who = identify(r);
      return Object.assign({
        id: r.disseminationIdentifier,
        executed: r.executionTimestamp,
        published: r.disseminationTimestamp,
        entity: who.name,
        key: who.key || null,
        ai: who.ai,
        index_name: !!who.index,
        sovereign: /Sov/.test(r.uniqueProductIdentifierShortName || ''),
        tenor_y: tenorYears(r.executionTimestamp, r.expirationDate),
        maturity: r.expirationDate,
        size: sizeText(r.notionalAmountLeg1),
      }, terms(r, who));
    })
    .filter((t) => t.entity !== 'UNNAMED')
    .sort((a, b) => (a.published < b.published ? 1 : a.published > b.published ? -1 : 0))
    .slice(0, 40);

  res.setHeader('cache-control', 'public, s-maxage=20, stale-while-revalidate=60');
  res.status(200).send(JSON.stringify({
    updated: new Date().toISOString(),
    source: 'DTCC Data Repository (U.S.) LLC, SEC public dissemination of security-based swaps (real-time ticker)',
    source_url: 'https://pddata.dtcc.com/ppd/secdashboard',
    trades,
  }));
};
