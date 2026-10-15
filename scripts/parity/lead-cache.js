/**
 * Parity check for the browser lead cache (client/src/lib/leadCache.ts and the
 * /api/leads/sync, /api/leads/outcomes/sync routes). READ-ONLY — it never writes.
 *
 * Serves the real routes/leads.js from a local Express app on the chosen
 * database and runs the real leadCache.ts (bundled) against it, with an
 * in-memory IndexedDB. For every account it requires the cached result to equal
 * GET /api/leads and GET /api/leads/outcomes exactly — from an empty cache, from
 * a stale one (changed, missing and extra entries), and from another account's
 * — and checks that only the stale documents are fetched again.
 *
 *   NODE_ENV=prod node scripts/parity/lead-cache.js
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const express = require('express');
const mongoose = require('mongoose');
const Lead = require('../../models/Lead');
const leadsRouter = require('../../routes/leads');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

// Just enough IndexedDB for leadCache.ts: one store, get/put/clear.
const idbData = new Map();
const ok = (fn) => { const r = {}; setTimeout(() => { try { r.result = fn(); r.onsuccess && r.onsuccess(); } catch (e) { r.onerror && r.onerror(e); } }); return r; };
global.indexedDB = {
  open() {
    const db = { transaction() {
      const tx = { objectStore: () => ({
        get: (k) => ok(() => structuredClone(idbData.get(k))),
        put: (v, k) => { idbData.set(k, structuredClone(v)); setTimeout(() => tx.oncomplete && tx.oncomplete()); },
        clear: () => { idbData.clear(); setTimeout(() => tx.oncomplete && tx.oncomplete()); },
      }) };
      return tx;
    } };
    return ok(() => db);
  },
};

function loadClient() {
  const esbuild = require(path.join(__dirname, '../../client/node_modules/esbuild'));
  const out = path.join(os.tmpdir(), `lead-cache-${process.pid}.cjs`);
  esbuild.buildSync({ entryPoints: [path.join(__dirname, '../../client/src/lib/leadCache.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
  const mod = require(out);
  fs.unlinkSync(out);
  return mod;
}

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${env.toUpperCase()} is not set`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
  console.log(`Parity (read-only) against ${env} / ${mongoose.connection.db.databaseName}`);

  let currentUser = null;
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => { req.userId = currentUser; next(); });
  app.use('/api/leads', leadsRouter);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;

  // apiFetch uses relative paths; count what the cache asks the server for.
  const realFetch = global.fetch;
  let posted = 0;
  global.fetch = (u, o = {}) => {
    if (o.method === 'POST') posted += JSON.parse(o.body).ids.length;
    return realFetch(base + u, o);
  };
  const client = loadClient();
  const getJson = async (p) => (await realFetch(base + p)).json();
  const wait = () => new Promise(r => setTimeout(r, 50)); // the cache saves in the background

  let checks = 0;
  for (const userId of await Lead.distinct('userId', { deleted: { $ne: true } })) {
    currentUser = userId;
    const t0 = Date.now();
    const [oldLeads, oldOutcomes] = [await getJson('/api/leads'), await getJson('/api/leads/outcomes')];
    const same = (label, a, b) => { checks++; assert.deepStrictEqual(a, b, `user ${userId}: ${label} differs`); };

    idbData.clear(); posted = 0;
    same('leads (empty cache)', await client.loadLeadsSynced(), oldLeads);
    same('outcomes (empty cache)', await client.loadLeadOutcomesSynced(), oldOutcomes);
    const firstFetch = posted;
    await wait();

    // Warm cache: nothing to fetch.
    posted = 0;
    same('leads (warm cache)', await client.loadLeadsSynced(), oldLeads);
    same('outcomes (warm cache)', await client.loadLeadOutcomesSynced(), oldOutcomes);
    same('fetched with a warm cache', posted, 0);
    await wait();

    // Stale cache: wrong hashes, missing entries, an entry that no longer exists.
    let stale = 0;
    for (const key of ['/api/leads', '/api/leads/outcomes']) {
      const snap = idbData.get(key);
      const ids = Object.keys(snap.entries);
      ids.forEach((id, i) => {
        if (i % 7 === 0) { snap.entries[id] = { ...snap.entries[id], h: 'stale', v: { wrong: true } }; stale++; }
        else if (i % 11 === 0) { delete snap.entries[id]; stale++; }
      });
      snap.entries['000000000000000000000000'] = { h: 'x', v: { ghost: true } };
      idbData.set(key, snap);
    }
    posted = 0;
    same('leads (stale cache)', await client.loadLeadsSynced(), oldLeads);
    same('outcomes (stale cache)', await client.loadLeadOutcomesSynced(), oldOutcomes);
    same('fetched with a stale cache', posted, stale);
    await wait();

    // Another account's copy is never used.
    for (const key of ['/api/leads', '/api/leads/outcomes']) idbData.set(key, { ...idbData.get(key), user: 'someone-else' });
    posted = 0;
    same('leads (other account cached)', await client.loadLeadsSynced(), oldLeads);
    same('fetched over another account\'s copy', posted, oldLeads.length);
    await wait();

    console.log(`✅  user ${userId}: ${oldLeads.length} leads, ${oldOutcomes.count} outcomes identical (first load fetched ${firstFetch}, stale re-fetched ${stale}) — ${Math.round((Date.now() - t0) / 1000)} s`);
  }
  server.close();
  await mongoose.disconnect();
  console.log(`All ${checks} lead-cache checks passed.`);
})().catch(async (err) => {
  console.error('❌ ', err.message.slice(0, 3000));
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
