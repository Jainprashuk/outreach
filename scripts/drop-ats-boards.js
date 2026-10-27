#!/usr/bin/env node
/**
 * One-off cleanup after the ATS board feature was removed (Jobs tab is now the
 * Naukri/Instahyre/Hirist pipeline). Raw driver, never db.js, so no seed/backfill runs.
 *
 *   node scripts/drop-ats-boards.js                  # DEV dry run
 *   node scripts/drop-ats-boards.js --prod           # PROD dry run
 *   node scripts/drop-ats-boards.js --prod --execute # export, verify, then drop
 *
 * Run it ONLY AFTER the code without /api/postings is deployed: the old cron
 * would otherwise recreate the collections. With --execute it first exports
 * jobboards and jobpostings to ~/Desktop/outreach-db-backups/ats-boards/ and
 * refuses to drop unless every export has the same document count.
 * Then: drops both collections, deletes the cronbeats row for /api/postings/sync,
 * and $unsets the dead Settings fields (jobCriteria, lastPostingSyncAt, postingSyncLockAt).
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROD = process.argv.includes('--prod');
const EXECUTE = process.argv.includes('--execute');
const uri = PROD ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const COLLECTIONS = ['jobboards', 'jobpostings'];
const OUT = path.join(os.homedir(), 'Desktop', 'outreach-db-backups', 'ats-boards');

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${PROD ? 'PROD' : 'DEV'} is not set`);
  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    const db = client.db();
    console.log(`Target: ${PROD ? 'PROD' : 'DEV'} (${db.databaseName})${EXECUTE ? '' : ' — dry run'}`);
    const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name));
    const present = COLLECTIONS.filter(c => existing.has(c));
    for (const c of COLLECTIONS) console.log(`  ${c}: ${existing.has(c) ? await db.collection(c).countDocuments() + ' documents' : 'not there'}`);
    const beat = await db.collection('cronbeats').countDocuments({ name: '/api/postings/sync' });
    const dirty = await db.collection('settings').countDocuments({ $or: [{ jobCriteria: { $exists: true } }, { lastPostingSyncAt: { $exists: true } }, { postingSyncLockAt: { $exists: true } }] });
    console.log(`  cronbeats rows for /api/postings/sync: ${beat}\n  settings docs with dead fields: ${dirty}`);
    if (!EXECUTE) { console.log('\nDry run. Nothing changed.'); return; }

    fs.mkdirSync(OUT, { recursive: true });
    for (const c of present) {
      const file = path.join(OUT, `${PROD ? 'prod' : 'dev'}-${c}.jsonl`);
      const docs = await db.collection(c).find({}).toArray();
      fs.writeFileSync(file, docs.map(d => JSON.stringify(d)).join('\n') + (docs.length ? '\n' : ''));
      const saved = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
      const live = await db.collection(c).countDocuments();
      if (saved !== live) throw new Error(`${c}: ${live} live vs ${saved} exported — aborting, nothing dropped`);
      console.log(`✓ exported ${c}: ${saved} → ${file}`);
    }
    for (const c of present) { await db.collection(c).drop(); console.log(`🗑  dropped ${c}`); }
    await db.collection('cronbeats').deleteMany({ name: '/api/postings/sync' });
    await db.collection('settings').updateMany({}, { $unset: { jobCriteria: '', lastPostingSyncAt: '', postingSyncLockAt: '' } });
    console.log('✓ cronbeats row removed, Settings fields unset');
  } finally { await client.close(); }
})().catch(e => { console.error('❌ ', e.message); process.exit(1); });
