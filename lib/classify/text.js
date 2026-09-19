// Turning a raw inbound email into the text the rules and the models actually see.
//
// Both steps exist because of a specific failure, not for tidiness:
//   - toPlainText: the call sites pass `parsed.text || parsed.html`, so an HTML-only reply
//     arrives as markup. Un-stripped, "<p>I am out of the office</p>" never matches an
//     out-of-office rule, and the model gets billed for reading tag soup.
//   - stripQuoted: a reply quotes OUR outreach email underneath it. Our own copy contains
//     phrases like "if you're not hiring right now" — scan that and the rejection rule fires
//     on an enthusiastic yes. This is the single largest false-positive source in the rules.

const ENTITIES = {
  '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
  '&quot;': '"', '&#39;': "'", '&apos;': "'", '&mdash;': '—', '&ndash;': '–',
};

/** HTML (or plain text — this is a no-op on text) collapsed to readable plain text. */
function toPlainText(input) {
  let s = String(input || '');
  if (!s) return '';

  if (/<(p|br|div|a|table|span|tr|td|body|html)\b/i.test(s)) {
    s = s
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<\s*(br|\/p|\/div|\/tr|\/li|\/h[1-6])\s*\/?>/gi, '\n')
      .replace(/<[^>]+>/g, ' ');
  }

  s = s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)));
  for (const [ent, ch] of Object.entries(ENTITIES)) s = s.split(ent).join(ch);

  return s
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n').map(line => line.trim()).join('\n')
    .trim();
}

// Where a reply stops being the reply and starts being a quote of what we sent.
const QUOTE_MARKERS = [
  /^On\s[\s\S]{0,200}?\bwrote:\s*$/m,          // Gmail
  /^-{2,}\s*(Original Message|Forwarded message)[\s\S]*$/mi,
  /^_{5,}\s*$/m,                                // Outlook's horizontal rule
  /^\s*From:\s.+$/m,                            // Outlook header block
  /^\s*>{1,}\s?.*$/m,                           // plain-text quoting
  /^Sent from my /m,
];

/** Everything above the quoted history — i.e. what this person actually typed. */
function stripQuoted(input) {
  const s = String(input || '');
  let cut = s.length;

  for (const marker of QUOTE_MARKERS) {
    const m = marker.exec(s);
    if (m && m.index < cut) cut = m.index;
  }

  const head = s.slice(0, cut).trim();
  // An empty head means the whole body looked like a quote (a bare forward, say). Better to
  // hand the model the full text than to classify an empty string.
  return head || s.trim();
}

/** toPlainText + stripQuoted — what every caller in this package actually wants. */
function normalizeBody(input) {
  return stripQuoted(toPlainText(input));
}

module.exports = { toPlainText, stripQuoted, normalizeBody };
