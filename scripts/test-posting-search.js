// Proves the two subtle rules that the search sources and the criteria filter
// introduce. Run with:  node scripts/test-posting-search.js
//
//   1. A 'search' source (The Muse, Jobicy) reads the first few pages of a query
//      that can run to 1400+, so a posting missing from today's slice is NOT
//      evidence the job closed. Search sources must never close anything.
//   2. The criteria filter decides what to STORE, never what exists. A posting
//      you filtered out is still listed by the company, so it must not be
//      treated as vanished — otherwise editing your keywords would "close" half
//      a board.
//
// Uses a STUB adapter (live sources change under you). DEV database only.
require('dotenv').config();
process.env.NODE_ENV = 'dev';   // .env sets prod; this script writes rows

const mongoose = require('mongoose');
const JobPosting = require('../models/JobPosting');
const JobBoard = require('../models/JobBoard');
const Settings = require('../models/Settings');
const boards = require('../lib/boards');
const sync = require('../lib/postingSync');
const R = require('../lib/boards/result');
const { normaliseCriteria } = require('../lib/criteria');

let pass = 0, fail = 0;
const ok = (l, c, d = '') => { c ? (pass++, console.log('  ok   ' + l)) : (fail++, console.log('  FAIL ' + l + (d ? '  << ' + d : ''))); };
const eq = (l, g, w) => ok(l + ' = ' + JSON.stringify(w), g === w, 'got ' + JSON.stringify(g));

const post = (id, title, extra = {}) => ({
  sourceId: id, title, company: 'Co', department: '', team: '', location: 'Remote',
  locations: ['Remote'], remote: true, workplaceType: 'remote', employmentType: '',
  country: '', url: 'https://x.test/' + id, applyUrl: 'https://x.test/' + id,
  requisitionId: '', postedAt: null, sourceUpdatedAt: null, ...extra,
});

let stub = () => R.empty();
boards.fetchBoard = async () => stub();
const run = async (b, opts = {}) => sync.syncBoard(await JobBoard.findById(b._id).lean(), { runStartedAt: new Date(), ...opts });

(async () => {
  await mongoose.connect(process.env.MONGODB_URI_DEV, { serverSelectionTimeoutMS: 10000 });
  if (!/dev/i.test(mongoose.connection.name)) throw new Error('refusing to run outside dev');
  console.log('db:', mongoose.connection.name, '\n');

  const TOK = '__searchtest', TOK2 = '__critboard';
  await JobPosting.deleteMany({ boardToken: { $in: [TOK, TOK2] } });
  await JobPosting.deleteMany({ source: { $in: ['muse', 'jobicy'] }, sourceId: /^S/ });
  await JobBoard.deleteMany({ token: { $in: [TOK, TOK2] } });

  // ── A. a SEARCH source must never close postings ─────────────────────────
  console.log('A. a search source never closes postings');
  const search = await JobBoard.create({ source: 'muse', token: TOK, label: 'SWE search', query: { category: 'Software Engineering' } });
  stub = () => R.ok([post('S1', 'Backend Engineer'), post('S2', 'ML Engineer'), post('S3', 'Data Engineer')]);
  let r = await run(search);
  eq('kind', r.kind, 'search');
  eq('inserted', r.inserted, 3);
  const searchKeys = ['S1', 'S2', 'S3'].map(i => boards.sourceKeyFor('muse', TOK, i));
  eq('sourceKey omits the token', searchKeys[0], 'muse:S1');
  eq('rows', await JobPosting.countDocuments({ sourceKey: { $in: searchKeys } }), 3);

  // page 2 of the query returns different jobs — the earlier ones must NOT close
  stub = () => R.ok([post('S4', 'Platform Engineer')]);
  r = await run(search);
  eq('closed', r.closed, 0);
  eq('nothing closed in db',
    await JobPosting.countDocuments({ sourceKey: { $in: searchKeys }, listingStatus: 'closed' }), 0);
  ok('this is the whole point: a partial slice is not evidence of closure', r.closed === 0);

  // even an EMPTY search result must not close
  stub = () => R.empty();
  r = await run(search);
  eq('empty search: status', r.status, 'empty');
  eq('empty search: closed', r.closed, 0);
  eq('still nothing closed',
    await JobPosting.countDocuments({ source: 'muse', listingStatus: 'closed' }), 0);

  console.log('\nA2. queries attribution accumulates across saved searches');
  const search2 = await JobBoard.create({ source: 'muse', token: '__searchtest2', label: 'ML search', query: { category: 'Data and Analytics' } });
  stub = () => R.ok([post('S1', 'Backend Engineer')]);   // same job, different search
  await run(search2);
  const s1 = await JobPosting.findOne({ sourceKey: 'muse:S1' }).lean();
  eq('still ONE row for that job', await JobPosting.countDocuments({ sourceKey: 'muse:S1' }), 1);
  eq('credited to both searches', JSON.stringify([...s1.queries].sort()), JSON.stringify(['ML search', 'SWE search']));

  // ── B. criteria filtering must not cause wrong closes ────────────────────
  console.log('\nB. criteria filtering never closes a still-listed posting');
  const board = await JobBoard.create({ source: 'greenhouse', token: TOK2, label: 'Crit' });
  const listing = [post('B1', 'Backend Engineer'), post('B2', 'Account Executive'), post('B3', 'ML Engineer')];
  stub = () => R.ok(listing);

  // first, with criteria OFF, store all three
  r = await run(board, { criteria: normaliseCriteria({ enabled: false }) });
  eq('criteria off: inserted', r.inserted, 3);
  eq('criteria off: filteredOut', r.filteredOut, 0);

  // now turn criteria ON. B2 (Account Executive) stops matching — but the board
  // still lists it, so it must NOT be closed.
  const crit = normaliseCriteria({ enabled: true });
  r = await run(board, { criteria: crit });
  eq('filteredOut', r.filteredOut, 1);
  eq('updated (only the matching two)', r.updated, 2);
  eq('closed', r.closed, 0);
  const b2 = await JobPosting.findOne({ sourceKey: boards.sourceKeyFor('greenhouse', TOK2, 'B2') }).lean();
  eq('the filtered-out posting is STILL open', b2.listingStatus, 'open');
  ok('and its lastSeenAt was refreshed', +b2.lastSeenAt > 0);
  eq('nothing closed on that board',
    await JobPosting.countDocuments({ source: 'greenhouse', boardToken: TOK2, listingStatus: 'closed' }), 0);

  console.log('\nB2. a genuinely vanished posting still closes, criteria on');
  stub = () => R.ok([post('B1', 'Backend Engineer'), post('B2', 'Account Executive')]);  // B3 gone
  r = await run(board, { criteria: crit });
  eq('closed', r.closed, 1);
  const b3 = await JobPosting.findOne({ sourceKey: boards.sourceKeyFor('greenhouse', TOK2, 'B3') }).lean();
  eq('B3 closed', b3.listingStatus, 'closed');
  const b2b = await JobPosting.findOne({ sourceKey: boards.sourceKeyFor('greenhouse', TOK2, 'B2') }).lean();
  eq('B2 (filtered out but listed) still open', b2b.listingStatus, 'open');

  console.log('\nB3. criteria filters what gets STORED on a fresh board');
  await JobPosting.deleteMany({ boardToken: TOK2 });
  stub = () => R.ok(listing);
  r = await run(board, { criteria: crit });
  eq('inserted only the matching roles', r.inserted, 2);
  eq('filteredOut', r.filteredOut, 1);
  const titles = (await JobPosting.find({ boardToken: TOK2 }).lean()).map(x => x.title).sort();
  eq('stored titles', JSON.stringify(titles), JSON.stringify(['Backend Engineer', 'ML Engineer']));

  // cleanup
  await JobPosting.deleteMany({ boardToken: { $in: [TOK, TOK2] } });
  await JobPosting.deleteMany({ sourceKey: /^muse:S/ });
  await JobBoard.deleteMany({ token: { $in: [TOK, TOK2, '__searchtest2'] } });
  eq('Settings still a singleton', await Settings.countDocuments({}), 1);
  console.log('\ncleaned up.');
  console.log('\n============  ' + pass + ' passed, ' + fail + ' failed  ============');
  await mongoose.disconnect();
  process.exit(fail ? 1 : 0);
})().catch(async e => { console.error('HARNESS ERROR:', e); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
