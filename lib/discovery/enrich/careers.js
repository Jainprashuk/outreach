// Open roles on the company's own careers page. Many companies list their jobs on a
// public applicant-tracking board (Greenhouse, Lever, Ashby, Workable) linked from
// their website; those boards have free, keyless APIs that list every open role.
//
// This only CHECKS a company already on the shortlist. It never adds companies to
// Discover — public job boards stay out of Hiring now, as decided for that view.

const { fetchText, fetchJson } = require('../../http');
const boards = require('../../boards');
const { familyOf } = require('../jobRoles');

const POINTS = 2;      // open roles like yours
const POINTS_ANY = 1;  // open roles, but you haven't said what you're after
const PAGES = ['/', '/careers', '/jobs', '/careers/'];

// Board links as they appear in a careers page's HTML.
const BOARD_LINKS = [
  { source: 'greenhouse', re: /(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board\?for=)?([A-Za-z0-9_-]+)/ },
  { source: 'lever', re: /jobs\.lever\.co\/([A-Za-z0-9_-]+)/ },
  { source: 'ashby', re: /jobs\.ashbyhq\.com\/([A-Za-z0-9_.-]+)/ },
  { source: 'workable', re: /apply\.workable\.com\/([A-Za-z0-9_-]+)/ },
];
const NOT_TOKENS = new Set(['embed', 'api', 'v1', 'jobs', 'j', 'careers']);

/** Pure: the first job-board link on these pages. */
function findBoard(htmls) {
  for (const html of htmls) {
    for (const b of BOARD_LINKS) {
      const m = String(html || '').match(b.re);
      if (m && m[1] && !NOT_TOKENS.has(m[1].toLowerCase())) return { source: b.source, token: m[1] };
    }
  }
  return null;
}

/** Pure: which titles look like the jobs you're after. No targets = any open role counts. */
function matching(titles, { families = [], terms = [] } = {}) {
  if (!families.length && !terms.length) return titles;
  const fam = new Set(families);
  return titles.filter(t => {
    const low = String(t || '').toLowerCase();
    return fam.has(familyOf(t)) || terms.some(term => term && low.includes(term));
  });
}

async function boardTitles({ source, token }, signal) {
  if (source === 'workable') {
    const res = await fetchJson(`https://apply.workable.com/api/v1/widget/accounts/${encodeURIComponent(token)}`, { timeoutMs: 8_000, retries: 1, signal });
    if (!res.ok || !res.data || !Array.isArray(res.data.jobs)) return null;
    return res.data.jobs.map(j => String(j.title || '')).filter(Boolean);
  }
  const adapter = boards.getAdapter(source);
  if (!adapter) return null;
  const r = await adapter.fetchBoard(token, { signal });
  if (r.kind === 'empty') return [];
  if (r.kind !== 'ok') return null;
  return r.postings.map(p => String(p.title || '')).filter(Boolean);
}

/**
 * @param {{company: string, domain: string|null}} c
 * @param {{families?: string[], terms?: string[], signal?: AbortSignal}} ctx  what you're looking for
 */
async function checkCareers(c, { families = [], terms = [], signal } = {}) {
  if (!c.domain) return { status: 'skipped', points: 0, reasons: [], note: 'Careers check needs the company’s domain' };
  const htmls = [];
  let reached = false;
  for (const host of [`https://${c.domain}`, `https://www.${c.domain}`]) {
    for (const path of PAGES) {
      const res = await fetchText(`${host}${path}`, { timeoutMs: 6_000, signal });
      if (res.ok && res.data) { reached = true; htmls.push(res.data); }
      const found = findBoard(htmls);
      if (found) return judgeBoard(c, found, await boardTitles(found, signal), { families, terms });
    }
    if (reached) break;
  }
  if (!reached) return { status: 'error', points: 0, reasons: [], note: 'Careers page unreachable' };
  return { status: 'none', points: 0, reasons: [], note: 'No public job board linked from the website' };
}

/** Pure: a board's titles → a signal. */
function judgeBoard(c, board, titles, targets) {
  if (titles === null) return { status: 'error', points: 0, reasons: [], note: 'Job board unavailable' };
  const hits = matching(titles, targets);
  const url = boards.SOURCE_META && boards.SOURCE_META[board.source] ? boards.SOURCE_META[board.source].boardUrl(board.token) : `https://apply.workable.com/${board.token}`;
  if (!hits.length) return { status: 'none', points: 0, reasons: [], note: `${titles.length} open roles, none like yours` };
  const like = targets.families.length || targets.terms.length;
  return {
    status: 'ok', points: like ? POINTS : POINTS_ANY,
    reasons: [{ text: `${hits.length} open ${hits.length === 1 ? 'role' : 'roles'}${like ? ' like yours' : ''} on their careers page (e.g. "${hits[0]}")`, url }],
  };
}

module.exports = { checkCareers, findBoard, matching, judgeBoard, POINTS, POINTS_ANY };
