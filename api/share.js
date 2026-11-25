// GET /s/<stamp> (rewritten to /api/share?id=<stamp>) -> a tiny page whose link preview is the
// live share card, then sends people on to the index. Each stamp is a new URL, so X, LinkedIn
// and Telegram fetch a fresh card instead of a cached one.
const { loadData, computeIndex, esc, baseUrl } = require('./_acsi');

module.exports = (req, res) => {
  const base = baseUrl(req);
  const id = String((req.query && req.query.id) || '').replace(/[^0-9A-Za-z-]/g, '').slice(0, 32) || 'latest';
  let title = 'AI Credit Stress Index';
  let desc = 'Where the stress in AI infrastructure sits: in the debt that financed the build-out, or in what the GPUs earn. Weekly, with live CDS and crowd odds.';
  try {
    const I = computeIndex(loadData());
    if (I.G !== null) {
      title = 'AI Credit Stress Index: gap ' + I.gapText + ', ' + I.state.toLowerCase();
      desc = 'Financing stress ' + I.Fi + ' (' + I.Fb + ') vs GPU asset stress ' + I.Ai + ' (' + I.Ab + '), weekly reading to ' + I.asOf + '. ' + desc;
    }
  } catch (e) { /* keep the generic text */ }
  const page = base + '/s/' + id;
  const img = base + '/api/og?v=' + encodeURIComponent(id);
  const html = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>' + esc(title) + '</title>'
    + '<meta name="description" content="' + esc(desc) + '">'
    + '<meta property="og:type" content="website">'
    + '<meta property="og:site_name" content="AI Credit Stress Index">'
    + '<meta property="og:title" content="' + esc(title) + '">'
    + '<meta property="og:description" content="' + esc(desc) + '">'
    + '<meta property="og:url" content="' + esc(page) + '">'
    + '<meta property="og:image" content="' + esc(img) + '">'
    + '<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">'
    + '<meta name="twitter:card" content="summary_large_image">'
    + '<meta name="twitter:title" content="' + esc(title) + '">'
    + '<meta name="twitter:description" content="' + esc(desc) + '">'
    + '<meta name="twitter:image" content="' + esc(img) + '">'
    + '<link rel="canonical" href="' + esc(base) + '/">'
    + '<meta http-equiv="refresh" content="0; url=/">'
    + '<style>body{background:#09090a;color:#c4c4ca;font:15px/1.5 system-ui,sans-serif;display:grid;place-items:center;height:100vh;margin:0}a{color:#ededef}</style>'
    + '</head><body><p>Opening the <a href="/">AI Credit Stress Index</a>…</p>'
    + '<script>location.replace("/")</script></body></html>';
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.setHeader('cache-control', 'public, s-maxage=86400');
  res.end(html);
};
