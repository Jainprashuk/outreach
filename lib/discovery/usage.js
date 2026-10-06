// Each user's discovery keys and free monthly allowances (models/DiscoveryConfig.js).

const DiscoveryConfig = require('../../models/DiscoveryConfig');
const credentials = require('../credentials');

const { PROVIDERS, MONTHLY_CAPS } = DiscoveryConfig;

/** YYYY-MM in India time, so the allowance rolls over at local midnight. */
function monthKey(d = new Date()) {
  return new Date(d.getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
}

/** The decrypted keys, '' for any not set (or that no longer decrypts). */
async function loadKeys(userId) {
  const doc = await DiscoveryConfig.findOne({ userId }).lean();
  const keys = {};
  for (const p of PROVIDERS) {
    try { keys[p] = doc && doc[`${p}Enc`] ? credentials.decrypt(doc[`${p}Enc`]) : ''; }
    catch (_) { keys[p] = ''; }
  }
  return keys;
}

/** Usage this month, with last month's counts already rolled over to zero. */
async function getUsage(userId) {
  const doc = await DiscoveryConfig.findOne({ userId }, { usage: 1 }).lean();
  const month = monthKey();
  const u = doc && doc.usage && doc.usage.month === month ? doc.usage : { month, tavily: 0, serpapi: 0, hunter: 0 };
  return { month, tavily: u.tavily || 0, serpapi: u.serpapi || 0, hunter: u.hunter || 0 };
}

/**
 * Spend `n` of a provider's free monthly allowance. Atomic: two searches racing for
 * the last credit can't both get it. Returns false when the allowance is used up.
 */
async function take(userId, provider, n = 1) {
  const cap = MONTHLY_CAPS[provider];
  if (cap === Infinity || cap === undefined) return true;
  const month = monthKey();
  await DiscoveryConfig.updateOne(
    { userId, 'usage.month': { $ne: month } },
    { $set: { usage: { month, tavily: 0, serpapi: 0, hunter: 0 } } },
  );
  const r = await DiscoveryConfig.updateOne(
    { userId, 'usage.month': month, [`usage.${provider}`]: { $lte: cap - n } },
    { $inc: { [`usage.${provider}`]: n } },
  );
  return r.modifiedCount === 1;
}

module.exports = { monthKey, loadKeys, getUsage, take, PROVIDERS, MONTHLY_CAPS };
