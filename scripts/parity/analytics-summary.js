/**
 * Parity check for GET /api/contacts/analytics-summary (lib/analyticsSummary.js)
 * against what the Analytics page derived in the browser from the full contact
 * download it replaced. READ-ONLY — it never writes.
 *
 * For every account, at one fixed `now` and in the process timezone, it runs the
 * old page code (scripts/parity/reference/analyticsPageOld.ts — lib/analytics.ts
 * plus the page's derivations, verbatim) over exactly what GET
 * /api/contacts?view=analytics sent, and the server summary plus the page's new
 * browser half (mergeActivity, interviewFunnel over the server's rows), and
 * requires every figure, table, chart series and the activity log to match.
 *
 *   TZ=Asia/Kolkata NODE_ENV=prod node scripts/parity/analytics-summary.js
 *   TZ=America/New_York NODE_ENV=prod node scripts/parity/analytics-summary.js   (DST)
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const mongoose = require('mongoose');
const Contact = require('../../models/Contact');
const Interview = require('../../models/Interview');
const { summary } = require('../../lib/analyticsSummary');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const TZ = Intl.DateTimeFormat().resolvedOptions().timeZone;

// routes/contacts.js ANALYTICS_FIELDS — what ?view=analytics sent.
const ANALYTICS_FIELDS = {
  name: 1, email: 1, company: 1, status: 1, template: 1, statusHistory: 1,
  lastSentAt: 1, repliedAt: 1, followUpSentAt: 1, createdAt: 1, updatedAt: 1,
};
const serialize = (doc) => { const o = { ...doc }; o.id = doc._id.toString(); delete o._id; delete o.__v; return o; };
const json = (x) => JSON.parse(JSON.stringify(x));

function loadReference() {
  const esbuild = require(path.join(__dirname, '../../client/node_modules/esbuild'));
  const out = path.join(os.tmpdir(), `analytics-ref-${process.pid}.cjs`);
  esbuild.buildSync({ entryPoints: [path.join(__dirname, 'reference/analyticsPageOld.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
  const ref = require(out);
  fs.unlinkSync(out);
  return ref;
}

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${env.toUpperCase()} is not set`);
  const ref = loadReference();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
  console.log(`Parity (read-only) against ${env} / ${mongoose.connection.db.databaseName}, TZ=${TZ}`);
  const realNow = Date.now;
  let checks = 0;

  for (const userId of await Contact.distinct('userId', { deleted: { $ne: true } })) {
    const t0 = realNow();
    const contacts = json((await Contact.find({ deleted: { $ne: true }, userId }, ANALYTICS_FIELDS).sort({ createdAt: -1 }).lean()).map(serialize));
    const interviews = json((await Interview.find({ userId, deleted: { $ne: true } }, { 'cv.data': 0, 'jd.data': 0 })
      .sort({ interviewAt: 1, lastActivityAt: -1 })).map(r => r.toJSON()));

    const NOW = realNow();
    Date.now = () => NOW; // both sides at the same instant
    const s = json(await summary(Contact, Interview, userId, { tz: TZ, now: NOW }));
    const old = json(ref.oldPage(contacts, interviews));
    const same = (label, a, b) => { checks++; assert.deepStrictEqual(a, b, `user ${userId}: ${label} differs`); };

    same('metrics', s.metrics, old.m);
    same('status (current)', s.statusCurrent, old.statusCurrent);
    same('status (ever)', s.statusEver, old.statusEver);
    const nowBy = Object.fromEntries(s.statusCurrent.map(r => [r.s, r.n]));
    same('status (now, beside ever)', Object.fromEntries(Object.keys(old.nowN).map(k => [k, nowBy[k] || 0])), old.nowN);
    same('reply journey', s.journey, old.journeyRows);
    same('templates', s.templates, old.tplEntries);
    same('top companies', s.companies, old.coRows);
    same('series 30d', s.series['30'], old.series30);
    same('series 90d', s.series['90'], old.series90);
    same('reply-time pairs', s.pairs, old.allPairs);
    same('weekly rhythm', s.weekday, old.weekday);
    same('reply weekday', s.replyWd, old.wd);
    same('reply hour', s.replyHr, old.hr);
    same('this week vs last', s.week, old.week);
    same('advanced repliers', s.adv, old.adv);
    same('follow-up due', s.due, old.due);

    const ivNew = json(ref.interviewFunnel(s.interviewRows, ref.indexInterviews(interviews), 'contact', c => c.email));
    same('interview funnel', { ...ivNew, records: ivNew.records.map(r => r.id).sort() }, { ...old.iv, records: old.iv.records.map(r => r.id).sort() });

    const merged = ref.mergeActivity(s.activity, interviews, NOW);
    for (const w of old.activity) {
      const col = merged.find(c => c.key === w.key);
      same(`activity counts ${w.key}`, col.counts, w.counts);
      same(`activity log ${w.key}`, json(col.feed.map(e => ({ t: e.t, type: e.type, id: e.c.id, name: e.c.name, company: e.c.company }))), w.feed);
    }
    Date.now = realNow;

    const kb = (x) => Math.round(JSON.stringify(x).length / 1024);
    console.log(`✅  user ${userId}: ${contacts.length} contacts, ${interviews.length} interviews — every figure identical (${kb(contacts)} KB → ${kb(s)} KB, ${Math.round((realNow() - t0) / 1000)} s)`);
  }
  await mongoose.disconnect();
  console.log(`All ${checks} analytics checks passed.`);
})().catch(async (err) => {
  console.error('❌ ', err.message.slice(0, 4000));
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
