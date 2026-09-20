#!/usr/bin/env node
/**
 * Admin-route isolation test.
 *
 * routes/admin.js is the only file that queries across users, so it gets its own
 * suite. Two things are asserted: that nobody but an admin can reach it, and
 * that what it returns is counts rather than anybody's content.
 *
 * The route list is DERIVED by walking the router's own stack rather than
 * written out here. A hand-written list is the weakness in a test like this: a
 * route added next month would silently never be checked.
 *
 * Dev database ONLY, with the server already up:
 *   NODE_ENV=dev PORT=4099 node server.js
 *   node scripts/test-admin-isolation.js --base=http://localhost:4099 \
 *     --email=you@example.com
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { loginViaOtp } = require('./test-helpers');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const BASE = value('base') || 'http://localhost:4099';
const URI = process.env.MONGODB_URI_DEV;

let pass = 0, fail = 0;
const ok = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };

const call = async (method, path, cookie, body) => {
  // fetch refuses a body on GET/HEAD, and the route sweep below passes one
  // blindly so it does not have to know which routes take input.
  const sendBody = body && method !== 'GET' && method !== 'HEAD';
  const res = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(sendBody ? { body: JSON.stringify(body) } : {}),
  });
  let data = null;
  try { data = await res.json(); } catch (_) {}
  return { status: res.status, data };
};

/** Every (method, path) the router actually exposes, read off its own stack. */
function enumerateRoutes() {
  const router = require('../routes/admin');
  const out = [];
  for (const layer of router.stack) {
    if (!layer.route) continue;
    const path = layer.route.path;
    for (const m of Object.keys(layer.route.methods)) {
      if (layer.route.methods[m]) out.push({ method: m.toUpperCase(), path });
    }
  }
  return out;
}

// Substituted into :params so a guard cannot be mistaken for a 404.
const concrete = (path, id) => path.replace(/:id/g, id);

async function main() {
  if (!URI) throw new Error('MONGODB_URI_DEV is not set');
  if (/prod/i.test(URI)) throw new Error('Refusing to run against a production URI');
  const email = value('email');
  if (!email) throw new Error('Pass --email= for the admin account');

  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const users = db.collection('users');
  const contacts = db.collection('contacts');

  const admin = await users.findOne({ email: email.toLowerCase() });
  if (!admin) throw new Error(`No account for ${email}`);
  if (admin.isAdmin !== true) throw new Error(`${email} is not an admin — run scripts/invite-user.js --admin`);

  const routes = enumerateRoutes();
  console.log(`\nDatabase: ${db.databaseName}`);
  console.log(`Admin:    ${email}`);
  console.log(`Routes discovered: ${routes.map(r => `${r.method} ${r.path}`).join(', ')}\n`);

  // A second real account, used both as the non-admin caller and as the owner
  // of the content that must not leak.
  const SECRET_NAME = `ZZIntruder-${Date.now()}`;
  const SECRET_COMPANY = `ZZSecretCorp-${Date.now()}`;
  const outsider = await users.insertOne({
    email: `admin-isolation-${Date.now()}@example.invalid`,
    name: '', isAdmin: false, status: 'active',
    createdAt: new Date(), updatedAt: new Date(),
    onboarding: { startedAt: null, completedAt: new Date(), step: 99, skipped: [], version: 1 },
  });
  const outsiderId = outsider.insertedId;
  const outsiderDoc = await users.findOne({ _id: outsiderId });

  const plantedContact = await contacts.insertOne({
    userId: outsiderId, name: SECRET_NAME, company: SECRET_COMPANY,
    email: `zz-${Date.now()}@example.invalid`, status: 'sent', approvalStatus: 'approved',
    lastSentAt: new Date(), statusHistory: [], createdAt: new Date(), updatedAt: new Date(),
  });

  try {
    const outsiderCookie = await loginViaOtp({ base: BASE, email: outsiderDoc.email });
    const adminCookie = await loginViaOtp({ base: BASE, email });

    console.log('Every admin route refuses a signed-in non-admin:');
    for (const r of routes) {
      const { status } = await call(r.method, '/api/admin' + concrete(r.path, String(outsiderId)), outsiderCookie, { email: 'x@y.invalid' });
      if (status === 403) ok(`${r.method} ${r.path} -> 403`);
      else bad(`${r.method} ${r.path} -> ${status}, expected 403`);
    }

    console.log('\nAnd an unauthenticated caller:');
    for (const r of routes) {
      const { status } = await call(r.method, '/api/admin' + concrete(r.path, String(outsiderId)), '', { email: 'x@y.invalid' });
      // 401, not 403: "you are not signed in" is a different answer from
      // "you are, and no". The client relies on the distinction.
      if (status === 401) ok(`${r.method} ${r.path} -> 401`);
      else bad(`${r.method} ${r.path} -> ${status}, expected 401`);
    }

    console.log('\nMachine credentials are never admins:');
    const forged = await fetch(BASE + '/api/admin/users', { headers: { 'X-Worker-Secret': 'wk_forged' } });
    forged.status === 401 || forged.status === 403
      ? ok(`a forged worker token -> ${forged.status}`)
      : bad(`a forged worker token -> ${forged.status}`);

    console.log('\nThe admin read returns counts, not content:');
    const { status, data } = await call('GET', '/api/admin/users', adminCookie);
    status === 200 ? ok('the admin gets 200') : bad(`the admin gets ${status}`);

    // The planted row must be COUNTED — otherwise this whole section could pass
    // simply because the endpoint returned nothing.
    const outsiderRow = (data.users || []).find(u => u.id === String(outsiderId));
    outsiderRow ? ok('the other account appears in the listing') : bad('the other account is missing from the listing');
    outsiderRow && outsiderRow.contacts.total >= 1
      ? ok(`its contact was counted (total ${outsiderRow.contacts.total})`)
      : bad('its contact was not counted — the leak checks below would prove nothing');

    const json = JSON.stringify(data);
    !json.includes(SECRET_NAME) ? ok('no contact name appears anywhere in the payload') : bad('a contact NAME leaked');
    !json.includes(SECRET_COMPANY) ? ok('no company name appears anywhere in the payload') : bad('a company name leaked');

    const DENY = ['passwordHash', 'gmailAppPasswordEnc', 'workerTokenHash', 'shareTokenHash',
                  'tokenHash', 'codeHash', 'codeSalt', 'statusHistory', 'thread', 'items', 'replySnippet'];
    const badKeys = [];
    const hashes = [];
    (function walk(node, path) {
      if (node && typeof node === 'object') {
        for (const [k, v] of Object.entries(node)) {
          if (DENY.includes(k)) badKeys.push(`${path}.${k}`);
          walk(v, `${path}.${k}`);
        }
      } else if (typeof node === 'string' && /^[a-f0-9]{64}$/.test(node)) {
        hashes.push(path);
      }
    })(data, '');
    badKeys.length === 0 ? ok('no sensitive key names in the payload') : bad(`sensitive keys present: ${badKeys.join(', ')}`);
    hashes.length === 0 ? ok('no hash-shaped strings in the payload') : bad(`hash-shaped values at: ${hashes.join(', ')}`);

    console.log('\nAn admin cannot lock the install out of itself:');
    const self = await call('PATCH', `/api/admin/users/${admin._id}`, adminCookie, { status: 'disabled' });
    self.status === 400 ? ok('disabling your own account -> 400') : bad(`disabling your own account -> ${self.status}`);
    const demote = await call('PATCH', `/api/admin/users/${admin._id}`, adminCookie, { isAdmin: false });
    demote.status === 400 ? ok('removing your own admin -> 400') : bad(`removing your own admin -> ${demote.status}`);
    const junk = await call('PATCH', '/api/admin/users/not-an-id', adminCookie, { status: 'active' });
    junk.status === 400 ? ok('a malformed id -> 400, not a 500') : bad(`a malformed id -> ${junk.status}`);

    console.log('\nThe admin is still an admin, and still enabled:');
    const after = await users.findOne({ _id: admin._id }, { projection: { isAdmin: 1, status: 1 } });
    after.isAdmin === true && after.status !== 'disabled'
      ? ok('unchanged after the refused self-edits')
      : bad(`CHANGED: isAdmin=${after.isAdmin} status=${after.status}`);
  } finally {
    await contacts.deleteOne({ _id: plantedContact.insertedId });
    await users.deleteOne({ _id: outsiderId });
    await db.collection('sessions').deleteMany({ userId: outsiderId });
    await db.collection('logincodes').deleteMany({ email: outsiderDoc.email });
    console.log('\nCleaned up the planted account and contact.');
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exitCode = 1;
}

main()
  .catch(err => { console.error(`\n✗ ${err.message}\n`); process.exitCode = 1; })
  .finally(() => mongoose.connection.close());
