#!/usr/bin/env node
/**
 * One-time cleanup: collapses duplicate Settings documents so a unique index on
 * userId can be created.
 *
 * Settings.getForUser was a read-then-create with no upsert guard, so two
 * concurrent first-time requests for the same user could each miss and each
 * insert. Nothing has depended on there being exactly one row, so the duplicates
 * are harmless today — but the onboarding wizard mounts several panels at once,
 * which is precisely the trigger, and the fix (a unique index) cannot be built
 * while duplicates exist.
 *
 * Run this to completion against a database BEFORE deploying the schema change
 * that adds the index, or the index build fails.
 *
 * Deliberately connects with mongoose.connect() rather than require('../db'):
 * db.js fires three contact backfills on connect, which is not something a
 * cleanup script should trigger against a live database.
 *
 *   node scripts/dedupe-settings.js --env=dev
 *   node scripts/dedupe-settings.js --env=dev --execute
 *   node scripts/dedupe-settings.js --env=prod --execute
 */
require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const flag = (name) => args.some(a => a === `--${name}`);
const value = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const EXECUTE = flag('execute');
const ENV = value('env') === 'dev' ? 'dev' : 'prod';
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

// Fields merged from a loser into the winner, but ONLY where the winner has
// nothing meaningful. Order matters for reporting only; each is independent.
//
// senderName/senderCompany carry schema defaults ('Your Name'/'Your Company')
// rather than being empty, so "unset" for them means "still the default" — the
// one place this script has to know a default string. Everything else is
// empty-or-absent.
const DEFAULTS = { senderName: 'Your Name', senderCompany: 'Your Company' };

const isBlank = (doc, field) => {
  const v = doc[field];
  if (v === null || v === undefined || v === '') return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (field in DEFAULTS && v === DEFAULTS[field]) return true;
  return false;
};

const MERGEABLE = [
  'gmailEmail', 'gmailAppPasswordEnc', 'resume', 'customVariables',
  'jobCriteria', 'senderName', 'senderCompany',
  'lastMailboxCheckAt', 'lastPostingSyncAt',
];

/**
 * The surviving document for one user.
 *
 * A stored Gmail credential outranks everything: it is the only field here that
 * cannot be re-derived or re-entered without the user going and generating a new
 * App Password. Then a resume (a file they uploaded and would have to find
 * again), then the oldest row, which is the one whose _id other code may already
 * have captured.
 */
function pickWinner(docs) {
  const score = (d) => (d.gmailAppPasswordEnc ? 4 : 0) + (d.resume && d.resume.filename ? 2 : 0);
  return [...docs].sort((a, b) => {
    const s = score(b) - score(a);
    if (s !== 0) return s;
    return new Date(a.createdAt || 0) - new Date(b.createdAt || 0);
  })[0];
}

async function main() {
  if (!URI) throw new Error(`MONGODB_URI_${ENV.toUpperCase()} is not set`);

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const settings = db.collection('settings');
  console.log(`\nDatabase: ${db.databaseName}  (MONGODB_URI_${ENV.toUpperCase()})`);

  const totalBefore = await settings.countDocuments();

  // Null userId is its own group on purpose. Such a row predates the
  // multi-tenant backfill and belongs to nobody; a unique index tolerates one of
  // them, so it is reported but never merged into a real user's row.
  const groups = await settings.aggregate([
    { $group: { _id: '$userId', ids: { $push: '$_id' }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();

  console.log(`\n  ${totalBefore} settings documents, ${groups.length} user(s) with duplicates`);

  if (!groups.length) {
    console.log(`\nNothing to do — safe to deploy the unique index on userId.\n`);
    return;
  }

  const plan = [];
  for (const g of groups) {
    const docs = await settings.find({ _id: { $in: g.ids } }).toArray();
    const winner = pickWinner(docs);
    const losers = docs.filter(d => String(d._id) !== String(winner._id));

    const merge = {};
    for (const field of MERGEABLE) {
      if (!isBlank(winner, field)) continue;
      const donor = losers.find(l => !isBlank(l, field));
      if (donor) merge[field] = donor[field];
    }
    plan.push({ userId: g._id, winner, losers, merge });

    const label = g._id === null ? '(no userId)' : String(g._id);
    console.log(`\n  user ${label}: ${docs.length} docs`);
    console.log(`    keep   ${winner._id}${winner.gmailAppPasswordEnc ? ' [has credential]' : ''}${winner.resume && winner.resume.filename ? ' [has resume]' : ''}`);
    for (const l of losers) console.log(`    delete ${l._id}`);
    const keys = Object.keys(merge);
    if (keys.length) console.log(`    merge forward: ${keys.join(', ')}`);
  }

  // A credential on a row about to be deleted, where the winner also has one, is
  // the single case this script cannot resolve safely: only one can survive and
  // the other is a working App Password that will become unreachable. Refuse
  // rather than guess.
  const conflicts = plan.filter(p =>
    p.winner.gmailAppPasswordEnc && p.losers.some(l => l.gmailAppPasswordEnc && l.gmailAppPasswordEnc !== p.winner.gmailAppPasswordEnc));
  if (conflicts.length) {
    throw new Error(
      `${conflicts.length} user(s) have DIFFERENT Gmail credentials on two rows: ` +
      conflicts.map(c => String(c.userId)).join(', ') +
      `. Decide which is current by hand before re-running — this script will not pick one.`);
  }

  if (!EXECUTE) {
    const deletions = plan.reduce((n, p) => n + p.losers.length, 0);
    console.log(`\nDry run — nothing written.`);
    console.log(`Would merge forward and delete ${deletions} document(s), leaving ${totalBefore - deletions}.`);
    console.log(`\nRe-run with --execute to apply.\n`);
    return;
  }

  console.log('\nApplying:');
  let deleted = 0;
  for (const p of plan) {
    if (Object.keys(p.merge).length) {
      await settings.updateOne({ _id: p.winner._id }, { $set: p.merge });
    }
    const res = await settings.deleteMany({ _id: { $in: p.losers.map(l => l._id) } });
    deleted += res.deletedCount;
    console.log(`  user ${p.userId === null ? '(no userId)' : p.userId}: merged ${Object.keys(p.merge).length} field(s), deleted ${res.deletedCount}`);
  }

  // ── Verify ────────────────────────────────────────────────────────────────
  console.log('\nVerifying:');
  const totalAfter = await settings.countDocuments();
  const remaining = await settings.aggregate([
    { $group: { _id: '$userId', n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
  ]).toArray();

  const expected = totalBefore - deleted;
  const countOk = totalAfter === expected;
  const dupesOk = remaining.length === 0;
  console.log(`  ${countOk ? 'ok  ' : 'FAIL'} document count: was ${totalBefore}, deleted ${deleted}, now ${totalAfter} (expected ${expected})`);
  console.log(`  ${dupesOk ? 'ok  ' : 'FAIL'} duplicate groups remaining: ${remaining.length}`);

  // Nobody may have lost a credential or a resume along the way. Counted across
  // the whole collection, because the point is that the TOTAL did not drop.
  const credsAfter = await settings.countDocuments({ gmailAppPasswordEnc: { $nin: [null, ''] } });
  const resumesAfter = await settings.countDocuments({ 'resume.filename': { $nin: [null, ''] } });
  const credsExpected = plan.filter(p => p.winner.gmailAppPasswordEnc || p.losers.some(l => l.gmailAppPasswordEnc)).length;
  console.log(`  ..   ${credsAfter} row(s) with a Gmail credential, ${resumesAfter} with a resume (${credsExpected} affected user(s) had one before)`);

  if (!countOk || !dupesOk) throw new Error('Verification failed — do NOT deploy the unique index until this is resolved.');
  console.log(`\nDeduped: every user in ${db.databaseName} has exactly one settings document.`);
  console.log(`Safe to deploy the unique index on userId.\n`);
}

main()
  .catch(err => { console.error(`\n✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
