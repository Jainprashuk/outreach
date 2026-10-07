/**
 * The one look every email from the product shares: sign-in codes, access
 * approvals, lifecycle emails, reports and campaign alerts.
 *
 * Pure string builders with no requires, so lib/emailOtp.js can use it without
 * picking up anything from the lifecycle side (its sender stays separate).
 * Every email ends with an "Open Outreach" link to the app when its URL is known.
 *
 * Email-client rules this works under:
 *  - Inline styles only. Gmail strips <style> blocks and nobody supports CSS
 *    custom properties, so the app's design tokens are copied in as hex below.
 *  - Tables for anything laid out side by side. Outlook ignores max-width and
 *    flex on divs; a fixed-width centred table is what holds there.
 *  - No images. Most clients block them until the reader clicks, and a broken
 *    logo at the top of a sign-in email looks like phishing. The wordmark is text.
 *  - color-scheme: light. Without it, dark-mode clients invert colours on their
 *    own and the indigo buttons come out muddy; with it, most leave them alone.
 */

const C = {
  page: '#f4f5f7',
  card: '#ffffff',
  border: '#e5e7eb',
  rule: '#eef0f3',
  ink: '#111827',
  body: '#374151',
  muted: '#6b7280',
  faint: '#9ca3af',
  brand: '#4f46e5',
  brandSoft: '#eef2ff',
  tile: '#f6f7f9',
  up: '#15803d',
  down: '#b91c1c',
};
const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,Roboto,Helvetica,Arial,sans-serif";

// The app's public origin, which every link in an email is built on. An email
// has no page to resolve a relative link against. OUTREACH_URL wins; otherwise
// Vercel's own production domain (a system env var on every Vercel deploy).
// Lives here, not in lib/lifecycle, so the sign-in emails can use it too.
const appUrl = () => {
  const explicit = String(process.env.OUTREACH_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  const vercel = String(process.env.VERCEL_PROJECT_PRODUCTION_URL || '').trim();
  return vercel ? `https://${vercel.replace(/^https?:\/\//, '').replace(/\/+$/, '')}` : '';
};
// Where the "Open Outreach" link in every email goes; '' (no link) without a URL.
const appHome = () => (appUrl() ? `${appUrl()}/app` : '');

const escapeHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const e = escapeHtml;

// Filler after the preheader so the inbox preview stops there instead of
// running on into "Outreach Hi Prashuk, ...".
const PREHEADER_PAD = '&#847;&zwnj;&nbsp;'.repeat(60);

/**
 * The page. `body` is trusted HTML built with the helpers below; everything a
 * user typed must already have gone through escapeHtml.
 */
function layout({ body, footer = '', preheader = '', width = 520 }) {
  const app = appHome();
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>Outreach</title>
</head>
<body style="margin:0;padding:0;background:${C.page};-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${C.page}">${e(preheader)}${PREHEADER_PAD}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.page}">
  <tr><td align="center" style="padding:28px 12px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:${width}px;font-family:${FONT}">
      <tr><td style="padding:0 4px 14px;font-size:15px;font-weight:700;letter-spacing:-.2px;color:${C.ink}">
        <span style="display:inline-block;width:10px;height:10px;border-radius:3px;background:${C.brand};margin-right:7px;vertical-align:1px"></span>Outreach
      </td></tr>
      <tr><td style="background:${C.card};border:1px solid ${C.border};border-radius:14px;padding:28px 26px;font-size:14.5px;line-height:1.6;color:${C.body}">
${body}
      </td></tr>
      ${app ? `<tr><td style="padding:14px 4px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${C.card};border:1px solid ${C.border};border-radius:12px">
          <tr>
            <td style="padding:12px 16px;font-size:13px;line-height:1.45;color:${C.body}"><strong style="color:${C.ink}">Outreach</strong><br><span style="color:${C.muted}">Your contacts, campaigns and replies.</span></td>
            <td align="right" style="padding:12px 16px 12px 0;white-space:nowrap"><a href="${e(app)}" style="display:inline-block;padding:8px 14px;border-radius:8px;border:1px solid ${C.border};font-size:13px;font-weight:600;color:${C.brand};text-decoration:none">Open Outreach</a></td>
          </tr>
        </table>
      </td></tr>` : ''}
      ${footer ? `<tr><td style="padding:16px 8px 0;font-size:12px;line-height:1.55;color:${C.faint};text-align:center">${footer}</td></tr>` : ''}
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── Blocks ───────────────────────────────────────────────────────────────────
// Each returns an HTML fragment. Text arguments are escaped here; arguments
// named *Html are trusted fragments the caller already built.

const heading = (text, sub = '') =>
  `<p style="margin:0 0 ${sub ? 4 : 16}px;font-size:20px;line-height:1.3;font-weight:700;letter-spacing:-.3px;color:${C.ink}">${e(text)}</p>`
  + (sub ? `<p style="margin:0 0 18px;font-size:13.5px;color:${C.muted}">${e(sub)}</p>` : '');

const para = (html, { muted = false, small = false, last = false } = {}) =>
  `<p style="margin:0 0 ${last ? 0 : 14}px;${small ? 'font-size:13px;' : ''}${muted ? `color:${C.muted};` : ''}">${html}</p>`;

const label = (text) =>
  `<p style="margin:20px 0 8px;font-size:11.5px;font-weight:700;letter-spacing:.6px;text-transform:uppercase;color:${C.muted}">${e(text)}</p>`;

const strong = (text) => `<strong style="color:${C.ink};font-weight:600">${e(text)}</strong>`;

const inlineLink = (href, text) =>
  `<a href="${e(href)}" style="color:${C.brand};text-decoration:underline">${e(text)}</a>`;

/** A full-width-on-phones primary button. Bulletproof enough for Outlook. */
const button = (href, text, { secondary = false } = {}) => `
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 4px">
  <tr><td style="border-radius:9px;background:${secondary ? C.card : C.brand};${secondary ? `border:1px solid ${C.border};` : ''}">
    <a href="${e(href)}" style="display:inline-block;padding:11px 20px;font-size:14px;font-weight:600;line-height:1.2;color:${secondary ? C.ink : '#ffffff'};text-decoration:none;border-radius:9px">${e(text)}</a>
  </td></tr>
</table>`;

/** Numbered steps; each `htmlItems` entry is a trusted fragment. */
const steps = (htmlItems) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px">
${htmlItems.map((item, i) => `  <tr>
    <td width="30" valign="top" style="padding:6px 0">
      <div style="width:22px;height:22px;border-radius:11px;background:${C.brandSoft};color:${C.brand};font-size:12px;font-weight:700;line-height:22px;text-align:center">${i + 1}</div>
    </td>
    <td valign="top" style="padding:7px 0 6px;font-size:14px;line-height:1.5">${item}</td>
  </tr>`).join('\n')}
</table>`;

/** A plain bulleted list of trusted fragments. */
const bullets = (htmlItems) =>
  `<ul style="margin:0 0 16px;padding-left:20px">${htmlItems.map(h => `<li style="margin:0 0 5px">${h}</li>`).join('')}</ul>`;

/** Two-column rows: [left, right] pairs, both escaped. Optional muted `note` under the left. */
const rows = (pairs) => `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 16px;font-size:13.5px">
${pairs.map(([left, right, note]) => `  <tr>
    <td style="padding:9px 0;border-top:1px solid ${C.rule};color:${C.ink}">${e(left)}${note ? `<span style="color:${C.faint}"> · ${e(note)}</span>` : ''}</td>
    <td align="right" style="padding:9px 0 9px 12px;border-top:1px solid ${C.rule};color:${C.muted}">${e(right)}</td>
  </tr>`).join('\n')}
</table>`;

/**
 * Stat tiles, two per row so they still read on a phone.
 * @param {Array<{label:string, value:string, delta?:string, tone?:'muted'|'down'}>} tiles
 *   `tone` overrides the colour guessed from the delta's sign, for a sub-line that
 *   is not a change (a breakdown, a count of failures).
 */
function stats(tiles) {
  const cell = (t) => !t ? '<td width="50%"></td>' : `
    <td width="50%" valign="top" style="padding:4px">
      <div style="background:${C.tile};border-radius:10px;padding:12px 14px">
        <div style="font-size:11px;letter-spacing:.4px;text-transform:uppercase;color:${C.muted}">${e(t.label)}</div>
        <div style="font-size:24px;line-height:1.25;font-weight:700;color:${C.ink};margin-top:2px">${e(t.value)}</div>
        <div style="font-size:12px;min-height:16px;color:${t.tone === 'muted' ? C.muted : t.tone === 'down' || String(t.delta || '').startsWith('-') ? C.down : C.up}">${e(t.delta || '')}</div>
      </div>
    </td>`;
  const out = [];
  for (let i = 0; i < tiles.length; i += 2) out.push(`<tr>${cell(tiles[i])}${cell(tiles[i + 1])}</tr>`);
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 10px">${out.join('')}</table>`;
}

/** A tinted box for the one thing in an email that matters most (a code, a warning). */
const callout = (html, { tone = 'brand' } = {}) =>
  `<div style="margin:0 0 16px;padding:14px 16px;border-radius:10px;background:${tone === 'brand' ? C.brandSoft : C.tile};color:${C.ink}">${html}</div>`;

/** The plain-text twin of the app banner: a line to put above a text footer, or ''. */
const appTextLine = () => (appHome() ? `\nOpen Outreach: ${appHome()}\n` : '');

const divider = () => `<div style="height:1px;background:${C.rule};margin:20px 0"></div>`;

module.exports = {
  COLORS: C, escapeHtml, layout, appUrl, appHome, appTextLine,
  heading, para, label, strong, inlineLink, button, steps, bullets, rows, stats, callout, divider,
};
