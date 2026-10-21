#!/usr/bin/env node
/**
 * Cloud worker admin endpoints (routes/admin.js → /users/:id/cloud-worker,
 * routes/scrapes.js → GET /worker-token).
 *
 * Asserts:
 *   - only an admin can set a cloud browser or issue a token (403 / 401 otherwise);
 *   - the link must be an https://screen-<name>.<domain> link — nothing else saves;
 *   - "Save link" never touches the account's existing worker token;
 *   - "issue token" returns the raw token once, stores only its SHA-256, and the
 *     token then authenticates as that account (and no other);
 *   - the user sees their own link in GET /api/scrapes/worker-token;
 *   - the fleet listing carries the link but no token and no hash;
 *   - DELETE clears the link, and with ?revokeToken=1 kills the token.
 *
 * Dev database ONLY, with the server already up:
 *   NODE_ENV=dev PORT=4099 node server.js
 *   node scripts/test-cloud-worker.js --base=http://localhost:4099 --email=you@example.com
 */
require('dotenv').config();
const crypto = require('crypto');
const mongoose = require('mongoose');
const { loginViaOtp } = require('./test-helpers');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const BASE = value('base') || 'http://localhost:4099';
const URI = process.env.MONGODB_URI_DEV;
const DOMAIN = (process.env.CLOUD_SCREEN_DOMAIN || 'jainprashuk.in').toLowerCase();

let pass = 0, fail = 0;
const check = (cond, m) => { if (cond) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const sha = (v) => crypto.createHash('sha256').update(v).digest('hex');

const call = async (method, path, cookie, body) => {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
};

async function main() {
  if (!URI) throw new Error('MONGODB_URI_DEV is not set');
  if (/prod/i.test(URI)) throw new Error('Refusing to run against a production URI');
  const email = value('email');
  if (!email) throw new Error('Pass --email= for the admin account');

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const users = mongoose.connection.db.collection('users');
  const admin = await users.findOne({ email: email.toLowerCase() });
  if (!admin || admin.isAdmin !== true) throw new Error(`${email} is not an admin on this database`);

  // A scratch account with a pre-existing worker token, as if it ran on a Mac.
  const OLD_TOKEN = `wk_old_${Date.now()}`;
  const target = await users.insertOne({
    email: `cloud-worker-${Date.now()}@example.invalid`, name: '', isAdmin: false, status: 'active',
    workerTokenHash: sha(OLD_TOKEN), createdAt: new Date(), updatedAt: new Date(),
    onboarding: { startedAt: null, completedAt: new Date(), step: 99, skipped: [], version: 1 },
  });
  const tid = String(target.insertedId);
  const targetEmail = (await users.findOne({ _id: target.insertedId })).email;
  const path = `/api/admin/users/${tid}/cloud-worker`;
  const good = `https://screen-zztest.${DOMAIN}`;
  const { resolveWorkerUser } = require('../lib/workerAuth');

  try {
    const adminCookie = await loginViaOtp({ base: BASE, email });
    const userCookie = await loginViaOtp({ base: BASE, email: targetEmail });

    console.log('Guards:');
    check((await call('POST', path, userCookie, { screenUrl: good, issueToken: true })).status === 403, 'a non-admin gets 403 on POST');
    check((await call('DELETE', path, userCookie)).status === 403, 'a non-admin gets 403 on DELETE');
    check((await call('POST', path, '', { screenUrl: good })).status === 401, 'signed out gets 401');
    check((await users.findOne({ _id: target.insertedId })).workerTokenHash === sha(OLD_TOKEN), 'the refused calls changed nothing');

    console.log('\nOnly screen-<name> links on the cloud domain save:');
    for (const bad of [
      'http://screen-zz.' + DOMAIN, 'https://evil.com', `https://screen-zz.${DOMAIN}.evil.com`,
      `https://screen-zz.${DOMAIN}/path`, `https://zz.${DOMAIN}`, `https://screen-.${DOMAIN}`, '',
    ]) {
      check((await call('POST', path, adminCookie, { screenUrl: bad })).status === 400, `refused: ${bad || '(empty)'}`);
    }

    console.log('\nSave link (no token):');
    const saved = await call('POST', path, adminCookie, { screenUrl: `${good.toUpperCase().replace('HTTPS', 'https')}/` });
    check(saved.status === 200 && saved.data.cloudScreenUrl === good, 'saved, normalised (lowercase, no trailing slash)');
    check(!('token' in (saved.data || {})), 'no token in the answer');
    let doc = await users.findOne({ _id: target.insertedId });
    check(doc.cloudScreenUrl === good, 'stored on the account');
    check(doc.workerTokenHash === sha(OLD_TOKEN), 'their existing worker token is untouched');

    console.log('\nThe user sees their own link:');
    const mine = await call('GET', '/api/scrapes/worker-token', userCookie);
    check(mine.status === 200 && mine.data.cloudScreenUrl === good && mine.data.registered === true, 'GET /api/scrapes/worker-token returns it');

    console.log('\nIssue a token:');
    const issued = await call('POST', path, adminCookie, { screenUrl: good, issueToken: true });
    const token = issued.data && issued.data.token;
    check(issued.status === 200 && /^wk_[A-Za-z0-9_-]{20,}$/.test(token || ''), 'a wk_ token comes back once');
    doc = await users.findOne({ _id: target.insertedId });
    check(doc.workerTokenHash === sha(token), 'only its SHA-256 is stored');
    check(!JSON.stringify(doc).includes(token), 'the raw token is nowhere on the account');
    check(String(await resolveWorkerUser(token)) === tid, 'the new token authenticates as this account');
    check(await resolveWorkerUser(OLD_TOKEN) === null, 'the old token no longer works');

    console.log('\nThe fleet listing carries the link, never the token:');
    const fleet = await call('GET', '/api/admin/users', adminCookie);
    const row = (fleet.data.users || []).find(u => u.id === tid);
    check(row && row.cloudScreenUrl === good, 'the row has cloudScreenUrl');
    const json = JSON.stringify(fleet.data);
    check(!json.includes(token) && !json.includes(sha(token)), 'neither the token nor its hash appears');

    console.log('\nRemove:');
    const kept = await call('DELETE', path, adminCookie);
    doc = await users.findOne({ _id: target.insertedId });
    check(kept.status === 200 && !('cloudScreenUrl' in doc) && doc.workerTokenHash === sha(token), 'plain DELETE clears the link, keeps the token');
    await call('POST', path, adminCookie, { screenUrl: good });
    const gone = await call('DELETE', `${path}?revokeToken=1`, adminCookie);
    doc = await users.findOne({ _id: target.insertedId });
    check(gone.status === 200 && gone.data.tokenRevoked === true && !('cloudScreenUrl' in doc) && doc.workerTokenHash === null,
      'DELETE ?revokeToken=1 clears the link and revokes the token');
    check(await resolveWorkerUser(token) === null, 'the revoked token no longer authenticates');
    const after = await call('GET', '/api/scrapes/worker-token', userCookie);
    check(after.data.cloudScreenUrl === null && after.data.registered === false, 'the user sees no link and no token');
  } finally {
    await users.deleteOne({ _id: target.insertedId });
    await mongoose.connection.db.collection('sessions').deleteMany({ userId: target.insertedId });
    await mongoose.connection.db.collection('activitylogs').deleteMany({ userId: target.insertedId });
    await mongoose.disconnect();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
