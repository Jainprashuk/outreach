#!/usr/bin/env node
/**
 * Analytics → Naukri (lib/naukriAnalytics.js), the Naukri block in reports
 * (lib/reportStats.js naukriPeriod) and the reason groups (lib/naukriReasons.js).
 *
 * Runs against a THROWAWAY database, `outreach_naukri_analytics_test`, on the DEV
 * cluster (MONGODB_URI_DEV with the database name swapped), created and dropped
 * here. Seeds one account's jobs, runs and config, plus a second account whose
 * rows must never be counted.
 *
 *   node scripts/test-naukri-analytics.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const NaukriJob = require('../models/NaukriJob');
const NaukriRun = require('../models/NaukriRun');
const NaukriConfig = require('../models/NaukriConfig');
const { naukriAnalytics } = require('../lib/naukriAnalytics');
const { buildReportStats } = require('../lib/reportStats');
const { reasonGroup } = require('../lib/naukriReasons');

const TEST_DB = 'outreach_naukri_analytics_test';
const uri = () => {
  const base = process.env.MONGODB_URI_DEV;
  if (!base) throw new Error('MONGODB_URI_DEV is not set');
  const u = new URL(base);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
};

let passed = 0, failed = 0;
const ok = (cond, label, detail = '') => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}${detail ? `  << ${detail}` : ''}`); }
};
const DAY = 864e5;
const ago = (d) => new Date(Date.now() - d * DAY);

async function main() {
  console.log('\nreason groups');
  const cases = [
    ['Applied', 'applied'], ['Applied after 2 question(s) — 1 answered by AI', 'applied'],
    ['Naukri says you have already applied to this job', 'already-applied'],
    ['Applies on the company site — open it yourself', 'company-site'],
    ['Walk-in drive — Naukri only offers…', 'walk-in'],
    ['Listing closed or removed — Naukri no longer takes applications', 'closed'],
    ['Unanswered screening question — answer it under Jobs → Needs answer', 'question'],
    ['No Apply button on the listing (login page)', 'no-button'], ['Apply button vanished before it could be clicked.', 'no-button'],
    ['Questionnaire could not be completed: radio not found', 'questionnaire'],
    ['Clicked Apply but Naukri never confirmed. Check this one by hand', 'unconfirmed'],
    ['set aside by you', 'set-aside'], ['"IT Intern" did not finish within 90s', 'timeout'],
    ['TypeError: x is undefined', 'other'], ['', 'other'], [null, 'other'],
  ];
  for (const [text, want] of cases) ok(reasonGroup(text) === want, `${JSON.stringify(text)} → ${want}`, reasonGroup(text));

  await mongoose.connect(uri(), { serverSelectionTimeoutMS: 10000 });
  if (mongoose.connection.name !== TEST_DB) throw new Error(`refusing to run on ${mongoose.connection.name}`);
  await mongoose.connection.dropDatabase();

  const me = new mongoose.Types.ObjectId();
  const other = new mongoose.Types.ObjectId();
  let seq = 0;
  const job = (o) => ({ userId: me, sourceId: String(++seq), sourceKey: `naukri:${seq}`, title: `Job ${seq}`, ...o });
  const hist = (d, to, note) => ({ at: ago(d), from: 'none', to, note });

  await NaukriJob.insertMany([
    // pending, scored 85 (bucket 80), from a search
    job({ score: 85, origins: ['search'], queries: ['react'] }),
    // pending, unscored
    job({ origins: ['recommended'] }),
    // approved by auto, waiting to send
    job({ approval: 'approved', approvedBy: 'auto', approvedAt: ago(2), score: 92, origins: ['recommended'] }),
    // applied 3 days ago, recruiter shortlisted 1 day later
    job({ approval: 'approved', approvedBy: 'you', applyStatus: 'applied', appliedAt: ago(3), score: 55, origins: ['search'], queries: ['react', 'frontend'],
      naukriStage: 'shortlisted', naukriStageAt: ago(2), trackedAt: ago(0), applyHistory: [hist(3, 'applied', 'Applied')] }),
    // applied 1 day ago, viewed after 12 hours
    job({ approval: 'approved', approvedBy: 'you', applyStatus: 'in-review', appliedAt: ago(1), score: 58, origins: ['search'], queries: ['react'],
      naukriStage: 'viewed', naukriStageAt: ago(0.5), trackedAt: ago(0), applyHistory: [hist(1, 'applied', 'Applied after 1 question(s)')] }),
    // interviewing (applied 40 days ago — outside the 30-day window)
    job({ approval: 'approved', applyStatus: 'interviewing', appliedAt: ago(40), score: 70, applyHistory: [hist(40, 'applied', 'Applied')] }),
    // skipped twice: a question, then company site
    job({ approval: 'approved', applyStatus: 'skipped', score: 30,
      applyHistory: [hist(5, 'skipped', 'Unanswered screening question — answer it under Jobs → Needs answer'), hist(4, 'skipped', 'Applies on the company site — x')] }),
    // failed
    job({ approval: 'approved', applyStatus: 'failed', applyHistory: [hist(2, 'failed', 'Clicked Apply but Naukri never confirmed.')] }),
    // rejected by you, and tidied away (stale + low fit)
    job({ approval: 'rejected', rejectedReason: 'not for me' }),
    job({ approval: 'rejected', tidiedAt: ago(1), tidyReason: 'posted 40 days ago' }),
    job({ approval: 'rejected', tidiedAt: ago(1), tidyReason: 'fit 20, below 40', score: 20 }),
    // deleted — never counted
    job({ approval: 'approved', applyStatus: 'applied', appliedAt: ago(1), deleted: true, applyHistory: [hist(1, 'applied', 'Applied')] }),
    // another account — never counted
    { userId: other, sourceId: 'x1', sourceKey: 'naukri:x1', title: 'Theirs', approval: 'approved', applyStatus: 'applied', appliedAt: ago(1),
      naukriStage: 'contacted', naukriStageAt: ago(0.5), applyHistory: [hist(1, 'applied', 'Applied')] },
  ]);
  await NaukriRun.insertMany([
    { userId: me, kind: 'apply', status: 'done', trigger: 'scheduled', stats: { applied: 2, aiAsked: 3, aiAnswered: 2 }, createdAt: ago(1) },
    { userId: me, kind: 'apply', status: 'blocked', exitCode: 2, createdAt: ago(2) },
    { userId: me, kind: 'harvest', status: 'done', stats: { autoApproved: 1 }, createdAt: ago(2) },
    { userId: me, kind: 'harvest', status: 'failed', createdAt: ago(45) }, // outside the window
    { userId: other, kind: 'apply', status: 'done', stats: { aiAsked: 9, aiAnswered: 9 }, createdAt: ago(1) },
  ]);
  await NaukriConfig.collection.insertOne({
    userId: me, schedule: { timezone: 'Asia/Kolkata' },
    apply: { maxPerDay: 25, autoApproveEnabled: true, autoApproveMinScore: 80 }, inboxTidy: { enabled: true },
    answers: [{ pattern: 'notice', answer: '30', origin: 'you' }, { pattern: 'ctc', answer: '10', origin: 'auto' }],
    drafts: [{ question: 'a', status: 'ready' }, { question: 'b', status: 'unknown' }, { question: 'c', status: 'ignored' }],
  });

  console.log('\nanalytics → naukri');
  const a = await naukriAnalytics(me, { days: 30 });
  const t = a.totals;
  ok(t.found === 11, 'found counts my live jobs only', t.found);
  ok(t.pending === 2 && t.approved === 6 && t.approvedAuto === 1, 'pending / approved / auto', JSON.stringify([t.pending, t.approved, t.approvedAuto]));
  ok(t.rejected === 1 && t.tidied === 2, 'rejected by you vs tidied', JSON.stringify([t.rejected, t.tidied]));
  ok(t.waiting === 1, 'approved and still to send');
  ok(t.applied === 3, 'applied = applied + in-review + interviewing', t.applied);
  ok(t.responded === 2 && t.shortlisted === 1 && t.tracked === 2, 'recruiter responses', JSON.stringify([t.responded, t.shortlisted, t.tracked]));
  ok(t.interviewing === 1 && t.skipped === 1 && t.failed === 1, 'interviewing / skipped / failed');
  ok(a.limits.maxPerDay === 25 && a.limits.autoApproveEnabled && a.limits.tidyEnabled, 'limits from config');
  ok(a.unscored === 4, 'unscored jobs', a.unscored);
  ok(a.scores.find(s => s.from === 80).n === 1 && a.scores.find(s => s.from === 90).n === 1 && a.scores.find(s => s.from === 50).applied === 2,
    'score buckets, with applied per bucket');
  ok(a.stages.find(s => s.stage === 'shortlisted').n === 1 && a.stages.find(s => s.stage === 'unknown').n === 1, 'stages over applications');
  ok(Math.abs(a.responseMedianHours - 18) < 0.5, 'median applied → response (12h and 24h → 18h)', a.responseMedianHours);
  const perDay = a.perDay.reduce((x, d) => ({ ap: x.ap + d.applied, sk: x.sk + d.skipped, fa: x.fa + d.failed }), { ap: 0, sk: 0, fa: 0 });
  ok(a.perDay.length === 30 && perDay.ap === 2 && perDay.sk === 2 && perDay.fa === 1, 'attempts per day in the window', JSON.stringify(perDay));
  const reason = (k) => a.reasons.find(r => r.key === k) || {};
  ok(reason('question').skipped === 1 && reason('company-site').skipped === 1 && reason('unconfirmed').failed === 1, 'reasons grouped');
  ok(a.origins.search === 3 && a.origins.recommended === 2 && a.origins.searchApplied === 2, 'origins', JSON.stringify(a.origins));
  ok(a.queries[0].query === 'react' && a.queries[0].found === 3 && a.queries[0].applied === 2, 'top search', JSON.stringify(a.queries[0]));
  const apply = a.runs.find(r => r.kind === 'apply');
  ok(apply.total === 2 && apply.blocked === 1 && apply.scheduled === 1, 'runs by kind, in the window');
  ok(!a.runs.find(r => r.kind === 'harvest' && r.failed), 'a run outside the window is not counted');
  ok(a.blocked.runs === 1, 'captcha blocks');
  ok(a.ai.asked === 3 && a.ai.answered === 2 && a.autoApproved === 1, 'AI and auto-approve, mine only');
  ok(a.ai.answers.you === 1 && a.ai.answers.auto === 1 && a.ai.drafts.ready === 1 && a.ai.drafts.ignored === 1, 'answer bank and drafts');
  ok(a.tidy.stale === 1 && a.tidy['low-fit'] === 1, 'tidy reasons', JSON.stringify(a.tidy));

  const empty = await naukriAnalytics(new mongoose.Types.ObjectId());
  ok(empty.totals.found === 0 && empty.perDay.length === 30 && empty.limits.maxPerDay === 40, 'an account with no Naukri data gets zeros and defaults');

  console.log('\nreport → naukri block');
  const r = await buildReportStats(me, { from: ago(7), to: new Date(), kind: 'custom', days: 7 });
  const k = r.naukri;
  ok(k.applied === 2 && k.skipped === 2 && k.failed === 1, 'attempts in the period', JSON.stringify(k));
  ok(k.autoApproved === 1 && k.aiAsked === 3 && k.aiAnswered === 2, 'auto-approved and AI in the period');
  ok(k.viewed === 1 && k.shortlisted === 1 && k.notShortlisted === 0, 'recruiter responses in the period');

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { if (mongoose.connection.name === TEST_DB) await mongoose.connection.dropDatabase(); } catch (_) { /* ignore */ }
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
