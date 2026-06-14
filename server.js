require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
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

// Builds a short preview of a reply's body, stopping at the first quoted-reply
// marker (">" lines, "On ... wrote:", or "--- Original Message ---").
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

// Checks whether a raw message is a reply to one of our outreach emails, and if
// so marks the matching contact as 'replied'. Two matching strategies:
//  - Strong: the message's In-Reply-To/References references a Message-ID we
//    stored when sending (works for emails sent after this feature shipped).
//  - Fallback heuristic: From == contact's email, Subject starts with "Re:",
//    and the message arrived after we sent to them (for older sends with no
//    stored Message-ID).
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
    // Match plain replies ("Re: ...") as well as common auto-responder
    // prefixes (Outlook/Exchange "Automatic reply:", "Out of Office:", etc.)
    // — these often carry useful info (e.g. "no longer employed, contact X").
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
    const info = await transporter.sendMail({
      from: `"${senderConfig.name}" <${senderConfig.email}>`,
      to,
      subject,
      text: body,
      ...(attachments ? { attachments } : {}),
    });
    res.json({ ok: true, messageId: info.messageId || null });
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

// ── Check mailbox for bounces & replies ────────────────────────────────────
// Scans the sender's Gmail INBOX + Spam via IMAP for delivery-failure (NDR)
// messages (marking contacts 'bounced') and for replies to outreach emails
// (marking contacts 'replied').
const BOUNCE_LOOKBACK_DAYS = 7;
const REPLY_LOOKBACK_DAYS = 30;

app.post('/api/check-mailbox', requireDb, async (req, res) => {
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
  const replied = [];
  const bounceSince = new Date(Date.now() - BOUNCE_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const replySince = new Date(Date.now() - REPLY_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);

  // Candidate contacts for reply-matching: only contacts we've sent to and
  // haven't already heard back from (or had bounce) are still "awaiting reply".
  const sentContacts = await Contact.find({ status: 'sent' });
  const byEmail = new Map();
  const byMessageId = new Map();
  for (const c of sentContacts) {
    byEmail.set(c.email.toLowerCase(), c);
    if (c.messageId) byMessageId.set(c.messageId.replace(/^<|>$/g, ''), c);
  }

  // Scans a single mailbox for NDR messages and replies, updating
  // `scanned`/`bounced`/`replied`. Skips silently if the mailbox can't be
  // opened (e.g. doesn't exist).
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
              // Reprocessing the same bounce message with an improved parser can
              // recover a more complete reason than what was stored previously.
              existing.bounceReason = reason;
              await existing.save();
            }
          }
          continue; // a DSN is never also a human reply
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

  res.json({ ok: true, scanned, bounced, replied });
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
