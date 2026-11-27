// GET /api/og -> 1200x630 PNG share card (satori draws it, resvg rasterizes it): the official weekly reading plus live context.
// Used as og:image for the site and for every /s/<stamp> share link. On any failure it
// redirects to the static /og.png so a shared link never shows a broken card.
const fs = require('fs');
const path = require('path');
const { loadData, computeIndex, liveIndex, getLiveContext, MON, baseUrl } = require('./_acsi');

const C = { bg: '#09090a', card: '#111114', line: '#212125', line2: '#2b2b30', track: '#1b1b1f', fg: '#ededef', fg2: '#c4c4ca', muted: '#8a8a92', dim: '#5d5d65', green: '#45b08c', amber: '#d8a03d', orange: '#e2773f', red: '#e5534b' };
const BAND_C = { Calm: C.green, Elevated: C.amber, Stressed: C.orange, Distressed: C.red };

let FONTS = null;
const fonts = () => {
  if (FONTS) return FONTS;
  const f = (file) => fs.readFileSync(path.join(__dirname, '_fonts', file));
  FONTS = [
    { name: 'Inter', data: f('inter-latin-400-normal.woff'), weight: 400, style: 'normal' },
    { name: 'Inter', data: f('inter-latin-700-normal.woff'), weight: 700, style: 'normal' },
    { name: 'Inter', data: f('inter-latin-800-normal.woff'), weight: 800, style: 'normal' },
    { name: 'Mono', data: f('jetbrains-mono-latin-400-normal.woff'), weight: 400, style: 'normal' },
    { name: 'Mono', data: f('jetbrains-mono-latin-600-normal.woff'), weight: 600, style: 'normal' },
  ];
  return FONTS;
};

// Minimal element builder for satori: every div is a flex container.
const h = (type, style, ...children) => {
  const kids = children.flat().filter((c) => c !== null && c !== undefined && c !== false);
  const props = { style: type === 'div' ? Object.assign({ display: 'flex' }, style) : style };
  if (kids.length) props.children = kids.length === 1 ? kids[0] : kids;
  return { type, props };
};
const mono = (size, color, weight, extra) => Object.assign({ fontFamily: 'Mono', fontSize: size, color, fontWeight: weight || 400 }, extra || {});

const longDate = (iso) => { const d = new Date(iso + 'T00:00:00Z'); return d.getUTCDate() + ' ' + MON[d.getUTCMonth()].toUpperCase() + ' ' + d.getUTCFullYear(); };
const stamp = (iso) => {
  const d = new Date(iso);
  if (isNaN(d)) return null;
  const p = (n) => String(n).padStart(2, '0');
  return d.getUTCDate() + ' ' + MON[d.getUTCMonth()].toUpperCase() + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
};

const SIDE_W = 470;
function sideBlock(label, v, b) {
  const col = BAND_C[b] || C.dim;
  const fill = Math.round(SIDE_W * Math.max(0.5, Math.min(100, v || 0)) / 100);
  return h('div', { flexDirection: 'column', width: SIDE_W },
    h('div', mono(17, C.muted, 400, { letterSpacing: 2 }), label),
    h('div', { alignItems: 'center', marginTop: 6 },
      h('div', { fontFamily: 'Inter', fontWeight: 800, fontSize: 76, lineHeight: 1, letterSpacing: -3, color: C.fg }, v === null ? '—' : String(Math.round(v))),
      h('div', mono(18, C.dim, 400, { marginLeft: 8, marginTop: 26 }), '/100'),
      h('div', mono(16, col, 600, { marginLeft: 18, marginTop: 10, letterSpacing: 2, border: '1.5px solid ' + col, borderRadius: 8, padding: '4px 10px' }), b.toUpperCase())),
    h('div', { marginTop: 14, width: SIDE_W, height: 12, borderRadius: 6, backgroundColor: C.track },
      h('div', { width: fill, height: 12, borderRadius: 6, backgroundColor: col })));
}

function card(I, live) {
  const LV = live && live.cds ? liveIndex(I, live.cds) : null;
  const logo = h('svg', { width: 24, height: 24 }, { type: 'path', props: { d: 'M5 22 L12 15 L17 18.5 L27 8', stroke: C.green, strokeWidth: 3, fill: 'none', strokeLinecap: 'round', strokeLinejoin: 'round' } });
  logo.props.viewBox = '0 0 32 32';
  const stateCol = I.state === 'Aligned' || I.G === null ? C.muted : C.orange;
  const when = live && live.items.length ? stamp(live.updated) : null;
  const bottom = live && live.items.length
    ? h('div', { width: 1080, alignItems: 'center', flexWrap: 'wrap' },
        h('div', { alignItems: 'center', marginRight: 28 },
          h('div', { width: 12, height: 12, borderRadius: 6, backgroundColor: C.green, boxShadow: '0 0 0 5px rgba(69,176,140,.22)' }),
          h('div', mono(16, C.green, 600, { marginLeft: 13, letterSpacing: 1 }), 'LIVE' + (when ? ' · ' + when : ''))),
        live.items.map((it, i) => h('div', { alignItems: 'baseline', marginRight: i === live.items.length - 1 ? 0 : 28 },
          h('div', mono(16, C.muted, 400), it.label),
          h('div', mono(20, C.fg, 600, { marginLeft: 9 }), it.value))))
    : h('div', mono(17, C.muted, 400), 'Method ' + I.method + ' · weekly · data to ' + longDate(I.asOf));

  return h('div', { width: 1200, height: 630, backgroundColor: C.bg, color: C.fg, fontFamily: 'Inter', position: 'relative' },
   h('div', { position: 'absolute', left: 60, top: 46, width: 1080, height: 542, flexDirection: 'column' },
    h('div', { width: 1080, justifyContent: 'space-between', alignItems: 'center' },
      h('div', { alignItems: 'center' },
        h('div', { width: 40, height: 40, borderRadius: 10, backgroundColor: C.card, border: '1px solid ' + C.line2, alignItems: 'center', justifyContent: 'center' }, logo),
        h('div', mono(22, C.fg, 600, { marginLeft: 14, letterSpacing: 2 }), 'ACSI'),
        h('div', mono(18, C.dim, 400, { marginLeft: 14, letterSpacing: 2 }), 'AI CREDIT STRESS INDEX')),
      h('div', mono(18, C.muted, 400), 'aistress.si')),
    h('div', { width: 1080, flexGrow: 1, marginTop: 24 },
      h('div', { flexDirection: 'column', width: 562, justifyContent: 'center' },
        h('div', mono(18, LV ? C.green : C.muted, LV ? 600 : 400, { letterSpacing: 2 }), LV ? 'STRESS GAP · LIVE · ' + longDate(LV.date) : 'STRESS GAP · WEEKLY · ' + longDate(I.asOf)),
        h('div', { fontFamily: 'Inter', fontWeight: 800, fontSize: LV ? 172 : 190, lineHeight: 1, letterSpacing: LV ? -8 : -9, color: C.fg, marginTop: 4 }, LV ? LV.gapText : I.gapText),
        h('div', { fontFamily: 'Inter', fontWeight: 700, fontSize: 40, letterSpacing: -1, color: stateCol, marginTop: 6 }, LV ? LV.state : I.state),
        LV ? h('div', mono(17, C.muted, 400, { marginTop: 12, letterSpacing: 1 }), 'METHOD v0.2 · NO CEILING · ON v0.1 ' + LV.v01Text) : null),
      h('div', { width: 518, flexDirection: 'column', justifyContent: 'center', paddingLeft: 47, borderLeft: '1px solid ' + C.line },
        sideBlock('FINANCING STRESS · DEBT', LV ? LV.F : I.F, LV ? LV.Fb : I.Fb),
        h('div', { height: 34 }),
        sideBlock('GPU ASSET STRESS · RENTS', I.A, I.Ab))),
    h('div', { width: 1080, borderTop: '1px solid ' + C.line, paddingTop: 20, marginTop: 22 }, bottom)));
}

module.exports = async (req, res) => {
  try {
    const satori = require('satori').default || require('satori');
    const { Resvg } = require('@resvg/resvg-js');
    const I = computeIndex(loadData());
    const q = req.query || {};
    const live = q.live === '0' ? null : await getLiveContext(baseUrl(req));
    const svg = await satori(card(I, live), { width: 1200, height: 630, fonts: fonts() });
    const buf = new Resvg(svg, { fitTo: { mode: 'width', value: 1200 } }).render().asPng();
    res.statusCode = 200;
    res.setHeader('content-type', 'image/png');
    // A stamped share card (?v=) is a frozen moment: keep it at the edge for a week once it has
    // the full live row. If the live row came back short (cold caches), keep it briefly so the
    // next crawler fetch gets the fuller card.
    const full = !live || live.items.length >= 3;
    res.setHeader('cache-control', q.v && full
      ? 'public, max-age=3600, s-maxage=604800, stale-while-revalidate=604800'
      : 'public, s-maxage=120, stale-while-revalidate=3600');
    res.setHeader('content-length', String(buf.length));
    res.end(buf);
  } catch (e) {
    console.error('og card failed:', e && e.stack || e);
    res.statusCode = 302;
    res.setHeader('location', '/og.png');
    res.setHeader('cache-control', 'public, s-maxage=60');
    res.end();
  }
};
module.exports.card = card;
