#!/usr/bin/env node
/**
 * Cross-tenant isolation test.
 *
 * Plants documents owned by a second, fabricated user, then drives the real HTTP
 * API as the genuine user and asserts none of them are readable, patchable or
 * deletable. Discipline does not catch a missed `userId` filter — this does.
 *
 * It fabricates the intruder's id rather than creating a real User row on
 * purpose: lib/currentUser.js refuses to resolve an owner once two accounts
 * exist, so a real second row would fail the whole suite for the wrong reason.
 *
 * Run against a dev database ONLY, with the server already up:
 *   NODE_ENV=dev PORT=4012 node server.js
 *   node scripts/test-tenant-isolation.js --base=http://localhost:4012 \
 *     --email=you@example.com
 *
 * Sign-in is an emailed code now, so there is no --password. The helper drives
 * the real endpoints and reads the issued row from the database.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const args = process.argv.slice(2);
const value = (n) => { const h = args.find(a => a.startsWith(`--${n}=`)); return h ? h.slice(n.length + 3) : null; };
const BASE = value('base') || 'http://localhost:4012';
const URI = process.env.MONGODB_URI_DEV;

// Signs in for real over HTTP rather than forging a cookie, so the test
// exercises the same path a browser takes.
const { loginViaOtp } = require('./test-helpers');
let SESSION_COOKIE = '';

const authCookie = () => SESSION_COOKIE;

const INTRUDER = new mongoose.Types.ObjectId();
let pass = 0, fail = 0;
const ok  = (m) => { pass++; console.log(`  ok   ${m}`); };
const bad = (m) => { fail++; console.log(`  FAIL ${m}`); };

const api = async (path, opts = {}) => {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', Cookie: authCookie(), ...(opts.headers || {}) },
  });
  let body = null;
  try { body = await res.json(); } catch (_) {}
  return { status: res.status, body };
};

const idsIn = (body) => {
  const rows = Array.isArray(body) ? body
    : Array.isArray(body?.contacts) ? body.contacts
    : Array.isArray(body?.leads) ? body.leads
    : Array.isArray(body?.postings) ? body.postings
    : Array.isArray(body?.rows) ? body.rows
    : Array.isArray(body?.entries) ? body.entries
    : [];
  return new Set(rows.map(r => String(r.id ?? r._id)));
};

async function main() {
  if (!URI) throw new Error('MONGODB_URI_DEV is not set');
  if (/prod/i.test(URI)) throw new Error('Refusing to run against a production URI');

  const email = value('email');
  if (!email) throw new Error('Pass --email= for the genuine account');

  // Connect BEFORE signing in: the OTP helper reads the issued code out of the
  // database, so it cannot run against a closed connection.
  await mongoose.connect(URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  SESSION_COOKIE = await loginViaOtp({ base: BASE, email });
  console.log(`\nDatabase: ${db.databaseName}`);
  console.log(`Signed in as: ${email}`);
  console.log(`Intruder user id: ${INTRUDER}\n`);

  const now = new Date();
  const planted = {
    contacts:   { userId: INTRUDER, name: 'Intruder Contact', email: 'intruder@example.com', status: 'queued', approvalStatus: 'pending', createdAt: now, updatedAt: now },
    templates:  { userId: INTRUDER, key: 'intruder-tpl', name: 'Intruder Template', subject: 's', body: 'b', createdAt: now, updatedAt: now },
    leads:      { userId: INTRUDER, authorName: 'Intruder Lead', email: 'intruderlead@example.com', dedupeKey: 'e:intruderlead@example.com', fitScore: 99, createdAt: now, updatedAt: now },
    blocklists: { userId: INTRUDER, type: 'email', value: 'intruder-blocked@example.com', reason: '', createdAt: now, updatedAt: now },
    interviews: { userId: INTRUDER, company: 'Intruder Co', role: 'Eng', status: 'assignment', sourceType: 'manual', email: 'intruderint@example.com', createdAt: now, updatedAt: now },
  };

  const ids = {};
  for (const [col, doc] of Object.entries(planted)) {
    const { insertedId } = await db.collection(col).insertOne(doc);
    ids[col] = String(insertedId);
  }
  console.log('Planted 5 documents owned by the intruder.\n');

  try {
    // 1. LIST endpoints must not surface them.
    console.log('List endpoints:');
    const listChecks = [
      ['contacts',   '/api/contacts?limit=500'],
      ['templates',  '/api/templates'],
      ['leads',      '/api/leads?limit=500'],
      ['blocklists', '/api/blocklist'],
      ['interviews', '/api/interviews'],
    ];
    for (const [col, path] of listChecks) {
      const { body } = await api(path);
      idsIn(body).has(ids[col]) ? bad(`${path} leaked the intruder's ${col} row`) : ok(`${path} hides the intruder's ${col} row`);
    }

    // 2. Direct fetch by id must 404, not serve another tenant's row.
    console.log('\nFetch by id (the IDOR case):');
    const getChecks = [
      ['contacts',   `/api/contacts/${ids.contacts}/thread`],
      ['interviews', `/api/interviews/${ids.interviews}`],
    ];
    for (const [col, path] of getChecks) {
      const { status } = await api(path);
      status === 404 ? ok(`GET ${path} -> 404`) : bad(`GET ${path} -> ${status} (expected 404)`);
    }

    // 3. Writes must not reach another tenant's row.
    console.log('\nWrites by id:');
    const writeChecks = [
      ['PATCH',  `/api/contacts/${ids.contacts}`,     { name: 'HACKED' }],
      ['DELETE', `/api/contacts/${ids.contacts}`,     null],
      ['PATCH',  `/api/templates/intruder-tpl`,        { name: 'HACKED' }],
      ['DELETE', `/api/templates/intruder-tpl`,        null],
      ['PATCH',  `/api/leads/${ids.leads}`,            { company: 'HACKED' }],
      ['DELETE', `/api/leads/${ids.leads}`,            null],
      ['DELETE', `/api/blocklist/${ids.blocklists}`,   null],
      ['PATCH',  `/api/interviews/${ids.interviews}`,  { company: 'HACKED' }],
    ];
    for (const [method, path, payload] of writeChecks) {
      const { status } = await api(path, { method, ...(payload ? { body: JSON.stringify(payload) } : {}) });
      status === 404 ? ok(`${method} ${path} -> 404`) : bad(`${method} ${path} -> ${status} (expected 404)`);
    }

    // 4. The database is the final word: nothing may have been mutated.
    console.log('\nIntruder rows untouched in the database:');
    for (const [col, id] of Object.entries(ids)) {
      const doc = await db.collection(col).findOne({ _id: new mongoose.Types.ObjectId(id) });
      if (!doc) { bad(`${col} row was DELETED by another tenant`); continue; }
      const mutated = doc.name === 'HACKED' || doc.company === 'HACKED' || doc.deleted === true;
      mutated ? bad(`${col} row was MUTATED by another tenant`) : ok(`${col} row intact and still owned by the intruder`);
    }
  } finally {
    for (const [col, id] of Object.entries(ids)) {
      await db.collection(col).deleteOne({ _id: new mongoose.Types.ObjectId(id) });
    }
    console.log('\nCleaned up planted documents.');
    await mongoose.connection.close();
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  if (fail) process.exitCode = 1;
}

main().catch(err => { console.error(`\n✗ ${err.message}\n`); process.exitCode = 1; });
