#!/usr/bin/env node
/**
 * One-time migration: renames the reply classifier's activity-log category from
 * 'gemini' to 'classifier'.
 *
 * The classifier is no longer Gemini-only — a deterministic rule pass and two fallback
 * providers can each produce a verdict — so a row labelled 'gemini' for an answer that
 * came from a rule is simply wrong. The Logs page filters on the literal value, so
 * without this the renamed filter shows an empty list over all existing history.
 *
 * ActivityLog.category is a free-form indexed String with no enum, so this is a pure
 * data rename with no schema change. It is still a write against live data, so it is a
 * dry run unless --execute is passed, and it verifies counts on both sides.
 *
 *   node scripts/migrate-log-category.js
 *   node scripts/migrate-log-category.js --execute
 *   node scripts/migrate-log-category.js --env=dev --execute
 */
require('dotenv').config();
const mongoose = require('mongoose');
const ActivityLog = require('../models/ActivityLog');

const args = process.argv.slice(2);
const flag = (name) => args.some(a => a === `--${name}`);
const value = (name) => {
  const hit = args.find(a => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
};

const EXECUTE = flag('execute');
const ENV = value('env') === 'dev' ? 'dev' : 'prod';
const URI = ENV === 'prod' ? process.env.MONGODB_URI_PROD : process.env.MONGODB_URI_DEV;

const OLD = 'gemini';
const NEW = 'classifier';

(async () => {
  if (!URI) {
    console.error(`No MONGODB_URI_${ENV.toUpperCase()} in the environment.`);
    process.exit(1);
  }

  await mongoose.connect(URI);
  console.log(`connected to ${ENV}${EXECUTE ? '' : '  (DRY RUN — pass --execute to write)'}\n`);

  const before = {
    old: await ActivityLog.countDocuments({ category: OLD }),
    new: await ActivityLog.countDocuments({ category: NEW }),
  };
  console.log(`  '${OLD}' rows:       ${before.old}`);
  console.log(`  '${NEW}' rows:   ${before.new}`);

  if (!before.old) {
    console.log('\nnothing to rename.');
  } else if (!EXECUTE) {
    console.log(`\nwould rename ${before.old} rows '${OLD}' -> '${NEW}'.`);
  } else {
    const res = await ActivityLog.updateMany({ category: OLD }, { $set: { category: NEW } });
    const after = {
      old: await ActivityLog.countDocuments({ category: OLD }),
      new: await ActivityLog.countDocuments({ category: NEW }),
    };
    console.log(`\n  modified:        ${res.modifiedCount}`);
    console.log(`  '${OLD}' left:     ${after.old}`);
    console.log(`  '${NEW}' now:  ${after.new}`);

    // Both sides, because a modifiedCount alone can't tell a successful rename from a
    // partial one that left half the history unreachable from the Logs filter.
    const consistent = after.old === 0 && after.new === before.new + before.old;
    console.log(consistent ? '\nverified: every row moved.' : '\nMISMATCH — counts do not add up. Investigate before trusting the Logs page.');
    if (!consistent) { await mongoose.disconnect(); process.exit(1); }
  }

  await mongoose.disconnect();
})().catch(async (e) => {
  console.error('\nMIGRATION ERROR:', e);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
