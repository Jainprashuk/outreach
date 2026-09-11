const Settings = require('../models/Settings');
const Template = require('../models/Template');

// PORT of client/src/lib/format.ts renderTemplate() and js/app.js:214-232.
// Kept behaviourally identical, including `name.split(' ')[0]` (FIRST name only)
// and the builtins-then-customs ordering.
//
// Duplicated rather than shared because the client is ESM/TS and the server is
// CJS — sharing would mean a build-system change. IF YOU EDIT format.ts, EDIT
// THIS. A drift here shows up as a campaign email that differs from its preview.
//
// Exists because SendJob.items need fully-rendered subject/body, and until now
// the ONLY renderer lived in the browser (Step 3 posts finished strings). A
// cron-driven release has no browser.

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Load everything the renderer needs, ONCE PER RUN.
 *
 * The Settings projection MUST exclude resume.data — the singleton holds a
 * Buffer, and pulling it once per contact would be catastrophic.
 *
 * @param {{templateKey: string}} opts
 * @returns {Promise<{template: object|null, sender: {name: string, company: string,
 *                    vars: Array<{re: RegExp, value: string}>}}>}
 */
async function loadRenderContext({ templateKey }) {
  const [settings, template] = await Promise.all([
    Settings.findOne({}, { senderName: 1, senderCompany: 1, customVariables: 1 }).lean(),
    Template.findOne({ key: templateKey }, { key: 1, name: 1, subject: 1, body: 1 }).lean(),
  ]);

  return {
    template: template || null,
    sender: {
      name:    (settings && settings.senderName)    || '',
      company: (settings && settings.senderCompany) || '',
      // Regexes compiled ONCE, not once per contact per variable. The key is
      // escaped defensively: routes/settings.js already validates keys against
      // /^[a-zA-Z][a-zA-Z0-9_]*$/, so this is inert today, but it's free.
      vars: ((settings && settings.customVariables) || []).map(v => ({
        re: new RegExp(`{{${escapeRe(v.key)}}}`, 'g'),
        value: v.value || '',
      })),
    },
  };
}

/**
 * Render one contact's email. NEVER throws — one malformed row must not take out
 * the whole day's batch. Returns PLAIN TEXT: inngest-fns.js bodyToHtml() runs on
 * item.body at send time, so escaping here would double-escape the output.
 *
 * @param {{subject: string, body: string}|null} template
 * @param {{name?: string, company?: string, role?: string, sentSubject?: string}} contact
 * @param {{name: string, company: string, vars: Array<{re: RegExp, value: string}>}} sender
 * @param {Array<{k: string, v: string}>} [extraVars] per-row values from the sheet's
 *        unmapped columns. Nothing populates this as a variable source yet; the
 *        parameter exists so adding {{industry}} from a column is a UI change
 *        rather than a migration on a spreadsheet you no longer have.
 * @returns {{subject: string, body: string}}
 */
function renderTemplate(template, contact, sender, extraVars) {
  if (!template) return { subject: '', body: '' };

  const c = contact || {};
  const first = String(c.name || '').split(' ')[0];

  const replace = (str) => {
    let out = String(str == null ? '' : str)
      .replace(/{{name}}/g, first)
      .replace(/{{company}}/g, c.company || '')
      .replace(/{{role}}/g, c.role || '')
      .replace(/{{sender}}/g, sender.name)
      .replace(/{{senderCompany}}/g, sender.company)
      .replace(/{{sentSubject}}/g, c.sentSubject || '');
    for (const v of sender.vars) out = out.replace(v.re, v.value);
    for (const e of (extraVars || [])) {
      if (!e || !e.k) continue;
      out = out.replace(new RegExp(`{{${escapeRe(e.k)}}}`, 'g'), e.v || '');
    }
    return out;
  };

  return { subject: replace(template.subject), body: replace(template.body) };
}

module.exports = { loadRenderContext, renderTemplate };
