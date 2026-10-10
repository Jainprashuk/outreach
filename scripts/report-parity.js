#!/usr/bin/env node
/**
 * Proves that adding "results by source" left every other report figure exactly as
 * it was. READ-ONLY — safe against any database, prod included.
 *
 *   node scripts/report-parity.js                 # dev, every account
 *   NODE_ENV=prod node scripts/report-parity.js   # prod (reads only)
 *
 * Runs the report code from before the change (git 0006811) and the current code
 * on the same accounts and periods, and compares everything but `bySource` and
 * `generatedAt`. Then checks bySource adds up: its sent/replies/bounced per period
 * must equal the report's own firstSends/replies/bounced totals.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const mongoose = require('mongoose');

const PROD = process.env.NODE_ENV === 'prod';
const URI = PROD ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'lib', '.reportStats.parity.js');

const strip = (s) => { const o = JSON.parse(JSON.stringify(s)); delete o.bySource; delete o.generatedAt; return o; };

async function main() {
  fs.writeFileSync(TMP, execSync('git show 0006811:lib/reportStats.js', { cwd: ROOT }));
  const before = require(TMP).buildReportStats;
  const after = require('../lib/reportStats').buildReportStats;

  await mongoose.connect(URI);
  console.log(`database: ${mongoose.connection.db.databaseName} (read-only)`);
  const users = await mongoose.connection.db.collection('users').find({}, { projection: { _id: 1 } }).toArray();
  const now = new Date();
  const DAY = 24 * 3600 * 1000;
  const periods = [7, 30, 90].map(days => ({ from: new Date(now.getTime() - days * DAY), to: now, kind: 'custom', days }));

  let pass = 0, fail = 0;
  for (const u of users) {
    for (const p of periods) {
      const [a, b] = await Promise.all([before(u._id, p, { now }), after(u._id, p, { now })]);
      const same = JSON.stringify(strip(a)) === JSON.stringify(strip(b));
      const sum = (k) => (b.bySource || []).reduce((n, r) => n + r[k], 0);
      const adds = sum('sent') === b.outreach.firstSends && sum('replies') === b.headline.replies.value && sum('bounced') === b.outreach.bounced;
      if (same && adds) pass++;
      else {
        fail++;
        console.log(`  FAIL user ${String(u._id).slice(-6)} ${p.days}d: ${same ? '' : 'old figures changed '}${adds ? '' : `bySource doesn't add up (${sum('sent')}/${b.outreach.firstSends} sent, ${sum('replies')}/${b.headline.replies.value} replies, ${sum('bounced')}/${b.outreach.bounced} bounced)`}`);
      }
    }
  }
  console.log(`${users.length} accounts × ${periods.length} periods: ${pass} identical, ${fail} different`);
  await mongoose.disconnect();
  return fail;
}

main()
  .then(fail => { fs.rmSync(TMP, { force: true }); process.exit(fail ? 1 : 0); })
  .catch(err => { fs.rmSync(TMP, { force: true }); console.error(err); process.exit(1); });
