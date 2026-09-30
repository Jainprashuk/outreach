/**
 * Parity check for GET /api/contacts?view=analytics. READ-ONLY — it never writes.
 *
 * The Analytics code is unchanged; it is now fed contacts carrying only
 * ANALYTICS_FIELDS instead of whole contacts. This proves that is safe:
 *   1. every field the analytics functions read (recorded with a Proxy while
 *      they run over the full contacts) is in the projection, with the page's
 *      own reads (id, name, company, email, status, template, dates) on top;
 *   2. every number and series the page shows comes out identical from the
 *      slim contacts and from the full ones.
 *
 *   node scripts/parity/analytics-view.js
 *   TZ=Asia/Kolkata NODE_ENV=prod node scripts/parity/analytics-view.js
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const mongoose = require('mongoose');
const Contact = require('../../models/Contact');
const Interview = require('../../models/Interview');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

// Must match routes/contacts.js ANALYTICS_FIELDS.
const ANALYTICS_FIELDS = {
  name: 1, email: 1, company: 1, status: 1, template: 1, statusHistory: 1,
  lastSentAt: 1, repliedAt: 1, followUpSentAt: 1, createdAt: 1, updatedAt: 1,
};
// Read directly by pages/Analytics.tsx render code (grep of a.c.* / e.c.* / c.*).
const PAGE_READS = ['id', 'name', 'company', 'email', 'status', 'template', 'lastSentAt', 'followUpSentAt'];

function loadLib() {
  const esbuild = require(path.join(__dirname, '../../client/node_modules/esbuild'));
  const out = path.join(os.tmpdir(), `analytics-ref-${process.pid}.cjs`);
  esbuild.buildSync({ entryPoints: [path.join(__dirname, 'reference/analyticsEntry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
  const lib = require(out); fs.unlinkSync(out); return lib;
}

const serialize = (doc) => { const o = { ...doc }; o.id = doc._id.toString(); delete o._id; delete o.__v; return o; };
const asBrowser = docs => JSON.parse(JSON.stringify(docs.map(serialize)));

// Everything Analytics.tsx derives from A, reduced to plain comparable values.
function pageOutputs(L, contacts, interviews) {
  const A = contacts.map(L.analyze);
  const iv = L.interviewFunnel(contacts, L.indexInterviews(interviews), 'contact', c => c.email);
  const count = (f) => Object.entries(A.reduce((acc, a) => { const k = f(a); if (k != null) acc[k] = (acc[k] || 0) + 1; return acc; }, {})).sort();
  return {
    metrics: L.computeMetrics(A),
    series30: L.buildDailySeries(A, 30), series90: L.buildDailySeries(A, 90),
    pairs: A.flatMap(a => a.pairs).sort((a, b) => a - b),
    events: L.buildActivityEvents(A, interviews).map(e => [e.t, e.type, e.note, !!e.countOnly, e.c.id, e.c.name, e.c.company]),
    funnel: { ...iv, records: iv.records.map(r => r.id) },
    statusNow: count(a => a.c.status),
    statusEver: Object.keys(L.STATUS_META).map(s => [s, A.filter(a => a.ever.has(s)).length]),
    journey: count(a => (a.everReplied ? a.outcome : null)),
    templates: count(a => (a.everSent ? `${a.c.template || '—'}|${a.everReplied}` : null)),
    companies: count(a => { const co = (a.c.company || '').trim(); return co ? `${co}|${a.everReplied}` : null; }),
    perContact: A.map(a => [a.c.id, a.everSent, a.everReplied, a.everFollowUp, a.everBounced, a.repliedAfterFu, a.outcome,
      [...a.ever].sort().join(), a.sends.length, a.replies.length, a.c.lastSentAt, a.c.followUpSentAt]),
  };
}

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${env.toUpperCase()} is not set`);
  const L = loadLib();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log(`Parity (read-only) against ${env} / ${mongoose.connection.db.databaseName}`);

  const userIds = await Contact.distinct('userId', { deleted: { $ne: true } });
  for (const userId of userIds) {
    const base = { deleted: { $ne: true }, userId };
    const [fullDocs, slimDocs, ivDocs] = await Promise.all([
      Contact.find(base, { 'thread.html': 0 }).sort({ createdAt: -1 }).lean(),
      Contact.find(base, ANALYTICS_FIELDS).sort({ createdAt: -1 }).lean(),
      Interview.find({ userId, deleted: { $ne: true } }, { 'cv.data': 0, 'jd.data': 0 }),
    ]);
    const full = asBrowser(fullDocs), slim = asBrowser(slimDocs);
    const interviews = JSON.parse(JSON.stringify(ivDocs.map(d => d.toJSON())));

    // 1. Which fields does the analytics code actually read?
    const read = new Set();
    const spied = full.map(c => new Proxy(c, { get(t, k) { if (typeof k === 'string') read.add(k); return t[k]; } }));
    pageOutputs(L, spied, interviews);
    const allowed = new Set(['id', ...Object.keys(ANALYTICS_FIELDS)]);
    const missing = [...read, ...PAGE_READS].filter(k => !allowed.has(k) && k !== 'toJSON' && k !== 'constructor');
    assert.deepStrictEqual(missing, [], `analytics reads fields outside the projection: ${missing}`);

    // 2. Same output from slim and full.
    assert.deepStrictEqual(pageOutputs(L, slim, interviews), pageOutputs(L, full, interviews), `user ${userId}: analytics output differs`);
    const kb = x => (JSON.stringify(x).length / 1024).toFixed(0);
    console.log(`✅  user ${userId}: ${full.length} contacts identical; fields read: ${[...read].sort().join(', ')} (${kb(full)} KB → ${kb(slim)} KB)`);
  }
  await mongoose.disconnect();
  console.log('Analytics view check passed.');
})().catch(async (err) => {
  console.error('❌ ', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
