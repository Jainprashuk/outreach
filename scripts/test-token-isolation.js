#!/usr/bin/env node
/**
 * Cross-account isolation for the two bearer credentials that identify an
 * account without a session: the scrape-worker token and the read-only share
 * link.
 *
 * This exists because the bug it checks for was real: once worker tokens
 * identified an account, /claim still handed out ANY queued run, so a second
 * account's worker picked up the first account's work. The /finish case matters
 * most — a worker can report `blocked`, which freezes ALL harvesting for that
 * account for 7 days, and being able to do that to somebody else is a denial of
 * service, not just a data leak.
 *
 * Creates a real second account (worker auth resolves users by token, so a
 * fabricated id would not work), then removes it.
 *
 * Dev database ONLY, with the server already up:
 *   node scripts/test-token-isolation.js --base=http://localhost:4042 \
 *     --email=you@example.com --password=...
 */
require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const BASE = value('base') || 'http://localhost:4042';
const URI = process.env.MONGODB_URI_DEV;

let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };

const post = async (path, body, token) => {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Worker-Secret': token } : {}) },
    body: JSON.stringify(body),
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
};

async function main() {
  if (!URI) throw new Error('MONGODB_URI_DEV is not set');
  if (/prod/i.test(URI)) throw new Error('Refusing to run against a production URI');
  const email = value('email');
  if (!email) throw new Error('Pass --email= for the genuine account');

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const User = require('../models/User');
  const ScrapeRun = require('../models/ScrapeRun');
  const ScrapeWorker = require('../models/ScrapeWorker');
  const { hashPassword } = require('../lib/password');
  const { issueWorkerToken } = require('../lib/workerAuth');
  const { issueShareToken } = require('../lib/shareAuth');
  const Contact = require('../models/Contact');

  const owner = await User.findOne({ email: email.toLowerCase() });
  if (!owner) throw new Error(`No account for ${email}`);

  const intruder = await User.create({
    email: `worker-isolation-${Date.now()}@example.invalid`,
    passwordHash: await hashPassword('x'.repeat(16)),
  });
  const intruderToken = await issueWorkerToken(intruder._id);
  const run = await ScrapeRun.create({
    userId: owner._id, queries: ['owner-only-query'], trigger: 'manual', status: 'queued',
  });

  console.log(`\nOwner:    ${owner._id}`);
  console.log(`Intruder: ${intruder._id}`);
  console.log(`Owner's queued run: ${run._id}\n`);

  try {
    console.log('Claiming:');
    {
      const { status, data } = await post('/api/scrapes/claim', { host: 'intruder-mac' }, intruderToken);
      const handed = data && data.run ? (data.run.queries || []).join(',') : null;
      status === 200 ? ok('the intruder worker authenticates as its own account')
                     : bad(`claim returned ${status}`);
      handed === null ? ok("it is handed none of the owner's queued runs")
                      : bad(`it was handed the owner's run (${handed})`);
    }

    console.log('\nWriting to the owner\'s run by id:');
    for (const [path, body, label] of [
      ['/api/scrapes/progress', { runId: String(run._id), progress: { rendered: 99 } }, 'progress'],
      ['/api/scrapes/ingest',   { runId: String(run._id), leads: [{ author_name: 'x', emails: ['x@y.invalid'] }] }, 'ingest'],
      ['/api/scrapes/finish',   { runId: String(run._id), status: 'blocked' }, 'finish (would freeze harvesting for 7 days)'],
    ]) {
      const { status } = await post(path, body, intruderToken);
      status === 404 ? ok(`${label} -> 404`) : bad(`${label} -> ${status} (expected 404)`);
    }

    console.log('\nUnauthenticated and forged tokens:');
    for (const [label, token] of [['no token', undefined], ['garbage token', 'wk_not-a-real-token']]) {
      const { status } = await post('/api/scrapes/claim', {}, token);
      status === 401 ? ok(`${label} -> 401`) : bad(`${label} -> ${status} (expected 401)`);
    }

    console.log('\nThe owner\'s run and worker state are untouched:');
    {
      const after = await ScrapeRun.findById(run._id).lean();
      after && after.status === 'queued'
        ? ok('the run is still queued, not claimed or finished by the intruder')
        : bad(`the run is now "${after && after.status}"`);

      const ownerWorker = await ScrapeWorker.findOne({ userId: owner._id }).lean();
      const blocked = ownerWorker && ownerWorker.blockedUntil && new Date(ownerWorker.blockedUntil) > new Date();
      blocked ? bad('the intruder triggered the 7-day LinkedIn block on the owner')
              : ok('no LinkedIn block was inflicted on the owner');
    }

    console.log('\nShare links are per account:');
    {
      const intruderShare = await issueShareToken(intruder._id);
      const marker = `share-isolation-${Date.now()}@example.invalid`;
      await Contact.create({ userId: intruder._id, name: 'Intruder Contact', email: marker, status: 'queued' });

      const res = await fetch(`${BASE}/api/share/contacts?s=${encodeURIComponent(intruderShare)}`);
      const data = await res.json().catch(() => ({}));
      const rows = data.contacts || [];
      res.status === 200 ? ok('the intruder link resolves to its own account') : bad(`share link returned ${res.status}`);
      rows.length === 1 && rows[0].email === marker
        ? ok("it shows only that account's contact")
        : bad(`it returned ${rows.length} rows — the owner's contacts leaked`);

      const bogus = await fetch(`${BASE}/api/share/contacts?s=sh_not-a-real-token`);
      bogus.status === 200 ? bad('a forged share token was accepted') : ok(`a forged share token -> ${bogus.status}`);

      await Contact.deleteOne({ email: marker });
    }
  } finally {
    await ScrapeRun.deleteOne({ _id: run._id });
    await ScrapeWorker.deleteMany({ userId: intruder._id });
    await Contact.deleteMany({ userId: intruder._id });
    await User.deleteOne({ _id: intruder._id });
    console.log('\nCleaned up the test account and run.');
    await mongoose.connection.close();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exitCode = 1;
}

main().catch(err => { console.error(`\n✗ ${err.message}\n`); process.exitCode = 1; });
