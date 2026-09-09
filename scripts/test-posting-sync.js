// Proves the job-posting sync diff. Run with:  node scripts/test-posting-sync.js
//
// There is no test framework in this repo, so this is a plain script. It uses a
// STUB adapter rather than live boards: live boards change under you, so they
// cannot prove close-detection. The two assertions that matter most are #7 (a
// failing board must close NOTHING) and #8 (an empty board closes everything) —
// they sit next to each other so the 404-vs-`[]` distinction is impossible to miss.
//
// Writes to the DEV database only, and cleans up after itself.
// Phase 1 — prove the sync diff. Uses a STUB adapter so the posting set is
// controlled: live boards change under you, so they cannot prove close detection.
require('dotenv').config();
// NEVER prod: .env sets NODE_ENV=prod, and this script writes test rows.
process.env.NODE_ENV = 'dev';

const mongoose = require('mongoose');
const JobPosting = require('../models/JobPosting');
const JobBoard = require('../models/JobBoard');
const Settings = require('../models/Settings');
const boards = require('../lib/boards');
const sync = require('../lib/postingSync');
const R = require('../lib/boards/result');
const { normaliseCriteria } = require('../lib/criteria');

const SOURCE = 'greenhouse';
const TOKEN = '__difftest';

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};
const eq = (label, got, want) =>
  ok(label + ' = ' + JSON.stringify(want), got === want, 'got ' + JSON.stringify(got));

const post = (id, extra = {}) => ({
  sourceId: id, title: 'Role ' + id, company: 'Difftest', department: 'Eng', team: '',
  location: 'Remote', locations: ['Remote'], remote: true, workplaceType: 'remote',
  employmentType: 'full-time', country: 'US',
  url: 'https://example.test/' + id, applyUrl: 'https://example.test/' + id + '/apply',
  requisitionId: '', postedAt: new Date('2026-01-01T00:00:00Z'), sourceUpdatedAt: null,
  ...extra,
});

// Override the registry entry point that postingSync calls.
let stub = () => R.empty();
boards.fetchBoard = async () => stub();

const rowsOf = () => JobPosting.find({ source: SOURCE, boardToken: TOKEN }).lean();
const byId = async (id) =>
  JobPosting.findOne({ sourceKey: sync.sourceKeyFor(SOURCE, TOKEN, id) }).lean();
const closedCount = () =>
  JobPosting.countDocuments({ source: SOURCE, boardToken: TOKEN, listingStatus: 'closed' });

const run = async (board, { dryRun = false, criteria = null } = {}) => {
  const fresh = await JobBoard.findById(board._id).lean();
  return sync.syncBoard(fresh, { runStartedAt: new Date(), dryRun, criteria });
};

// A posting with an explicit title, for the search + criteria sections below.
const titled = (id, title, extra = {}) => ({ ...post(id, extra), title });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI_DEV, { serverSelectionTimeoutMS: 10000 });
  console.log('db:', mongoose.connection.name, '\n');

  // Guard: refuse to run against anything but the dev database.
  if (!/dev/i.test(mongoose.connection.name)) throw new Error('refusing to test outside a dev db');

  await JobPosting.deleteMany({ source: SOURCE, boardToken: TOKEN });
  await JobBoard.deleteMany({ token: TOKEN });
  let board = await JobBoard.create({ source: SOURCE, token: TOKEN, label: 'Difftest' });

  // ── 1. first sync ────────────────────────────────────────────────────────
  console.log('1. first sync [A,B,C]');
  stub = () => R.ok([post('A'), post('B'), post('C')]);
  let r = await run(board);
  eq('inserted', r.inserted, 3);
  eq('closed', r.closed, 0);
  eq('status', r.status, 'ok');
  ok('firstSync flagged', r.firstSync === true);
  let rows = await rowsOf();
  eq('rows', rows.length, 3);
  ok('all open', rows.every(x => x.listingStatus === 'open'));
  ok('firstSeenAt === lastSeenAt on insert',
    rows.every(x => +x.firstSeenAt === +x.lastSeenAt));
  ok('seenCount 1', rows.every(x => x.seenCount === 1));
  board = await JobBoard.findById(board._id).lean();
  ok('board.firstSyncAt stamped', !!board.firstSyncAt);
  const firstSeenA = +(await byId('A')).firstSeenAt;

  // ── 2. idempotency ───────────────────────────────────────────────────────
  console.log('\n2. idempotency — identical set twice more');
  r = await run(board);
  eq('run2 inserted', r.inserted, 0);
  eq('run2 updated', r.updated, 3);
  eq('run2 closed', r.closed, 0);
  r = await run(board);
  eq('run3 closed', r.closed, 0);
  rows = await rowsOf();
  eq('seenCount now 3', rows[0].seenCount, 3);
  eq('firstSeenAt unchanged', +(await byId('A')).firstSeenAt, firstSeenA);
  ok('still all open', rows.every(x => x.listingStatus === 'open'));

  // Prove test 2 is not vacuous: the cutoff must be EXACTLY runStartedAt. With
  // $lte semantics (cutoff nudged 1ms later) the same state closes everything.
  console.log('\n2b. the $lt boundary is load-bearing');
  const stamp = (await byId('A')).lastSeenAt;
  eq('closeStale at the exact stamp closes nothing',
    await sync.closeStale({ source: SOURCE, boardToken: TOKEN, runStartedAt: stamp }), 0);
  const wouldClose = await sync.closeStale({
    source: SOURCE, boardToken: TOKEN, runStartedAt: new Date(+stamp + 1),
  });
  eq('closeStale 1ms later closes all 3 (this is what $lte would do)', wouldClose, 3);
  // undo that deliberate damage
  await JobPosting.updateMany({ source: SOURCE, boardToken: TOKEN },
    { $set: { listingStatus: 'open', closedAt: null }, $inc: { closeCount: -1 } });

  // ── 3. close ─────────────────────────────────────────────────────────────
  console.log('\n3. C vanishes');
  stub = () => R.ok([post('A'), post('B')]);
  r = await run(board);
  eq('closed', r.closed, 1);
  let c = await byId('C');
  eq('C listingStatus', c.listingStatus, 'closed');
  ok('C closedAt set', !!c.closedAt);
  eq('C closeCount', c.closeCount, 1);
  ok('A still open', (await byId('A')).listingStatus === 'open');

  // ── 4. close is idempotent ───────────────────────────────────────────────
  console.log('\n4. close is idempotent');
  r = await run(board);
  eq('closed again', r.closed, 0);
  eq('C closeCount still 1', (await byId('C')).closeCount, 1);

  // ── 5. reopen ────────────────────────────────────────────────────────────
  console.log('\n5. C comes back');
  stub = () => R.ok([post('A'), post('B'), post('C')]);
  r = await run(board);
  eq('reopened', r.reopened, 1);
  c = await byId('C');
  eq('C open again', c.listingStatus, 'open');
  ok('C reopenedAt set', !!c.reopenedAt);
  eq('C closedAt cleared', c.closedAt, null);
  eq('C firstSeenAt STILL the original (so it is not "new")', +c.firstSeenAt, firstSeenA);
  eq('C closeCount still 1', c.closeCount, 1);

  // ── 6. tracking survives ─────────────────────────────────────────────────
  console.log('\n6. your tracking survives close + reopen');
  await JobPosting.updateOne({ sourceKey: sync.sourceKeyFor(SOURCE, TOKEN, 'C') }, {
    $set: { applyStatus: 'applied', appliedAt: new Date(), applyNote: 'sent CV',
            appliedVia: 'https://example.test/C/apply' },
    $push: { applyHistory: { status: 'applied', changedAt: new Date(), note: 'sent CV' } },
  });
  stub = () => R.ok([post('A'), post('B')]);            // close it
  await run(board);
  stub = () => R.ok([post('A'), post('B'), post('C')]); // reopen it
  await run(board);
  c = await byId('C');
  eq('applyStatus intact', c.applyStatus, 'applied');
  ok('appliedAt intact', !!c.appliedAt);
  eq('applyNote intact', c.applyNote, 'sent CV');
  eq('applyHistory intact', c.applyHistory.length, 1);
  eq('appliedVia intact', c.appliedVia, 'https://example.test/C/apply');
  ok('and it is open again', c.listingStatus === 'open');

  console.log('\n6b. a posting you deleted stays deleted and does not return as a new row');
  stub = () => R.ok([post('A'), post('B'), post('C'), post('D')]);
  await run(board);
  const dBefore = await byId('D');
  await JobPosting.updateOne({ _id: dBefore._id }, { $set: { deleted: true, deletedAt: new Date() } });
  await run(board);
  const dRows = await JobPosting.find({ sourceKey: sync.sourceKeyFor(SOURCE, TOKEN, 'D') }).lean();
  eq('still exactly one D row', dRows.length, 1);
  eq('D still deleted', dRows[0].deleted, true);
  eq('D kept its _id (updated, not re-inserted)', String(dRows[0]._id), String(dBefore._id));

  // ── 7. THE LOAD-BEARING NEGATIVE TEST ────────────────────────────────────
  console.log('\n7. a failing board must NOT close anything');
  await JobPosting.updateMany({ source: SOURCE, boardToken: TOKEN },
    { $set: { listingStatus: 'open', closedAt: null } });
  const openBefore = await JobPosting.countDocuments({ source: SOURCE, boardToken: TOKEN, listingStatus: 'open' });
  console.log('   (' + openBefore + ' postings open going in)');

  const failures = [
    ['404 not-found', () => R.notFound('Board not found (HTTP 404)')],
    ['network error', () => R.error('Timed out after 12000ms', null)],
    ['shape guard',   () => R.error('Unexpected response shape (no `jobs` array)', 200)],
  ];
  for (const [label, s] of failures) {
    stub = s;
    const rep = await run(board);
    eq(label + ': closed', rep.closed, 0);
    eq(label + ': zero closed in db', await closedCount(), 0);
    eq(label + ': still ' + openBefore + ' open',
      await JobPosting.countDocuments({ source: SOURCE, boardToken: TOKEN, listingStatus: 'open' }), openBefore);
  }
  const bAfterFails = await JobBoard.findById(board._id).lean();
  eq('consecutiveFailures incremented to 3', bAfterFails.consecutiveFailures, 3);

  console.log('\n7b. deadline skip closes nothing either');
  const expired = { expired: () => true, remaining: () => 0, signal: undefined };
  const skipped = await sync.syncBoard(await JobBoard.findById(board._id).lean(),
    { runStartedAt: new Date(), deadline: expired });
  eq('status', skipped.status, 'skipped');
  eq('closed', skipped.closed, 0);
  eq('zero closed in db', await closedCount(), 0);

  // ── 8. empty DOES close, and is flagged ──────────────────────────────────
  console.log('\n8. an empty board (HTTP 200 []) DOES close — the 404 contrast');
  stub = () => R.empty();
  r = await run(board);
  eq('status', r.status, 'empty');
  eq('closed all ' + openBefore, r.closed, openBefore);
  eq('everything closed in db', await closedCount(), openBefore);
  ok('massClosed false below the warn threshold (' + openBefore + ' < ' + sync.MASS_CLOSE_WARN + ')',
    r.massClosed === false);

  console.log('\n8b. massClosed flag fires at scale');
  const many = Array.from({ length: sync.MASS_CLOSE_WARN + 5 }, (_, i) => post('M' + i));
  stub = () => R.ok(many);
  await run(board);
  stub = () => R.empty();
  r = await run(board);
  eq('closed', r.closed, sync.MASS_CLOSE_WARN + 5);
  eq('massClosed', r.massClosed, true);

  // ── 9. write-error guard ─────────────────────────────────────────────────
  // Mongoose casts leniently (an uncastable Date silently becomes null), so a
  // genuine partial write is hard to provoke and the guard is purely defensive.
  // Stub bulkWrite to exercise the branch directly — that is what is being
  // tested here, not Mongo's error reporting.
  console.log('\n9. a partial write failure skips the close pass');
  await JobPosting.deleteMany({ source: SOURCE, boardToken: TOKEN });
  stub = () => R.ok([post('A'), post('B'), post('C')]);
  await run(board);
  eq('3 open to start',
    await JobPosting.countDocuments({ source: SOURCE, boardToken: TOKEN, listingStatus: 'open' }), 3);

  const realBulkWrite = JobPosting.bulkWrite.bind(JobPosting);

  // 9a. bulkWrite resolves but reports writeErrors
  JobPosting.bulkWrite = async () => ({ writeErrors: [{ index: 0, errmsg: 'simulated' }] });
  stub = () => R.ok([post('A')]);            // B and C would otherwise be closed
  r = await run(board);
  eq('9a writeErrors surfaced', r.writeErrors, 1);
  eq('9a closed', r.closed, 0);
  eq('9a nothing closed in db', await closedCount(), 0);

  // 9b. bulkWrite throws a BulkWriteError
  JobPosting.bulkWrite = async () => {
    const err = new Error('simulated bulk write error');
    err.writeErrors = [{ index: 0 }, { index: 1 }];
    throw err;
  };
  r = await run(board);
  eq('9b writeErrors surfaced', r.writeErrors, 2);
  eq('9b closed', r.closed, 0);
  eq('9b nothing closed in db', await closedCount(), 0);
  ok('9b error reported, not swallowed', /Partial write failure/.test(r.error || ''), r.error);

  JobPosting.bulkWrite = realBulkWrite;

  // and with the stub removed the same vanishing set DOES close, proving the
  // guard was the only thing holding it back.
  r = await run(board);
  eq('9c once writes succeed, B and C close normally', r.closed, 2);

  // ── 10. two-board isolation ──────────────────────────────────────────────
  console.log('\n10. one bad board does not affect a good one');
  // Reset board1 so this test cannot inherit closures from test 9.
  await JobPosting.deleteMany({ source: SOURCE, boardToken: TOKEN });
  stub = () => R.ok([post('A'), post('B')]);
  await run(board);
  eq('board1 reset to 2 open, 0 closed', await closedCount(), 0);
  const TOKEN2 = '__difftest2';
  await JobPosting.deleteMany({ boardToken: TOKEN2 });
  await JobBoard.deleteMany({ token: TOKEN2 });
  const board2 = await JobBoard.create({ source: 'lever', token: TOKEN2, label: 'Difftest2' });
  stub = () => R.ok([post('P'), post('Q')]);
  await sync.syncBoard(board2.toObject(), { runStartedAt: new Date() });
  eq('board2 has 2 open',
    await JobPosting.countDocuments({ boardToken: TOKEN2, listingStatus: 'open' }), 2);

  // board1 fails while board2 succeeds in the same run
  const runAt = new Date();
  let call = 0;
  boards.fetchBoard = async (source) => {
    call++;
    return source === SOURCE ? R.notFound('404') : R.ok([post('P'), post('Q')]);
  };
  await Promise.all([
    sync.syncBoard(await JobBoard.findById(board._id).lean(), { runStartedAt: runAt }),
    sync.syncBoard(await JobBoard.findById(board2._id).lean(), { runStartedAt: runAt }),
  ]);
  eq('board2 untouched by board1 failing',
    await JobPosting.countDocuments({ boardToken: TOKEN2, listingStatus: 'closed' }), 0);
  eq('board1 closed nothing', await closedCount(), 0);
  boards.fetchBoard = async () => stub();

  // ── 11. lease ────────────────────────────────────────────────────────────
  console.log('\n11. the sync lease');
  // Settings is a singleton. The lease must never upsert it: with no unique
  // index, an upsert whose filter misses (i.e. the lock IS held) inserts a
  // second settings doc, which breaks the invariant AND defeats the lease
  // because each contender then owns its own copy. Regression guard:
  const settingsBefore = await Settings.countDocuments({});
  eq('exactly one Settings doc going in', settingsBefore, 1);
  await Settings.updateOne({}, { $set: { postingSyncLockAt: null } });
  stub = () => R.ok([post('A')]);
  const [a, b] = await Promise.all([
    sync.syncAllBoards({ boardIds: [String(board._id)] }),
    new Promise(r => setTimeout(r, 40)).then(() => sync.syncAllBoards({ boardIds: [String(board._id)] })),
  ]);
  const locked = [a, b].filter(x => x.ok === false && x.reason === 'locked');
  const ran = [a, b].filter(x => x.ok === true);
  eq('one run proceeded', ran.length, 1);
  eq('one run was refused as locked', locked.length, 1);
  const st = await Settings.findOne({}, { postingSyncLockAt: 1, lastPostingSyncAt: 1 }).lean();
  eq('lease released', st.postingSyncLockAt, null);
  ok('lastPostingSyncAt stamped', !!st.lastPostingSyncAt);

  eq('still exactly one Settings doc after contended syncs',
    await Settings.countDocuments({}), 1);

  console.log('\n11b. a stale lease self-heals');
  await Settings.updateOne({}, { $set: { postingSyncLockAt: new Date(Date.now() - sync.LOCK_TTL_MS - 5000) } });
  const healed = await sync.syncAllBoards({ boardIds: [String(board._id)] });
  eq('proceeded past a stale lock', healed.ok, true);

  // ── cleanup ──────────────────────────────────────────────────────────────
  await JobPosting.deleteMany({ boardToken: { $in: [TOKEN, TOKEN2] } });
  await JobBoard.deleteMany({ token: { $in: [TOKEN, TOKEN2] } });
  eq('and one Settings doc at the end', await Settings.countDocuments({}), 1);
  await Settings.updateOne({}, { $set: { postingSyncLockAt: null, lastPostingSyncAt: null } });
  console.log('\ncleaned up test rows.');

  console.log('\n================  ' + pass + ' passed, ' + fail + ' failed  ================');
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async (e) => {
  console.error('\nHARNESS ERROR:', e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
