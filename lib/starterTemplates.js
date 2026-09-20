/**
 * The templates a brand-new account starts with.
 *
 * Nothing was ever seeded before, so a new user's Templates page was empty and
 * the send wizard had nothing to offer — you cannot write your first campaign
 * from a blank page as easily as you can edit three drafts.
 *
 * Only the variables lib/renderTemplate.js actually substitutes appear here:
 * {{name}} (first name only), {{company}}, {{role}}, {{sender}},
 * {{senderCompany}} and {{sentSubject}}. A typo'd variable would render as
 * literal braces in somebody's first real email.
 */
const Template = require('../models/Template');

const STARTER_TEMPLATES = [
  {
    key: 'cold-outreach',
    name: 'Cold outreach',
    subject: '{{role}} at {{company}}',
    body: `Hi {{name}},

I came across {{company}} and wanted to reach out about the {{role}} opening.

I've attached my resume. I'd love to hear whether it might be a fit, and I'm happy to share more about what I've been working on.

Thanks for your time,
{{sender}}`,
  },
  {
    key: 'follow-up',
    name: 'Follow-up',
    // Threads under the original in most clients, which is why sentSubject
    // exists as a variable at all.
    subject: 'Re: {{sentSubject}}',
    body: `Hi {{name}},

Just floating this back to the top of your inbox in case it got buried.

Still very interested in the {{role}} role at {{company}} — happy to answer anything that would be useful.

Thanks,
{{sender}}`,
  },
  {
    key: 'referral-request',
    name: 'Referral request',
    subject: 'Quick question about {{company}}',
    body: `Hi {{name}},

I'm applying for the {{role}} role at {{company}} and noticed you're on the team.

Would you be open to a quick referral, or pointing me to the right person? Totally understand if not — I know these asks add up.

Either way, thanks for reading.
{{sender}}`,
  },
];

/**
 * Add the starter templates to an account.
 *
 * Idempotent by construction rather than by checking first: the unique
 * {userId, key} index rejects a repeat, and ordered:false means one collision
 * does not abort the rest. So re-running never duplicates anything and never
 * overwrites a template the user has since edited — the failure mode of a
 * "seed if empty" check is that it silently resurrects templates somebody
 * deliberately deleted.
 */
async function seedStarterTemplates(userId) {
  const docs = STARTER_TEMPLATES.map(t => ({ ...t, userId }));
  try {
    const res = await Template.insertMany(docs, { ordered: false });
    return { created: res.length, total: STARTER_TEMPLATES.length };
  } catch (err) {
    // A bulk write that hit duplicates still inserted the rest; the count of
    // what actually landed is on the error, not on a thrown-away result.
    if (err && err.code === 11000 && err.result) {
      return { created: err.result.insertedCount || 0, total: STARTER_TEMPLATES.length };
    }
    if (err && err.writeErrors && err.insertedDocs) {
      return { created: err.insertedDocs.length, total: STARTER_TEMPLATES.length };
    }
    throw err;
  }
}

module.exports = { STARTER_TEMPLATES, seedStarterTemplates };
