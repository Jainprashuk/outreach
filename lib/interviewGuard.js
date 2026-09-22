// Send-time guard: once a person has been moved into the Interviews section you
// are in an actual conversation with them, so cold outreach must stop. The
// Interview record never writes back to the Contact (see models/Interview.js),
// which is exactly why this has to be checked at send time rather than relying
// on the contact's own status.
//
// Deliberately covers every non-deleted interview, including `selected` and
// `rejected`: the record being present in the section IS the signal. To put
// someone back into outreach, delete their interview row.

const Interview = require('../models/Interview');

const INTERVIEW_ERROR = 'Skipped — this contact is in your interview pipeline.';

const norm = (email) => (email || '').trim().toLowerCase();

/**
 * Loads one user's interview pipeline as two Sets, for cheap repeated lookups
 * within a single job run.
 *
 * Matches on BOTH the source contact id and the email address: an interview can
 * be created straight from a contact (sourceId), from a lead, or by hand after a
 * phone call — and in the last two cases the only thing tying it back to a
 * contact is the address.
 */
async function loadInterviewSets(userId) {
  const rows = await Interview.find(
    { userId, deleted: { $ne: true } },
    { sourceType: 1, sourceId: 1, email: 1 }
  ).lean();

  const contactIds = new Set();
  const emails = new Set();
  for (const r of rows) {
    if (r.sourceType === 'contact' && r.sourceId) contactIds.add(String(r.sourceId));
    if (r.email) emails.add(norm(r.email));
  }
  return { contactIds, emails };
}

/** True if this contact (by id or address) already sits in the interview pipeline. */
function isInInterview({ id, email }, { contactIds, emails }) {
  if (id && contactIds.has(String(id))) return true;
  const addr = norm(email);
  return !!addr && emails.has(addr);
}

/**
 * Pull someone out of everything already queued for them, the moment they're
 * moved into Interviews.
 *
 * The send-time guard alone would be enough to stop the mail going out, but it
 * would leave the person sitting in an in-flight job and reserved by a running
 * campaign — the queue counts would lie and the campaign would rediscover the
 * row on every run. So:
 *   - pending SendJob items become `skipped`,
 *   - pending/queued CampaignRows become `skipped` with reason 'in_interview',
 *   - a contact still parked at `in-campaign` by such a row gets its real
 *     status back.
 *
 * Deliberately touches only the outreach queue, never the Contact's own
 * outreach history — the Interview record stays a one-way link (see
 * models/Interview.js).
 */
async function withdrawFromOutreach(userId, { contactId, email }) {
  const SendJob = require('../models/SendJob');
  const CampaignRow = require('../models/CampaignRow');
  const Contact = require('../models/Contact');

  const id = contactId ? String(contactId) : null;
  const addr = norm(email);
  if (!id && !addr) return { jobItems: 0, campaignRows: 0 };

  // Same person expressed two ways, because an interview may be linked by id
  // (moved from Contacts) or only by address (moved from a Lead, or manual).
  const itemMatch = [];
  if (id) itemMatch.push({ contactId: id });
  if (addr) itemMatch.push({ to: addr });
  const itemFilter = [];
  if (id) itemFilter.push({ 'it.contactId': id });
  if (addr) itemFilter.push({ 'it.to': addr });

  // Live jobs only — a done/cancelled job's items are history.
  const jobs = await SendJob.updateMany(
    {
      userId,
      status: { $in: ['pending', 'processing', 'paused'] },
      items: { $elemMatch: { status: 'pending', $or: itemMatch } },
    },
    {
      $set: {
        'items.$[it].status': 'skipped',
        'items.$[it].error': INTERVIEW_ERROR,
        'items.$[it].processedAt': new Date(),
      },
    },
    { arrayFilters: [{ $and: [{ 'it.status': 'pending' }, { $or: itemFilter }] }] }
  );

  const rowMatch = [];
  if (id) rowMatch.push({ sourceContactId: id });
  if (addr) rowMatch.push({ email: addr });
  const rows = await CampaignRow.find(
    { userId, status: { $in: ['pending', 'queued'] }, $or: rowMatch },
    { _id: 1, sourceContactId: 1, sourceContactStatusBefore: 1 }
  ).lean();

  if (rows.length) {
    await CampaignRow.updateMany(
      { _id: { $in: rows.map(r => r._id) }, userId },
      { $set: { status: 'skipped', skipReason: 'in_interview' } }
    );
    const ops = rows.filter(r => r.sourceContactId).map(r => {
      const status = r.sourceContactStatusBefore || 'queued';
      return {
        updateOne: {
          filter: { _id: r.sourceContactId, userId, status: 'in-campaign', deleted: { $ne: true } },
          update: {
            $set: { status },
            $push: { statusHistory: { status, changedAt: new Date(), note: 'Released from campaign — moved to interviews' } },
          },
        },
      };
    });
    if (ops.length) await Contact.bulkWrite(ops, { ordered: false });
  }

  return { jobItems: jobs.modifiedCount || 0, campaignRows: rows.length };
}

module.exports = { INTERVIEW_ERROR, loadInterviewSets, isInInterview, withdrawFromOutreach };
