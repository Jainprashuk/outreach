#!/usr/bin/env node
/**
 * Parity for the 2026-11 track-stage change (lib/naukriQueue.js readStatus):
 * re-reads every stored naukriTimeline with the OLD rule (furthest stage wins)
 * and the NEW one (a later rejection is final; Contact Viewed = viewed), and
 * lists every job whose stage would differ. Read-only.
 *
 *   node scripts/parity/track-stage.js            # dev
 *   node scripts/parity/track-stage.js --prod     # prod, still read-only
 *   add --detail to print each differing job's timeline with dates
 */
require('dotenv').config();
const mongoose = require('mongoose');
const { readStatus } = require('../../lib/naukriQueue');

const OLD_STATUS = { 1: 'applied', 2: 'applied', 4: 'viewed', 10: 'viewed', 6: 'shortlisted', 9: 'contacted', 7: 'not-shortlisted' };
const RANK = { applied: 0, viewed: 1, 'not-shortlisted': 2, shortlisted: 3, contacted: 4 };
function oldStage(tl) {
  let stage = 'applied';
  for (const s of tl) { const st = OLD_STATUS[s.id]; if (st && RANK[st] >= RANK[stage]) stage = st; }
  return stage;
}

(async () => {
  const prod = process.argv.includes('--prod');
  const uri = prod ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });
  const cur = mongoose.connection.db.collection('naukrijobs').find(
    { 'naukriTimeline.0': { $exists: true }, deleted: { $ne: true } },
    { projection: { title: 1, company: 1, platform: 1, naukriStage: 1, naukriTimeline: 1, applyStatus: 1 } });
  let n = 0; const diffs = {};
  for await (const j of cur) {
    n++;
    const row = { status: j.naukriTimeline.map(t => ({ statusId: t.id, statusValue: t.value, dateTime: t.at })) };
    const a = oldStage(j.naukriTimeline), b = readStatus(row).stage;
    if (a !== b) {
      const k = `${a} → ${b}`;
      const tl = process.argv.includes('--detail')
        ? '\n      ' + j.naukriTimeline.map(t => `${t.value} @ ${t.at ? new Date(t.at).toISOString().slice(0, 16) : 'no date'}`).join('\n      ')
        : '';
      (diffs[k] = diffs[k] || []).push(`${j.platform || 'naukri'} · ${j.title} · ${j.company} [stored ${j.naukriStage}, ${j.applyStatus}]${tl}`);
    }
  }
  console.log(`${prod ? 'PROD' : 'dev'}: ${n} tracked jobs`);
  if (!Object.keys(diffs).length) console.log('no differences');
  for (const [k, list] of Object.entries(diffs)) { console.log(`\n${k}: ${list.length}`); list.slice(0, 15).forEach(x => console.log('  ' + x)); }
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
