require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const cors = require('cors');
const db = require('./db');
const Settings = require('./models/Settings');
const Contact = require('./models/Contact');

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

// ── Sender state ────────────────────────────────────────────────────────────
let transporter = null;
let senderConfig = { email: '', name: 'Prashuk Jain' };
let senderAppPassword = ''; // retained in memory only, for IMAP bounce checks

const buildTransporter = (email, appPassword) =>
  nodemailer.createTransport({
    service: 'gmail',
    auth: { user: email, pass: appPassword }
  });

// Optional: pre-configure from .env so /api/config can be skipped
if (process.env.GMAIL_EMAIL && process.env.GMAIL_APP_PASSWORD) {
  transporter = buildTransporter(process.env.GMAIL_EMAIL, process.env.GMAIL_APP_PASSWORD);
  senderConfig = {
    email: process.env.GMAIL_EMAIL,
    name: process.env.SENDER_NAME || 'Prashuk Jain'
  };
  senderAppPassword = process.env.GMAIL_APP_PASSWORD;
}

// ── Configure Gmail credentials ────────────────────────────────────────────
app.post('/api/config', (req, res) => {
  const { email, appPassword, name } = req.body;
  if (!email || !appPassword) return res.status(400).json({ error: 'email and appPassword required' });

  const candidate = buildTransporter(email, appPassword);

  candidate.verify((err) => {
    if (err) {
      return res.status(400).json({ error: 'Could not connect. Check email/app password.', detail: err.message });
    }
    transporter = candidate;
    senderConfig = { email, name: name || 'Prashuk Jain' };
    senderAppPassword = appPassword;
    res.json({ ok: true, message: `Connected as ${email}` });
  });
});

// Escapes a string for safe use inside a RegExp.
const escapeRegExp = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Parses a raw RFC822 bounce/NDR message source for failed recipients + reasons.
// Primary: machine-readable DSN fields (Final-Recipient / Diagnostic-Code / Status).
// Fallback: Gmail's human-readable "wasn't delivered to ... because ..." text.
const parseBounces = (raw) => {
  const hits = [];
  const finalRecipientRe = /Final-Recipient:\s*rfc822;\s*<?([^\s>]+)>?/gi;
  let match;
  while ((match = finalRecipientRe.exec(raw)) !== null) {
    const email = match[1].toLowerCase();
    const tail = raw.slice(match.index, match.index + 1000);
    // Diagnostic-Code can be folded across multiple header-continuation lines
    // (lines starting with whitespace) — capture and join them all.
    const diagnostic = tail.match(/Diagnostic-Code:\s*(?:smtp|x-[\w-]+);\s*([^\r\n]+(?:\r?\n[ \t]+[^\r\n]+)*)/i);
    const status = tail.match(/Status:\s*([\d.]+)/i);
    // Some MTAs (e.g. Gmail's own NoSuchUser message) repeat the SMTP code
    // ("550-5.1.1", "550 5.1.1") at the start of each continuation-line —
    // strip those (only on continuation lines, since enhanced status code
    // subcodes can be multi-digit, e.g. "554 5.4.14") before joining.
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

// Builds a nodemailer attachment for the stored resume, if requested and present.
const getResumeAttachment = async (attachResume) => {
  if (!attachResume) return undefined;
  const settings = await Settings.getSingleton();
  if (!settings.resume) return undefined;
  return [{
    filename: settings.resume.filename,
    content: settings.resume.data,
    contentType: settings.resume.contentType,
  }];
};

// ── Send single email ──────────────────────────────────────────────────────
app.post('/api/send', async (req, res) => {
  if (!transporter) return res.status(400).json({ error: 'Not configured. Set up Gmail first.' });

  const { to, subject, body, attachResume } = req.body;
  if (!to || !subject || !body) return res.status(400).json({ error: 'to, subject, body are required' });

  try {
    const attachments = await getResumeAttachment(attachResume);
    await transporter.sendMail({
      from: `"${senderConfig.name}" <${senderConfig.email}>`,
      to,
      subject,
      text: body,
      ...(attachments ? { attachments } : {}),
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Bulk send with delay ───────────────────────────────────────────────────
// Accepts array of { to, subject, body, name }
// Sends one every `delayMs` ms, returns a results array when complete
app.post('/api/bulk-send', async (req, res) => {
  if (!transporter) return res.status(400).json({ error: 'Not configured. Set up Gmail first.' });

  const { contacts, delayMs = 8000, attachResume } = req.body; // default 8s between emails
  if (!contacts || !contacts.length) return res.status(400).json({ error: 'No contacts provided' });

  const results = [];
  const attachments = await getResumeAttachment(attachResume);

  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i];
    try {
      await transporter.sendMail({
        from: `"${senderConfig.name}" <${senderConfig.email}>`,
        to: c.to,
        subject: c.subject,
        text: c.body,
        ...(attachments ? { attachments } : {}),
      });
      results.push({ name: c.name, to: c.to, status: 'sent' });
    } catch (err) {
      results.push({ name: c.name, to: c.to, status: 'failed', error: err.message });
    }

    // delay between sends (skip delay after last one)
    if (i < contacts.length - 1) {
      await new Promise(r => setTimeout(r, delayMs));
    }
  }

  res.json({ ok: true, results });
});

// ── Check for bounces ───────────────────────────────────────────────────────
// Scans the sender's Gmail inbox via IMAP for delivery-failure (NDR) messages
// from the last BOUNCE_LOOKBACK_DAYS, and marks matching contacts as 'bounced'.
const BOUNCE_LOOKBACK_DAYS = 7;

app.post('/api/check-bounces', requireDb, async (req, res) => {
  if (!senderConfig.email || !senderAppPassword) {
    return res.status(400).json({ error: 'Not configured. Set up Gmail first.' });
  }

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: senderConfig.email, pass: senderAppPassword },
    logger: false,
  });

  let scanned = 0;
  const bounced = [];
  const since = new Date(Date.now() - BOUNCE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // Scans a single mailbox for NDR messages, updating `scanned`/`bounced`.
  // Skips silently if the mailbox can't be opened (e.g. doesn't exist).
  const scanMailbox = async (mailbox) => {
    let lock;
    try {
      lock = await client.getMailboxLock(mailbox);
    } catch (err) {
      return;
    }
    try {
      // Union of several search strategies: Gmail's HEADER search for
      // "multipart/report" misses some genuine DSNs (e.g. Office 365/Exchange
      // bounces forwarded via postmaster@<recipient-domain>), so also catch
      // messages from mailer-daemon (Gmail's own NDRs) or any postmaster@.
      const [reportUids, daemonUids, postmasterUids] = await Promise.all([
        client.search({ since, header: { 'content-type': 'multipart/report' } }, { uid: true }),
        client.search({ since, from: 'mailer-daemon' }, { uid: true }),
        client.search({ since, from: 'postmaster' }, { uid: true }),
      ]);
      const uids = [...new Set([...reportUids, ...daemonUids, ...postmasterUids])];
      scanned += uids.length;

      for (const uid of uids) {
        const msg = await client.fetchOne(uid, { source: true }, { uid: true });
        if (!msg || !msg.source) continue;
        const hits = parseBounces(msg.source.toString('utf8'));

        for (const { email, reason } of hits) {
          const existing = await Contact.findOne({ email: new RegExp(`^${escapeRegExp(email)}$`, 'i') });
          if (!existing) continue;

          if (existing.status !== 'bounced') {
            existing.status = 'bounced';
            existing.bounceReason = reason;
            await existing.save();
            bounced.push({ email: existing.email, name: existing.name, reason });
          } else if (reason !== existing.bounceReason && reason.length > (existing.bounceReason || '').length) {
            // Reprocessing the same bounce message with an improved parser can
            // recover a more complete reason than what was stored previously.
            existing.bounceReason = reason;
            await existing.save();
          }
        }
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

  res.json({ ok: true, scanned, bounced });
});

// ── Status ──────────────────────────────────────────────────────────────────
app.get('/api/status', (req, res) => {
  res.json({ configured: !!transporter, email: senderConfig.email, name: senderConfig.name });
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
