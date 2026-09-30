/**
 * Per-user indexes for the list queries every tab runs. Additive only — this
 * never drops or changes an existing index.
 *
 *   node scripts/build-perf-indexes.js                   # dev: list what is missing
 *   node scripts/build-perf-indexes.js --apply           # dev: build them
 *   NODE_ENV=prod node scripts/build-perf-indexes.js --apply
 *
 * Builds one index at a time, so run it in a quiet hour on prod. Only after it
 * has finished there should these be declared in the schemas — otherwise
 * Mongoose's autoIndex would build them during a Vercel cold start instead.
 */
require('dotenv').config();
const mongoose = require('mongoose');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const apply = process.argv.includes('--apply');

// [collection, key] — each backs a find().sort() that today scans past other users' rows.
const INDEXES = [
  ['leads',        { userId: 1, fitScore: -1, createdAt: -1 }],   // GET /api/leads
  ['jobpostings',  { userId: 1, listingStatus: 1, postedAt: -1, firstSeenAt: -1 }], // GET /api/postings
  ['contacts',     { userId: 1, status: 1, createdAt: -1 }],     // contact tabs
  ['campaigns',    { userId: 1, createdAt: -1 }],                // GET /api/campaigns
  ['sendjobs',     { userId: 1, status: 1, createdAt: -1 }],     // /active, /active-all
  ['sendjobs',     { userId: 1, 'items.processedAt': 1 }],       // sent-24h, headroom, timeline
  ['interviews',   { userId: 1, interviewAt: 1 }],               // GET /api/interviews
  ['scraperuns',   { userId: 1, createdAt: -1 }],                // GET /api/scrapes
  ['activitylogs', { userId: 1, createdAt: -1 }],                // GET /api/logs
  ['blocklists',   { userId: 1, createdAt: -1 }],                // GET /api/blocklist
];

const sameKey = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${env.toUpperCase()} is not set`);
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  const db = mongoose.connection.db;
  console.log(`${apply ? 'Building' : 'Checking'} indexes on ${env} / ${db.databaseName}`);

  const existingCollections = new Set((await db.listCollections().toArray()).map(c => c.name));
  for (const [name, key] of INDEXES) {
    if (!existingCollections.has(name)) { console.log(`–  ${name}: collection does not exist, skipped`); continue; }
    const existing = await db.collection(name).indexes();
    if (existing.some(ix => sameKey(ix.key, key))) { console.log(`✓  ${name} ${JSON.stringify(key)} already exists`); continue; }
    if (!apply) { console.log(`+  ${name} ${JSON.stringify(key)} missing`); continue; }
    const t = Date.now();
    const created = await db.collection(name).createIndex(key);
    console.log(`✅  ${name} ${created} built in ${Date.now() - t}ms`);
  }
  await mongoose.disconnect();
})().catch(async (err) => {
  console.error('❌ ', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
