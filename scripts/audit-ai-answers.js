// READ-ONLY: how many AI calls each screening answer / application note took
// over the last 30 days, which failures cost calls, and how often the same
// question was asked again. Writes nothing.
//
//   node scripts/audit-ai-answers.js [dev|prod]   (default prod)
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const mongoose = require('mongoose');
(async () => {
  await mongoose.connect(process.env[process.argv[2] === 'dev' ? 'MONGODB_URI_DEV' : 'MONGODB_URI_PROD']);
  const c = mongoose.connection.db.collection('aicalls');
  const since = new Date(Date.now() - 30 * 864e5);
  const m = { feature: { $in: ['naukri', 'applynote'] }, createdAt: { $gte: since } };

  console.log('== calls by feature / outcome ==');
  console.log(await c.aggregate([{ $match: m }, { $group: { _id: { f: '$feature', o: '$outcome' }, n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray());

  console.log('== calls per runId (one answer) ==');
  console.log(await c.aggregate([{ $match: m }, { $group: { _id: { f: '$feature', r: '$runId' }, n: { $sum: 1 } } },
    { $group: { _id: { f: '$_id.f', calls: '$n' }, answers: { $sum: 1 } } }, { $sort: { '_id.f': 1, '_id.calls': 1 } }]).toArray());

  console.log('== errors by provider/status (wasted calls) ==');
  console.log(await c.aggregate([{ $match: { ...m, outcome: { $ne: 'ok' } } }, { $group: { _id: { p: '$provider', s: '$status', o: '$outcome', e: { $substrCP: [{ $ifNull: ['$error', ''] }, 0, 60] } }, n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 15 }]).toArray());

  console.log('== same question asked again (naukri) ==');
  const rows = await c.find({ feature: 'naukri', createdAt: { $gte: since } }, { projection: { prompt: 1, userId: 1, runId: 1, createdAt: 1, outcome: 1 } }).toArray();
  const byQ = new Map();
  for (const r of rows) {
    const q = ((r.prompt || '').match(/\nQuestion: (.*)/) || [])[1];
    if (!q) continue;
    const k = `${r.userId}|${q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}`;
    const e = byQ.get(k) || { q, runs: new Set(), calls: 0 };
    e.runs.add(r.runId); e.calls++; byQ.set(k, e);
  }
  const all = [...byQ.values()];
  const runsTotal = all.reduce((s, e) => s + e.runs.size, 0);
  console.log({ distinctQuestions: all.length, answerRuns: runsTotal, calls: rows.length, repeatRuns: runsTotal - all.length });
  console.log(all.sort((a, b) => b.runs.size - a.runs.size).slice(0, 12).map(e => ({ runs: e.runs.size, calls: e.calls, q: e.q.slice(0, 70) })));

  console.log('== tokens ==');
  console.log(await c.aggregate([{ $match: m }, { $group: { _id: '$feature', in: { $sum: '$tokens.input' }, out: { $sum: '$tokens.output' }, think: { $sum: '$tokens.thinking' }, n: { $sum: 1 } } }]).toArray());
  await mongoose.disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
