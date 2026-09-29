/**
 * Who would get WHICH lifecycle email in the next 24 hours — READ-ONLY.
 *
 *   node scripts/lifecycle-preview.js                 # outreach_dev
 *   node scripts/lifecycle-preview.js --env=prod      # the live database
 *   node scripts/lifecycle-preview.js --env=prod --hours=48
 *
 * Runs the SAME candidate queries and the SAME gate the Inngest sweeps use
 * (lib/lifecycle/candidates.js, lib/lifecycle/gate.js), at the times the sweeps
 * will actually fire, so its answer cannot drift from what the app does.
 *
 * It prints two answers:
 *   1. with the switches exactly as they are in that database right now
 *   2. if you switched everything on with test mode OFF at this moment
 *
 * Cannot write and cannot send, three ways over:
 *   - every write method on the MongoDB driver's Collection throws
 *   - mongoose autoIndex/autoCreate are off, so connecting builds nothing
 *   - the mail transport is replaced by one that throws
 * and it connects with mongoose directly, never through db.js (which seeds).
 */
require('dotenv').config();
const mongoose = require('mongoose');

// ── Read-only, enforced ──────────────────────────────────────────────────────
const WRITES = ['insertOne', 'insertMany', 'updateOne', 'updateMany', 'replaceOne', 'deleteOne', 'deleteMany',
  'findOneAndUpdate', 'findOneAndDelete', 'findOneAndReplace', 'bulkWrite', 'createIndex', 'createIndexes',
  'dropIndex', 'dropIndexes', 'drop', 'rename'];
for (const m of WRITES) {
  mongoose.mongo.Collection.prototype[m] = function blocked() {
    throw new Error(`lifecycle-preview is read-only: refused ${m} on ${this.collectionName}`);
  };
}
const systemMail = require('../lib/systemMail');
// Also makes isConfigured() true, so the gate answers as the deployed app will
// rather than "sender not configured" because this laptop lacks the env var.
systemMail.setTransportForTests(async () => { throw new Error('lifecycle-preview never sends'); });

const User = require('../models/User');
const Settings = require('../models/Settings');
const { getLifecycleConfig } = require('../lib/lifecycle/config');
const { decide, REASONS } = require('../lib/lifecycle/gate');
const cands = require('../lib/lifecycle/candidates');
const { buildMessage } = require('../lib/lifecycle/deliver');
const { buildReportStats } = require('../lib/reportStats');
const { checkReadiness } = require('../lib/onboarding');
const { TYPES, TYPE_KEYS } = require('../lib/lifecycle/types');
const { nextIstTime, labelFor } = require('../lib/reportPeriod');

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const ENV = arg('env', 'dev');
const HOURS = Number(arg('hours', 24));
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

const ist = (d) => new Date(d).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

async function describe(c, at) {
  const u = c.user;
  if (c.type === 'setup-reminder') {
    const s = await Settings.findOne({ userId: u._id }, { gmailAppPasswordEnc: 1, senderName: 1 }).lean();
    const r = checkReadiness(s);
    const missing = Object.entries(r).filter(([, v]) => !v).map(([k]) => k);
    return `signed in ${ist(cands.setupAnchor(u))}; still missing: ${missing.join(' + ') || 'nothing (wizard not finished)'}`;
  }
  if (c.type === 'inactive') return `quiet since ${ist(c.context.since)}`;
  if (c.type === 'weekly-report') {
    const st = await buildReportStats(u._id, c.context.period, { now: at });
    return st.quiet
      ? `quiet week, gets the one-line note (no PDF)`
      : `${st.headline.sent.value} sent, ${st.headline.replies.value} replies, ${st.headline.interviews.value} interviews, PDF attached`;
  }
  return '';
}

async function main() {
  if (!URI) throw new Error(`MONGODB_URI_${ENV.toUpperCase()} is not set`);
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 10000, autoIndex: false, autoCreate: false });
  const now = new Date();
  const until = new Date(now.getTime() + HOURS * 3600 * 1000);
  console.log(`\nLifecycle email preview — database "${mongoose.connection.name}" (read-only)`);
  console.log(`Window: ${ist(now)} → ${ist(until)} IST\n`);

  const config = await getLifecycleConfig();
  const flag = (v) => (v ? 'ON' : 'off');
  console.log('Switches in this database right now:');
  console.log(`  master ${flag(config.enabled)} · test mode ${flag(config.testMode)}${config.testMode ? (config.testRecipient ? ` (only ${config.testRecipient} gets mail)` : ' (no recipient until an admin turns the master switch on)') : ''} · first enabled ${config.firstEnabledAt ? ist(config.firstEnabledAt) : 'never'}`);
  console.log(`  types: ${TYPE_KEYS.map(t => `${TYPES[t].label} ${flag(config.types[t])}`).join(' · ')}`);
  const env = ['LIFECYCLE_FROM_EMAIL', 'RESEND_API_KEY', 'OUTREACH_URL', 'CREDENTIAL_KEY'];
  console.log(`  (this laptop's env: ${env.map(k => `${k} ${process.env[k] ? 'set' : 'MISSING'}`).join(', ')} — what matters is Vercel's)\n`);

  // "Switch everything on now, test mode off": the clock would start now.
  const hypothetical = { ...config, enabled: true, testMode: false, firstEnabledAt: config.firstEnabledAt || now, types: Object.fromEntries(TYPE_KEYS.map(t => [t, true])) };

  const runs = [];
  // Every sweep that fires in the window. Later ones assume nothing changes in
  // between (nobody visits, nobody finishes setup), so read them as upper bounds.
  for (let t = nextIstTime(now, 10); t <= until; t = nextIstTime(t, 10)) {
    const at = t;
    runs.push({ at, label: 'Daily sweep (setup reminders + inactivity)', find: async (cfg) => [...await cands.setupReminderCandidates(at), ...await cands.inactiveCandidates(at, cfg)] });
  }
  for (let t = nextIstTime(now, 9, 0); t <= until; t = nextIstTime(t, 9, 0)) {
    const at = t;
    runs.push({ at, label: 'Weekly report sweep', find: async () => cands.weeklyReportCandidates(at) });
  }

  let totalNow = 0, totalIfOn = 0;
  for (const run of runs.sort((a, b) => a.at - b.at)) {
    console.log(`── ${run.label} — fires ${ist(run.at)} IST ──`);
    const [listNow, listIfOn] = await Promise.all([run.find(config), run.find(hypothetical)]);
    const byKey = new Map([...listIfOn, ...listNow].map(c => [`${c.userId}|${c.type}|${c.key}`, c]));
    if (!byKey.size) { console.log('  nobody is due\n'); continue; }
    for (const c of byKey.values()) {
      const inNow = listNow.some(x => String(x.userId) === String(c.userId) && x.type === c.type && x.key === c.key);
      const dNow = inNow ? decide(c.type, c.user, config) : { send: false, reason: 'not-due' };
      const dOn = decide(c.type, c.user, hypothetical);
      if (dNow.send) totalNow++;
      if (dOn.send) totalIfOn++;
      let subject = '';
      try { subject = (await buildMessage(c.type, c.user, { now: run.at, since: c.context && c.context.since, period: c.context && c.context.period })).subject; } catch (err) { subject = `(could not build: ${err.message})`; }
      console.log(`  • ${c.user.email}${c.user.name ? ` (${c.user.name})` : ''} — ${TYPES[c.type].label}`);
      console.log(`      subject: ${subject}`);
      console.log(`      ${await describe(c, run.at)}`);
      console.log(`      as switches are now: ${dNow.send ? `WILL SEND to ${dNow.to}` : `not sent (${REASONS[dNow.reason] || dNow.reason})`}`);
      console.log(`      if you turn it all on:  ${dOn.send ? `would send to ${dOn.to}` : `not sent (${REASONS[dOn.reason] || dOn.reason})`}`);
    }
    console.log('');
  }
  if (!runs.length) console.log('No sweep fires in this window.\n');

  // Welcome is event-driven: whoever finishes setup in the window gets one.
  const pending = await User.find({ status: 'active', 'onboarding.completedAt': null }, { email: 1 }).lean();
  console.log('── Welcome (sent when someone finishes setup) ──');
  console.log(pending.length
    ? `  ${pending.length} signed-in account(s) have not finished setup and would get one on finishing: ${pending.map(u => u.email).join(', ')}`
    : '  nobody is mid-setup');
  console.log('  Accounts that already finished setup never get a welcome.\n');

  console.log(`TOTAL in the next ${HOURS}h: ${totalNow} email(s) with the switches as they are; ${totalIfOn} if you turned everything on (test mode off) right now.`);
  if (!config.enabled) console.log('The master switch is OFF in this database, so deploying sends nothing until an admin turns it on.');
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error(err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
