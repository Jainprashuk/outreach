const User = require('../models/User');

// Phase 2 of the multi-tenant migration: route handlers already scope every
// query by `req.userId`, but auth is still the single shared password, so that
// id has to come from somewhere. Exactly one account exists until phase 3 swaps
// in real sessions — and rather than quietly picking the first row if that stops
// being true, this refuses, so a second account cannot silently start reading
// the first one's data through the old cookie.
let cached = null;

async function resolveSoleUserId() {
  if (cached) return cached;

  const users = await User.find().select('_id').limit(2).lean();
  if (users.length === 0) {
    throw new Error('No user account exists yet — run scripts/migrate-multi-tenant.js');
  }
  if (users.length > 1) {
    throw new Error('More than one account exists, but the password cookie cannot tell them apart. Session auth (phase 3) has to land before a second account is usable.');
  }

  cached = users[0]._id;
  return cached;
}

const attachUser = async (req, res, next) => {
  try {
    req.userId = await resolveSoleUserId();
    next();
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
};

module.exports = { attachUser, resolveSoleUserId };
