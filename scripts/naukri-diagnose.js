#!/usr/bin/env node
/**
 * Where is the Naukri flow losing applications? READ-ONLY — safe against any
 * database, prod included.
 *
 *   node scripts/naukri-diagnose.js --email=you@example.com              # dev
 *   NODE_ENV=prod node scripts/naukri-diagnose.js --email=...            # prod (reads only)
 *   node scripts/naukri-diagnose.js --email=... --days=7
 *
 * Prints, for the window:
 *   1. runs by kind and status, with the most common error lines
 *   2. apply outcomes by reason (company site / unanswered question / failed / applied)
 *   3. the review funnel: harvested → approved → applied
 *   4. the most common unanswered screening questions
 *
 * Connects with mongoose directly, never through db.js — that would seed and run
 * backfills against whichever database it touches.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const EMAIL = value('email');
const DAYS = Number(value('days')) || 30;
const PROD = process.env.NODE_ENV === 'prod';
const URI = PROD ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—');
const pad = (s, n) => String(s).padEnd(n);

// One bucket per reason the worker gives, so the table reads as "where it went".
function reasonBucket(job) {
  const note = String(job.applyNote || '').toLowerCase();
  if (job.unknownQuestion) return 'skipped: unanswered question';
  if (/company site/.test(note)) return 'skipped: company site';
  if (/already applied/.test(note)) return 'skipped: already applied';
  if (/set aside/.test(note)) return 'skipped: set aside by you';
  if (job.applyStatus === 'skipped') return 'skipped: other';
  if (job.applyStatus === 'failed') {
    if (/questionnaire/.test(note)) return 'failed: questionnaire stuck';
    if (/never confirmed/.test(note)) return 'failed: no confirmation';
    if (/did not finish within/.test(note)) return 'failed: timed out';
    if (/no apply button/.test(note)) return 'failed: no apply button';
    return 'failed: other';
  }
  return job.applyStatus;
}

async function main() {
  if (!EMAIL) { console.error('Usage: node scripts/naukri-diagnose.js --email=you@example.com [--days=30]'); process.exit(1); }
  if (!URI) { console.error(`${PROD ? 'MONGODB_URI_PROD' : 'MONGODB_URI_DEV'} is not set`); process.exit(1); }

  await mongoose.connect(URI);
  const db = mongoose.connection.db;
  const user = await db.collection('users').findOne({ email: EMAIL.toLowerCase() });
  if (!user) { console.error(`No user ${EMAIL}`); process.exit(1); }
  const userId = user._id;
  const since = new Date(Date.now() - DAYS * 86400000);
  const live = { userId, deleted: { $ne: true } };

  console.log(`Naukri — ${EMAIL} — last ${DAYS} days (${PROD ? 'PROD' : 'dev'}, read-only)\n`);

  // 1. Runs
  const runs = await db.collection('naukriruns').find({ ...live, createdAt: { $gte: since } }).toArray();
  const byKind = {};
  const errors = {};
  for (const r of runs) {
    const k = (byKind[r.kind] ||= {});
    k[r.status] = (k[r.status] || 0) + 1;
    if (r.error) {
      const line = String(r.error).split('\n')[0].replace(/\d+/g, 'N').slice(0, 140);
      errors[line] = (errors[line] || 0) + 1;
    }
  }
  console.log('1. Runs');
  for (const [kind, s] of Object.entries(byKind)) {
    const total = Object.values(s).reduce((a, b) => a + b, 0);
    console.log(`   ${pad(kind, 9)} ${total} total — ${Object.entries(s).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  }
  if (!runs.length) console.log('   (none)');
  const topErrors = Object.entries(errors).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (topErrors.length) {
    console.log('   Most common errors:');
    for (const [line, n] of topErrors) console.log(`     ${String(n).padStart(3)}×  ${line}`);
  }
  const applyRuns = runs.filter(r => r.kind === 'apply' && r.status === 'done');
  const granted = applyRuns.reduce((a, r) => a + (r.stats?.applied || 0) + (r.stats?.skipped || 0) + (r.stats?.failed || 0), 0);
  const appliedInRuns = applyRuns.reduce((a, r) => a + (r.stats?.applied || 0), 0);
  console.log(`   Apply runs spent ${granted} attempts; ${appliedInRuns} became applications (${pct(appliedInRuns, granted)}).\n`);

  // 2. Outcomes by reason, for jobs touched in the window
  const touched = await db.collection('naukrijobs').find({
    ...live, applyStatus: { $ne: 'none' }, updatedAt: { $gte: since },
  }).project({ applyStatus: 1, applyNote: 1, unknownQuestion: 1, retryable: 1, likelyExternal: 1, applyHistory: 1 }).toArray();
  const buckets = {};
  let retries = 0;
  for (const j of touched) {
    const b = reasonBucket(j);
    buckets[b] = (buckets[b] || 0) + 1;
    // Attempts beyond the first on the same job: budget spent going round again.
    const attempts = (j.applyHistory || []).filter(h => ['applied', 'skipped', 'failed'].includes(h.to)).length;
    if (attempts > 1) retries += attempts - 1;
  }
  console.log('2. Outcomes (jobs the worker reached)');
  for (const [b, n] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
    console.log(`   ${pad(b, 32)} ${String(n).padStart(4)}  ${pct(n, touched.length)}`);
  }
  if (!touched.length) console.log('   (none)');
  console.log(`   Repeat attempts on the same job: ${retries}\n`);

  // 3. Funnel for jobs first seen in the window
  const funnel = await db.collection('naukrijobs').aggregate([
    { $match: { ...live, firstSeenAt: { $gte: since } } },
    { $group: {
        _id: null,
        harvested: { $sum: 1 },
        pending: { $sum: { $cond: [{ $eq: ['$approval', 'pending'] }, 1, 0] } },
        approved: { $sum: { $cond: [{ $eq: ['$approval', 'approved'] }, 1, 0] } },
        rejected: { $sum: { $cond: [{ $eq: ['$approval', 'rejected'] }, 1, 0] } },
        applied: { $sum: { $cond: [{ $in: ['$applyStatus', ['applied', 'in-review', 'interviewing', 'offer', 'rejected']] }, 1, 0] } },
        likelyExternal: { $sum: { $cond: ['$likelyExternal', 1, 0] } },
    } },
  ]).toArray();
  const f = funnel[0] || {};
  console.log('3. Funnel (jobs first seen in the window)');
  console.log(`   harvested ${f.harvested || 0} → approved ${f.approved || 0} (${pct(f.approved, f.harvested)}) → applied ${f.applied || 0} (${pct(f.applied, f.approved)} of approved)`);
  console.log(`   still pending review ${f.pending || 0} · rejected ${f.rejected || 0} · flagged company-site ${f.likelyExternal || 0}\n`);

  // 4. Unanswered questions
  const questions = await db.collection('naukrijobs').aggregate([
    { $match: { ...live, applyStatus: 'skipped', unknownQuestion: { $nin: [null, ''] } } },
    { $group: { _id: '$unknownQuestion', n: { $sum: 1 } } },
    { $sort: { n: -1 } }, { $limit: 20 },
  ]).toArray();
  console.log('4. Unanswered screening questions (all time, most common first)');
  for (const q of questions) console.log(`   ${String(q.n).padStart(3)}×  ${q._id.slice(0, 120)}`);
  if (!questions.length) console.log('   (none)');

  await mongoose.disconnect();
}

main().catch((err) => { console.error(err); process.exit(1); });
