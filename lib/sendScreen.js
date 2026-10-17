// Which contacts may be emailed right now, and why each of the others may not.
//
// One rule set for every place that sends to (or counts) existing contacts:
// POST /api/campaigns/from-contacts and its dryRun preview, and the Action
// Center's buttons (routes/actionCenter.js) — so a button never offers a contact
// the send would then refuse.

const mongoose = require('mongoose');
const Contact = require('../models/Contact');
const { EMAIL_RE } = require('./campaignRunner');
const { inCooldown } = require('./cooldown');
const { isDeadAddress } = require('./deadAddress');
const { loadInterviewSets, isInInterview } = require('./interviewGuard');
const { hasUnansweredReply } = require('./actionQueue');

// Every field the rules below (and a campaign row) read.
const SCREEN_FIELDS = 'name email company role status lastSentAt lastOutboundAt repliedAt bounceReason statusHistory.status';

const normEmail = (e) => String(e || '').trim().toLowerCase();
const emptySkips = () => ({ missing: 0, in_campaign: 0, invalid: 0, cooldown: 0, dead: 0, interview: 0, replied: 0 });

/** Splits already-loaded contacts (with SCREEN_FIELDS) into sendable and skip counts. */
async function screenDocs(userId, candidates, interviewSets) {
  const skipped = emptySkips();
  // Contacts already in the interview pipeline are never emailed from here.
  const sets = interviewSets || await loadInterviewSets(userId);
  const contacts = [];
  for (const c of candidates) {
    if (c.status === 'in-campaign') skipped.in_campaign++;
    // A contact whose email is not an address would be reserved and then fail at
    // send time with "No recipients defined" — leave it out instead.
    else if (!EMAIL_RE.test(normEmail(c.email))) skipped.invalid++;
    else if (inCooldown(c)) skipped.cooldown++;
    // An address that already bounced would only bounce again — and each bounce
    // costs the sending account reputation.
    else if (isDeadAddress(c)) skipped.dead++;
    else if (isInInterview({ id: c._id, email: c.email }, sets)) skipped.interview++;
    // They wrote back and you haven't answered: an email now would talk over
    // them. The send worker skips these too; leaving them out keeps counts honest.
    else if (hasUnansweredReply(c)) skipped.replied++;
    else contacts.push(c);
  }
  return { contacts, skipped };
}

/** The same, for a list of contact ids (unknown or deleted ones count as missing). */
async function screenContacts(userId, rawIds) {
  const ids = [...new Set(Array.isArray(rawIds) ? rawIds.filter(mongoose.isValidObjectId).map(String) : [])];
  if (!ids.length) return { requested: 0, eligible: 0, skipped: emptySkips(), contacts: [] };
  const candidates = await Contact.find({ _id: { $in: ids }, userId, deleted: { $ne: true } }).select(SCREEN_FIELDS).lean();
  const { contacts, skipped } = await screenDocs(userId, candidates);
  skipped.missing = ids.length - candidates.length;
  return { requested: ids.length, eligible: contacts.length, skipped, contacts };
}

module.exports = { SCREEN_FIELDS, screenDocs, screenContacts };
