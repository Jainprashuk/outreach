const crypto = require('crypto');
const { promisify } = require('util');

const scrypt = promisify(crypto.scrypt);

const KEYLEN = 64;
const SALT_BYTES = 16;

// scrypt rather than bcrypt/argon2: it's in Node's stdlib, so there's no native
// module to build on Vercel and no dependency to keep patched.
async function hashPassword(password) {
  const salt = crypto.randomBytes(SALT_BYTES).toString('hex');
  const key = await scrypt(password, salt, KEYLEN);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const [scheme, salt, hex] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !hex) return false;

  const expected = Buffer.from(hex, 'hex');
  const key = await scrypt(password, salt, KEYLEN);
  if (expected.length !== key.length) return false;

  return crypto.timingSafeEqual(key, expected);
}

module.exports = { hashPassword, verifyPassword };
