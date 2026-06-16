require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const cors = require('cors');
const db = require('./db');
const Settings = require('./models/Settings');
const Contact = require('./models/Contact');
const mailer = require('./lib/mailer');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serves index.html etc.

// Guard DB-backed routes until MongoDB is connected
const requireDb = (req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({ error: 'Database not connected. Check MONGODB_URI_DEV/PROD in .env and restart the server.' });
  }
  next();
};

app.use('/api/contacts', requireDb, require('./routes/contacts'));
app.use('/api/templates', requireDb, require('./routes/templates'));
app.use('/api/settings', requireDb, require('./routes/settings'));
app.use('/api/jobs', requireDb, require('./routes/jobs'));

// ── Inngest handler ─────────────────────────────────────────────────────────
const { serve } = require('inngest/express');
const { inngest } = require('./inngest');
const { sendEmailBatch, sendSingleEmail } = require('./inngest-fns');
app.use('/api/inngest', serve({ client: inngest, functions: [sendEmailBatch, sendSingleEmail] }));

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

// Escapes a string for safe use inside a RegExp.
const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Parses a raw RFC822 bounce/NDR message source for failed recipients + reasons.
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
  if (snippet.length > REPLY_SNIPPET_MAX_LEN) {
    snippet = snippet.slice(0, REPLY_SNIPPET_MAX_LEN).trim() + '…';
  }
  return snippet;
};

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

  if (!contact || contact.status === 'replied') return;

  contact.status = 'replied';
  contact.repliedAt = parsed.date || new Date();
  contact.replySnippet = buildSnippet(parsed.text || parsed.html || '');
  await contact.save();
  replied.push({ email: contact.email, name: contact.name, repliedAt: contact.repliedAt, snippet: contact.replySnippet });
};

// ── Send single email ──────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  if (!mailer.transporter) {
    return res.status(400).json({ error: 'Not configured. Set up Gmail first.' });
  }

  const { to, subject, body, attachResume } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, body are required' });

  try {
    const attachments = await mailer.getResumeAttachment(attachResume);
    const info = await mailer.transporter.sendMail({
      from: `"${mailer.senderConfig.name}" <${mailer.senderConfig.email}>`,
      to,
      subject,
      text: body,
      ...(attachments ? { attachments } : {}),
    });
    res.json({ ok: true, messageId: info.messageId || null });
  } catch (err) {
    res.status(500).json({ error: err.message, code: err.responseCode || err.code || null });
  }
});

// ── Check mailbox for bounces & replies ────────────────────────────────────
const BOUNCE_LOOKBACK_DAYS = 7;
const REPLY_LOOKBACK_DAYS = 30;
const BUFFER_MS = 5 * 60 * 1000;

app.post('/api/check-mailbox', requireDb, async (req, res) => {
  if (!mailer.senderConfig.email || !mailer.senderAppPassword) {
    return res.status(400).json({ error: 'Not configured. Set up Gmail first.' });
  }

  const settings = await Settings.getSingleton();
  const lastChecked = settings.lastMailboxCheckAt;

  const fallbackBounce = new Date(Date.now() - BOUNCE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const fallbackReply  = new Date(Date.now() - REPLY_LOOKBACK_DAYS  * 24 * 60 * 60 * 1000);

  const bounceSince = lastChecked
    ? new Date(Math.max(lastChecked.getTime() - BUFFER_MS, fallbackBounce.getTime()))
    : fallbackBounce;
  const replySince = lastChecked
    ? new Date(Math.max(lastChecked.getTime() - BUFFER_MS, fallbackReply.getTime()))
    : fallbackReply;

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: mailer.senderConfig.email, pass: mailer.senderAppPassword },
    logger: false,
  });

  let scanned = 0;
  const bounced = [];
  const replied = [];

  const sentContacts = await Contact.find({ status: 'sent' });
  const byEmail = new Map();
  const byMessageId = new Map();
  for (const c of sentContacts) {
    byEmail.set(c.email.toLowerCase(), c);
    if (c.messageId) byMessageId.set(c.messageId.replace(/^<|>$/g, ''), c);
  }

  const scanMailbox = async (mailbox) => {
    let lock;
    try {
      lock = await client.getMailboxLock(mailbox);
    } catch (err) {
      return;
    }
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
        if (!msg || !msg.source) continue;
        const raw = msg.source.toString('utf8');
        const hits = parseBounces(raw);

        if (hits.length > 0) {
          for (const { email, reason } of hits) {
            const existing = await Contact.findOne({ email: new RegExp(`^${escapeRegExp(email)}$`, 'i') });
            if (!existing) continue;

            if (existing.status !== 'bounced') {
              existing.status = 'bounced';
              existing.bounceReason = reason;
              await existing.save();
              bounced.push({ email: existing.email, name: existing.name, reason });
            } else if (reason !== existing.bounceReason && reason.length > (existing.bounceReason || '').length) {
              existing.bounceReason = reason;
              await existing.save();
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
    try { await client.logout(); } catch (_) { /* ignore */ }
  }

  settings.lastMailboxCheckAt = new Date();
  await settings.save();

  res.json({ ok: true, scanned, bounced, replied, lastCheckedAt: settings.lastMailboxCheckAt });
});

// ── Status ──────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ configured: !!mailer.transporter, email: mailer.senderConfig.email, name: mailer.senderConfig.name });
});

const PORT = process.env.PORT || 3000;

db.connect()
  .catch(err => console.error('❌  MongoDB connection error:', err.message))
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`\n✅  Outreach server running at http://localhost:${PORT}`);
      console.log(`   Open http://localhost:${PORT} in your browser\n`);
    });
  });
