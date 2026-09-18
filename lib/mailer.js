const nodemailer = require('nodemailer');
const Settings = require('../models/Settings');
const User = require('../models/User');
const { decrypt, isConfigured } = require('./credentials');

// Credentials are resolved per user, per send. They used to live in module
// globals, which is fine for one owner and dangerous for several: on Vercel one
// warm process serves many requests, so whoever configured Gmail last would
// have been the sender for everybody until that instance recycled.
//
// The GMAIL_* environment variables remain only as a fallback for the account
// that predates per-user storage, so a half-migrated deployment keeps sending.
// Once that owner's Settings carries a credential, the env vars are ignored.

const buildTransporter = (email, appPassword) =>
  nodemailer.createTransport({
    service: 'gmail',
    auth: { user: email, pass: appPassword },
  });

// Not cached: going from one account to two must switch the env fallback off
// immediately, and a stale "yes" here would leak a credential. It is an indexed
// query capped at two documents, against work that is about to open an SMTP
// connection anyway.
async function isSoleAccount(userId) {
  if (!process.env.GMAIL_EMAIL || !process.env.GMAIL_APP_PASSWORD) return false;
  const users = await User.find().select('_id').limit(2).lean();
  return users.length === 1 && String(users[0]._id) === String(userId);
}

/**
 * The sending identity for one user: { email, name, appPassword }.
 * appPassword is '' when nothing is configured — callers check before sending.
 */
async function getSenderFor(userId) {
  const settings = await Settings.findOne(
    { userId },
    { senderName: 1, gmailEmail: 1, gmailAppPasswordEnc: 1 },
  ).lean();

  let appPassword = '';
  if (settings?.gmailAppPasswordEnc && isConfigured()) {
    try {
      appPassword = decrypt(settings.gmailAppPasswordEnc);
    } catch (err) {
      // A credential that will not decrypt (rotated CREDENTIAL_KEY, corrupted
      // row) must not silently fall back to another account's env password.
      throw new Error(`Stored Gmail credential could not be decrypted: ${err.message}`);
    }
  }

  let email = settings?.gmailEmail || '';

  // The env fallback is only ever for the original single-owner install. Keying
  // it on "does this user's gmailEmail match GMAIL_EMAIL" would have handed the
  // owner's App Password to any second user who typed the same address, so it is
  // gated on there genuinely being only one account.
  if (!appPassword && await isSoleAccount(userId)) {
    email = email || process.env.GMAIL_EMAIL || '';
    appPassword = process.env.GMAIL_APP_PASSWORD || '';
  }

  return {
    email,
    name: settings?.senderName || process.env.SENDER_NAME || '',
    appPassword,
  };
}

/** Sender plus a ready transporter, or null when the user has no credentials. */
async function getTransporterFor(userId) {
  const sender = await getSenderFor(userId);
  if (!sender.email || !sender.appPassword) return null;
  return { ...sender, transporter: buildTransporter(sender.email, sender.appPassword) };
}

const getResumeAttachment = async (attachResume, userId) => {
  if (!attachResume) return undefined;
  const settings = await Settings.getForUser(userId);
  if (!settings.resume) return undefined;
  return [{
    filename: settings.resume.filename,
    content: settings.resume.data,
    contentType: settings.resume.contentType,
  }];
};

module.exports = { buildTransporter, getSenderFor, getTransporterFor, getResumeAttachment };
