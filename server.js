require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const cors = require('cors');
const crypto = require('crypto');
const path = require('path');
const db = require('./db');
const Settings = require('./models/Settings');
const Contact = require('./models/Contact');
const User = require('./models/User');
const mailer = require('./lib/mailer');
const { verifyPassword } = require('./lib/password');
const credentials = require('./lib/credentials');
const {
  createSession, resolveSession, destroySession, setCookieHeader, clearCookieHeader,
} = require('./lib/session');
const { auditHttpMutations } = require('./lib/activityLog');
const { attachUser, resolveSoleUserId } = require('./lib/currentUser');
const { resolveWorkerUser } = require('./lib/workerAuth');
const { issueShareToken, revokeShareToken, resolveShareUser, hasShareToken } = require('./lib/shareAuth');
const { usersByStaleness, runForUsers } = require('./lib/fanout');
const { deadline } = require('./lib/http');
const { classifyReply } = require('./lib/replyClassifier');
const { runBackfillBatch } = require('./routes/contacts');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: false }));

// ── Auth ─────────────────────────────────────────────────────────────────────
const AUTH_PASSWORD = process.env.AUTH_PASSWORD;
const AUTH_SECRET   = process.env.AUTH_SECRET || 'outreach-default-secret';
const AUTH_COOKIE   = 'outreach_auth';
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds

const makeToken = (pw) =>
  crypto.createHmac('sha256', AUTH_SECRET).update(pw).digest('hex');

const AUTH_TOKEN = AUTH_PASSWORD ? makeToken(AUTH_PASSWORD) : null;

// ── Separate "share" credential — a public read-only export view ─────────────
// Independent of the owner password: lets the owner hand out a link + this
// password so outsiders can use the Export tab (and nothing else).
const EXPORT_PASSWORD = process.env.EXPORT_PASSWORD;
const EXPORT_COOKIE   = 'outreach_share';
// Namespaced so it never collides with the owner token even if secrets match.
const EXPORT_TOKEN = EXPORT_PASSWORD ? makeToken('share:' + EXPORT_PASSWORD) : null;

// ── Third independent credential — machine-to-machine cron ──────────────────
// The GitHub Actions workflows send the RAW secret; we HMAC it here and compare,
// exactly as POST /login and /api/share/login do. Sending a pre-derived token
// would gain nothing (it is a bearer credential either way) and would force the
// secret to be HMAC'd by hand to populate the GitHub secret.
const CRON_SECRET = process.env.CRON_SECRET;
const CRON_TOKEN  = CRON_SECRET ? makeToken('cron:' + CRON_SECRET) : null;

// ── Fourth independent credential — the LinkedIn scrape worker ──────────────
// Separate from CRON_SECRET on purpose: that one lives in GitHub Actions, this
// one lives on a laptop, so they should be revocable independently.
// Now a legacy fallback: per-account worker tokens live on the User document
// (lib/workerAuth.js), and this one is only honoured while a single account
// exists, so one shared secret can never claim somebody else's runs.
const WORKER_SECRET = process.env.WORKER_SECRET;

// Constant-time compare of two hex digests. Both sides are fixed-length here, so
// the length precheck that stops timingSafeEqual from throwing cannot leak
// anything about the secret.
const tokenMatches = (candidate, expected) => {
  if (!expected || typeof candidate !== 'string' || candidate.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
  } catch (_) {
    return false;
  }
};

// EXACT paths only, never a prefix — so a future /api/postings/* endpoint is not
// reachable with a cron secret just because the sync endpoint is.
const CRON_PATHS = new Set(['/api/postings/sync', '/api/check-mailbox', '/api/campaigns/run-due']);

// Same exact-match rule. These carry the run id in the BODY rather than the
// path precisely so they can be matched exactly — /api/scrapes/:id/... could
// not be, and a prefix match would expose every scrape endpoint to the worker.
const WORKER_PATHS = new Set([
  '/api/scrapes/claim', '/api/scrapes/ingest', '/api/scrapes/finish',
  '/api/scrapes/progress',
]);

const isCron = (req) => {
  if (!CRON_TOKEN) return false;   // unset secret => carve-out is inert
  const raw = req.headers['x-cron-secret'];
  if (typeof raw !== 'string' || !raw) return false;
  return tokenMatches(makeToken('cron:' + raw), CRON_TOKEN);
};

// Resolves the ACCOUNT behind a worker token, not just "is this the worker".
// A scrape run, the leads it ingests and the 7-day LinkedIn block it can trigger
// all belong to one user, so the credential has to name them.
const resolveWorker = (req) =>
  resolveWorkerUser(req.headers['x-worker-secret'], { legacySecret: WORKER_SECRET || null });

// Read a cookie value from the raw header and constant-time compare to a token.
const cookieMatches = (req, name, expected) => {
  if (!expected) return false;
  const raw = req.headers.cookie || '';
  const match = raw.split(';').find(c => c.trim().startsWith(name + '='));
  const token = match ? decodeURIComponent(match.trim().slice(name.length + 1)) : '';
  if (token.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
  } catch (_) {
    return false;
  }
};

// ── Legacy shared-password login — the rollback path ────────────────────────
// Phase 3 of the multi-tenant migration replaced this with per-user sessions.
// It stays reachable for one deploy cycle so a bug in session auth cannot lock
// the owner out of their own app, but it is OFF unless explicitly switched on:
// it authenticates "whoever knows the password", which has no place once more
// than one account exists.
const LEGACY_LOGIN = process.env.LEGACY_LOGIN === '1' && !!AUTH_TOKEN;

// Escape hatch for local development, replacing the old "no password set means
// no auth" rule. Explicit, because that rule failed open on a missing env var.
const AUTH_OPEN = process.env.AUTH_OPEN === '1';

const isLegacyOwner = (req) => LEGACY_LOGIN && cookieMatches(req, AUTH_COOKIE, AUTH_TOKEN);
const isShare = (req) => cookieMatches(req, EXPORT_COOKIE, EXPORT_TOKEN);

const requireAuth = async (req, res, next) => {
  // Local-development bypass. It resolves the owner here, beside the bypass, so
  // that attachUser can stay strict for every real request.
  if (AUTH_OPEN) {
    try { await ensureDb(); req.userId = await resolveSoleUserId(); } catch (_) { /* no account yet */ }
    return next();
  }
  if (req.path === '/login' || req.path.startsWith('/api/auth') || req.path.startsWith('/api/inngest')) return next();
  // The React SPA shell is public so share/unauthenticated visitors can load it;
  // the client renders "Not authorised" for owner-only pages and all owner DATA
  // endpoints below stay gated. The share API self-guards.
  if (req.path === '/app' || req.path.startsWith('/app/')) return next();
  // Trailing slash matters: the carve-out is for the unauthenticated share API
  // under /api/share/, NOT for /api/share-link, which is owner-only management
  // and must stay behind auth. A bare /api/share prefix would swallow it.
  if (req.path.startsWith('/api/share/')) return next();
  // Allow static assets so the login page can load its CSS/JS
  if (/\.(css|js|woff2?|ttf|svg|ico|png|jpg|jpeg)$/.test(req.path)) return next();

  // Scheduled jobs have no cookie to send. Gated to two exact paths, and inert
  // unless CRON_SECRET is configured. Flagged explicitly rather than inferred
  // from "no session", which would also catch legacy-login and AUTH_OPEN
  // requests and make a person's click behave like a sweep over every account.
  if (CRON_PATHS.has(req.path) && isCron(req)) { req.isCron = true; return next(); }

  // The scrape worker runs on a Mac and has no cookie either. Same exact-path
  // rule. Its token identifies the account, so req.userId is set here and every
  // handler downstream stays scoped without knowing how the caller authenticated.
  if (WORKER_PATHS.has(req.path)) {
    try {
      await ensureDb();
      const workerUserId = await resolveWorker(req);
      if (workerUserId) { req.isWorker = true; req.userId = workerUserId; return next(); }
    } catch (err) {
      return res.status(503).json({ error: `Database not available: ${err.message}` });
    }
  }

  if (isLegacyOwner(req)) return next();

  // A real per-user session. The lookup needs the database, and this middleware
  // runs ahead of the per-route requireDb, so it connects for itself.
  try {
    await ensureDb();
    const session = await resolveSession(req);
    if (session) {
      req.session = session;
      req.userId = session.userId;
      return next();
    }
  } catch (err) {
    return res.status(503).json({ error: `Database not available: ${err.message}` });
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
};

app.use(requireAuth);

app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'login.html')));

// Email + password. Signups are deliberately closed: without verified email
// there is nothing stopping someone registering as anybody, so accounts are
// created out of band by scripts/set-password.js until OTP lands.
app.post('/api/auth/login', async (req, res) => {
  const email = String((req.body && req.body.email) || '').trim().toLowerCase();
  const password = String((req.body && req.body.password) || '');
  if (!email || !password) return res.status(400).json({ error: 'Email and password are required' });

  try {
    await ensureDb();
    const user = await User.findOne({ email });
    // One message and one code for "no such account" and "wrong password", so
    // this endpoint cannot be used to discover which addresses have accounts.
    const okPassword = user ? await verifyPassword(password, user.passwordHash) : false;
    if (!user || !okPassword) return res.status(401).json({ error: 'Incorrect email or password' });

    const token = await createSession(user._id);
    res.setHeader('Set-Cookie', setCookieHeader(token));
    await User.updateOne({ _id: user._id }, { $set: { lastLoginAt: new Date() } });
    res.json({ ok: true, user: { id: user._id.toString(), email: user.email, name: user.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  try {
    await ensureDb();
    await destroySession(req);
  } catch (_) { /* clearing the cookie matters more than tidying the row */ }
  res.setHeader('Set-Cookie', clearCookieHeader());
  res.json({ ok: true });
});

app.get('/api/auth/session', async (req, res) => {
  try {
    await ensureDb();
    const session = await resolveSession(req);
    if (!session) return res.json({ authenticated: false });
    const user = await User.findById(session.userId, { email: 1, name: 1 }).lean();
    if (!user) return res.json({ authenticated: false });
    res.json({ authenticated: true, user: { id: user._id.toString(), email: user.email, name: user.name } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/logout', async (req, res) => {
  try {
    await ensureDb();
    await destroySession(req);
  } catch (_) { /* as above */ }
  res.setHeader('Set-Cookie', clearCookieHeader());
  res.redirect('/login');
});

// ── UI toggle: remembered preference for the React UI (see client/) ─────────
// Only the exact root path redirects — deep links to either UI always work.
app.get('/', (req, res, next) => {
  if ((req.headers.cookie || '').includes('outreach_ui=react')) return res.redirect('/app/');
  next();
});

// React SPA (Vite build) — served behind the same requireAuth as everything else.
app.use('/app', express.static(path.join(__dirname, 'client/dist')));
app.get('/app/*', (req, res, next) => {
  // Only client-side routes fall back to index.html. A request that looks like a
  // file (has an extension) but wasn't served above is a genuinely missing asset —
  // let it 404 instead of returning index.html with a text/html MIME type.
  if (/\.\w+$/.test(req.path)) return next();
  res.sendFile(path.join(__dirname, 'client/dist/index.html'));
});

app.use(express.static(__dirname));

// Cached connection promise — one connection attempt shared across all concurrent requests
// on a cold start. Resets on failure so the next request triggers a fresh attempt.
let _dbConnecting = null;

// One-time, fire-and-forget migration for contacts classified before `replyClassifierOk`
// existed. `.lean()` reads (used everywhere in this app) never apply Mongoose schema
// defaults, so every pre-existing contact would otherwise read as replyClassifierOk:
// undefined — indistinguishable from "needs classification" — even ones that were already
// correctly classified. The old code path always wrote the literal reasoning "classification
// failed" on a fallback, so that string is the one reliable signal to tell a real answer
// apart from a disguised failure, without needing to re-spend Gemini quota re-checking
// everyone. Runs once per warm instance; the $exists:false queries become no-ops after that.
let _classifierFlagMigrated = false;
const migrateClassifierFlagOnce = () => {
  if (_classifierFlagMigrated) return;
  _classifierFlagMigrated = true;
  (async () => {
    await Contact.updateMany(
      { replyClassifierOk: { $exists: false }, replyCategory: { $ne: null }, replyCategoryReasoning: { $ne: 'classification failed' } },
      { $set: { replyClassifierOk: true } },
    );
    await Contact.updateMany(
      { replyClassifierOk: { $exists: false } },
      { $set: { replyClassifierOk: false } },
    );
  })().catch(err => console.error('[migrate] replyClassifierOk backfill failed:', err.message));
};

const ensureDb = async () => {
  if (mongoose.connection.readyState === 1) { migrateClassifierFlagOnce(); return; } // already connected (warm instance)
  if (!_dbConnecting) {
    _dbConnecting = db.connect().catch(err => {
      _dbConnecting = null; // reset so the next request retries
      throw err;
    });
  }
  await _dbConnecting;
  migrateClassifierFlagOnce();
};

// Awaits the connection instead of returning 503 on the instant of a cold start.
const requireDb = async (req, res, next) => {
  try {
    await ensureDb();
    next();
  } catch (err) {
    res.status(503).json({ error: `Database not available: ${err.message}` });
  }
};

// ── Public share (read-only export) ──────────────────────────────────────────
// Owner is always allowed; otherwise a valid share cookie is required.
const requireShareAuth = async (req, res, next) => {
  if (AUTH_OPEN || isLegacyOwner(req) || isShare(req)) return next();
  // A per-account link token. This is what makes sharing multi-tenant: the token
  // names WHOSE export is being read, which one global password never could.
  try {
    const shareUserId = await resolveShareUser(req.query.s, { legacySecret: null });
    if (shareUserId) { req.isShareLink = true; req.userId = shareUserId; return next(); }
  } catch (_) { /* fall through */ }

  // A signed-in user may always read their own export.
  try {
    const session = await resolveSession(req);
    if (session) { req.session = session; req.userId = session.userId; return next(); }
  } catch (_) { /* fall through to the share-password check */ }

  // The legacy global share password names no account, so it can only mean
  // anything while exactly one exists. Resolved explicitly here rather than
  // left for attachUser to guess at.
  if (isShare(req)) {
    try { req.userId = await resolveSoleUserId(); return next(); }
    catch (err) { return res.status(503).json({ error: `The share password cannot identify an account: ${err.message}` }); }
  }

  if (!EXPORT_TOKEN) return res.status(503).json({ error: 'Sharing not configured' });
  return res.status(401).json({ error: 'Unauthorized' });
};

// On the /api/share carve-out, so requireAuth lets it through without resolving
// a session — it has to do that itself to answer whether the caller is signed in.
app.get('/api/share/session', requireDb, async (req, res) => {
  let owner = AUTH_OPEN || isLegacyOwner(req);
  let user = null;
  if (!owner) {
    try {
      const session = await resolveSession(req);
      if (session) {
        const doc = await User.findById(session.userId, { email: 1, name: 1 }).lean();
        if (doc) { owner = true; user = { id: doc._id.toString(), email: doc.email, name: doc.name }; }
      }
    } catch (_) { /* fall through as signed-out */ }
  }
  let share = isShare(req);
  if (!share && req.query.s) {
    try { share = !!(await resolveShareUser(req.query.s)); } catch (_) { /* not a valid link */ }
  }
  res.json({ owner, share, user });
});

app.post('/api/share/login', (req, res) => {
  const { password } = req.body;
  if (EXPORT_TOKEN && password && makeToken('share:' + password) === EXPORT_TOKEN) {
    res.setHeader('Set-Cookie',
      `${EXPORT_COOKIE}=${encodeURIComponent(EXPORT_TOKEN)}; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}; Path=/`
    );
    return res.json({ ok: true });
  }
  res.status(401).json({ error: 'Invalid password' });
});

// Mounted ahead of the `/api` attachUser middleware, so requireShareAuth resolves
// the account itself — from a link token, a session, or (single-account only) the
// legacy share cookie. attachUser is the last resort and refuses once there are
// several accounts, since a global password cannot say whose export it wants.
app.get('/api/share/contacts', requireDb, requireShareAuth, attachUser, async (req, res) => {
  try {
    const docs = await Contact.find({ userId: req.userId, deleted: { $ne: true } })
      .select('name email company role status repliedAt lastSentAt')
      .sort({ createdAt: -1 })
      .lean();
    // Return only non-sensitive fields; derive booleans so dates never ship.
    const contacts = docs.map(c => ({
      name: c.name,
      email: c.email,
      company: c.company || '',
      role: c.role || '',
      status: c.status,
      replied: !!c.repliedAt || c.status === 'replied' || c.status === 'follow-up-replied',
      delivered: !!c.lastSentAt && c.status !== 'bounced' && c.status !== 'failed',
    }));
    res.json({ contacts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// attachUser sits ahead of every /api route so handlers can rely on req.userId.
// It runs after requireDb because it reads the account from the database.
// ── Share link management (owner only) ──────────────────────────────────────
// Deliberately NOT under /api/share, which is the unauthenticated carve-out.
app.post('/api/share-link', requireDb, attachUser, async (req, res) => {
  try {
    if (!req.session) return res.status(401).json({ error: 'Sign in to manage your share link' });
    const token = await issueShareToken(req.userId);
    res.json({ token, path: `/app/export-contacts?s=${encodeURIComponent(token)}`,
      note: 'Anyone with this link can read your contact export. It is shown once; rotate or revoke it here.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/share-link', requireDb, attachUser, async (req, res) => {
  try {
    if (!req.session) return res.status(401).json({ error: 'Sign in to manage your share link' });
    await revokeShareToken(req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/share-link', requireDb, attachUser, async (req, res) => {
  try {
    if (!req.session) return res.status(401).json({ error: 'Sign in to manage your share link' });
    res.json({ registered: await hasShareToken(req.userId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.use('/api', requireDb, attachUser, auditHttpMutations);
app.use('/api/logs', requireDb, require('./routes/logs'));
app.use('/api/contacts', requireDb, require('./routes/contacts'));
app.use('/api/templates', requireDb, require('./routes/templates'));
app.use('/api/settings', requireDb, require('./routes/settings'));
app.use('/api/jobs', requireDb, require('./routes/jobs'));
app.use('/api/leads', requireDb, require('./routes/leads'));
app.use('/api/scrapes', requireDb, require('./routes/scrapes'));
// People who actually got back to you. A separate store from Contact/Lead so the
// outreach and apply journeys above are never written to — see models/Interview.js.
app.use('/api/interviews', requireDb, require('./routes/interviews'));
// Job postings pulled from public ATS boards. NOT /api/jobs — that is taken by
// the email SendJob routes above, and these are job *postings* anyway.
app.use('/api/postings', requireDb, require('./routes/postings'));
app.use('/api/campaigns', requireDb, require('./routes/campaigns'));
app.use('/api/blocklist', requireDb, require('./routes/blocklist'));

// ── Inngest handler ─────────────────────────────────────────────────────────
const { serve } = require('inngest/express');
const { inngest } = require('./inngest');
const { sendEmailBatch, sendSingleEmail, sendEmailBulk, sendEmailDrip } = require('./inngest-fns');
app.use('/api/inngest', serve({ client: inngest, functions: [sendEmailBatch, sendSingleEmail, sendEmailBulk, sendEmailDrip] }));

// ── Configure Gmail credentials ────────────────────────────────────────────
app.post('/api/config', requireDb, async (req, res) => {
  const { email, appPassword, name } = req.body;
  if (!email || !appPassword) return res.status(400).json({ error: 'email and appPassword required' });
  if (!credentials.isConfigured()) {
    return res.status(503).json({ error: 'CREDENTIAL_KEY is not set, so a Gmail password cannot be stored safely.' });
  }

  try {
    await new Promise((resolve, reject) => {
      mailer.buildTransporter(email, appPassword).verify(err => (err ? reject(err) : resolve()));
    });
  } catch (err) {
    return res.status(400).json({ error: 'Could not connect. Check email/app password.', detail: err.message });
  }

  try {
    // Persisted against this user, encrypted. It used to live in process memory,
    // which a cron invocation never saw and which every other user's request on
    // the same warm instance did.
    const update = { gmailEmail: email, gmailAppPasswordEnc: credentials.encrypt(appPassword) };
    if (name) update.senderName = name;
    const settings = await Settings.getForUser(req.userId);
    await Settings.updateOne({ _id: settings._id, userId: req.userId }, { $set: update });
    res.json({ ok: true, message: `Connected as ${email}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bounce parsing ─────────────────────────────────────────────────────────
const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const parseBounces = (raw) => {
  const hits = [];
  const finalRecipientRe = /Final-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/gi;
  let match;
  while ((match = finalRecipientRe.exec(raw)) !== null) {
    const email = match[1].toLowerCase();
    const tail = raw.slice(match.index, match.index + 1000);
    const diagnostic = tail.match(/Diagnostic-Code:\s*(?:smtp|x-[\w-]+);\s*([^\r\n]+(?:\r?\n[ \t]+[^\r\n]+)*)/i);
    const status = tail.match(/Status:\s*([\d.]+)/i);
    const reason = diagnostic
      ? diagnostic[1].split(/\r?\n/).map((line, i) => {
          const trimmed = line.trim();
          return i === 0 ? trimmed : trimmed.replace(/^\d{3}[ -]\d+\.\d+\.\d+\s*/, '');
        }).join(' ').trim()
      : (status ? `SMTP status ${status[1]}` : 'Unknown bounce reason');
    hits.push({ email, reason });
  }

  if (hits.length === 0) {
    const bodyMatch = raw.match(/wasn'?t delivered to\s+([^\s]+@[^\s]+?)\s+because/i);
    if (bodyMatch) {
      const email = bodyMatch[1].replace(/[<>.,]+$/, '').toLowerCase();
      const reasonMatch = raw.match(/because[:\s]+(.{10,300}?)[\r\n]/i);
      hits.push({ email, reason: reasonMatch ? reasonMatch[1].trim() : 'Unknown bounce reason' });
    }
  }
  return hits;
};

const REPLY_SNIPPET_MAX_LEN = 400;

const buildSnippet = (text) => {
  if (!text) return null;
  const lines = text.replace(/<[^>]+>/g, ' ').split(/\r?\n/);
  const kept = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('>')) break;
    if (/^on .+wrote:$/i.test(trimmed)) break;
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(trimmed)) break;
    kept.push(line);
  }
  let snippet = kept.join('\n').trim();
  if (!snippet) return null;
  if (snippet.length > REPLY_SNIPPET_MAX_LEN) snippet = snippet.slice(0, REPLY_SNIPPET_MAX_LEN).trim() + '…';
  return snippet;
};

// Strips angle brackets from a raw Message-ID header value.
const cleanMsgId = (id) => (id || '').replace(/^<|>$/g, '') || null;

// Has this exact message already been captured in the contact's thread? Lean
// projections only carry `thread.messageId` here, not the full entries.
const threadHasMessageId = (contact, messageId) =>
  !!messageId && (contact.thread || []).some(t => t.messageId === messageId);

// tryMatchReply — uses pre-loaded lean maps; writes via findOneAndUpdate (no doc hydration).
// Runs on every scan regardless of whether the contact already has a prior reply, so an
// ongoing back-and-forth (2nd, 3rd, ... reply) keeps getting captured — de-duped purely on
// message-id so the same inbound message is never appended to `thread` twice.
const tryMatchReply = async (raw, byMessageId, byEmail, replied, userId) => {
  const parsed = await simpleParser(raw);
  const fromAddr = (parsed.from?.value?.[0]?.address || '').toLowerCase();
  if (!fromAddr || /mailer-daemon|postmaster/i.test(fromAddr)) return;

  const refTokens = [
    parsed.inReplyTo,
    ...(Array.isArray(parsed.references) ? parsed.references : (parsed.references ? [parsed.references] : [])),
  ].filter(Boolean).map(t => t.replace(/^<|>$/g, ''));

  let contact = null;
  for (const token of refTokens) {
    if (byMessageId.has(token)) { contact = byMessageId.get(token); break; }
  }

  if (!contact) {
    const subject = (parsed.subject || '').trim();
    if (/^(re|automatic reply|auto-?reply|out[ -]of[ -]office)\s*:/i.test(subject)) {
      const candidate = byEmail.get(fromAddr);
      if (candidate && !candidate.messageId && parsed.date && parsed.date > candidate.updatedAt) {
        contact = candidate;
      }
    }
  }

  if (!contact) return;

  const inboundMessageId = cleanMsgId(parsed.messageId);
  if (threadHasMessageId(contact, inboundMessageId)) return; // already captured this exact message

  const repliedAt = parsed.date || new Date();
  const replySnippet = buildSnippet(parsed.text || parsed.html || '');
  const fullBody = parsed.text || parsed.html || '';

  const { category, reasoning, success } = await classifyReply({
    subject: parsed.subject, body: fullBody,
    contactEmail: contact.email, contactName: contact.name, userId,
  });

  const threadEntry = {
    direction: 'inbound',
    subject: parsed.subject || '',
    text: parsed.text || '',
    html: parsed.html || '',
    messageId: inboundMessageId,
    inReplyTo: cleanMsgId(parsed.inReplyTo),
    at: repliedAt,
  };

  // A reply that comes in after we already sent a follow-up is tracked separately from a
  // reply to the initial email. Once a contact is already `replied`/`follow-up-replied`,
  // later replies keep that status as-is rather than re-deriving it.
  const newStatus = ['replied', 'follow-up-replied'].includes(contact.status)
    ? contact.status
    : (contact.status === 'follow-up-sent' ? 'follow-up-replied' : 'replied');

  // Mark in-memory to prevent double-processing (and re-matching by message-id) in the same batch
  contact.status = newStatus;
  contact.thread = [...(contact.thread || []), { messageId: inboundMessageId }];
  if (inboundMessageId) byMessageId.set(inboundMessageId, contact);

  // A new reply always resets replyClassifierOk to false first (this is the "new reply"
  // moment) — it only becomes true if THIS classification attempt actually succeeded. On
  // failure, category/reasoning are left null rather than filled with a fake fallback value,
  // so the UI can tell "not yet classified" apart from a real (if unconfident) verdict.
  await Contact.findOneAndUpdate({ _id: contact._id, userId }, {
    $set: {
      status: newStatus, repliedAt, replySnippet,
      replyCategory: success ? category : null,
      replyCategoryReasoning: success ? reasoning : null,
      replyCategorizedAt: success ? new Date() : null,
      replyClassifierOk: success,
    },
    $push: {
      statusHistory: { status: newStatus, changedAt: repliedAt, note: newStatus === 'follow-up-replied' ? 'Reply received after follow-up' : 'Reply received' },
      thread: threadEntry,
    },
  });
  replied.push({ email: contact.email, name: contact.name, repliedAt, snippet: replySnippet, category: success ? category : null });
};

// trySentReply — matches a message found in the Sent folder (i.e. a reply YOU typed
// directly in Gmail, outside this app) back to a contact via thread message-ids or a
// Re:-subject + recipient-email fallback, and appends it as an outbound thread entry.
// No status change, no classification — sent messages are just captured for the thread view.
// De-duped on message-id, which also naturally skips messages the app already recorded at
// send time (inngest-fns.js), since those already carry the same Message-ID header.
const trySentReply = async (raw, byMessageId, byEmail, userId) => {
  const parsed = await simpleParser(raw);
  const toAddr = (parsed.to?.value?.[0]?.address || '').toLowerCase();
  if (!toAddr) return;

  const refTokens = [
    parsed.inReplyTo,
    ...(Array.isArray(parsed.references) ? parsed.references : (parsed.references ? [parsed.references] : [])),
  ].filter(Boolean).map(t => t.replace(/^<|>$/g, ''));

  let contact = null;
  for (const token of refTokens) {
    if (byMessageId.has(token)) { contact = byMessageId.get(token); break; }
  }
  if (!contact) {
    const subject = (parsed.subject || '').trim();
    if (/^re\s*:/i.test(subject)) contact = byEmail.get(toAddr) || null;
  }
  if (!contact) return;

  const messageId = cleanMsgId(parsed.messageId);
  if (threadHasMessageId(contact, messageId)) return;

  const threadEntry = {
    direction: 'outbound',
    subject: parsed.subject || '',
    text: parsed.text || '',
    html: parsed.html || '',
    messageId,
    inReplyTo: cleanMsgId(parsed.inReplyTo),
    at: parsed.date || new Date(),
  };

  contact.thread = [...(contact.thread || []), { messageId }];
  if (messageId) byMessageId.set(messageId, contact);

  await Contact.findOneAndUpdate({ _id: contact._id, userId }, { $push: { thread: threadEntry } });
};

// ── Check mailbox ──────────────────────────────────────────────────────────
const BOUNCE_LOOKBACK_DAYS = 7;
const REPLY_LOOKBACK_DAYS = 30;
const BUFFER_MS = 5 * 60 * 1000;

// One user's mailbox scan. Extracted from the route so the cron can run it for
// every account: there is no longer a single mailbox to check.
async function checkMailboxForUser(userId) {
  const sender = await mailer.getSenderFor(userId);
  if (!sender.email || !sender.appPassword) {
    return { ok: false, skipped: 'no_credentials' };
  }

  const settings = await Settings.findOne({ userId: userId }, { 'resume.data': 0 });
  const lastChecked = settings?.lastMailboxCheckAt ?? null;

  const fallbackBounce = new Date(Date.now() - BOUNCE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const fallbackReply  = new Date(Date.now() - REPLY_LOOKBACK_DAYS  * 24 * 60 * 60 * 1000);
  const bounceSince = lastChecked
    ? new Date(Math.max(lastChecked.getTime() - BUFFER_MS, fallbackBounce.getTime()))
    : fallbackBounce;
  const replySince = lastChecked
    ? new Date(Math.max(lastChecked.getTime() - BUFFER_MS, fallbackReply.getTime()))
    : fallbackReply;

  const client = new ImapFlow({
    host: 'imap.gmail.com', port: 993, secure: true,
    auth: { user: sender.email, pass: sender.appPassword },
    logger: false,
  });

  let scanned = 0;
  const bounced = [];
  const replied = [];

  // Pre-load ALL contacts once with a lean projection — eliminates N+1 queries in the scan loop.
  // `thread.messageId` only (not full text/html) keeps this payload small even as threads grow.
  const allContacts = await Contact.find(
    { userId: userId, deleted: { $ne: true } },
    'email name status bounceReason messageId updatedAt thread.messageId lastSentAt repliedAt'
  ).lean();

  // byEmailAll: for bounce matching (any status)
  // byEmail + byMessageId: for reply/sent matching — any contact that has ever been emailed
  // or replied, or has any thread activity. Deliberately NOT keyed off `status`: you can
  // manually re-triage a replied contact to closed/no-openings/in-review after reading it,
  // which would otherwise silently stop the scanner from noticing any further reply from
  // them. `lastSentAt`/`repliedAt` never get touched by that manual triage.
  const byEmailAll  = new Map();
  const byEmail     = new Map();
  const byMessageId = new Map();

  for (const c of allContacts) {
    const addr = c.email.toLowerCase();
    byEmailAll.set(addr, c);
    const isThreadable = !!(c.lastSentAt || c.repliedAt) || (c.thread && c.thread.length > 0);
    if (isThreadable) {
      byEmail.set(addr, c);
      if (c.messageId) byMessageId.set(c.messageId.replace(/^<|>$/g, ''), c);
      for (const t of (c.thread || [])) {
        if (t.messageId) byMessageId.set(t.messageId, c);
      }
    }
  }

  const scanMailbox = async (mailbox) => {
    let lock;
    try { lock = await client.getMailboxLock(mailbox); } catch (_) { return; }
    try {
      const [reportUids, daemonUids, postmasterUids, replyUids] = await Promise.all([
        client.search({ since: bounceSince, header: { 'content-type': 'multipart/report' } }, { uid: true }),
        client.search({ since: bounceSince, from: 'mailer-daemon' }, { uid: true }),
        client.search({ since: bounceSince, from: 'postmaster' }, { uid: true }),
        client.search({ since: replySince }, { uid: true }),
      ]);
      const uids = [...new Set([...reportUids, ...daemonUids, ...postmasterUids, ...replyUids])];
      scanned += uids.length;

      for (const uid of uids) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg?.source) continue;
        const raw = msg.source.toString('utf8');
        const hits = parseBounces(raw);

        if (hits.length > 0) {
          for (const { email, reason } of hits) {
            // O(1) lookup — no DB query
            const existing = byEmailAll.get(email.toLowerCase());
            if (!existing) continue;

            if (existing.status !== 'bounced') {
              existing.status = 'bounced'; // in-memory: prevents double-processing
              await Contact.findOneAndUpdate({ _id: existing._id, userId: userId }, {
                $set: { status: 'bounced', bounceReason: reason },
                $push: { statusHistory: { status: 'bounced', changedAt: new Date(), note: reason || 'Bounce detected' } },
              });
              bounced.push({ email: existing.email, name: existing.name, reason });
            } else if (reason !== existing.bounceReason && reason.length > (existing.bounceReason || '').length) {
              existing.bounceReason = reason;
              await Contact.findOneAndUpdate({ _id: existing._id, userId: userId }, { bounceReason: reason });
            }
          }
          continue;
        }

        await tryMatchReply(raw, byMessageId, byEmail, replied, userId);
      }
    } finally {
      lock.release();
    }
  };

  // Scans the Sent folder for replies you typed directly in Gmail (not through this app),
  // so the thread view has your side of the conversation too. No bounce/reply-status logic
  // here — just thread capture via trySentReply.
  const scanSentMailbox = async (mailbox) => {
    let lock;
    try { lock = await client.getMailboxLock(mailbox); } catch (_) { return; }
    try {
      const uids = await client.search({ since: replySince }, { uid: true });
      scanned += uids.length;
      for (const uid of uids) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg?.source) continue;
        await trySentReply(msg.source.toString('utf8'), byMessageId, byEmail, userId);
      }
    } finally {
      lock.release();
    }
  };

  try {
    await client.connect();
    for (const mailbox of ['INBOX', '[Gmail]/Spam']) {
      await scanMailbox(mailbox);
    }
    await scanSentMailbox('[Gmail]/Sent');
  } catch (err) {
    throw new Error(`IMAP check failed: ${err.message}`);
  } finally {
    try { await client.logout(); } catch (_) {}
  }

  await Settings.findOneAndUpdate({ userId: userId }, { lastMailboxCheckAt: new Date() });

  // Drains the legacy thread/classification backfill in the background, piggybacking on this
  // cron so the "Backfill now" button on Mailbox is a manual override, not the only way it
  // ever runs. One bounded batch per 5-minute tick keeps this well under the function timeout;
  // best-effort — a failure here (e.g. a classifier rate limit) must not fail the mailbox check.
  let backfill = null;
  try {
    backfill = await runBackfillBatch(20, userId);
  } catch (err) {
    backfill = { error: err.message };
  }

  return { ok: true, scanned, bounced, replied, lastCheckedAt: new Date(), backfill };
}

// POST /api/check-mailbox
// A signed-in person checks their own mailbox. The cron has no session, so it
// sweeps every account, longest-unchecked first, within a time budget — Vercel
// kills the function at 60s and a killed sweep reports nothing at all.
app.post('/api/check-mailbox', requireDb, async (req, res) => {
  try {
    if (!req.isCron) {
      const result = await checkMailboxForUser(req.userId);
      if (result.skipped === 'no_credentials') {
        return res.status(400).json({ error: 'Not configured. Set up Gmail first.' });
      }
      return res.json(result);
    }

    // Measured: a single mailbox scan takes ~50s against a real Gmail account,
    // and Vercel kills the function at 60s. The budget can only stop the loop
    // STARTING another account, never interrupt one in flight, so it is set well
    // below the cost of one scan: in practice a tick handles one account and
    // defers the rest to the next tick, oldest-first so nobody is starved.
    // More than a handful of accounts needs the Inngest fan-out (one event per
    // user, workers in parallel) rather than this serial sweep.
    const userIds = await usersByStaleness('lastMailboxCheckAt');
    const report = await runForUsers(userIds, checkMailboxForUser, { budget: deadline(25_000) });
    res.json(report);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Send single email (legacy — kept for step3 fallback) ──────────────────
app.post('/api/send', requireDb, async (req, res) => {
  const { to, subject, body, attachResume } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, body are required' });

  try {
    const sender = await mailer.getTransporterFor(req.userId);
    if (!sender) return res.status(400).json({ error: 'Not configured. Set up Gmail first.' });
    const attachments = await mailer.getResumeAttachment(attachResume, req.userId);
    const info = await sender.transporter.sendMail({
      from: `"${sender.name}" <${sender.email}>`,
      to, subject, text: body,
      ...(attachments ? { attachments } : {}),
    });
    res.json({ ok: true, messageId: info.messageId || null });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.responseCode || err.code || null });
  }
});

// ── Status ──────────────────────────────────────────────────────────────────
app.get('/api/status', requireDb, async (req, res) => {
  try {
    const sender = await mailer.getSenderFor(req.userId);
    res.json({ configured: !!(sender.email && sender.appPassword), email: sender.email, name: sender.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Global error handler — catches unhandled throws in any route ─────────────
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('[unhandled]', err.message);
  if (!res.headersSent) res.status(500).json({ error: err.message || 'Internal server error' });
});

// Export for Vercel (serverless). On Vercel, ensureDb() is called lazily per-request via the
// middleware above; the listen block below only runs in local dev.
module.exports = app;

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  ensureDb()
    .catch(err => console.error('❌  MongoDB connection error:', err.message))
    .finally(() => {
      app.listen(PORT, () => {
        console.log(`\n✅  Outreach server running at http://localhost:${PORT}`);
        console.log(`   Open http://localhost:${PORT} in your browser\n`);
      });
    });
}
