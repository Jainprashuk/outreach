/**
 * Which lifecycle emails fall due between now and `until` — READ-ONLY.
 *
 * Shared by scripts/lifecycle-preview.js and the admin panel's email schedule,
 * so the two cannot disagree. It runs the SAME candidate queries
 * (./candidates.js) and the SAME gate (./gate.js) the Inngest sweeps use, at
 * the instants the sweeps will actually fire.
 *
 * Every item is answered twice:
 *   now — with the switches exactly as saved
 *   on  — as if the master switch were on (with `hypothetical` as the caller
 *         builds it; see masterOnConfig)
 *
 * Later sweeps assume nothing changes in between (nobody visits, nobody
 * finishes setup), so read the later days as upper bounds.
 */
const User = require('../../models/User');
const cands = require('./candidates');
const { decide } = require('./gate');
const { nextIstTime } = require('../reportPeriod');

// Skips that do not use up a slot: a pause or a test-mode skip. Anything else
// (a real send, or a recorded type-off/opt-out skip) does, so a later sweep in
// the window must not count it again.
const NON_CONSUMING = ['master-off', 'test-mode', 'test-mode-no-recipient', 'sender-not-configured', 'links-not-configured'];

/** The saved config with the master switch on; the inactivity clock would start now. */
function masterOnConfig(config, now, { types = [], testOff = false } = {}) {
  return {
    ...config,
    enabled: true,
    firstEnabledAt: config.firstEnabledAt || now,
    testMode: testOff ? false : config.testMode,
    types: { ...config.types, ...Object.fromEntries(types.map(t => [t, true])) },
  };
}

/** Every sweep that fires in (now, until], oldest first. */
function sweepsBetween(now, until) {
  const runs = [];
  for (let t = nextIstTime(now, 10); t <= until; t = nextIstTime(t, 10)) {
    const at = t;
    runs.push({ at, kind: 'daily', label: 'Daily sweep (setup reminders + inactivity)', find: async (cfg) => [...await cands.setupReminderCandidates(at), ...await cands.inactiveCandidates(at, cfg)] });
  }
  for (let t = nextIstTime(now, 9, 0); t <= until; t = nextIstTime(t, 9, 0)) {
    const at = t;
    runs.push({ at, kind: 'weekly', label: 'Weekly report sweep', find: async () => cands.weeklyReportCandidates(at) });
  }
  return runs.sort((a, b) => a.at - b.at);
}

/**
 * @returns {Promise<{ runs: Array<{ at: Date, kind: string, label: string,
 *   items: Array<{ c: object, dNow: object, dOn: object }> }>, midSetup: object[] }>}
 */
async function forecast({ now = new Date(), until, config, hypothetical }) {
  const planned = new Set();
  const runs = [];
  for (const run of sweepsBetween(now, until)) {
    const [listNow, listIfOn] = await Promise.all([run.find(config), run.find(hypothetical)]);
    const byKey = new Map([...listIfOn, ...listNow]
      .filter(c => !planned.has(`${c.userId}|${c.type}|${c.key}`))
      .map(c => [`${c.userId}|${c.type}|${c.key}`, c]));
    const items = [];
    for (const c of byKey.values()) {
      const inNow = listNow.some(x => String(x.userId) === String(c.userId) && x.type === c.type && x.key === c.key);
      const dNow = inNow ? decide(c.type, c.user, config) : { send: false, reason: 'not-due' };
      const dOn = decide(c.type, c.user, hypothetical);
      if (dOn.send || !NON_CONSUMING.includes(dOn.reason)) planned.add(`${c.userId}|${c.type}|${c.key}`);
      items.push({ c, dNow, dOn });
    }
    runs.push({ at: run.at, kind: run.kind, label: run.label, items });
  }

  // Welcome is event-driven: whoever finishes setup in the window gets one.
  const midSetup = await User.find({ status: 'active', 'onboarding.completedAt': null }, { email: 1, name: 1 }).lean();
  return { runs, midSetup };
}

module.exports = { forecast, masterOnConfig, sweepsBetween };
