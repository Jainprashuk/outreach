/**
 * Lifecycle email tests.
 *
 *   node scripts/test-lifecycle.js
 *
 * Runs against a THROWAWAY database, `outreach_lifecycle_test`, on the DEV
 * cluster (MONGODB_URI_DEV with the database name swapped), created and dropped
 * on every run. It never touches outreach_dev or outreach_prod, and it connects
 * with mongoose directly, NOT through db.js (which would seed).
 *
 * Nothing is emailed: the Resend key is removed from the environment and the
 * mail transport is replaced by an in-memory sink before anything loads.
 */
require('dotenv').config();
delete process.env.RESEND_API_KEY;
delete process.env.LIFECYCLE_FROM_EMAIL;
process.env.OUTREACH_URL = process.env.OUTREACH_URL || 'https://outreach.test';
process.env.CREDENTIAL_KEY = process.env.CREDENTIAL_KEY || 'test-key-for-lifecycle';

const mongoose = require('mongoose');
const systemMail = require('../lib/systemMail');

const sent = [];
systemMail.setTransportForTests(async (msg) => { sent.push(msg); return { id: `test-${sent.length}` }; });

const User = require('../models/User');
const Contact = require('../models/Contact');
const AppConfig = require('../models/AppConfig');
const LifecycleEmail = require('../models/LifecycleEmail');
const { getLifecycleConfig, setLifecycleSwitch } = require('../lib/lifecycle/config');
const { deliver } = require('../lib/lifecycle/deliver');
const cands = require('../lib/lifecycle/candidates');
const { buildReportStats } = require('../lib/reportStats');
const { lastFullWeek, fromIstDateString, DAY_MS } = require('../lib/reportPeriod');
const { makeToken, readToken } = require('../lib/lifecycle/unsubscribe');

const TEST_DB = 'outreach_lifecycle_test';
const uri = () => {
  const base = process.env.MONGODB_URI_DEV;
  if (!base) throw new Error('MONGODB_URI_DEV is not set');
  const u = new URL(base);
  u.pathname = `/${TEST_DB}`;
  return u.toString();
};

let passed = 0, failed = 0;
const ok = (cond, label) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); } else { failed++; console.log(`  ✗ ${label}`); }
};
const days = (n) => new Date(Date.now() - n * DAY_MS);

async function reset() {
  sent.length = 0;
  await Promise.all([User.deleteMany({}), Contact.deleteMany({}), AppConfig.deleteMany({}), LifecycleEmail.deleteMany({})]);
}

const mkUser = (o = {}) => User.create({
  email: o.email || `u${Math.random().toString(36).slice(2, 8)}@example.com`,
  name: o.name || 'Test Person', status: o.status || 'active',
  isAdmin: !!o.isAdmin, lastLoginAt: o.lastLoginAt || days(10), firstLoginAt: o.firstLoginAt || days(10),
  lastActiveAt: o.lastActiveAt === undefined ? null : o.lastActiveAt,
  onboarding: { completedAt: o.onboarded ? days(9) : null, startedAt: days(10), version: 1 },
  emailOptOut: o.emailOptOut || [], emailBlockedByAdmin: o.emailBlockedByAdmin || [],
});
const admin = (u) => ({ id: u._id, email: u.email });
const ALL_TYPES = ['welcome', 'setup-reminder', 'inactive', 'weekly-report', 'manual-report'];
const allTypesOn = async (a) => {
  for (const t of ALL_TYPES) await setLifecycleSwitch({ field: `type:${t}`, value: true, admin: admin(a) });
};
const liveMode = async (a) => {
  await setLifecycleSwitch({ field: 'enabled', value: true, admin: admin(a) });
  await setLifecycleSwitch({ field: 'testMode', value: false, admin: admin(a) });
  await allTypesOn(a);
};

async function main() {
  if (!/_test$/.test(TEST_DB)) throw new Error('refusing: not a test database');
  await mongoose.connect(uri(), { serverSelectionTimeoutMS: 10000 });
  if (mongoose.connection.name !== TEST_DB) throw new Error(`connected to ${mongoose.connection.name}, expected ${TEST_DB}`);
  await Promise.all([User.init(), LifecycleEmail.init(), AppConfig.init()]);
  console.log(`Connected to ${mongoose.connection.name}`);

  console.log('\nSafe defaults');
  await reset();
  {
    const cfg = await getLifecycleConfig();
    ok(cfg.enabled === false, 'no config row = master switch OFF');
    ok(cfg.testMode === true, 'no config row = test mode ON');
    ok(Object.values(cfg.types).every(v => v === false), 'no config row = every email type OFF');
    const a0 = await mkUser({ isAdmin: true });
    await setLifecycleSwitch({ field: 'types:all', value: true, admin: admin(a0) });
    ok(Object.values((await getLifecycleConfig()).types).every(v => v === true), 'Enable all turns every type on');
    await setLifecycleSwitch({ field: 'types:all', value: false, admin: admin(a0) });
    const c0 = await getLifecycleConfig();
    ok(Object.values(c0.types).every(v => v === false) && c0.enabled === false, 'Disable all turns every type off, master untouched');
    await reset();
    const u = await mkUser({ onboarded: true });
    const r = await deliver({ type: 'welcome', userId: u._id, key: 'welcome' });
    ok(r.status === 'paused' && sent.length === 0, 'master off: welcome is not sent');
    ok(await LifecycleEmail.countDocuments() === 0, 'master off: nothing recorded, so nothing is consumed');
  }

  console.log('\nTest mode ("send only to me")');
  await reset();
  {
    const a = await mkUser({ email: 'admin@example.com', isAdmin: true });
    const u = await mkUser({ email: 'someone@example.com' });
    await setLifecycleSwitch({ field: 'enabled', value: true, admin: admin(a) });
    const off = await deliver({ type: 'setup-reminder', userId: a._id, key: 'setup-reminder' });
    ok(off.reason === 'type-off' && sent.length === 0, 'master on alone sends nothing: each type must be switched on');
    await LifecycleEmail.deleteMany({});
    await allTypesOn(a);
    const cfg = await getLifecycleConfig();
    ok(cfg.enabled && cfg.testMode && cfg.testRecipient === 'admin@example.com', 'enabling first time keeps test mode on, addressed to the admin');
    ok(!!cfg.firstEnabledAt, 'first enable stamps firstEnabledAt');
    const r1 = await deliver({ type: 'setup-reminder', userId: u._id, key: 'setup-reminder' });
    ok(r1.status === 'skipped' && r1.reason === 'test-mode', "another user's email is not sent in test mode");
    ok(!sent.some(m => m.to !== 'admin@example.com'), 'nothing reached anyone but the admin');
    const r2 = await deliver({ type: 'setup-reminder', userId: a._id, key: 'setup-reminder' });
    ok(r2.status === 'sent' && sent.length === 1 && sent[0].to === 'admin@example.com', "the admin's own email is sent in test mode");
    await setLifecycleSwitch({ field: 'testMode', value: false, admin: admin(a) });
    const r3 = await deliver({ type: 'setup-reminder', userId: u._id, key: 'setup-reminder' });
    ok(r3.status === 'sent' && sent.at(-1).to === 'someone@example.com', 'test-mode skip did not use up the real slot');
  }

  console.log('\nExactly once');
  await reset();
  {
    const a = await mkUser({ isAdmin: true });
    await liveMode(a);
    const u = await mkUser({ onboarded: true });
    const key = cands.weekKey(new Date());
    const results = await Promise.all(Array.from({ length: 6 }, () => deliver({ type: 'weekly-report', userId: u._id, key })));
    ok(results.filter(r => r.status === 'sent').length === 1 && sent.length === 1, 'six concurrent deliveries of one slot send one email');
    const again = await deliver({ type: 'weekly-report', userId: u._id, key });
    ok(again.status === 'skipped' && sent.length === 1, 'a later retry of a sent slot does nothing');
  }

  console.log('\nSwitches and opt-outs');
  await reset();
  {
    const a = await mkUser({ isAdmin: true });
    await liveMode(a);
    const u = await mkUser();
    await setLifecycleSwitch({ field: 'type:setup-reminder', value: false, admin: admin(a) });
    const r1 = await deliver({ type: 'setup-reminder', userId: u._id, key: 'setup-reminder' });
    ok(r1.reason === 'type-off' && sent.length === 0, 'type switched off app-wide: not sent');
    await setLifecycleSwitch({ field: 'type:setup-reminder', value: true, admin: admin(a) });
    const r2 = await deliver({ type: 'setup-reminder', userId: u._id, key: 'setup-reminder' });
    ok(r2.status === 'skipped' && sent.length === 0, 'turning it back on does not catch up');

    const b = await mkUser({ emailBlockedByAdmin: ['setup-reminder'] });
    ok((await deliver({ type: 'setup-reminder', userId: b._id, key: 'setup-reminder' })).reason === 'user-blocked', 'blocked for one user by admin: not sent');
    const c = await mkUser({ emailOptOut: ['reminders'] });
    ok((await deliver({ type: 'setup-reminder', userId: c._id, key: 'setup-reminder' })).reason === 'opted-out', 'user opted out: not sent');
    const w = await mkUser({ onboarded: true, emailOptOut: ['reminders', 'weekly-report'] });
    ok((await deliver({ type: 'welcome', userId: w._id, key: 'welcome' })).status === 'sent', 'welcome ignores opt-outs (transactional)');
    const d = await mkUser({ status: 'disabled' });
    const rd = await deliver({ type: 'setup-reminder', userId: d._id, key: 'setup-reminder' });
    ok(rd.status === 'skipped' && sent.filter(m => m.to === d.email).length === 0, 'disabled account: not sent');
    await setLifecycleSwitch({ field: 'enabled', value: false, admin: admin(a) });
    const x = await mkUser({ onboarded: true });
    ok((await deliver({ type: 'welcome', userId: x._id, key: 'welcome' })).status === 'paused', 'master off again: everything pauses');
  }

  console.log('\nWho is due');
  await reset();
  {
    const a = await mkUser({ isAdmin: true, onboarded: true, lastActiveAt: new Date() });
    await liveMode(a);
    const early = await mkUser({ firstLoginAt: days(4) });
    const late = await mkUser({ firstLoginAt: days(6) });
    await mkUser({ firstLoginAt: days(6), onboarded: true });
    await mkUser({ firstLoginAt: days(9), status: 'invited' });
    const due = (await cands.setupReminderCandidates()).map(c => String(c.userId));
    ok(due.includes(String(late._id)) && !due.includes(String(early._id)) && due.length === 1, 'setup reminder: day 6 due, day 4 not, set-up and invited excluded');
    await deliver({ type: 'setup-reminder', userId: late._id, key: 'setup-reminder' });
    ok((await cands.setupReminderCandidates()).length === 0, 'setup reminder: never twice');

    // Inactivity clock started 10 days ago.
    await AppConfig.updateOne({ key: 'lifecycle' }, { $set: { 'lifecycle.firstEnabledAt': days(10) } });
    let cfg = await getLifecycleConfig();
    const idle = await mkUser({ onboarded: true, lastActiveAt: days(4) });
    const sending = await mkUser({ onboarded: true, lastActiveAt: days(4) });
    await Contact.create({ userId: sending._id, name: 'X', email: 'x@co.com', lastSentAt: days(1) });
    const recent = await mkUser({ onboarded: true, lastActiveAt: days(1) });
    let ids = (await cands.inactiveCandidates(new Date(), cfg)).map(c => String(c.userId));
    ok(ids.includes(String(idle._id)), 'inactive: no visit and no send for 4 days is due');
    ok(!ids.includes(String(sending._id)), 'inactive: a campaign still sending is NOT nudged');
    ok(!ids.includes(String(recent._id)), 'inactive: visited yesterday is not due');
    const c1 = (await cands.inactiveCandidates(new Date(), cfg)).find(c => String(c.userId) === String(idle._id));
    ok((await deliver(c1)).status === 'sent', 'inactive: nudge sent');
    ids = (await cands.inactiveCandidates(new Date(), cfg)).map(c => String(c.userId));
    ok(!ids.includes(String(idle._id)), 'inactive: only one per quiet spell');
    await User.updateOne({ _id: idle._id }, { $set: { lastActiveAt: days(3.5) } });
    ids = (await cands.inactiveCandidates(new Date(), cfg)).map(c => String(c.userId));
    ok(ids.includes(String(idle._id)), 'inactive: came back, went quiet again = a new spell');

    // Clock just started: nobody is judged idle from before it.
    await AppConfig.updateOne({ key: 'lifecycle' }, { $set: { 'lifecycle.firstEnabledAt': days(1) } });
    cfg = await getLifecycleConfig();
    ok((await cands.inactiveCandidates(new Date(), cfg)).length === 0, 'inactive: nobody due within 3 days of launch');
  }

  console.log('\nWeekly report');
  await reset();
  {
    const a = await mkUser({ isAdmin: true });
    await liveMode(a);
    const quiet = await mkUser({ onboarded: true });
    const busy = await mkUser({ onboarded: true });
    const other = await mkUser({ onboarded: true });
    const wk = lastFullWeek(new Date());
    const inWeek = new Date(wk.from.getTime() + 2 * DAY_MS);
    await Contact.create({ userId: busy._id, name: 'A', email: 'a@co.com', status: 'replied', repliedAt: inWeek, replyCategory: 'reviewing',
      statusHistory: [{ status: 'sent', changedAt: inWeek }, { status: 'replied', changedAt: inWeek }] });
    await Contact.create({ userId: other._id, name: 'B', email: 'b@co.com', statusHistory: [{ status: 'sent', changedAt: inWeek }, { status: 'sent', changedAt: inWeek }] });
    const key = cands.weekKey(new Date());
    await deliver({ type: 'weekly-report', userId: quiet._id, key });
    const q = sent.at(-1);
    ok(/Quiet week/.test(q.subject) && !(q.attachments || []).length, 'quiet week: one-line note, no PDF');
    await deliver({ type: 'weekly-report', userId: busy._id, key });
    const b = sent.at(-1);
    const pdf = (b.attachments || [])[0];
    ok(pdf && pdf.content.slice(0, 4).toString() === '%PDF', 'busy week: PDF attached');
    ok(b.headers && /unsubscribe/.test(b.headers['List-Unsubscribe'] || ''), 'weekly report carries List-Unsubscribe');
    const stats = await buildReportStats(busy._id, wk);
    ok(stats.headline.sent.value === 1 && stats.headline.replies.value === 1, "report counts the user's own sends and replies");
    ok(stats.topReplies.length === 1 && stats.topReplies[0].name === 'A', "top replies are the user's own");
  }

  console.log('\nIST week boundaries');
  await reset();
  {
    const u = await mkUser({ onboarded: true });
    const monday = fromIstDateString('2026-09-21');
    const week = { from: monday, to: new Date(monday.getTime() + 7 * DAY_MS), kind: 'week', days: 7 };
    const sunLate = new Date(Date.parse('2026-09-27T23:30:00+05:30'));
    const monEarly = new Date(Date.parse('2026-09-28T00:10:00+05:30'));
    await Contact.create({ userId: u._id, name: 'C', email: 'c@co.com', statusHistory: [{ status: 'sent', changedAt: sunLate }, { status: 'follow-up-sent', changedAt: monEarly }] });
    const s = await buildReportStats(u._id, week, { now: new Date('2026-09-28T10:00:00+05:30') });
    ok(s.headline.sent.value === 1, 'Sunday 23:30 IST is in that week, Monday 00:10 IST is not');
    ok(s.series.points.length === 7 && s.series.points[6].day === '2026-09-27' && s.series.points[6].sent === 1, 'daily series is Mon→Sun in IST');
  }

  console.log('\nFooter on every email');
  {
    const t = require('../lib/lifecycle/templates');
    const unsub = 'https://outreach.test/api/email/unsubscribe?t=abc';
    const stats = { period: { from: new Date(), to: new Date(Date.now() + DAY_MS) }, quiet: true, headline: {}, waiting: { items: [] }, upcomingInterviews: [] };
    const msgs = {
      welcome: t.welcome({ name: 'A', gmail: 'a@gmail.com' }),
      setup: t.setupReminder({ name: 'A', missing: ['gmail'], unsub }),
      inactive: t.inactive({ name: 'A', since: new Date(), news: { replies: 0, finishedCampaigns: [], upcomingInterviews: 0 }, unsub }),
      quiet: t.report({ name: 'A', stats, unsub }),
    };
    for (const [k, m] of Object.entries(msgs)) {
      ok(/This is a system-generated email\. You can opt out by clicking <a [^>]+>Opt out<\/a>/.test(m.html) && /system-generated email/.test(m.text), `${k}: system-generated line with an Opt out link`);
    }
    ok(msgs.setup.html.includes(unsub) && msgs.inactive.html.includes(unsub) && msgs.quiet.html.includes(unsub), 'opt-out goes to the one-click unsubscribe where there is one');
    ok(msgs.welcome.html.includes('/app/settings'), 'welcome opt-out goes to email settings');
  }

  console.log('\nUnsubscribe links');
  {
    const id = new mongoose.Types.ObjectId();
    const t = makeToken(id, 'weekly-report');
    const r = readToken(t);
    ok(r && r.userId === String(id) && r.pref === 'weekly-report', 'a valid token reads back');
    const [b64, sig] = t.split('.');
    const forged = `${Buffer.from(`${new mongoose.Types.ObjectId()}.weekly-report`).toString('base64url')}.${sig}`;
    ok(readToken(forged) === null, 'a token edited to another account is rejected');
    ok(readToken(`${b64}.${sig.slice(0, -2)}xx`) === null, 'a tampered signature is rejected');
  }

  console.log('\nFailed sends retry, but not forever');
  await reset();
  {
    const a = await mkUser({ isAdmin: true });
    await liveMode(a);
    const u = await mkUser();
    systemMail.setTransportForTests(async () => { throw new Error('boom'); });
    for (let i = 0; i < 4; i++) await deliver({ type: 'setup-reminder', userId: u._id, key: 'setup-reminder' }).catch(() => {});
    const row = await LifecycleEmail.findOne({ userId: u._id, type: 'setup-reminder' }).lean();
    ok(row.status === 'failed' && row.attempts === 3, 'stops after 3 attempts');
    systemMail.setTransportForTests(async (msg) => { sent.push(msg); return { id: 'x' }; });
  }

  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { if (mongoose.connection.name === TEST_DB) await mongoose.connection.dropDatabase(); } catch (_) { /* ignore */ }
  process.exit(1);
});
