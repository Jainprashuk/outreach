require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const cors = require('cors');
const db = require('./db');
const Settings = require('./models/Settings');

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
    res.json({ ok: true, message: `Connected as ${email}` });
  });
});

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
