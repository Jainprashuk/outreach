/**
 * Sign-in, sign-out and "who am I".
 *
 * Mounted ahead of the main /api stack because none of these can require a
 * req.userId — they are how one is obtained. The paths are listed individually
 * in PUBLIC_AUTH_PATHS in server.js, deliberately as an exact set rather than a
 * prefix, so that adding a route to this file cannot make it public by accident.
 */
const express = require('express');
const User = require('../models/User');
const { requestCode, requestAccess, verifyCode, CODE_TTL_MS, RESEND_COOLDOWN_MS } = require('../lib/loginCode');
const { createSession, resolveSession, destroySession, setCookieHeader, clearCookieHeader } = require('../lib/session');
const { logEvent } = require('../lib/activityLog');
const { isOnboarded } = require('../lib/onboarding');

const router = express.Router();

const publicUser = (user) => ({
  id: String(user._id),
  email: user.email,
  name: user.name || '',
  isAdmin: user.isAdmin === true,
  onboarded: isOnboarded(user),
});

/**
 * Ask for a code.
 *
 * This tells the caller whether the address is registered. Sign-in is
 * whitelist-only, so the alternative is somebody who was never added sitting at
 * a code screen waiting for mail that will never arrive — a dead end with no way
 * out. They are told, and pointed at the access request instead.
 *
 * `canRequestAccess` is what the login page keys its form off, rather than
 * matching on message text.
 */
router.post('/request-code', async (req, res) => {
  try {
    const { outcome } = await requestCode(req, req.body && req.body.email);

    switch (outcome) {
      case 'sent':
      case 'throttled':
        // Throttling stays quiet. The cooldown on the page already explains the
        // wait, and a 429 here would only ever be noise to a real person.
        return res.json({ ok: true, cooldownMs: RESEND_COOLDOWN_MS, ttlMs: CODE_TTL_MS });

      case 'unknown':
        return res.status(404).json({
          error: 'That email address is not registered.',
          canRequestAccess: true,
        });

      case 'requested':
        return res.status(403).json({
          error: 'Your access request is waiting to be reviewed. You will get an email if it is approved.',
          requestPending: true,
        });

      case 'rejected':
        // Said plainly so they stop trying. The reason is deliberately not
        // included — that is the admin's note to themselves.
        return res.status(403).json({ error: 'Your access request was not approved.' });

      case 'disabled':
        return res.status(403).json({ error: 'This account has been disabled. Contact the administrator.' });

      case 'invalid':
      default:
        return res.status(400).json({ error: 'Enter a valid email address.' });
    }
  } catch (err) {
    // A genuine server fault, not a refused sign-in.
    console.error(`[auth] request-code failed: ${err.message}`);
    logEvent({ userId: null, category: 'auth', action: 'failed', message: `Sign-in code request failed: ${err.message}` }).catch(() => {});
    res.status(500).json({ error: 'Could not send a sign-in code. Try again in a moment.' });
  }
});

/**
 * Ask to be let in.
 *
 * Public, because the people using it have no account by definition. Capped per
 * IP in lib/loginCode.js — an open form on a public URL is a spam target.
 */
router.post('/request-access', async (req, res) => {
  try {
    const body = req.body || {};
    const { outcome } = await requestAccess(req, body.email, body.name, body.note);

    switch (outcome) {
      case 'created':
      case 'updated':
      case 'pending':
        return res.json({
          ok: true,
          message: 'Your request has been sent. You will get an email if it is approved.',
        });
      case 'exists':
        return res.status(409).json({ error: 'That address already has an account — go ahead and sign in.' });
      case 'rejected':
        return res.status(403).json({ error: 'Your access request was not approved.' });
      case 'throttled':
        return res.status(429).json({ error: 'Too many requests from this network today. Try again tomorrow.' });
      case 'invalid':
      default:
        return res.status(400).json({ error: 'Enter a valid email address.' });
    }
  } catch (err) {
    console.error(`[auth] request-access failed: ${err.message}`);
    res.status(500).json({ error: 'Could not send that request. Try again in a moment.' });
  }
});

/**
 * Submit a code.
 *
 * One status and one message for every failure — wrong, expired, already used,
 * superseded by a newer code, locked out after too many attempts, an address
 * with no account at all. Callers cannot tell those apart, which is the same
 * property the old password endpoint had and for the same reason.
 */
router.post('/verify-code', async (req, res) => {
  try {
    const result = await verifyCode(req.body && req.body.email, req.body && req.body.code);
    if (!result.ok) return res.status(401).json({ error: 'That code is not valid' });

    const { user } = result;
    const token = await createSession(user._id);
    res.setHeader('Set-Cookie', setCookieHeader(token));

    // First successful sign-in is what activates an invited account.
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date(), status: 'active' } });

    res.json({ ok: true, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/logout', async (req, res) => {
  try {
    await destroySession(req);
  } catch (_) { /* clearing the cookie matters more than tidying the row */ }
  res.setHeader('Set-Cookie', clearCookieHeader());
  res.json({ ok: true });
});

router.get('/session', async (req, res) => {
  try {
    const session = await resolveSession(req);
    if (!session) return res.json({ authenticated: false });
    const user = await User.findById(session.userId, { email: 1, name: 1, isAdmin: 1, status: 1, onboarding: 1 }).lean();
    // A session whose user was deleted, or whose access was revoked while they
    // were signed in.
    if (!user || user.status === 'disabled') return res.json({ authenticated: false });
    res.json({ authenticated: true, user: publicUser(user) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
