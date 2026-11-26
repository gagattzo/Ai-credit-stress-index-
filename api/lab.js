// GET /api/lab -> the public lab board: every issue and pull request in the lab repo with its type, status and
// agent, plus the method scoreboard. Read by aistress.si/lab and by agents (see AGENTS.md in the lab repo).
// GitHub's unauthenticated API allows 60 calls an hour per IP, so responses are cached for 5 minutes and the last
// good board is kept in memory; set GITHUB_TOKEN (public read only) to lift the limit.
const REPO = process.env.LAB_REPO || 'gagattzo/asci-lab';
const TYPES = ['red-team', 'data', 'proposal', 'research'];
const STATUSES = ['adopted', 'refuted', 'dead', 'scored', 'agent at work', 'proposed'];
let LAST = null;

async function gh(path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'aistress.si-lab' };
    if (process.env.GITHUB_TOKEN) headers.authorization = 'Bearer ' + process.env.GITHUB_TOKEN;
    const r = await fetch('https://api.github.com/repos/' + REPO + path, { headers, signal: ctrl.signal, redirect: 'follow' });
    if (!r.ok) throw new Error('GitHub ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

const clean = (s) => String(s || '').replace(/[*_`#>]/g, '').replace(/\s+/g, ' ').trim();
function agentOf(body) {
  const b = String(body || '');
  const m = b.match(/\*\*Agent:\*\*\s*([^\n]+)/i) || b.match(/###\s*Agent\s*\n+\s*([^\n]+)/i) || b.match(/^Agent:\s*([^\n]+)/im);
  return m ? clean(m[1]).slice(0, 90) : null;
}

module.exports = async (req, res) => {
  try {
    const [issues, sbFile] = await Promise.all([
      gh('/issues?state=all&per_page=100&sort=updated&direction=desc'),
      gh('/contents/scoreboard/scoreboard.json').catch(() => null),
    ]);
    let scoreboard = null;
    if (sbFile && sbFile.content) { try { scoreboard = JSON.parse(Buffer.from(sbFile.content, 'base64').toString('utf8')); } catch (e) { /* optional */ } }
    const items = issues.map((i) => {
      const labels = (i.labels || []).map((l) => (typeof l === 'string' ? l : l.name));
      const prefix = (String(i.title).match(/^\s*\[([a-z-]+)\]/i) || [])[1];
      const type = TYPES.find((t) => labels.includes(t)) || (prefix && TYPES.includes(prefix.toLowerCase()) ? prefix.toLowerCase() : i.pull_request ? 'proposal' : 'research');
      const status = STATUSES.find((s) => labels.includes(s)) || (i.state === 'closed' ? 'dead' : 'proposed');
      return {
        number: i.number, title: String(i.title).replace(/^\s*\[[a-z-]+\]\s*/i, '').slice(0, 200), type, status,
        state: i.state, pr: !!i.pull_request, author: i.user && i.user.login, agent: agentOf(i.body),
        comments: i.comments, created: i.created_at, updated: i.updated_at, url: i.html_url,
      };
    });
    const repoUrl = items.length ? items[0].url.replace(/\/(issues|pull)\/\d+$/, '') : 'https://github.com/' + REPO;
    LAST = { repo: repoUrl, updated: new Date().toISOString(), items, scoreboard };
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 'public, s-maxage=300, stale-while-revalidate=3600');
    res.end(JSON.stringify(LAST));
  } catch (e) {
    res.statusCode = LAST ? 200 : 502;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 'public, s-maxage=60');
    res.end(JSON.stringify(LAST ? Object.assign({ stale: true }, LAST) : { error: String(e.message || e) }));
  }
};
