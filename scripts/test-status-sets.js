// Keeps the analytics status lists in step with the models. Run with:  node scripts/test-status-sets.js
//
// Part 1 and 2 need no database. They fail when models/Contact.js gains a status that
// lib/statusSets.js (server) or client/src/lib/analytics.ts (browser) doesn't know —
// the drift that once made Analytics silently drop every `in-campaign` contact.
// Part 3 checks that the Mongo spelling of sourceOf agrees with the JS one, on the
// dev database (read-only: it evaluates expressions over literal $documents).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const S = require('../lib/statusSets');

let pass = 0, fail = 0;
const ok = (label, cond, detail = '') => {
  if (cond) { pass++; console.log('  ok   ' + label); }
  else { fail++; console.log('  FAIL ' + label + (detail ? '  << ' + detail : '')); }
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// ─────────────────────────────────────────────── part 1: server lists vs the model

console.log('\npart 1 — lib/statusSets.js against models/Contact.js');
const modelStatuses = Contact.schema.path('status').enumValues;
const missing = modelStatuses.filter(s => !S.STATUS_KEYS.includes(s));
ok('every Contact.status is in STATUS_KEYS', !missing.length, missing.join(', '));
ok('STATUS_KEYS holds no unknown status', S.STATUS_KEYS.every(s => modelStatuses.includes(s)));
const noActivity = modelStatuses.filter(s => !S.CONTACT_ACTIVITY_TYPES.includes(s));
ok('every Contact.status can appear in Recent activity', !noActivity.length, noActivity.join(', '));
ok('EMAILED and REPLIED are Contact statuses', [...S.EMAILED, ...S.REPLIED].every(s => modelStatuses.includes(s)));
const modelSources = Contact.schema.path('source').enumValues;
ok('every Contact.source is a report source', modelSources.every(s => S.SOURCE_ORDER.includes(s)));
ok('every report source has a label', S.SOURCE_ORDER.every(k => S.SOURCE_LABELS[k]));

// ─────────────────────────────────────────────── part 2: the browser copy

console.log('\npart 2 — client/src/lib/analytics.ts against lib/statusSets.js');
const ts = fs.readFileSync(path.join(__dirname, '../client/src/lib/analytics.ts'), 'utf8');
const block = (start, end) => ts.slice(ts.indexOf(start), ts.indexOf(end, ts.indexOf(start)));
const keysOf = (src) => [...src.matchAll(/^\s+'?([a-z-]+)'?:\s*\{\s*label/gm)].map(m => m[1]);
const metaKeys = keysOf(block('export const STATUS_META', '};'));
ok('STATUS_META has every status, in STATUS_KEYS order', same(metaKeys, S.STATUS_KEYS), metaKeys.join(','));
const emailedTs = [...block('export const EMAILED', ']);').matchAll(/'([a-z-]+)'/g)].map(m => m[1]);
ok('EMAILED matches', same(emailedTs, S.EMAILED), emailedTs.join(','));
const actTypes = [...block('export const ACTIVITY_META', '...INTERVIEW_STATUS_ORDER').matchAll(/type: '([a-z-]+)'/g)].map(m => m[1]);
ok('ACTIVITY_META has every contact activity type, in order', same(actTypes, S.CONTACT_ACTIVITY_TYPES), actTypes.join(','));

// ─────────────────────────────────────────────── part 3: sourceOf, JS vs Mongo

const cases = [
  {}, { source: 'outreach' }, { source: 'lead' }, { source: '' }, { source: null },
  { prospectId: 'p1' }, { prospectId: 'p1', source: 'lead' }, { prospectId: '' },
  { fromLibrary: true }, { fromLibrary: true, source: 'lead' }, { fromLibrary: false, source: 'lead' },
  { naukriJobId: 'n1' }, { naukriJobId: 'n1', prospectId: 'p1', fromLibrary: true }, { naukriJobId: null, prospectId: 'p1' },
];

(async () => {
  const uri = process.env.MONGODB_URI_DEV;
  if (!uri) {
    console.log('\npart 3 — skipped (MONGODB_URI_DEV is not set)');
  } else {
    console.log('\npart 3 — sourceOf and sourceExpr agree');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 30000 });
    const rows = await mongoose.connection.db.aggregate([
      { $documents: cases.map((c, i) => ({ ...c, i })) },
      { $project: { i: 1, src: S.sourceExpr } },
    ]).toArray();
    for (const r of rows) {
      const want = S.sourceOf(cases[r.i]);
      ok(`${JSON.stringify(cases[r.i])} → ${want}`, r.src === want, `mongo said ${r.src}`);
    }
    await mongoose.disconnect();
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (err) => {
  console.error(err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
