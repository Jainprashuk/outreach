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
const { requestCode, verifyCode, CODE_TTL_MS, RESEND_COOLDOWN_MS } = require('../lib/loginCode');
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
 * Answers 200 no matter what happened — unknown address, rate limited, disabled
 * account, code actually sent, Resend refusing it. That is the point: any
 * variation here tells a stranger which addresses have accounts. In particular
 * this never answers 429, because a 429 for one address beside a 200 for another
 * is that disclosure in a different shape. The visible cooldown on the login
 * page is what keeps this honest to a real user.
 */
router.post('/request-code', async (req, res) => {
  try {
    await requestCode(req, req.body && req.body.email);
    res.json({ ok: true, cooldownMs: RESEND_COOLDOWN_MS, ttlMs: CODE_TTL_MS });
  } catch (err) {
    // A genuine server fault, not a rejected sign-in. Logged with no userId
    // because at this point we do not know, and must not reveal, who this is.
    console.error(`[auth] request-code failed: ${err.message}`);
    logEvent({ userId: null, category: 'auth', action: 'failed', message: `Sign-in code request failed: ${err.message}` }).catch(() => {});
    res.status(500).json({ error: 'Could not send a sign-in code. Try again in a moment.' });
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
