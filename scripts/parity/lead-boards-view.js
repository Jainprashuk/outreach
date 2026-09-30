/**
 * Parity check for GET /api/leads?view=boards. READ-ONLY — it never writes.
 *
 * The Jobs page loads leads only to suggest boards from their links
 * (lib/postings.ts suggestedBoardsFromLeads, unchanged). This runs that code on
 * the full leads and on the slim view — with a Proxy recording every field it
 * reads — and requires identical suggestions, against every board set from
 * "none tracked" to "all tracked but one".
 *
 *   node scripts/parity/lead-boards-view.js
 *   NODE_ENV=prod node scripts/parity/lead-boards-view.js
 */
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const os = require('os');
const assert = require('assert');
const mongoose = require('mongoose');
const Lead = require('../../models/Lead');
const JobBoard = require('../../models/JobBoard');
const { serialize } = require('../../routes/leads');

const env = process.env.NODE_ENV === 'prod' ? 'prod' : 'dev';
const uri = env === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
const LEAD_BOARD_FIELDS = { links: 1, applyUrl: 1, postUrl: 1 }; // must match routes/leads.js

function loadLib() {
  const esbuild = require(path.join(__dirname, '../../client/node_modules/esbuild'));
  const out = path.join(os.tmpdir(), `postings-ref-${process.pid}.cjs`);
  esbuild.buildSync({ entryPoints: [path.join(__dirname, 'reference/postingsEntry.ts')], bundle: true, platform: 'node', format: 'cjs', outfile: out, logLevel: 'error' });
  const lib = require(out); fs.unlinkSync(out); return lib;
}
const asBrowser = docs => JSON.parse(JSON.stringify(docs.map(serialize)));

(async () => {
  if (!uri) throw new Error(`MONGODB_URI_${env.toUpperCase()} is not set`);
  const L = loadLib();
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
  console.log(`Parity (read-only) against ${env} / ${mongoose.connection.db.databaseName}`);

  const userIds = await Lead.distinct('userId', { deleted: { $ne: true } });
  for (const userId of userIds) {
    const filter = { userId, deleted: { $ne: true } };
    const [fullDocs, slimDocs, boardDocs] = await Promise.all([
      Lead.find(filter).sort({ fitScore: -1, createdAt: -1 }).lean(),
      Lead.find(filter, LEAD_BOARD_FIELDS).sort({ fitScore: -1, createdAt: -1 }).lean(),
      JobBoard.find({ userId }).lean(),
    ]);
    const full = asBrowser(fullDocs), slim = asBrowser(slimDocs);
    const boards = JSON.parse(JSON.stringify(boardDocs));

    const read = new Set();
    const spied = full.map(l => new Proxy(l, { get(t, k) { if (typeof k === 'string') read.add(k); return t[k]; } }));
    const baseline = L.suggestedBoardsFromLeads(spied, []);
    const outside = [...read].filter(k => !(k in LEAD_BOARD_FIELDS));
    assert.deepStrictEqual(outside, [], `suggestion code reads fields outside the view: ${outside}`);

    // Every board set: nothing tracked, what is tracked today, and every suggestion tracked but one.
    const sets = [[], boards, ...baseline.map((_, i) => baseline.filter((__, j) => j !== i).map(b => ({ source: b.source, token: b.token })))];
    for (const bs of sets.slice(0, 60)) {
      assert.deepStrictEqual(L.suggestedBoardsFromLeads(slim, bs), L.suggestedBoardsFromLeads(full, bs), 'suggestions differ');
    }
    const kb = x => (JSON.stringify(x).length / 1024).toFixed(0);
    console.log(`✅  user ${userId}: ${full.length} leads, ${baseline.length} suggestions identical; reads ${[...read].sort().join(', ')} (${kb(full)} KB → ${kb(slim)} KB)`);
  }
  await mongoose.disconnect();
  console.log('Lead boards view check passed.');
})().catch(async (err) => {
  console.error('❌ ', err.message);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
