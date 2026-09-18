const crypto = require('crypto');

// Gmail App Passwords are stored encrypted rather than in plain text. With one
// owner a database leak exposed one person's own credential; with several
// accounts the same leak would hand over every user's mailbox, so the blast
// radius is what changed, not the storage.
//
// AES-256-GCM: authenticated, so a tampered ciphertext fails to decrypt instead
// of silently yielding garbage that gets handed to an SMTP login.

const ALGO = 'aes-256-gcm';
const PREFIX = 'v1';

let cachedKey = null;

function key() {
  if (cachedKey) return cachedKey;

  const raw = process.env.CREDENTIAL_KEY;
  if (!raw) {
    throw new Error('CREDENTIAL_KEY is not set — generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'base64\'))"');
  }

  const buf = Buffer.from(raw, 'base64');
  if (buf.length !== 32) {
    throw new Error(`CREDENTIAL_KEY must decode to 32 bytes, got ${buf.length}`);
  }

  cachedKey = buf;
  return cachedKey;
}

/** True when a key is configured, so callers can degrade instead of throwing. */
const isConfigured = () => {
  try { key(); return true; } catch (_) { return false; }
};

function encrypt(plaintext) {
  if (!plaintext) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, key(), iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join('.');
}

function decrypt(stored) {
  if (!stored) return '';
  const [prefix, ivB64, tagB64, ctB64] = String(stored).split('.');
  if (prefix !== PREFIX || !ivB64 || !tagB64 || !ctB64) {
    throw new Error('Stored credential is not in the expected format');
  }
  const decipher = crypto.createDecipheriv(ALGO, key(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString('utf8');
}

module.exports = { encrypt, decrypt, isConfigured };
