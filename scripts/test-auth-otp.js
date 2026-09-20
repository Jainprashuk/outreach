#!/usr/bin/env node
/**
 * Sign-in code tests.
 *
 * The properties worth protecting here are easy to lose in a refactor and
 * invisible when they break:
 *   - a request for an unknown address must be indistinguishable from one for a
 *     real address, INCLUDING when rate limited (so: never a 429);
 *   - a six-digit code is only safe because of the attempt cap;
 *   - locking out must burn the CODE, not the account, or guessing at someone
 *     else's address becomes a denial of service against them.
 *
 * Dev database ONLY, with the server already up and NO RESEND_API_KEY set:
 *   NODE_ENV=dev PORT=4099 node server.js
 *   node scripts/test-auth-otp.js --base=http://localhost:4099 --email=you@example.com
 */
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const BASE = value('base') || 'http://localhost:4099';
const URI = process.env.MONGODB_URI_DEV;

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };

const post = async (path, body) => {
  const res = await fetch(BASE + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null; try { data = JSON.parse(text); } catch (_) {}
  return { status: res.status, text, data, setCookie: res.headers.get('set-cookie') || '' };
};

let codes, users, sessions;

/** Rewrites the newest row for an address to a code we know. Standing in for an
 *  inbox — the plaintext is never stored, by design. */
async function plant(email, code = '424242') {
  const row = await codes.findOne({ email }, { sort: { createdAt: -1 } });
  if (!row || !row.codeSalt) return null;
  await codes.updateOne({ _id: row._id }, {
    $set: {
      codeHash: crypto.createHmac('sha256', row.codeSalt).update(code).digest('hex'),
      attempts: 0, consumedAt: null, consumedReason: null,
    },
  });
  return row;
}

/** Rate limits are counted from the rows, so clearing them resets the window. */
const clearCodes = (email) => codes.deleteMany({ email });

async function main() {
  if (!URI) throw new Error('MONGODB_URI_DEV is not set');
  if (/prod/i.test(URI)) throw new Error('Refusing to run against a production URI');
  const EMAIL = (value('email') || '').toLowerCase();
  if (!EMAIL) throw new Error('Pass --email= for a whitelisted account');

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  codes = db.collection('logincodes');
  users = db.collection('users');
  sessions = db.collection('sessions');

  const account = await users.findOne({ email: EMAIL });
  if (!account) throw new Error(`No account for ${EMAIL}`);

  const UNKNOWN = `nobody-${Date.now()}@example.invalid`;
  const DISABLED = `disabled-${Date.now()}@example.invalid`;
  let disabledId = null;

  console.log(`\nDatabase: ${db.databaseName}`);
  console.log(`Account:  ${EMAIL}\n`);

  try {
    // ── Happy path ────────────────────────────────────────────────────────
    console.log('A whitelisted address can sign in:');
    await clearCodes(EMAIL);
    const req1 = await post('/api/auth/request-code', { email: EMAIL });
    req1.status === 200 ? ok('request-code -> 200') : bad(`request-code -> ${req1.status}`);

    const row = await codes.findOne({ email: EMAIL }, { sort: { createdAt: -1 } });
    row && row.codeHash ? ok('a code row was written, hashed') : bad('no hashed code row');
    row && !/\b\d{6}\b/.test(JSON.stringify({ ...row, _id: undefined }))
      ? ok('the plaintext code is nowhere in the row')
      : bad('a six-digit value is stored in the row');

    await plant(EMAIL);
    const v1 = await post('/api/auth/verify-code', { email: EMAIL, code: '424242' });
    v1.status === 200 ? ok('verify-code -> 200') : bad(`verify-code -> ${v1.status}`);
    /outreach_session=/.test(v1.setCookie) ? ok('a session cookie was set') : bad('no session cookie');

    const cookie = v1.setCookie.split(';')[0];
    const me = await fetch(BASE + '/api/contacts/stats', { headers: { Cookie: cookie } });
    me.status === 200 ? ok('that cookie authenticates a real API call') : bad(`the cookie does not work (${me.status})`);

    const used = await codes.findOne({ _id: row._id });
    used.consumedReason === 'verified' ? ok("the row is marked 'verified'") : bad(`row reason is ${used.consumedReason}`);
    const acct = await users.findOne({ _id: account._id });
    acct.status === 'active' ? ok("the account is 'active'") : bad(`status is ${acct.status}`);
    acct.lastLoginAt ? ok('lastLoginAt was set') : bad('lastLoginAt not set');

    // ── Replay and supersession ───────────────────────────────────────────
    console.log('\nA code works exactly once:');
    const replay = await post('/api/auth/verify-code', { email: EMAIL, code: '424242' });
    replay.status === 401 ? ok('replaying it -> 401') : bad(`replaying it -> ${replay.status}`);

    await clearCodes(EMAIL);
    await post('/api/auth/request-code', { email: EMAIL });
    const older = await plant(EMAIL, '111111');
    await codes.updateOne({ _id: older._id }, { $set: { createdAt: new Date(Date.now() - 120000) } });
    await post('/api/auth/request-code', { email: EMAIL });
    const supersededRow = await codes.findOne({ _id: older._id });
    supersededRow.consumedReason === 'superseded' ? ok('asking again supersedes the old code') : bad(`old code reason is ${supersededRow.consumedReason}`);
    const vOld = await post('/api/auth/verify-code', { email: EMAIL, code: '111111' });
    vOld.status === 401 ? ok('the superseded code -> 401') : bad(`the superseded code -> ${vOld.status}`);

    console.log('\nAn expired code is refused:');
    await clearCodes(EMAIL);
    await post('/api/auth/request-code', { email: EMAIL });
    const exp = await plant(EMAIL);
    await codes.updateOne({ _id: exp._id }, { $set: { validUntil: new Date(Date.now() - 1000) } });
    const vExp = await post('/api/auth/verify-code', { email: EMAIL, code: '424242' });
    vExp.status === 401 ? ok('an expired code -> 401') : bad(`an expired code -> ${vExp.status}`);

    // ── Brute force ───────────────────────────────────────────────────────
    console.log('\nGuessing is capped, and the cap burns the code not the account:');
    await clearCodes(EMAIL);
    await post('/api/auth/request-code', { email: EMAIL });
    const target = await plant(EMAIL);
    let all401 = true;
    for (let i = 0; i < 5; i++) {
      const r = await post('/api/auth/verify-code', { email: EMAIL, code: '000000' });
      if (r.status !== 401) all401 = false;
    }
    all401 ? ok('five wrong codes -> five 401s') : bad('a wrong code did not return 401');
    const locked = await codes.findOne({ _id: target._id });
    locked.attempts >= 5 ? ok(`attempts reached ${locked.attempts}`) : bad(`attempts only ${locked.attempts}`);

    const rightButLocked = await post('/api/auth/verify-code', { email: EMAIL, code: '424242' });
    rightButLocked.status === 401 ? ok('the CORRECT code is now refused too') : bad(`the correct code -> ${rightButLocked.status}`);

    await clearCodes(EMAIL);
    await post('/api/auth/request-code', { email: EMAIL });
    await plant(EMAIL);
    const recovered = await post('/api/auth/verify-code', { email: EMAIL, code: '424242' });
    recovered.status === 200
      ? ok('a freshly requested code still works — the account was not locked')
      : bad(`the account appears locked (${recovered.status})`);

    // ── Enumeration ───────────────────────────────────────────────────────
    console.log('\nAn unknown address is indistinguishable from a real one:');
    await clearCodes(EMAIL);
    const real = await post('/api/auth/request-code', { email: EMAIL });
    const fake = await post('/api/auth/request-code', { email: UNKNOWN });
    fake.status === real.status ? ok(`same status (${real.status})`) : bad(`${real.status} vs ${fake.status}`);
    fake.text === real.text ? ok('byte-identical body') : bad(`bodies differ: ${real.text} vs ${fake.text}`);

    const decoy = await codes.findOne({ email: UNKNOWN }, { sort: { createdAt: -1 } });
    decoy ? ok('a decoy row was written for it') : bad('no decoy row — the rate limits would differ');
    decoy && decoy.codeHash === null && decoy.userId === null
      ? ok('the decoy has no hash and no user, so it can never verify')
      : bad('the decoy row is not inert');
    const vFake = await post('/api/auth/verify-code', { email: UNKNOWN, code: '424242' });
    vFake.status === 401 ? ok('verifying against it -> 401') : bad(`verifying against it -> ${vFake.status}`);
    !vFake.setCookie.includes('outreach_session') ? ok('and no session is issued') : bad('a session was issued for an unknown address');

    // ── Rate limiting ─────────────────────────────────────────────────────
    console.log('\nRate limiting never announces itself:');
    await clearCodes(EMAIL);
    const first = await post('/api/auth/request-code', { email: EMAIL });
    const second = await post('/api/auth/request-code', { email: EMAIL });
    second.status === 200 ? ok('a second request inside the cooldown -> 200') : bad(`-> ${second.status}`);
    second.status !== 429 ? ok('never a 429 (a 429 would itself identify real addresses)') : bad('returned 429');
    second.text === first.text ? ok('byte-identical body to the un-throttled one') : bad('the throttled body differs');
    const count = await codes.countDocuments({ email: EMAIL });
    count === 1 ? ok('and no second row was written') : bad(`${count} rows written`);

    // ── Disabled accounts ─────────────────────────────────────────────────
    console.log('\nA disabled account cannot sign in:');
    const ins = await users.insertOne({
      email: DISABLED, name: '', isAdmin: false, status: 'disabled',
      createdAt: new Date(), updatedAt: new Date(),
      onboarding: { startedAt: null, completedAt: null, step: 0, skipped: [], version: 0 },
    });
    disabledId = ins.insertedId;
    const dReq = await post('/api/auth/request-code', { email: DISABLED });
    dReq.status === 200 ? ok('requesting a code -> the same 200') : bad(`-> ${dReq.status}`);
    const dRow = await codes.findOne({ email: DISABLED }, { sort: { createdAt: -1 } });
    dRow && dRow.codeHash === null ? ok('but only a decoy row was written') : bad('a usable code was issued to a disabled account');

    // ── Machine callers still work ────────────────────────────────────────
    console.log('\nMachine callers are unaffected:');
    const noCookie = await fetch(BASE + '/api/contacts');
    noCookie.status === 401 ? ok('an unauthenticated API call -> 401') : bad(`-> ${noCookie.status}`);
    const login = await fetch(BASE + '/login');
    login.status === 200 ? ok('/login is still public') : bad(`/login -> ${login.status}`);
    const sess = await fetch(BASE + '/api/auth/session');
    sess.status === 200 ? ok('/api/auth/session is still public') : bad(`-> ${sess.status}`);
  } finally {
    await codes.deleteMany({ email: { $in: [UNKNOWN, DISABLED] } });
    if (disabledId) await users.deleteOne({ _id: disabledId });
    await clearCodes(EMAIL);
    // The suite signs in several times; tidy up after itself.
    await sessions.deleteMany({ userId: account._id, createdAt: { $gt: new Date(Date.now() - 600000) } });
    console.log('\nCleaned up test rows.');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exitCode = 1;
}

main()
  .catch(err => { console.error(`\n✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
