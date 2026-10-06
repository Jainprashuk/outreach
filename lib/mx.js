// Can this domain receive email at all? One DNS lookup, so a typo'd or parked domain
// is caught before anyone is guessed an address on it.
//
// Answers true / false / null. null means "couldn't find out" (a DNS timeout), which
// callers must treat as unknown, never as "no".

const dns = require('dns').promises;

const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, reject) => setTimeout(() => reject(Object.assign(new Error('DNS timeout'), { code: 'ETIMEOUT' })), ms)),
]);

const NO_SUCH = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

async function checkMx(domain, { timeoutMs = 4000 } = {}) {
  try {
    const records = await withTimeout(dns.resolveMx(domain), timeoutMs);
    if (records && records.some(r => r.exchange && r.exchange !== '.')) return true;
    return false; // a "null MX" (RFC 7505) says outright: this domain takes no mail
  } catch (err) {
    if (!NO_SUCH.has(err.code)) return null;
  }
  // No MX record. Mail servers still fall back to the domain's own address record
  // (RFC 5321), so only a domain with neither is a definite no.
  try {
    const a = await withTimeout(dns.resolve4(domain), timeoutMs);
    return a && a.length ? null : false;
  } catch (err) {
    return NO_SUCH.has(err.code) ? false : null;
  }
}

module.exports = { checkMx };
