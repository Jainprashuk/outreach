// Send-time guard: never email an address, or any address on a domain, that's
// been explicitly blocklisted (e.g. "don't email anyone at this company again").

const Blocklist = require('../models/Blocklist');

const BLOCKLIST_ERROR = 'Skipped — recipient is on the blocklist.';

function domainOf(email) {
  return (email || '').split('@')[1]?.toLowerCase() || '';
}

/** Loads the current blocklist as two Sets, for cheap repeated lookups within one job run. */
async function loadBlocklistSets() {
  const entries = await Blocklist.find().lean();
  const emails = new Set(entries.filter(e => e.type === 'email').map(e => e.value));
  const domains = new Set(entries.filter(e => e.type === 'domain').map(e => e.value));
  return { emails, domains };
}

/** True if `email` matches a blocklisted address or its domain matches a blocklisted domain. */
function isBlocked(email, { emails, domains }) {
  const addr = (email || '').toLowerCase();
  if (!addr) return false;
  if (emails.has(addr)) return true;
  return domains.has(domainOf(addr));
}

module.exports = { BLOCKLIST_ERROR, domainOf, loadBlocklistSets, isBlocked };
