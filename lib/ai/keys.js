/**
 * Whose AI key a call runs on.
 *
 * Every user brings their own free keys (Gemini, Groq, Cerebras), saved
 * encrypted on their Settings. The owner's env keys are used for a user only
 * when:
 *   - the rollout switch is off (AppConfig aiKeys.enforce !== true) — the old
 *     behaviour, and the instant rollback;
 *   - the grace period is still running (aiKeys.graceUntil in the future); or
 *   - an admin turned on User.aiOwnerFallback for that account.
 * A user's own key always wins over the owner's, and a failing own key never
 * falls through to the owner's unless one of the above already allows it.
 *
 * Cached for a short while per instance: a mailbox sweep classifies dozens of
 * replies for one user in a row, and three reads per reply would be wasted.
 */
const mongoose = require('mongoose');
const AppConfig = require('../../models/AppConfig');
const Settings = require('../../models/Settings');
const User = require('../../models/User');
const credentials = require('../credentials');
const { notify } = require('../notify');

const PROVIDERS = ['gemini', 'groq', 'cerebras'];
const ENV = { gemini: 'GEMINI_API_KEY', groq: 'GROQ_API_KEY', cerebras: 'CEREBRAS_API_KEY' };
const LABEL = { gemini: 'Gemini', groq: 'Groq', cerebras: 'Cerebras' };
const CONFIG_KEY = 'aiKeys';
const TTL_MS = 30_000;

// ── the rollout switch ──────────────────────────────────────────────────────

let configCache = null; // { at, value }

function normaliseConfig(row) {
  const a = (row && row.aiKeys) || {};
  return {
    enforce: a.enforce === true,
    graceUntil: a.graceUntil ? new Date(a.graceUntil) : null,
    enforcedAt: a.enforcedAt ? new Date(a.enforcedAt) : null,
  };
}

async function getAiKeysConfig({ fresh = false } = {}) {
  if (!fresh && configCache && Date.now() - configCache.at < TTL_MS) return configCache.value;
  const row = await AppConfig.findOne({ key: CONFIG_KEY }).lean();
  const value = normaliseConfig(row);
  configCache = { at: Date.now(), value };
  return value;
}

/** Admin change: `enforce` (boolean) and/or `graceUntil` (Date|null). Returns the new config. */
async function setAiKeysConfig({ enforce, graceUntil, admin }) {
  const current = await getAiKeysConfig({ fresh: true });
  const $set = {};
  const changes = [];
  if (typeof enforce === 'boolean') {
    $set['aiKeys.enforce'] = enforce;
    if (enforce && !current.enforcedAt) $set['aiKeys.enforcedAt'] = new Date();
    changes.push({ field: 'aiKeys.enforce', value: enforce });
  }
  if (graceUntil !== undefined) {
    $set['aiKeys.graceUntil'] = graceUntil;
    changes.push({ field: 'aiKeys.graceUntil', value: graceUntil });
  }
  if (!changes.length) return current;
  const at = new Date();
  await AppConfig.updateOne(
    { key: CONFIG_KEY },
    {
      $set,
      $push: { changes: { $each: changes.map(c => ({ ...c, by: admin.id, byEmail: admin.email, at })), $slice: -200 } },
    },
    { upsert: true },
  );
  configCache = null;
  userCache.clear();
  return getAiKeysConfig({ fresh: true });
}

const inGrace = (cfg, now = Date.now()) => !!(cfg.graceUntil && cfg.graceUntil.getTime() > now);

// ── one user's keys ─────────────────────────────────────────────────────────

const userCache = new Map(); // userId -> { at, value: { own, fallback } }

async function loadUser(userId) {
  const id = String(userId);
  const hit = userCache.get(id);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const [settings, user] = await Promise.all([
    Settings.findOne({ userId: id }, { aiKeys: 1 }).lean(),
    User.findById(id, { aiOwnerFallback: 1 }).lean(),
  ]);
  const own = {};
  for (const p of PROVIDERS) {
    const enc = settings && settings.aiKeys && settings.aiKeys[`${p}Enc`];
    if (!enc) continue;
    // A key that no longer decrypts (CREDENTIAL_KEY rotated) counts as not saved.
    try { own[p] = credentials.decrypt(enc) || null; } catch (_) { own[p] = null; }
  }
  const value = { own, fallback: !!user && user.aiOwnerFallback === true };
  if (userCache.size > 1000) userCache.clear();
  userCache.set(id, { at: Date.now(), value });
  return value;
}

/** Forget what this instance cached for a user — after they save or remove a key, or an admin flips their fallback. */
function forget(userId) { userCache.delete(String(userId)); }

/**
 * Pure: which key each provider runs on.
 * @returns {{[provider]: {key: string, source: 'user'|'owner'} | null}}
 */
function decide({ cfg, own = {}, fallback = false, env = process.env, now = Date.now() }) {
  const out = {};
  const ownerAllowed = !cfg.enforce || fallback === true || inGrace(cfg, now);
  for (const p of PROVIDERS) {
    // Before the rollout is enforced nothing changes: everyone stays on the owner keys,
    // even a user who already saved their own.
    if (cfg.enforce && own[p]) out[p] = { key: own[p], source: 'user' };
    else if (ownerAllowed && env[ENV[p]]) out[p] = { key: env[ENV[p]], source: 'owner' };
    else out[p] = null;
  }
  return out;
}

async function resolveKeys(userId) {
  const cfg = await getAiKeysConfig();
  if (!userId || !mongoose.isValidObjectId(userId)) return decide({ cfg });
  const { own, fallback } = await loadUser(userId);
  return decide({ cfg, own, fallback });
}

/**
 * What the Settings card and the banner need, for one user.
 */
async function aiAccess(userId) {
  const cfg = await getAiKeysConfig();
  const [settings, user] = await Promise.all([
    Settings.findOne({ userId }, { aiKeys: 1, aiKeyStatus: 1 }).lean(),
    User.findById(userId, { aiOwnerFallback: 1 }).lean(),
  ]);
  const has = {};
  for (const p of PROVIDERS) has[p] = !!(settings && settings.aiKeys && settings.aiKeys[`${p}Enc`]);
  const keyCount = PROVIDERS.filter(p => has[p]).length;
  // Groq is the key users must add: Gemini (on the model in use) is too slow to carry an
  // account alone, and Cerebras needs a card. A Gemini-only account counts as not ready.
  const ready = has.groq;
  const ownerFallback = !!user && user.aiOwnerFallback === true;
  const grace = cfg.enforce && inGrace(cfg);
  return {
    enforce: cfg.enforce,
    graceUntil: cfg.enforce ? cfg.graceUntil : null,
    inGrace: grace,
    ownerFallback,
    has,
    keyCount,
    ready,
    status: (settings && settings.aiKeyStatus) || {},
    // Is any AI available to this account right now?
    aiOn: !cfg.enforce || ready || ownerFallback || grace,
  };
}

// ── what a real call said about a user's own key ────────────────────────────

const STATE_FOR = { ok: 'ok', auth: 'invalid', 'rate-limited': 'quota' };
const lastNoted = new Map(); // `${userId}:${provider}` -> `${state}:${day}`
const today = () => new Date().toISOString().slice(0, 10);

/**
 * Records the outcome of a call made with a user's OWN key, so Settings can show
 * Working / Rejected / Daily limit reached, and raises the bell notices. Never
 * throws. Writes only when the state changes (or a new day starts), so a sweep
 * of fifty replies is one write, not fifty.
 */
async function noteResult(userId, provider, kind, error) {
  try {
    const state = STATE_FOR[kind];
    if (!state || !userId || !PROVIDERS.includes(provider)) return;
    const memo = `${userId}:${provider}`;
    const stamp = `${state}:${today()}`;
    if (lastNoted.get(memo) === stamp) return;
    lastNoted.set(memo, stamp);
    if (lastNoted.size > 5000) lastNoted.clear();

    await Settings.updateOne(
      { userId },
      { $set: { [`aiKeyStatus.${provider}`]: { state, checkedAt: new Date(), error: state === 'ok' ? null : String(error || '').slice(0, 300) } } },
    );

    if (state === 'invalid') {
      await notify(userId, {
        type: 'ai.key_failed',
        title: `Your ${LABEL[provider]} key was rejected`,
        body: `${LABEL[provider]} refused your API key. Check it in Settings → AI keys. Your other keys are still being used.`,
        link: '/settings',
        dedupeKey: `ai.key_failed:${provider}:${today()}`,
      });
    } else if (state === 'quota') {
      // Only when EVERY saved key is out for today — one running out is handled by the next.
      const s = await Settings.findOne({ userId }, { aiKeys: 1, aiKeyStatus: 1 }).lean();
      const saved = PROVIDERS.filter(p => s && s.aiKeys && s.aiKeys[`${p}Enc`]);
      const day = today();
      const allOut = saved.length > 0 && saved.every(p => {
        const st = s.aiKeyStatus && s.aiKeyStatus[p];
        return st && st.state === 'quota' && st.checkedAt && new Date(st.checkedAt).toISOString().slice(0, 10) === day;
      });
      if (allOut) {
        await notify(userId, {
          type: 'ai.key_quota',
          title: "Today's free AI limit is used up",
          body: 'Every AI key you added has reached its free daily limit. AI picks up again tomorrow.',
          link: '/settings',
          dedupeKey: `ai.key_quota:${day}`,
        });
      }
    }
  } catch (err) {
    console.error('[ai/keys] noteResult failed:', err.message);
  }
}

module.exports = {
  PROVIDERS, ENV, LABEL,
  getAiKeysConfig, setAiKeysConfig, inGrace,
  resolveKeys, decide, forget, aiAccess, noteResult,
};
