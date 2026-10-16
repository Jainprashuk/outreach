/**
 * The scheduled mailbox check, on Inngest rather than GitHub Actions. GitHub ran
 * the 5-minute workflow about 6 times a day, and each run could only scan one
 * account inside Vercel's 60s (a scan takes up to ~50s). Here a sweep every 2
 * hours fans out ONE event per account, and each account is scanned in its own
 * function run, with its own 60s.
 *
 * The 2-hour cadence is a Vercel CPU budget choice (Hobby plan). The Dashboard
 * still checks on its own while it is open, exactly as before.
 *
 * checkMailboxForUser lives in server.js, which requires this file, so it is
 * handed in rather than required.
 */
const mongoose = require('mongoose');
const { inngest } = require('../../inngest');
const db = require('../../db');
const User = require('../../models/User');
const Settings = require('../../models/Settings');
const SendJob = require('../../models/SendJob');
const { recordBeat } = require('../cronBeat');

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Nobody has sent anything for this long: their mailbox only needs a look every
// IDLE_EVERY_MS, still more often than the ~6 a day GitHub managed.
const ACTIVE_WINDOW_MS = 30 * DAY;
const IDLE_EVERY_MS = 6 * HOUR;
// Unchecked for this long (or never), a scan has a wide window and can run past
// 60s (97s measured on a long-idle account), so it runs as three calls instead of
// one. Above IDLE_EVERY_MS, so an idle account on schedule still takes one call.
const PHASED_AFTER_MS = 12 * HOUR;

const ensureDb = async () => {
  if (mongoose.connection.readyState !== 1) await db.connect();
};

// Step results are stored by Inngest. Keep only what notifyMailboxScan reads
// (lib/mailboxNotifications.js), and the address only when there is no name.
const slimReply = (r) => ({
  name: r.name || '', ...(r.name ? {} : { email: r.email || '' }), company: r.company || '',
  contactId: r.contactId, messageId: r.messageId || null, repliedAt: r.repliedAt,
  needsYou: !!r.needsYou, unsubscribed: !!r.unsubscribed, snippet: r.snippet || '',
});
const counts = (r) => ({
  ok: r.ok !== false, skipped: r.skipped || null, scanned: Number(r.scanned) || 0,
  replied: (r.replied || []).length, bounced: (r.bounced || []).length,
});

/** Accounts whose mailbox is due now, oldest check first. */
async function dueAccounts(now = Date.now()) {
  const users = await User.find({}, { _id: 1 }).lean();
  const settings = await Settings.find({}, { userId: 1, gmailEmail: 1, gmailAppPasswordEnc: 1, lastMailboxCheckAt: 1 }).lean();
  const byUser = new Map(settings.map(s => [String(s.userId), s]));
  // The sole-account install may keep its Gmail login in env (lib/mailer.js).
  const sole = users.length === 1;
  const active = new Set((await SendJob.distinct('userId', { updatedAt: { $gte: new Date(now - ACTIVE_WINDOW_MS) } })).map(String));

  const due = [];
  let idle = 0;
  for (const u of users) {
    const s = byUser.get(String(u._id));
    if (!sole && !s?.gmailAppPasswordEnc) continue;
    const last = s?.lastMailboxCheckAt ? new Date(s.lastMailboxCheckAt).getTime() : 0;
    if (!active.has(String(u._id)) && now - last < IDLE_EVERY_MS) { idle++; continue; }
    due.push({ userId: String(u._id), last, phased: now - last > PHASED_AFTER_MS });
  }
  due.sort((a, b) => a.last - b.last);
  return { due, idle, users: users.length };
}

function createMailboxFunctions({ checkMailboxForUser }) {
  const mailboxSweep = inngest.createFunction(
    { id: 'mailbox-sweep', triggers: [{ cron: 'TZ=Asia/Kolkata 0 */2 * * *' }] },
    async ({ step }) => {
      const found = await step.run('find-due', async () => {
        await ensureDb();
        const started = Date.now();
        const { due, idle, users } = await dueAccounts();
        const events = due.map(d => ({ name: 'mailbox/check.user', data: { userId: d.userId, phased: d.phased } }));
        await recordBeat('inngest:mailbox-sweep', {
          status: 200, ms: Date.now() - started,
          body: { users, queued: events.length, phased: due.filter(d => d.phased).length, idle },
        });
        return { events };
      });
      if (found.events.length) await step.sendEvent('fan-out', found.events);
      return { queued: found.events.length };
    },
  );

  const mailboxCheckUser = inngest.createFunction(
    {
      id: 'mailbox-check-user',
      // One scan of a mailbox at a time, and at most two mailboxes at once.
      concurrency: [{ key: 'event.data.userId', limit: 1 }, { limit: 2 }],
      retries: 2,
      triggers: [{ event: 'mailbox/check.user' }],
    },
    async ({ event, step }) => {
      const { userId, phased } = event.data;
      const run = async (opts) => {
        await ensureDb();
        return checkMailboxForUser(userId, opts);
      };

      // Usual case: one call. If the Dashboard is mid-scan of the same mailbox,
      // that scan covers it, notifications included, so skipping is right.
      if (!phased) return step.run('scan', async () => counts(await run()));

      // A phase that meets another scan's lease throws, so Inngest retries it a
      // little later: stopping between phases would stamp nothing and could drop
      // the notifications for replies the first phase already captured.
      const phase = async (opts) => {
        const r = await run(opts);
        if (r.skipped === 'already_running') throw new Error('Mailbox is being scanned by another check; retrying');
        return r;
      };
      const inbox = await step.run('inbox', async () => {
        const r = await phase({ phase: 'inbox' });
        if (r.skipped) return { skipped: r.skipped };
        return { scanned: r.scanned, startedAt: r.startedAt, replied: r.replied.map(slimReply), bounced: r.bounced.map(b => ({ name: b.name || '' })) };
      });
      if (inbox.skipped) return { ok: false, skipped: inbox.skipped };
      const sent = await step.run('sent', async () => counts(await phase({ phase: 'sent' })));
      return step.run('finalize', async () => counts(await phase({
        phase: 'finalize',
        carry: { ...inbox, scanned: inbox.scanned + sent.scanned },
      })));
    },
  );

  return { mailboxSweep, mailboxCheckUser };
}

module.exports = { createMailboxFunctions, dueAccounts };
