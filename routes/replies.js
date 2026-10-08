// Answering a conversation from the Mailbox: an AI first draft you edit, then a send that
// goes out from your Gmail as a real reply in the same thread.
//
// The send is threaded (In-Reply-To / References onto their latest message, "Re:" subject),
// so Gmail files it inside the conversation and the recipient sees one thread. It's
// recorded in the contact's thread at once and moves the queue item to Waiting on them —
// the later Sent-folder scan recognises the message id and skips it.
const express = require('express');
const Contact = require('../models/Contact');
const Settings = require('../models/Settings');
const mailer = require('../lib/mailer');
const actionQueue = require('../lib/actionQueue');
const { draftReply } = require('../lib/replyDraft');
const { normalizeBody } = require('../lib/classify/text');
const { logEvent } = require('../lib/activityLog');

const router = express.Router();

const MAX_NOTE = 1_000;
const MAX_BODY = 10_000;

const clean = (id) => (id || '').replace(/^<|>$/g, '');
const bracket = (id) => `<${clean(id)}>`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const latestInbound = (contact) => [...(contact.thread || [])]
  .filter(t => t.direction === 'inbound')
  .sort((a, b) => new Date(b.at) - new Date(a.at))[0] || null;

const replySubject = (contact, inbound) => {
  const base = (inbound?.subject || contact.sentSubject || '').trim();
  if (!base) return 'Re: our conversation';
  return /^re\s*:/i.test(base) ? base : `Re: ${base}`;
};

const loadContact = (req) => Contact.findOne({ _id: req.params.id, userId: req.userId, deleted: { $ne: true } });

// POST /api/replies/:id/draft {note?, attachResume?} → {body, provider, attachResume, hasResume}
router.post('/:id/draft', async (req, res) => {
  try {
    const contact = await loadContact(req);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const settings = await Settings.findOne({ userId: req.userId }, { senderName: 1, replyProfile: 1, 'resume.filename': 1 }).lean();
    const hasResume = !!settings?.resume?.filename;
    // Asked for a resume → attach it, unless you've said otherwise for this draft.
    const attachResume = hasResume && ('attachResume' in (req.body || {})
      ? !!req.body.attachResume
      : contact.replyCategory === 'resume-requested');

    const out = await draftReply({
      contact,
      senderName: settings?.senderName || '',
      profile: settings?.replyProfile || '',
      note: String(req.body?.note || '').slice(0, MAX_NOTE),
      attachResume,
      userId: req.userId,
    });
    if (!out.ok) return res.status(502).json({ error: out.error });

    logEvent({ userId: req.userId, category: 'email', action: 'reply_drafted', message: `Drafted a reply to ${contact.name} with ${out.provider}`, meta: { contactId: String(contact._id), provider: out.provider } })
      .catch(err => console.error('Activity log write failed:', err.message));
    res.json({ body: out.body, provider: out.provider, attachResume, hasResume });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/replies/:id/send {body, attachResume} → the updated contact
router.post('/:id/send', async (req, res) => {
  try {
    const body = String(req.body?.body || '').trim();
    if (!body) return res.status(400).json({ error: 'The reply is empty.' });
    if (body.length > MAX_BODY) return res.status(400).json({ error: 'The reply is too long.' });
    if (/\[[^\]\n]{2,40}\]/.test(body) && !req.body?.allowPlaceholders) {
      return res.status(400).json({ error: 'The reply still has a [placeholder] to fill in.', code: 'placeholders' });
    }

    const contact = await loadContact(req);
    if (!contact) return res.status(404).json({ error: 'Contact not found' });
    const inbound = latestInbound(contact);
    if (!inbound) return res.status(400).json({ error: 'There is no reply from them to answer.' });

    const sender = await mailer.getTransporterFor(req.userId);
    if (!sender) return res.status(400).json({ error: 'Gmail is not set up. Add your Gmail and App Password in Settings.' });
    const attachments = await mailer.getResumeAttachment(!!req.body?.attachResume, req.userId);
    if (req.body?.attachResume && !attachments) return res.status(400).json({ error: 'No resume is uploaded. Add one in Settings, or untick "Attach resume".' });

    // Every message id in the conversation, oldest first — Gmail and other clients thread on
    // References, and In-Reply-To names the message this answers.
    const refs = [...(contact.thread || [])]
      .sort((a, b) => new Date(a.at) - new Date(b.at))
      .map(t => t.messageId).filter(Boolean).map(bracket);
    const inReplyTo = inbound.messageId ? bracket(inbound.messageId) : undefined;

    // Quote their message underneath, the way a mail client does when you press Reply.
    const theirs = normalizeBody(inbound.text || '');
    const quoteHead = `On ${new Date(inbound.at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Kolkata' })}, ${contact.name} <${contact.email}> wrote:`;
    const text = theirs ? `${body}\n\n${quoteHead}\n${theirs.split('\n').map(l => `> ${l}`).join('\n')}` : body;
    const html = `<div>${esc(body).replace(/\n/g, '<br>')}</div>`
      + (theirs ? `<br><div>${esc(quoteHead)}</div><blockquote style="margin:0 0 0 .8ex;border-left:1px solid #ccc;padding-left:1ex">${esc(theirs).replace(/\n/g, '<br>')}</blockquote>` : '');

    const subject = replySubject(contact, inbound);
    const info = await sender.transporter.sendMail({
      from: `"${sender.name}" <${sender.email}>`,
      to: contact.email,
      subject,
      text,
      html,
      ...(inReplyTo ? { inReplyTo } : {}),
      ...(refs.length ? { references: refs } : {}),
      ...(attachments ? { attachments } : {}),
    });

    const sentAt = new Date();
    const moved = actionQueue.onOutbound(contact.action, sentAt, contact.lastInboundAt || inbound.at);
    const updated = await Contact.findOneAndUpdate({ _id: contact._id, userId: req.userId }, {
      $set: {
        lastOutboundAt: sentAt,
        replyRead: true,
        ...(moved ? { action: moved } : {}),
      },
      $push: {
        thread: {
          direction: 'outbound', subject, text: body, html: esc(body).replace(/\n/g, '<br>'),
          messageId: clean(info.messageId) || null, inReplyTo: inbound.messageId ? clean(inbound.messageId) : null, at: sentAt,
        },
      },
    }, { returnDocument: 'after' });

    logEvent({ userId: req.userId, category: 'email', action: 'reply_sent', message: `Replied to ${contact.name} from the Mailbox`, meta: { contactId: String(contact._id), attachedResume: !!attachments } })
      .catch(err => console.error('Activity log write failed:', err.message));
    res.json(updated.toJSON());
  } catch (err) {
    res.status(500).json({ error: `Could not send: ${err.message}` });
  }
});

module.exports = router;
