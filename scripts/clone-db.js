#!/usr/bin/env node
/**
 * Clones a database into a new database on the SAME Atlas cluster, as a
 * restore point before the multi-tenant migration.
 *
 * Deliberately uses the raw driver, not db.js — connecting through db.js would
 * run seed() and the three backfill passes against whichever DB it touches.
 *
 *   node scripts/clone-db.js                      # dry run against prod: sizes + counts, writes nothing
 *   node scripts/clone-db.js --execute            # actually clone
 *   node scripts/clone-db.js --env=dev            # use MONGODB_URI_DEV
 *   node scripts/clone-db.js --target=my_backup   # override the generated target name
 */
require('dotenv').config();
const { MongoClient } = require('mongodb');

const args = process.argv.slice(2);
const flag = (name) => args.some(a => a === `--${name}`);
const value = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const EXECUTE = flag('execute');
const FORCE = flag('force');
const ENV = value('env') === 'dev' ? 'dev' : 'prod';
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

const BATCH = 1000;
const MB = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// The database the URI points at — the path segment before any query string.
const dbNameFromUri = (uri) => {
  const afterHost = uri.split('://')[1]?.split('/').slice(1).join('/') || '';
  const name = afterHost.split('?')[0];
  return name || null;
};

const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

async function main() {
  if (!URI) throw new Error(`MONGODB_URI_${ENV.toUpperCase()} is not set`);

  const source = dbNameFromUri(URI);
  if (!source) throw new Error('Could not read a database name from the connection string');
  const target = value('target') || `${source}_backup_${stamp()}`;
  if (target === source) throw new Error('Target database must differ from the source');

  const client = new MongoClient(URI, { serverSelectionTimeoutMS: 10000 });
  await client.connect();

  try {
    const srcDb = client.db(source);
    const tgtDb = client.db(target);

    const collections = (await srcDb.listCollections({ type: 'collection' }).toArray())
      .map(c => c.name)
      .filter(n => !n.startsWith('system.'))
      .sort();

    const stats = await srcDb.command({ dbStats: 1 });

    console.log(`\nSource: ${source}  →  Target: ${target}   (cluster from MONGODB_URI_${ENV.toUpperCase()})`);
    console.log(`Data size ${MB(stats.dataSize)} · storage ${MB(stats.storageSize)} · ${collections.length} collections\n`);

    const counts = {};
    for (const name of collections) {
      counts[name] = await srcDb.collection(name).countDocuments();
      console.log(`  ${name.padEnd(28)} ${String(counts[name]).padStart(7)} docs`);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    console.log(`  ${'TOTAL'.padEnd(28)} ${String(total).padStart(7)} docs\n`);

    if (!EXECUTE) {
      console.log('Dry run — nothing written. Re-run with --execute to clone.');
      console.log(`Note: an M0 (free) cluster caps total storage at 512 MB across all databases;`);
      console.log(`      this clone adds roughly another ${MB(stats.dataSize)}.\n`);
      return;
    }

    const existing = await tgtDb.listCollections({}, { nameOnly: true }).toArray();
    if (existing.length && !FORCE) {
      throw new Error(`Target "${target}" already has ${existing.length} collections. Pick another --target, or pass --force to add to it.`);
    }

    for (const name of collections) {
      const src = srcDb.collection(name);
      const tgt = tgtDb.collection(name);

      let copied = 0;
      let batch = [];
      const cursor = src.find({});
      for await (const doc of cursor) {
        batch.push(doc);
        if (batch.length === BATCH) {
          await tgt.insertMany(batch, { ordered: false });
          copied += batch.length;
          batch = [];
        }
      }
      if (batch.length) {
        await tgt.insertMany(batch, { ordered: false });
        copied += batch.length;
      }

      // Indexes matter: a restore that silently drops a unique index would let
      // duplicates in on the next run.
      const indexes = (await src.indexes()).filter(i => i.name !== '_id_');
      if (indexes.length) {
        await tgt.createIndexes(indexes.map(({ v, ns, ...spec }) => spec));
      }

      console.log(`  copied ${name.padEnd(28)} ${String(copied).padStart(7)} docs, ${indexes.length} indexes`);
    }

    console.log('\nVerifying…');
    let mismatched = 0;
    for (const name of collections) {
      const after = await tgtDb.collection(name).countDocuments();
      const ok = after === counts[name];
      if (!ok) mismatched++;
      console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(28)} source ${counts[name]} / target ${after}`);
    }

    if (mismatched) throw new Error(`${mismatched} collection(s) do not match — the clone is NOT a valid restore point.`);
    console.log(`\nClone verified: ${target} matches ${source} document-for-document.\n`);
  } finally {
    await client.close();
  }
}

main().catch(err => {
  console.error(`\n✗ ${err.message}\n`);
  process.exit(1);
});
