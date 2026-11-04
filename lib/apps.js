/**
 * Which product this server is.
 *
 * Outreach and Clientline share ONE account store: the users, sessions, sign-in
 * codes and access requests collections in this database. An account can belong
 * to either app or both, recorded in User.apps. Everything else — contacts,
 * leads, settings, onboarding — belongs to one app and lives in that app's own
 * collections.
 *
 * Clientline carries a copy of the auth files (lib/session.js, lib/loginCode.js
 * and the four models). Keep them identical apart from APP below, so that a
 * plain diff shows any drift.
 *
 * Admin rights (User.isAdmin) are global: the separate admin app manages both.
 */
const APP = 'outreach';
const APPS = ['outreach', 'clientline'];

/** Does this account have access to `app` (default: this one)? A missing or
 *  malformed `apps` means no — db.js backfills every pre-existing account. */
const hasApp = (user, app = APP) => Array.isArray(user && user.apps) && user.apps.includes(app);

/** A User query limited to this app's accounts. Every sweep over "all users"
 *  goes through this, or a Clientline-only account gets Outreach's crons and
 *  reminder emails. */
const inApp = (filter = {}) => ({ ...filter, apps: APP });

module.exports = { APP, APPS, hasApp, inApp };
