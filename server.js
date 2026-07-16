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
const mailer = require('./lib/mailer');

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

const requireAuth = (req, res, next) => {
  if (!AUTH_TOKEN) return next(); // no password configured → open (local dev)
  if (req.path === '/login' || req.path.startsWith('/api/inngest')) return next();
  // Allow static assets so the login page can load its CSS/JS
  if (/\.(css|js|woff2?|ttf|svg|ico|png|jpg|jpeg)$/.test(req.path)) return next();

  const raw = req.headers.cookie || '';
  const match = raw.split(';').find(c => c.trim().startsWith(AUTH_COOKIE + '='));
  const token = match ? decodeURIComponent(match.trim().slice(AUTH_COOKIE.length + 1)) : '';

  if (token.length === AUTH_TOKEN.length) {
    try {
      if (crypto.timingSafeEqual(Buffer.from(token), Buffer.from(AUTH_TOKEN))) {
        return next();
      }
    } catch (_) {}
  }

  if (req.path.startsWith('/api/')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.redirect('/login');
};

app.use(requireAuth);

app.get('/login', (_req, res) => res.sendFile(path.join(__dirname, 'login.html')));

app.post('/login', (req, res) => {
  const { password } = req.body;
  if (!AUTH_TOKEN || (password && makeToken(password) === AUTH_TOKEN)) {
    const token = AUTH_TOKEN || '';
    res.setHeader('Set-Cookie',
      `${AUTH_COOKIE}=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}; Path=/`
    );
    return res.redirect('/');
  }
  res.redirect('/login?error=1');
});

app.get('/logout', (_req, res) => {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; HttpOnly; Max-Age=0; Path=/`);
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
app.get('/app/*', (_req, res) => res.sendFile(path.join(__dirname, 'client/dist/index.html')));

app.use(express.static(__dirname));

// Cached connection promise — one connection attempt shared across all concurrent requests
// on a cold start. Resets on failure so the next request triggers a fresh attempt.
let _dbConnecting = null;

const ensureDb = async () => {
  if (mongoose.connection.readyState === 1) return; // already connected (warm instance)
  if (!_dbConnecting) {
    _dbConnecting = db.connect().catch(err => {
      _dbConnecting = null; // reset so the next request retries
      throw err;
    });
  }
  await _dbConnecting;
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

app.use('/api/contacts', requireDb, require('./routes/contacts'));
app.use('/api/templates', requireDb, require('./routes/templates'));
app.use('/api/settings', requireDb, require('./routes/settings'));
app.use('/api/jobs', requireDb, require('./routes/jobs'));

// ── Inngest handler ─────────────────────────────────────────────────────────
const { serve } = require('inngest/express');
const { inngest } = require('./inngest');
const { sendEmailBatch, sendSingleEmail, sendEmailBulk, sendEmailDrip } = require('./inngest-fns');
app.use('/api/inngest', serve({ client: inngest, functions: [sendEmailBatch, sendSingleEmail, sendEmailBulk, sendEmailDrip] }));

// ── Configure Gmail credentials ────────────────────────────────────────────
app.post('/api/config', (req, res) => {
  const { email, appPassword, name } = req.body;
  if (!email || !appPassword) return res.status(400).json({ error: 'email and appPassword required' });

  const candidate = mailer.buildTransporter(email, appPassword);
  candidate.verify((err) => {
    if (err) {
      return res.status(400).json({ error: 'Could not connect. Check email/app password.', detail: err.message });
    }
    mailer.transporter = candidate;
    mailer.senderConfig = { email, name: name || 'Prashuk Jain' };
    mailer.senderAppPassword = appPassword;
    res.json({ ok: true, message: `Connected as ${email}` });
  });
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

// tryMatchReply — uses pre-loaded lean maps; writes via findByIdAndUpdate (no doc hydration)
const tryMatchReply = async (raw, byMessageId, byEmail, replied) => {
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

  if (!contact || ['replied', 'follow-up-replied'].includes(contact.status)) return;

  const repliedAt = parsed.date || new Date();
  const replySnippet = buildSnippet(parsed.text || parsed.html || '');
  // A reply that comes in after we already sent a follow-up is tracked separately from a
  // reply to the initial email, so it doesn't get treated as still needing a first follow-up.
  const newStatus = contact.status === 'follow-up-sent' ? 'follow-up-replied' : 'replied';

  // Mark in-memory to prevent double-processing in the same batch
  contact.status = newStatus;

  await Contact.findByIdAndUpdate(contact._id, {
    $set: { status: newStatus, repliedAt, replySnippet },
    $push: { statusHistory: { status: newStatus, changedAt: repliedAt, note: newStatus === 'follow-up-replied' ? 'Reply received after follow-up' : 'Reply received' } },
  });
  replied.push({ email: contact.email, name: contact.name, repliedAt, snippet: replySnippet });
};

// ── Check mailbox ──────────────────────────────────────────────────────────
const BOUNCE_LOOKBACK_DAYS = 7;
const REPLY_LOOKBACK_DAYS = 30;
const BUFFER_MS = 5 * 60 * 1000;

app.post('/api/check-mailbox', requireDb, async (req, res) => {
  if (!mailer.senderConfig.email || !mailer.senderAppPassword) {
    return res.status(400).json({ error: 'Not configured. Set up Gmail first.' });
  }

  const settings = await Settings.findOne({}, { 'resume.data': 0 });
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
    auth: { user: mailer.senderConfig.email, pass: mailer.senderAppPassword },
    logger: false,
  });

  let scanned = 0;
  const bounced = [];
  const replied = [];

  // Pre-load ALL contacts once with a lean projection — eliminates N+1 queries in the scan loop
  const allContacts = await Contact.find(
    { deleted: { $ne: true } },
    'email name status bounceReason messageId updatedAt'
  ).lean();

  // byEmailAll: for bounce matching (any status)
  // byEmail + byMessageId: for reply matching (sent contacts only)
  const byEmailAll  = new Map();
  const byEmail     = new Map();
  const byMessageId = new Map();

  for (const c of allContacts) {
    const addr = c.email.toLowerCase();
    byEmailAll.set(addr, c);
    if (c.status === 'sent' || c.status === 'follow-up-sent') {
      byEmail.set(addr, c);
      if (c.messageId) byMessageId.set(c.messageId.replace(/^<|>$/g, ''), c);
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
              await Contact.findByIdAndUpdate(existing._id, {
                $set: { status: 'bounced', bounceReason: reason },
                $push: { statusHistory: { status: 'bounced', changedAt: new Date(), note: reason || 'Bounce detected' } },
              });
              bounced.push({ email: existing.email, name: existing.name, reason });
            } else if (reason !== existing.bounceReason && reason.length > (existing.bounceReason || '').length) {
              existing.bounceReason = reason;
              await Contact.findByIdAndUpdate(existing._id, { bounceReason: reason });
            }
          }
          continue;
        }

        await tryMatchReply(raw, byMessageId, byEmail, replied);
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
  } catch (err) {
    return res.status(500).json({ error: 'IMAP check failed', detail: err.message });
  } finally {
    try { await client.logout(); } catch (_) {}
  }

  await Settings.findOneAndUpdate({}, { lastMailboxCheckAt: new Date() });
  res.json({ ok: true, scanned, bounced, replied, lastCheckedAt: new Date() });
});

// ── Send single email (legacy — kept for step3 fallback) ──────────────────
app.post('/api/send', async (req, res) => {
  if (!mailer.transporter) return res.status(400).json({ error: 'Not configured. Set up Gmail first.' });
  const { to, subject, body, attachResume } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, body are required' });

  try {
    const attachments = await mailer.getResumeAttachment(attachResume);
    const info = await mailer.transporter.sendMail({
      from: `"${mailer.senderConfig.name}" <${mailer.senderConfig.email}>`,
      to, subject, text: body,
      ...(attachments ? { attachments } : {}),
    });
    res.json({ ok: true, messageId: info.messageId || null });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.responseCode || err.code || null });
  }
});

// ── Status ──────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ configured: !!mailer.transporter, email: mailer.senderConfig.email, name: mailer.senderConfig.name });
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
