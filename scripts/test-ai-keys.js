#!/usr/bin/env node
/**
 * Bring-your-own AI keys test (lib/ai/keys.js, lib/classify/providers chainFor).
 *
 * Asserts the promises the rollout makes:
 *   - rollout off: everyone runs on the owner's keys, even with their own saved;
 *   - rollout on: an account's own key always wins;
 *   - the owner's key is used only in the grace period or with the admin fallback;
 *   - after the grace period, no key + no fallback = no AI at all (empty chain);
 *   - the owner's Gemini is still skipped where it always was, the user's is not;
 *   - each own key gets its own breaker, so one bad key can't block everybody;
 *   - Gemini's "API key not valid" 400 reads as a bad key, not a network blip;
 *   - the two emails find the right accounts, and render.
 *
 * Pure checks always run. The database part uses MONGODB_URI_DEV only, makes a
 * scratch account, and puts back the AppConfig row it found:
 *   node scripts/test-ai-keys.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

let pass = 0, fail = 0;
const check = (cond, m) => { if (cond) { pass++; console.log(`  ok   ${m}`); } else { fail++; console.log(`  FAIL ${m}`); } };

const keys = require('../lib/ai/keys');
const { kindForStatus, KIND } = require('../lib/classify/providers/kinds');
const templates = require('../lib/lifecycle/templates');

const ENV = { GEMINI_API_KEY: 'owner-g', GROQ_API_KEY: 'owner-q', CEREBRAS_API_KEY: 'owner-c' };
const DAY = 86_400_000;

function pure() {
  console.log('\nKey choice (decide)');
  const off = { enforce: false, graceUntil: null };
  const grace = { enforce: true, graceUntil: new Date(Date.now() + 3 * DAY) };
  const over = { enforce: true, graceUntil: new Date(Date.now() - DAY) };
  const own = { groq: 'mine-q' };

  let d = keys.decide({ cfg: off, own, env: ENV });
  check(d.groq.source === 'owner' && d.gemini.source === 'owner', 'rollout off: owner keys, even with an own key saved');

  d = keys.decide({ cfg: grace, own, env: ENV });
  check(d.groq.source === 'user' && d.groq.key === 'mine-q', 'grace: own key wins');
  check(d.gemini.source === 'owner', 'grace: missing providers fall back to the owner');

  d = keys.decide({ cfg: over, own, env: ENV });
  check(d.groq.source === 'user' && d.gemini === null && d.cerebras === null, 'after grace: own key only, nothing from the owner');

  d = keys.decide({ cfg: over, own: {}, env: ENV });
  check(Object.values(d).every(v => v === null), 'after grace, no key, no fallback: no AI');

  d = keys.decide({ cfg: over, own: {}, fallback: true, env: ENV });
  check(Object.values(d).every(v => v && v.source === 'owner'), 'after grace with admin fallback: owner keys');

  d = keys.decide({ cfg: over, own, fallback: true, env: ENV });
  check(d.groq.source === 'user' && d.gemini.source === 'owner', 'fallback never replaces an own key');

  d = keys.decide({ cfg: { enforce: true, graceUntil: null }, own: {}, env: ENV });
  check(Object.values(d).every(v => v === null), 'enforced with no grace date: no owner keys');

  console.log('\nError kinds');
  check(kindForStatus(400, '[400 Bad Request] API key not valid. Please pass a valid API key.') === KIND.AUTH, 'Gemini bad-key 400 = auth');
  check(kindForStatus(400, 'reason: API_KEY_INVALID') === KIND.AUTH, 'API_KEY_INVALID = auth');
  check(kindForStatus(401, 'Invalid API Key') === KIND.AUTH, 'Groq 401 = auth');
  check(kindForStatus(429, '') === KIND.RATE_LIMITED, '429 still rate-limited');
  check(kindForStatus(400, 'something else') === KIND.TRANSIENT, 'other 400 still transient');

  console.log('\nTemplates');
  const prevUrl = process.env.OUTREACH_URL;
  process.env.OUTREACH_URL = process.env.OUTREACH_URL || 'https://example.com';
  const e0 = () => templates.aiKeyEnded({ name: '' });
  const a = templates.aiKeyAnnounce({ name: 'Asha Rao', graceUntil: new Date(Date.now() + 7 * DAY) });
  check(/add your free Groq key by/.test(a.subject), 'announce subject asks for Groq');
  check(['aistudio.google.com/apikey', 'console.groq.com/keys'].every(u => a.text.includes(u) && a.html.includes(u)), 'announce links Groq, and Gemini as the backup');
  check(a.text.indexOf('console.groq.com') < a.text.indexOf('aistudio.google.com'), 'Groq comes first');
  check(!/cerebras/i.test(a.text) && !/cerebras/i.test(e0().text), 'emails do not ask for Cerebras (it needs a card now)');
  check(/Hi Asha,/.test(a.text) && /settings/.test(a.html), 'announce greets and links to Settings');
  const e = templates.aiKeyEnded({ name: '' });
  check(e.subject === 'AI features are now off on your account', 'ended subject');
  check(/not affected/.test(e.text) && /Turn AI back on/.test(e.html), 'ended says sending is unaffected, has the button');
  if (prevUrl === undefined) delete process.env.OUTREACH_URL;
}

async function withDb() {
  const uri = process.env.MONGODB_URI_DEV;
  if (!uri) { console.log('\n(no MONGODB_URI_DEV — skipping the database part)'); return; }
  if (!require('../lib/credentials').isConfigured()) { console.log('\n(no CREDENTIAL_KEY — skipping the database part)'); return; }
  await mongoose.connect(uri);
  const AppConfig = require('../models/AppConfig');
  const User = require('../models/User');
  const Settings = require('../models/Settings');
  const credentials = require('../lib/credentials');
  const { chainFor, breakerKeyOf } = require('../lib/classify/providers');
  const cand = require('../lib/lifecycle/candidates');

  const saved = await AppConfig.findOne({ key: 'aiKeys' }).lean();
  const email = `ai-keys-test-${Date.now()}@example.invalid`;
  const user = await User.create({ email, status: 'active', createdAt: new Date(Date.now() - 30 * DAY) });
  const uid = user._id;
  const setCfg = async (aiKeys) => {
    await AppConfig.updateOne({ key: 'aiKeys' }, { $set: { aiKeys } }, { upsert: true });
    // Bypass the 30s caches between steps.
    await keys.getAiKeysConfig({ fresh: true });
    keys.forget(uid);
  };

  try {
    console.log('\nThrough the database (chainFor)');
    await Settings.getForUser(uid);

    await setCfg({ enforce: false });
    let chain = await chainFor(uid);
    check(chain.length > 0 && chain.every(p => p.keySource === 'owner'), 'rollout off: owner chain');

    await setCfg({ enforce: true, graceUntil: new Date(Date.now() - DAY) });
    chain = await chainFor(uid);
    check(chain.length === 0, 'after grace, no key: empty chain');

    const announce0 = await cand.aiKeyAnnounceCandidates(new Date(), await keys.getAiKeysConfig({ fresh: true }));
    check(!announce0.some(c => String(c.userId) === String(uid)), 'no announcement after the grace period');
    const ended = await cand.aiKeyEndedCandidates(new Date(), await keys.getAiKeysConfig({ fresh: true }));
    check(ended.some(c => String(c.userId) === String(uid)), '"AI is now off" email due for a keyless account');

    // A Gemini key alone is not "ready": it still gets the emails and the banner.
    await Settings.updateOne({ userId: uid }, { $set: { 'aiKeys.geminiEnc': credentials.encrypt('user-gemini-only') } });
    keys.forget(uid);
    const geminiOnly = await keys.aiAccess(uid);
    check(!geminiOnly.ready && !geminiOnly.aiOn, 'Gemini-only account: not ready, AI counted as off');
    const endedG = await cand.aiKeyEndedCandidates(new Date(), await keys.getAiKeysConfig({ fresh: true }));
    check(endedG.some(c => String(c.userId) === String(uid)), 'Gemini-only account still gets the "AI is off" email');
    await Settings.updateOne({ userId: uid }, { $set: { 'aiKeys.geminiEnc': '' } });

    await Settings.updateOne({ userId: uid }, { $set: { 'aiKeys.groqEnc': credentials.encrypt('user-groq-key') } });
    keys.forget(uid);
    chain = await chainFor(uid);
    check(chain.length === 1 && chain[0].name === 'groq' && chain[0].keySource === 'user', 'own Groq key: chain is just that key');
    check(breakerKeyOf(chain[0]) === `groq:${uid}`, 'own key has its own breaker');
    const ended2 = await cand.aiKeyEndedCandidates(new Date(), await keys.getAiKeysConfig({ fresh: true }));
    check(!ended2.some(c => String(c.userId) === String(uid)), 'no "AI is off" email once a key is saved');

    await Settings.updateOne({ userId: uid }, { $set: { 'aiKeys.geminiEnc': credentials.encrypt('user-gemini-key') } });
    keys.forget(uid);
    chain = await chainFor(uid, { skipOwnerGemini: true });
    check(chain.some(p => p.name === 'gemini' && p.keySource === 'user'), "own Gemini key is used where the owner's is skipped");

    await Settings.updateOne({ userId: uid }, { $set: { 'aiKeys.groqEnc': '', 'aiKeys.geminiEnc': '' } });
    await User.updateOne({ _id: uid }, { $set: { aiOwnerFallback: true } });
    keys.forget(uid);
    chain = await chainFor(uid, { skipOwnerGemini: true });
    check(chain.length > 0 && chain.every(p => p.keySource === 'owner'), 'admin fallback: owner chain');
    check(!chain.some(p => p.name === 'gemini'), "owner's Gemini still skipped for those features");
    check(breakerKeyOf(chain[0]) === chain[0].name, 'owner key keeps the shared breaker');

    await User.updateOne({ _id: uid }, { $set: { aiOwnerFallback: false } });
    await setCfg({ enforce: true, graceUntil: new Date(Date.now() + 3 * DAY) });
    chain = await chainFor(uid);
    check(chain.length > 0 && chain.every(p => p.keySource === 'owner'), 'grace: keyless account still on the owner chain');
    const announce = await cand.aiKeyAnnounceCandidates(new Date(), await keys.getAiKeysConfig({ fresh: true }));
    check(announce.some(c => String(c.userId) === String(uid)), 'announcement due during grace');

    const access = await keys.aiAccess(uid);
    check(access.inGrace && access.aiOn && access.keyCount === 0, 'aiAccess: in grace, AI on, no keys');
  } finally {
    await Settings.deleteMany({ userId: uid });
    await User.deleteOne({ _id: uid });
    if (saved) await AppConfig.replaceOne({ key: 'aiKeys' }, saved);
    else await AppConfig.deleteOne({ key: 'aiKeys' });
    await mongoose.disconnect();
  }
}

(async () => {
  pure();
  await withDb();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(err => { console.error(err); process.exit(1); });
