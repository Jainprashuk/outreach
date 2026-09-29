/**
 * The admin's app-wide lifecycle switches.
 *
 * Read fresh on every decision, never cached: "takes effect right away" has to
 * hold on a warm serverless instance too, including for a Monday report that was
 * queued before the switch was flipped.
 */
const AppConfig = require('../../models/AppConfig');
const { TYPE_KEYS, isType } = require('./types');

const KEY = 'lifecycle';

// What a database that has never had a config row gets: everything OFF. Written
// out as literals rather than taken from schema defaults, because .lean() never
// applies those and a missing row has no defaults to apply anyway.
const OFF = Object.freeze({
  enabled: false,
  firstEnabledAt: null,
  testMode: true,
  testRecipient: '',
  types: Object.freeze(Object.fromEntries(TYPE_KEYS.map(t => [t, false]))),
});

function normalise(row) {
  const l = (row && row.lifecycle) || {};
  const types = {};
  // Everything is opt-IN: a type is on only when an admin explicitly switched
  // it on. A type absent from the stored map — including any type added in a
  // later release — is off, the same rule as the master switch.
  for (const t of TYPE_KEYS) types[t] = !!(l.types && l.types[t] === true);
  return {
    enabled: l.enabled === true,
    firstEnabledAt: l.firstEnabledAt || null,
    // Test mode is only off when explicitly switched off.
    testMode: l.testMode !== false,
    testRecipient: l.testRecipient || '',
    types,
  };
}

async function getLifecycleConfig() {
  const row = await AppConfig.findOne({ key: KEY }).lean();
  return row ? normalise(row) : { ...OFF, types: { ...OFF.types } };
}

async function getLifecycleConfigWithHistory() {
  const row = await AppConfig.findOne({ key: KEY }).lean();
  return {
    config: row ? normalise(row) : { ...OFF, types: { ...OFF.types } },
    changes: ((row && row.changes) || []).slice(-50).reverse(),
  };
}

/**
 * Applies one admin change. `field` is 'enabled', 'testMode' or 'type:<name>'.
 * Returns the new config.
 */
async function setLifecycleSwitch({ field, value, admin }) {
  if (typeof value !== 'boolean') throw new Error('value must be true or false');
  const $set = {};
  if (field === 'enabled') {
    $set['lifecycle.enabled'] = value;
  } else if (field === 'testMode') {
    $set['lifecycle.testMode'] = value;
    // Test mode delivers to whoever turned it on: the admin at the keyboard is
    // the one inbox we know they are watching.
    if (value) $set['lifecycle.testRecipient'] = admin.email;
  } else if (field.startsWith('type:') && isType(field.slice(5))) {
    $set[`lifecycle.types.${field.slice(5)}`] = value;
  } else {
    throw new Error('Unknown switch');
  }

  const change = { field, value, by: admin.id, byEmail: admin.email, at: new Date() };
  await AppConfig.updateOne(
    { key: KEY },
    {
      $set,
      $push: { changes: { $each: [change], $slice: -200 } },
      // A first-ever row starts in test mode, addressed to the admin creating it.
      $setOnInsert: field === 'testMode' ? {} : { 'lifecycle.testMode': true, 'lifecycle.testRecipient': admin.email },
    },
    { upsert: true },
  );
  if (field === 'enabled' && value) {
    // Only the first time: the inactivity clock must not restart on every flip.
    // `null` matches both a stored null and a missing field.
    await AppConfig.updateOne(
      { key: KEY, 'lifecycle.firstEnabledAt': null },
      { $set: { 'lifecycle.firstEnabledAt': new Date() } },
    );
  }
  return getLifecycleConfig();
}

module.exports = { getLifecycleConfig, getLifecycleConfigWithHistory, setLifecycleSwitch, normalise };
