#!/usr/bin/env node
/**
 * Tests that an address which already bounced is never emailed again
 * (lib/deadAddress.js) — at campaign release (scanForBatch) and at send time
 * (sendSingleEmail) — against the DEV database, with SMTP stubbed.
 *
 * Everything is written under a throwaway userId and deleted at the end.
 *
 *   node scripts/test-dead-address.js
 */
if (process.env.NODE_ENV === 'prod') { console.error('Refusing to run against prod.'); process.exit(1); }
require('dotenv').config();
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');
const { inngest } = require('../inngest');

const mailed = [];
nodemailer.createTransport = () => ({ sendMail: async (m) => { mailed.push(m.to); return { messageId: '<t@test>' }; }, close() {} });
inngest.send = async () => {};
const step = { run: (_id, cb) => cb(), sendEvent: async () => {} };

const db = require('../db');
const SendJob = require('../models/SendJob');
const Contact = require('../models/Contact');
const CampaignRow = require('../models/CampaignRow');
const { isDeadAddress, lastRealStatus } = require('../lib/deadAddress');
const { scanForBatch } = require('../lib/campaignRunner');
const { sendSingleEmail } = require('../inngest-fns');

let pass = 0, fail = 0;
const check = (cond, msg) => { cond ? (pass++, console.log(`  ok   ${msg}`)) : (fail++, console.log(`  FAIL ${msg}`)); };

const userId = new mongoose.Types.ObjectId();
const campaignId = new mongoose.Types.ObjectId();
const h = (...statuses) => statuses.map(status => ({ status, changedAt: new Date(), note: '' }));
const ago = (days) => new Date(Date.now() - days * 864e5);
const WHATFIX = '550-5.7.1 The concerned person may no longer be a part of Whatfix.';
const GMAIL_SPAM = 'Message rejected. For more information, go to https://support.google.com/mail/answer/69585';

async function main() {
  await db.connect();

  console.log('\nThe rule:');
  check(isDeadAddress({ status: 'bounced', bounceReason: WHATFIX }), 'a bounced contact is dead');
  check(isDeadAddress({ status: 'in-campaign', bounceReason: WHATFIX, statusHistory: h('sent', 'bounced', 'in-campaign') }), 'still dead once a campaign reserves it (the Romita case)');
  check(isDeadAddress({ status: 'queued', statusHistory: h('sent', 'bounced', 'queued') }), 'still dead after "Reset for sending"');
  check(isDeadAddress({ status: 'blocked' }), 'a blocklisted contact is dead');
  check(!isDeadAddress({ status: 'bounced', bounceReason: GMAIL_SPAM }), 'Gmail refusing to send from YOUR account (69585) is not a dead address');
  check(!isDeadAddress({ status: 'in-campaign', statusHistory: h('sent', 'in-campaign') }), 'a delivered contact is not dead');
  check(!isDeadAddress({ status: 'replied', statusHistory: h('sent', 'bounced', 'replied') }), 'a later real status (they replied) wins over an old bounce');
  check(!isDeadAddress({ status: 'queued', statusHistory: h('queued') }), 'a brand-new contact is not dead');
  check(lastRealStatus({ status: 'in-campaign', statusHistory: h('sent', 'bounced', 'in-campaign') }) === 'bounced', 'lastRealStatus looks past the reservation');

  console.log('\nCampaign release skips it:');
  const [dead, alive, spamBlocked] = await Contact.insertMany([
    { userId, email: `dead-${Date.now()}@example.com`, name: 'Dead', status: 'in-campaign', lastSentAt: ago(2), bounceReason: WHATFIX, statusHistory: h('sent', 'bounced', 'in-campaign') },
    { userId, email: `alive-${Date.now()}@example.com`, name: 'Alive', status: 'in-campaign', lastSentAt: ago(2), statusHistory: h('sent', 'in-campaign') },
    { userId, email: `refused-${Date.now()}@example.com`, name: 'Refused', status: 'in-campaign', lastSentAt: ago(2), bounceReason: GMAIL_SPAM, statusHistory: h('sent', 'bounced', 'in-campaign') },
  ]);
  await CampaignRow.insertMany([dead, alive, spamBlocked].map((c, i) => ({
    userId, campaignId, rowIndex: i, sourceRow: i + 1, sourceContactId: String(c._id), name: c.name, email: c.email,
    sourceContactStatusBefore: i === 1 ? 'sent' : 'bounced', status: 'pending',
  })));
  const scan = await scanForBatch(campaignId, 10, null, userId);
  const chosen = scan.chosen.map(r => r.email);
  check(!chosen.includes(dead.email), 'the bounced contact is not released');
  check(scan.skips.some(s => s.row.email === dead.email && s.reason === 'bounced'), 'it is skipped with reason "bounced"');
  check(chosen.includes(alive.email), 'the delivered contact is released');
  check(chosen.includes(spamBlocked.email), 'the Gmail-refused (69585) contact is still released');

  console.log('\nSend time skips it too (safety net):');
  const queuedDead = await Contact.create({ userId, email: `dead2-${Date.now()}@example.com`, name: 'Dead2', status: 'queued', lastSentAt: ago(2), bounceReason: WHATFIX, statusHistory: h('sent', 'bounced', 'queued') });
  const job = await SendJob.create({
    userId, senderEmail: 'dead-test@example.com', senderName: 'T', senderAppPassword: 'x', status: 'processing', sendMode: 'drip',
    items: [{ contactId: String(queuedDead._id), to: queuedDead.email, name: 'Dead2', subject: 's', body: 'b' }],
  });
  await sendSingleEmail.fn({ event: { data: { jobId: String(job._id), contactId: String(queuedDead._id) } }, step });
  const j = await SendJob.findById(job._id).lean();
  check(j.items[0].status === 'skipped' && /bounced before/.test(j.items[0].error), 'the send is skipped, not sent');
  check(!mailed.includes(queuedDead.email), 'nothing reached SMTP');
  const after = await Contact.findById(queuedDead._id).lean();
  check(after.status === 'bounced', 'the contact goes back to "bounced" instead of staying "queued"');
  check(j.status === 'done', 'the job still completes');
}

main()
  .catch(e => { fail++; console.error(e); })
  .finally(async () => {
    try {
      await Promise.all([
        SendJob.deleteMany({ userId }), Contact.deleteMany({ userId }), CampaignRow.deleteMany({ userId }),
        mongoose.connection.db.collection('activitylogs').deleteMany({ userId }),
        mongoose.connection.db.collection('issues').deleteMany({ userId }),
      ]);
    } catch (e) { console.error('cleanup failed:', e.message); }
    console.log(`\n${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  });
