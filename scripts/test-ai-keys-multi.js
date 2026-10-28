#!/usr/bin/env node
/**
 * Several AI keys for one provider (lib/ai/keys.js, lib/classify/providers chainFor).
 *   - an account with one key per provider behaves exactly as before;
 *   - failover: key 1, then key 2, before the next provider;
 *   - balance: the first key tried rotates evenly, and every key is still in the chain;
 *   - every key has its own cooldown breaker and its own status (key 1 keeps the provider name);
 *   - the card's data (aiAccess) lists keys by last 4 only, never the value.
 * Pure checks always run; the database part uses MONGODB_URI_DEV and a scratch account:
 *   node scripts/test-ai-keys-multi.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

let pass = 0, fail = 0;
const check = (cond, m) => { if (cond) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };
const keys = require('../lib/ai/keys');
const DAY = 86_400_000;
const ENFORCED = { enforce: true, graceUntil: null };

console.log('\nPure');
let d = keys.decide({ cfg: ENFORCED, own: { groq: 'q1' }, more: { groq: [{ id: 'b2', key: 'q2' }] }, env: {} });
check(d.groq.key === 'q1' && d.groq.all.length === 2 && d.groq.all[1].id === 'b2', 'decide lists key 1 then the extras');
d = keys.decide({ cfg: ENFORCED, own: { groq: 'q1' }, env: {} });
check(d.groq.key === 'q1' && d.groq.all.length === 1 && d.gemini === null, 'one key: as before');
d = keys.decide({ cfg: { enforce: false }, own: { groq: 'q1' }, more: { groq: [{ id: 'b2', key: 'q2' }] }, env: { GROQ_API_KEY: 'owner' } });
check(d.groq.source === 'owner' && !d.groq.all, 'rollout off: owner key, extras unused');

const list = [{ id: 'main' }, { id: 'b2' }, { id: 'c3' }];
check(keys.orderKeys(list, 'failover', 'x:groq').map(k => k.id).join() === 'main,b2,c3', 'failover keeps the saved order, every call');
const firsts = {};
for (let i = 0; i < 300; i++) {
  const o = keys.orderKeys(list, 'balance', 'u:groq');
  firsts[o[0].id] = (firsts[o[0].id] || 0) + 1;
  if (o.length !== 3 || new Set(o.map(k => k.id)).size !== 3) { check(false, 'balance never drops a key'); break; }
}
check(Object.values(firsts).length === 3 && Object.values(firsts).every(n => n === 100), `balance starts on each key equally (${JSON.stringify(firsts)})`);
check(keys.orderKeys([{ id: 'main' }], 'balance', 'u:one').length === 1, 'a single key is left alone');
check(keys.statusName('groq', 'main') === 'groq' && keys.statusName('groq', 'b2') === 'groq_b2', 'key 1 keeps the provider name for its status');

async function withDb() {
  const uri = process.env.MONGODB_URI_DEV;
  if (!uri) { console.log('\n(no MONGODB_URI_DEV — skipping the database part)'); return; }
  const credentials = require('../lib/credentials');
  if (!credentials.isConfigured()) { console.log('\n(no CREDENTIAL_KEY — skipping the database part)'); return; }
  await mongoose.connect(uri);
  const AppConfig = require('../models/AppConfig');
  const User = require('../models/User');
  const Settings = require('../models/Settings');
  const { chainFor, breakerKeyOf } = require('../lib/classify/providers');
  const saved = await AppConfig.findOne({ key: 'aiKeys' }).lean();
  const user = await User.create({ email: `ai-keys-multi-${Date.now()}@example.invalid`, status: 'active', createdAt: new Date(Date.now() - 30 * DAY) });
  const uid = user._id;
  const fresh = async () => { keys.forget(uid); await keys.getAiKeysConfig({ fresh: true }); };
  try {
    console.log('\nThrough the database');
    await AppConfig.updateOne({ key: 'aiKeys' }, { $set: { aiKeys: ENFORCED } }, { upsert: true });
    await Settings.getForUser(uid);
    await Settings.updateOne({ userId: uid }, { $set: {
      'aiKeys.groqEnc': credentials.encrypt('groq-key-AAAA'), 'aiKeys.geminiEnc': credentials.encrypt('gem-key-ZZZZ'),
    } });
    await fresh();
    let chain = await chainFor(uid);
    check(chain.map(p => p.name).join() === 'groq,gemini', 'one key each: chain unchanged (groq, gemini)');
    check(breakerKeyOf(chain[0]) === `groq:${uid}`, 'key 1 keeps its original breaker key');

    await Settings.updateOne({ userId: uid }, { $push: { 'aiKeys.more.groq': { $each: [{ id: 'b2b2b2b2', enc: credentials.encrypt('groq-key-BBBB') }, { id: 'c3c3c3c3', enc: credentials.encrypt('groq-key-CCCC') }] } } });
    await fresh();
    chain = await chainFor(uid);
    check(chain.map(p => p.name).join() === 'groq,groq,groq,gemini', 'failover: all Groq keys come before Gemini');
    check(new Set(chain.map(breakerKeyOf)).size === 4, 'every key has its own breaker key');
    check(chain[1].breakerKey === `groq:${uid}:b2b2b2b2`, 'an extra key is breaker-keyed by its id');

    await Settings.updateOne({ userId: uid }, { $set: { aiKeyMode: 'balance' } });
    await fresh();
    const starts = {};
    for (let i = 0; i < 30; i++) {
      const c = await chainFor(uid);
      const names = c.map(p => p.name).join();
      if (names !== 'groq,groq,groq,gemini' || new Set(c.map(breakerKeyOf)).size !== 4) { check(false, 'balance keeps all keys, Groq before Gemini'); break; }
      starts[breakerKeyOf(c[0])] = (starts[breakerKeyOf(c[0])] || 0) + 1;
    }
    check(Object.keys(starts).length === 3 && Object.values(starts).every(n => n === 10), `balance: 30 calls start 10 on each Groq key (${Object.values(starts).join('/')})`);

    // What a real call said about the 2nd key lands on that key only.
    await keys.noteResult(uid, 'groq', 'rate-limited', '429', 'b2b2b2b2');
    const acc = await keys.aiAccess(uid);
    check(acc.keys.groq.length === 3 && acc.keys.groq[1].status && acc.keys.groq[1].status.state === 'quota', 'key 2 shows "daily limit" from its own result');
    check(!acc.keys.groq[0].status || acc.keys.groq[0].status.state !== 'quota', 'key 1 is not marked');
    check(acc.keys.groq.map(k => k.last4).join() === 'AAAA,BBBB,CCCC' && acc.mode === 'balance', 'the card gets last 4 and the mode — never a key');
    check(!JSON.stringify(acc).includes('groq-key-'), 'no key value anywhere in the access payload');

    // Calls are recorded with WHICH key ran them (never the key), and per-key usage reads them back.
    const { ALL } = require('../lib/classify/providers');
    const AiCall = require('../models/AiCall');
    const { aiUsage } = require('../lib/aiUsage');
    const seen = [];
    const realComplete = ALL.groq.complete;
    ALL.groq.complete = async (input, opts) => { seen.push({ keyNo: opts.logAs.keyNo, keyTail: opts.logAs.keyTail, apiKey: opts.apiKey }); return { kind: 'ok', text: '{}' }; };
    try {
      await Settings.updateOne({ userId: uid }, { $set: { aiKeyMode: 'failover' } });
      await fresh();
      const c = await chainFor(uid);
      for (const p of c.filter(x => x.name === 'groq')) await p.complete({ system: 's', prompt: 'p' }, { logAs: { feature: 'applynote' } });
      check(seen.map(x => `${x.keyNo}:${x.keyTail}`).join() === '1:AAAA,2:BBBB,3:CCCC', 'each call is tagged with its key number and last 4');
      check(seen[1].apiKey === 'groq-key-BBBB', 'and still runs on the right key');
    } finally { ALL.groq.complete = realComplete; }

    const row = (keyNo, keyTail, outcome) => ({ userId: uid, feature: 'applynote', provider: 'groq', method: 'complete', outcome, keySource: 'user', keyNo, keyTail, source: 'live', expireAt: new Date(Date.now() + DAY) });
    await AiCall.insertMany([row(1, 'AAAA', 'ok'), row(1, 'AAAA', 'rate-limited'), row(2, 'BBBB', 'ok'), row(2, 'BBBB', 'ok'), row(null, null, 'ok')]);
    const usage = await aiUsage(uid, { days: 1 });
    const k1 = usage.keys.find(k => k.keyNo === 1), k2 = usage.keys.find(k => k.keyNo === 2);
    check(usage.keys.length === 2 && k1.calls === 3 && k1.rateLimited === 1 && k2.calls === 2, 'usage: per-key counts (an old row with no key counts as key 1)');
    check(k1.keyTail === 'AAAA' && usage.features.some(f => f.key === 'applynote' && f.label === 'Application messages'), 'usage: key tail kept, "Application messages" labelled');
    const byNo = await AiCall.countDocuments({ userId: uid, keyNo: 2 });
    check(byNo === 2, 'the keyNo filter finds exactly key 2');
    await AiCall.deleteMany({ userId: uid });
  } finally {
    await Settings.deleteMany({ userId: uid });
    await User.deleteOne({ _id: uid });
    if (saved) await AppConfig.replaceOne({ key: 'aiKeys' }, saved); else await AppConfig.deleteOne({ key: 'aiKeys' });
    await mongoose.disconnect();
  }
}

withDb().then(() => { console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch(e => { console.error(e); process.exit(1); });
