// The same role on two or three job platforms.
//
// A job is a duplicate of another when the COMPANY and the TITLE match after
// normalising, and the other is on a different platform. Deliberately
// conservative: a missed duplicate costs you one look at two rows, while a false
// one would hide a real, different role. Duplicates are never dropped — only
// flagged, and kept from being auto-approved or applied to twice.
//
// Whether a job "is a duplicate" is computed on READ from the other rows' live
// state (approved? applied? when?), never stored on the row: a stored copy would
// go stale the moment the other platform applied.

const { keyOf } = require('./discovery/hiringCompanies');
const { labelOf, platformOfDoc } = require('./platforms');

// Words that say the same thing in different spellings. Only exact,
// unambiguous equivalents — "developer" is NOT folded into "engineer", because
// some companies hire both and mean different roles.
const SAME = [
  [/\bsr\.?(?=\s|$)/g, 'senior'],
  [/\bjr\.?(?=\s|$)/g, 'junior'],
  [/\bsde\b/g, 'software engineer'],
  [/\bswe\b/g, 'software engineer'],
  [/\bengg?\b/g, 'engineer'],
  [/\bmgr\b/g, 'manager'],
  [/\bdev ops\b/g, 'devops'],
  [/\bfront end\b/g, 'frontend'],
  [/\bback end\b/g, 'backend'],
  [/\bfull stack\b/g, 'fullstack'],
  [/\b1\b/g, 'i'], [/\b2\b/g, 'ii'], [/\b3\b/g, 'iii'], [/\b4\b/g, 'iv'],
];

// "Sr. Backend Engineer (Node.js) - Bangalore" → "senior backend engineer".
// Bracketed asides and a trailing location/team after " - " or " | " are
// dropped: sites append them differently to the very same role.
function normTitle(title) {
  let t = String(title || '').toLowerCase();
  t = t.replace(/\([^)]*\)|\[[^\]]*\]/g, ' ');
  t = t.split(/\s[-|–—]\s/)[0];
  t = t.replace(/[-/]/g, ' ').replace(/[^a-z0-9+#. ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [rx, to] of SAME) t = t.replace(rx, to);
  return t.replace(/\./g, '').replace(/\s+/g, ' ').trim();
}

// '' when either half is unknown — an empty company would make every untitled
// listing a duplicate of every other.
function dupKeyOf({ company, title } = {}) {
  const c = keyOf(company || '');
  // Hirist writes "Procore - Staff Full Stack Engineer": drop a leading
  // segment that is just the company's name, so the role is what is compared.
  let raw = String(title || '');
  const parts = raw.split(/\s[-|–—]\s/);
  if (parts.length > 1 && c) {
    const head = keyOf(parts[0]);
    if (head && (c.startsWith(head) || head.startsWith(c))) raw = parts.slice(1).join(' - ');
  }
  const t = normTitle(raw);
  return c && t ? `${c}:${t}` : '';
}

const SENT = ['applied', 'in-review', 'interviewing', 'offer', 'rejected'];

// The furthest along of a set of rows: applied beats approved beats pending.
function stateOf(row) {
  if (SENT.includes(row.applyStatus)) return 'applied';
  if (row.approval === 'approved' && ['none', 'failed', 'skipped'].includes(row.applyStatus)) return 'approved';
  if (row.approval === 'pending') return 'pending';
  return null;
}
const RANK = { applied: 3, approved: 2, pending: 1 };

/**
 * For each job, its most advanced copy on ANOTHER platform within the window:
 * { platform, label, state: 'applied'|'approved'|'pending', at, jobId }.
 * Jobs with no copy are left out of the map.
 */
async function dupesFor(NaukriJob, userId, jobs, { windowDays = 60, now = new Date() } = {}) {
  const keys = [...new Set(jobs.map(j => j.dupKey).filter(Boolean))];
  const out = new Map();
  if (!keys.length) return out;
  const since = new Date(now.getTime() - windowDays * 86400000);
  const others = await NaukriJob.find(
    { userId, dupKey: { $in: keys }, deleted: { $ne: true }, $or: [{ lastSeenAt: { $gte: since } }, { appliedAt: { $gte: since } }] },
    { dupKey: 1, platform: 1, approval: 1, applyStatus: 1, appliedAt: 1, approvedAt: 1 },
  ).lean();
  for (const j of jobs) {
    if (!j.dupKey) continue;
    const mine = platformOfDoc(j);
    let best = null;
    for (const o of others) {
      if (o.dupKey !== j.dupKey || platformOfDoc(o) === mine) continue;
      const state = stateOf(o);
      if (!state) continue;
      if (!best || RANK[state] > RANK[best.state]) {
        best = {
          platform: platformOfDoc(o), label: labelOf(platformOfDoc(o)), state,
          at: state === 'applied' ? o.appliedAt : state === 'approved' ? o.approvedAt : null,
          jobId: String(o._id),
        };
      }
    }
    if (best) out.set(String(j._id), best);
  }
  return out;
}

// The words the UI and the apply-time skip use.
function dupText(d) {
  if (!d) return '';
  const day = d.at ? new Date(d.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' }) : '';
  if (d.state === 'applied') return `Already applied via ${d.label}${day ? ` on ${day}` : ''}`;
  if (d.state === 'approved') return `Approved on ${d.label}`;
  return `Also on ${d.label}, not applied yet`;
}

// Whether a duplicate stops this job being auto-approved / applied to.
const blocksAuto = (d) => !!d && (d.state === 'applied' || d.state === 'approved');
const blocksApply = (d) => !!d && d.state === 'applied';

module.exports = { normTitle, dupKeyOf, dupesFor, dupText, blocksAuto, blocksApply, stateOf };
