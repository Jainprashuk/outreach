#!/usr/bin/env node
/**
 * Drops the two migration restore-point databases from the prod cluster to
 * free Atlas storage. Uses the raw driver, not db.js, so no seed/backfill runs.
 *
 *   node scripts/drop-backups.js              # dry run: shows what would be dropped
 *   node scripts/drop-backups.js --execute    # drops them
 *
 * Refuses to run unless each database has a local export in
 * ~/Desktop/outreach-db-backups/<name>/ with the same document count per collection.
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TARGETS = ['outreach_prod_backup_20260918', 'outreach_prod_backup_20260929'];
const EXPORT_DIR = path.join(os.homedir(), 'Desktop', 'outreach-db-backups');
const EXECUTE = process.argv.includes('--execute');

const linesIn = (file) => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;

(async () => {
  const uri = process.env.MONGODB_URI_PROD;
  if (!uri) throw new Error('MONGODB_URI_PROD is not set');
  const client = await MongoClient.connect(uri, { serverSelectionTimeoutMS: 8000 });
  try {
    // Verify every export before dropping anything.
    for (const name of TARGETS) {
      const db = client.db(name);
      const cols = await db.listCollections({}, { nameOnly: true }).toArray();
      for (const { name: col } of cols) {
        const file = path.join(EXPORT_DIR, name, `${col}.jsonl`);
        if (!fs.existsSync(file)) throw new Error(`No export for ${name}.${col} (${file}) — aborting, nothing dropped`);
        const live = await db.collection(col).countDocuments();
        const saved = linesIn(file);
        if (live !== saved) throw new Error(`${name}.${col}: ${live} live vs ${saved} exported — aborting, nothing dropped`);
      }
      console.log(`✓ ${name}: ${cols.length} collections match their export`);
    }

    if (!EXECUTE) { console.log('\nDry run. Re-run with --execute to drop them.'); return; }

    for (const name of TARGETS) {
      await client.db(name).dropDatabase();
      console.log(`🗑  dropped ${name}`);
    }
    const left = (await client.db().admin().listDatabases()).databases.map(d => d.name);
    console.log('Databases now:', left.join(', '));
  } finally {
    await client.close();
  }
})().catch((err) => { console.error('❌ ', err.message); process.exit(1); });
