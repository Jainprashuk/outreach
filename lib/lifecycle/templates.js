/**
 * The words of every lifecycle email. Each builder returns { subject, text, html }.
 *
 * The look lives in lib/emailLayout.js, shared with the sign-in and campaign
 * emails; this file only decides what each email says.
 */
const L = require('../emailLayout');
const { appUrl } = require('./unsubscribe');
const { labelFor } = require('../reportPeriod');

const e = L.escapeHtml;
const n = (v) => Number(v || 0).toLocaleString('en-IN');
const when = (d) => new Date(d).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});
const shortDate = (d) => new Date(d).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' });
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const hi = (name) => (firstName(name) ? `Hi ${firstName(name)},` : 'Hi,');
const link = (path) => `${appUrl()}/app${path}`;
const plural = (count, one, many) => `${n(count)} ${count === 1 ? one : many}`;

// Every email ends the same way: it says it is system-generated, and gives an
// "Opt out" link. Where the email has its own preference that is a signed
// one-click unsubscribe; for the welcome and a report the user asked for there
// is nothing to unsubscribe from, so it opens the email settings instead.
const optOutHref = (unsub) => unsub || link('/settings');
const footerFor = (unsub) =>
  `This is a system-generated email. You can opt out by clicking <a href="${e(optOutHref(unsub))}" style="color:#6b7280;text-decoration:underline">Opt out</a>.`;
const textFooter = (unsub) =>
  `\n${L.appTextLine()}\n--\nThis is a system-generated email. You can opt out here: ${optOutHref(unsub)}`;

// ── B. Welcome ───────────────────────────────────────────────────────────────
// No promise of a weekly report here: that email is opt-in per type and may
// never be switched on, so saying "every Monday" would be untrue.
function welcome({ name, gmail }) {
  const subject = "You're ready to send on Outreach";
  const firstSteps = [
    ['Add contacts', '/add-contacts', 'upload a spreadsheet or add people one by one.'],
    ['Pick a template', '/templates', 'start from one of ours or write your own.'],
    ['Launch a campaign', '/campaigns', 'it sends a few emails a day from your Gmail, on its own.'],
  ];
  const text = `${hi(name)}

Your Gmail ${gmail || ''} is connected, so you're ready to send.

Three steps to your first emails:
${firstSteps.map(([t, p, d], i) => `${i + 1}. ${t}: ${d}\n   ${link(p)}`).join('\n')}

Handled for you: replies and bounces are tracked automatically, and every
reply is sorted (interested, not now, resume requested, needs attention) so
you know who to answer first.${textFooter(null)}`;

  const html = L.layout({
    preheader: 'Your Gmail is connected. Three steps to your first emails.',
    body: `
    ${L.heading("You're ready to send")}
    ${L.para(e(hi(name)))}
    ${L.para(`Your Gmail${gmail ? ` ${L.strong(gmail)}` : ''} is connected. Three steps to your first emails:`)}
    ${L.steps(firstSteps.map(([t, p, d]) => `<a href="${e(link(p))}" style="color:#111827;font-weight:600;text-decoration:none">${e(t)}</a><span style="color:#6b7280"> — ${e(d)}</span>`))}
    ${L.button(link('/add-contacts'), 'Add your first contacts')}
    ${L.label('Handled for you')}
    ${L.para('Replies and bounces are tracked automatically, and every reply is sorted — interested, not now, resume requested or needs attention — so you know who to answer first.', { last: true })}`,
    footer: footerFor(null),
  });
  return { subject, text, html };
}

// ── A. Setup reminder ────────────────────────────────────────────────────────
function setupReminder({ name, missing, unsub }) {
  const needsGmail = missing.includes('gmail');
  const needsIdentity = missing.includes('identity');
  const both = needsGmail && needsIdentity;
  const subject = both ? 'Two quick steps and you can start sending'
    : needsGmail ? 'One step left: connect your Gmail' : 'One step left: add your name';

  const SECURITY = 'https://myaccount.google.com/security';
  const APP_PASSWORDS = 'https://myaccount.google.com/apppasswords';
  const text = `${hi(name)}

You're ${both ? 'two quick steps' : 'one step'} away from sending your first email on Outreach.
${needsGmail ? `
Connect your Gmail:
1. Turn on 2-Step Verification for the Gmail account you send from: ${SECURITY}
2. Create an App Password named "Outreach": ${APP_PASSWORDS}
3. Paste the 16-character password into the Gmail step of setup.

An App Password lets Outreach send from your Gmail without your real password,
and you can revoke it from your Google account at any time.
` : ''}${needsIdentity ? '\nAdd your name so your emails are signed correctly.\n' : ''}
Finish setup: ${link('/onboarding')}${textFooter(unsub)}`;

  const html = L.layout({
    preheader: needsGmail ? 'Connect your Gmail and you can start sending.' : 'Add your name and you are ready.',
    body: `
    ${L.heading(both ? 'Two quick steps left' : 'One step left')}
    ${L.para(e(hi(name)))}
    ${L.para(`Your Outreach account is almost ready — you're ${both ? 'two quick steps' : 'one step'} away from sending your first email.`)}
    ${needsGmail ? `
    ${L.label('Connect your Gmail')}
    ${L.steps([
    `Turn on ${L.inlineLink(SECURITY, '2-Step Verification')} for the Gmail account you send from.`,
    `Create an ${L.inlineLink(APP_PASSWORDS, 'App Password')} named “Outreach”.`,
    'Paste the 16-character password into the Gmail step of setup.',
  ])}
    ${L.para('An App Password lets Outreach send from your Gmail without your real password, and you can revoke it from your Google account at any time.', { muted: true, small: true })}` : ''}
    ${needsIdentity ? `
    ${L.label('Add your name')}
    ${L.para('So your emails are signed correctly.')}` : ''}
    ${L.button(link('/onboarding'), 'Finish setup')}`,
    footer: footerFor(unsub),
  });
  return { subject, text, html };
}

// ── C. Inactivity nudge ──────────────────────────────────────────────────────
function inactive({ name, since, news, unsub }) {
  const lines = [];
  if (news.replies) {
    lines.push(`${plural(news.replies, 'new reply', 'new replies')}${news.needsAttention ? `, ${n(news.needsAttention)} ${news.needsAttention === 1 ? 'needs' : 'need'} your attention` : ''}`);
  }
  for (const c of news.finishedCampaigns) lines.push(`Campaign "${c.name}" finished`);
  if (news.upcomingInterviews) lines.push(`${plural(news.upcomingInterviews, 'interview', 'interviews')} coming up this week`);
  const idle = lines.length === 0;

  const subject = idle
    ? 'Your outreach pipeline is quiet'
    : news.replies ? `${plural(news.replies, 'new reply', 'new replies')} while you were away` : 'Here’s what happened while you were away';

  const people = news.replyPeople || [];
  const cta = idle ? ['/campaigns', 'Start a campaign'] : news.replies ? ['/mailbox', 'Read replies'] : ['/', 'Open Outreach'];
  const idleCopy = 'No emails have gone out from your account in the last few days. A campaign sends a few emails a day on its own, so it only takes a couple of minutes to get going again.';

  const text = `${hi(name)}

${idle ? idleCopy : `Here's what happened since ${shortDate(since)}:\n${lines.map(l => `- ${l}`).join('\n')}`}
${people.length ? `\n${people.map(p => `  ${p.name}${p.company ? ` (${p.company})` : ''}: ${p.label}`).join('\n')}\n` : ''}
${cta[1]}: ${link(cta[0])}${textFooter(unsub)}`;

  const html = L.layout({
    preheader: idle ? 'Start a campaign in two minutes.' : lines[0],
    body: `
    ${idle ? L.heading("It's been quiet") : L.heading('While you were away', `Since ${shortDate(since)}`)}
    ${L.para(e(hi(name)))}
    ${idle ? L.para(idleCopy) : L.bullets(lines.map(e))}
    ${people.length ? `${L.label('Who replied')}${L.rows(people.map(p => [p.name, p.label, p.company]))}` : ''}
    ${L.button(link(cta[0]), cta[1])}`,
    footer: footerFor(unsub),
  });
  return { subject, text, html };
}

// ── D. Weekly / manual report ────────────────────────────────────────────────
function delta(h, isRate) {
  if (h.delta === 0) return '';
  const abs = isRate ? `${Math.abs(h.delta)} pts` : n(Math.abs(h.delta));
  return h.delta > 0 ? `+${abs}` : `-${abs}`;
}

function report({ name, stats, unsub, manual = false }) {
  const range = labelFor({ from: new Date(stats.period.from), to: new Date(stats.period.to) });
  const h = stats.headline;

  // Quiet week: one line, no PDF (the caller does not attach one).
  if (stats.quiet && !manual) {
    const subject = `Quiet week on Outreach (${range})`;
    const text = `${hi(name)}\n\nQuiet week: no emails were sent from your account (${range}).\n\nStart a campaign: ${link('/campaigns')}${textFooter(unsub)}`;
    const html = L.layout({
      preheader: 'No emails were sent last week.',
      body: `
      ${L.heading('A quiet week', range)}
      ${L.para(e(hi(name)))}
      ${L.para('No emails were sent from your account this week. Start a campaign and it will send a few a day on its own.')}
      ${L.button(link('/campaigns'), 'Start a campaign')}`,
      footer: footerFor(unsub),
    });
    return { subject, text, html };
  }

  const subject = manual ? `Your Outreach report: ${range}` : `Your outreach week: ${range}`;
  const tiles = [
    { label: 'Emails sent', value: n(h.sent.value), delta: delta(h.sent) },
    { label: 'Replies', value: n(h.replies.value), delta: delta(h.replies) },
    { label: 'Reply rate', value: `${h.replyRate.value}%`, delta: delta(h.replyRate, true) },
    { label: 'Interviews', value: n(h.interviews.value), delta: delta(h.interviews) },
  ];
  const waiting = stats.waiting.items.map(w => [w.name, w.categoryLabel, w.company]);
  const interviews = stats.upcomingInterviews.slice(0, 5)
    .map(i => [[i.company, i.role].filter(Boolean).join(' · ') || i.name, when(i.interviewAt)]);

  const text = `${hi(name)}

Your outreach, ${range}:
${tiles.map(t => `- ${t.label}: ${t.value}${t.delta ? ` (${t.delta} vs the period before)` : ''}`).join('\n')}
${waiting.length ? `\nWaiting on you:\n${waiting.map(([who, what, co]) => `- ${who}${co ? ` (${co})` : ''}: ${what}`).join('\n')}\n` : ''}${interviews.length ? `\nComing up:\n${interviews.map(([what, at]) => `- Interview: ${what}, ${at}`).join('\n')}\n` : ''}
The full report is attached as a PDF, and it's in the app too: ${link('/analytics?view=reports')}${textFooter(manual ? null : unsub)}`;

  const html = L.layout({
    preheader: `${n(h.sent.value)} sent, ${n(h.replies.value)} replies.`,
    body: `
    ${L.heading(manual ? 'Your outreach report' : 'Your outreach week', range)}
    ${L.stats(tiles)}
    ${L.para('Changes are compared with the period before.', { muted: true, small: true })}
    ${waiting.length ? `${L.label('Waiting on you')}${L.rows(waiting)}` : ''}
    ${interviews.length ? `${L.label('Coming up')}${L.rows(interviews)}` : ''}
    ${L.para('The full report is attached as a PDF.', { muted: true })}
    ${L.button(link('/analytics?view=reports'), 'View in the app')}`,
    footer: footerFor(manual ? null : unsub),
  });
  return { subject, text, html };
}

module.exports = { welcome, setupReminder, inactive, report };
