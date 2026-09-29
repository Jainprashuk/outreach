/**
 * The words of every lifecycle email. Each builder returns { subject, text, html }.
 *
 * Inline styles only and no CSS variables: mail clients strip <style> blocks,
 * the same constraint lib/emailOtp.js works under.
 */
const { escapeHtml: e } = require('../systemMail');
const { appUrl } = require('./unsubscribe');
const { labelFor } = require('../reportPeriod');

const n = (v) => Number(v || 0).toLocaleString('en-IN');
const when = (d) => new Date(d).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit',
});
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const hi = (name) => (firstName(name) ? `Hi ${firstName(name)},` : 'Hi,');
const link = (path) => `${appUrl()}/app${path}`;

const button = (href, label) =>
  `<a href="${e(href)}" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;padding:10px 18px;border-radius:8px;font-size:14px;font-weight:600;margin:4px 6px 4px 0">${e(label)}</a>`;

function layout({ body, footer = '', preheader = '' }) {
  return `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Inter,sans-serif;color:#111827">
  <span style="display:none;max-height:0;overflow:hidden">${e(preheader)}</span>
  <div style="max-width:520px;margin:0 auto;background:#ffffff;border:1px solid #e5e7eb;border-radius:12px;padding:28px;font-size:14px;line-height:1.55;color:#374151">
    ${body}
  </div>
  <div style="max-width:520px;margin:12px auto 0;font-size:11.5px;color:#9ca3af;text-align:center;line-height:1.5">
    ${footer}
  </div>
</body></html>`;
}

// Every email ends the same way: it says it is system-generated, and gives an
// "Opt out" link. Where the email has its own preference that is a signed
// one-click unsubscribe; for the welcome and a report the user asked for there
// is nothing to unsubscribe from, so it opens the email settings instead.
const optOutHref = (unsub) => unsub || link('/settings');
const footerFor = (unsub) =>
  `This is a system-generated email. You can opt out by clicking <a href="${e(optOutHref(unsub))}" style="color:#6b7280;text-decoration:underline">Opt out</a>.`;
const textFooter = (unsub) =>
  `\n\n--\nThis is a system-generated email. You can opt out here: ${optOutHref(unsub)}`;

// ── B. Welcome ───────────────────────────────────────────────────────────────
function welcome({ name, gmail }) {
  const subject = "You're all set on Outreach";
  const text = `${hi(name)}

Your Gmail ${gmail || ''} is connected, so you're ready to send.

Three things to do first:
1. Add contacts: ${link('/add-contacts')}
2. Pick or edit a template: ${link('/templates')}
3. Launch your first campaign: ${link('/campaigns')}

What happens on its own: replies and bounces are tracked for you, and each
reply is sorted (interested, not now, resume requested, needs attention).

Every Monday you'll get a short report of your week.${textFooter(null)}`;
  const html = layout({
    preheader: 'Your Gmail is connected. Here is what to do first.',
    body: `
    <p style="margin:0 0 14px;font-size:17px;font-weight:600;color:#111827">You're all set</p>
    <p style="margin:0 0 14px">${e(hi(name))}</p>
    <p style="margin:0 0 18px">Your Gmail${gmail ? ` <strong>${e(gmail)}</strong>` : ''} is connected, so you're ready to send.</p>
    <p style="margin:0 0 8px;font-weight:600;color:#111827">Three things to do first</p>
    <div style="margin:0 0 18px">
      ${button(link('/add-contacts'), '1. Add contacts')}
      ${button(link('/templates'), '2. Pick a template')}
      ${button(link('/campaigns'), '3. Launch a campaign')}
    </div>
    <p style="margin:0 0 10px"><strong>What happens on its own:</strong> replies and bounces are tracked for you, and each reply is sorted: interested, not now, resume requested, or needs attention.</p>
    <p style="margin:0;color:#6b7280">Every Monday you'll get a short report of your week.</p>`,
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

  const gmailSteps = [
    'Turn on 2-Step Verification for the Gmail account you send from (myaccount.google.com/security).',
    'Open myaccount.google.com/apppasswords and create an App Password named "Outreach".',
    'Paste the 16-character password into the Gmail step of the setup.',
  ];
  const text = `${hi(name)}

You're ${both ? 'two quick steps' : 'one step'} away from sending your first email on Outreach.
${needsGmail ? `\nConnect your Gmail to start sending:\n${gmailSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\n` : ''}${needsIdentity ? '\nAdd your name so your emails are signed correctly.\n' : ''}
Finish setup: ${link('/onboarding')}${textFooter(unsub)}`;

  const html = layout({
    preheader: needsGmail ? 'Connect your Gmail and you can start sending.' : 'Add your name and you are ready.',
    body: `
    <p style="margin:0 0 14px;font-size:17px;font-weight:600;color:#111827">You're ${both ? 'almost there' : 'one step away'}</p>
    <p style="margin:0 0 14px">${e(hi(name))}</p>
    <p style="margin:0 0 16px">Your Outreach account is almost ready. ${both ? 'Two things are left:' : 'One thing is left:'}</p>
    ${needsGmail ? `
    <p style="margin:0 0 6px;font-weight:600;color:#111827">Connect your Gmail to start sending</p>
    <ol style="margin:0 0 16px;padding-left:20px">${gmailSteps.map(s => `<li style="margin-bottom:4px">${e(s)}</li>`).join('')}</ol>` : ''}
    ${needsIdentity ? '<p style="margin:0 0 16px"><strong>Add your name</strong> so your emails are signed correctly.</p>' : ''}
    ${button(link('/onboarding'), 'Finish setup')}`,
    footer: footerFor(unsub),
  });
  return { subject, text, html };
}

// ── C. Inactivity nudge ──────────────────────────────────────────────────────
function inactive({ name, since, news, unsub }) {
  const lines = [];
  if (news.replies) {
    lines.push(`${n(news.replies)} new ${news.replies === 1 ? 'reply' : 'replies'} since your last visit${news.needsAttention ? `, ${n(news.needsAttention)} ${news.needsAttention === 1 ? 'needs' : 'need'} your attention` : ''}`);
  }
  for (const c of news.finishedCampaigns) lines.push(`Campaign "${c.name}" finished`);
  if (news.upcomingInterviews) lines.push(`You have ${n(news.upcomingInterviews)} ${news.upcomingInterviews === 1 ? 'interview' : 'interviews'} coming up this week`);
  const idle = lines.length === 0;

  const subject = idle
    ? 'Your outreach pipeline is quiet'
    : news.replies ? `${n(news.replies)} new ${news.replies === 1 ? 'reply' : 'replies'} while you were away` : 'Here’s what happened while you were away';

  const people = news.replyPeople || [];
  const text = `${hi(name)}

${idle
    ? 'Nothing has been sent from your account for a few days. Start a campaign and it runs on its own, a few emails a day.'
    : `Here's what happened since ${new Date(since).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short' })}:\n${lines.map(l => `- ${l}`).join('\n')}`}
${people.length ? `\n${people.map(p => `  ${p.name}${p.company ? ` (${p.company})` : ''}: ${p.label}`).join('\n')}\n` : ''}
${idle ? `Start a campaign: ${link('/campaigns')}` : `Open Outreach: ${link(news.replies ? '/mailbox' : '/')}`}${textFooter(unsub)}`;

  const html = layout({
    preheader: idle ? 'Start a campaign in two minutes.' : lines[0],
    body: `
    <p style="margin:0 0 14px;font-size:17px;font-weight:600;color:#111827">${idle ? 'Your pipeline is quiet' : 'While you were away'}</p>
    <p style="margin:0 0 14px">${e(hi(name))}</p>
    ${idle
    ? '<p style="margin:0 0 18px">Nothing has been sent from your account for a few days. Start a campaign and it runs on its own, a few emails a day.</p>'
    : `<ul style="margin:0 0 16px;padding-left:20px">${lines.map(l => `<li style="margin-bottom:4px">${e(l)}</li>`).join('')}</ul>`}
    ${people.length ? `<table style="width:100%;border-collapse:collapse;margin:0 0 18px;font-size:13px">${people.map(p => `
      <tr><td style="padding:6px 0;border-top:1px solid #f0f1f3">${e(p.name)}${p.company ? `<span style="color:#9ca3af"> · ${e(p.company)}</span>` : ''}</td>
      <td style="padding:6px 0;border-top:1px solid #f0f1f3;text-align:right;color:#6b7280">${e(p.label)}</td></tr>`).join('')}</table>` : ''}
    ${idle ? button(link('/campaigns'), 'Start a campaign') : button(link(news.replies ? '/mailbox' : '/'), news.replies ? 'Read replies' : 'Open Outreach')}`,
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
    const html = layout({
      preheader: 'No emails were sent last week.',
      body: `<p style="margin:0 0 14px">${e(hi(name))}</p>
      <p style="margin:0 0 18px">Quiet week: no emails were sent from your account (${e(range)}).</p>
      ${button(link('/campaigns'), 'Start a campaign')}`,
      footer: footerFor(unsub),
    });
    return { subject, text, html };
  }

  const subject = manual ? `Your Outreach report: ${range}` : `Your outreach week: ${range}`;
  const tiles = [
    ['Emails sent', n(h.sent.value), delta(h.sent)],
    ['Replies', n(h.replies.value), delta(h.replies)],
    ['Reply rate', `${h.replyRate.value}%`, delta(h.replyRate, true)],
    ['Interviews', n(h.interviews.value), delta(h.interviews)],
  ];
  const waiting = [
    ...stats.waiting.items.map(w => `${w.name}${w.company ? ` (${w.company})` : ''}: ${w.categoryLabel}`),
    ...stats.upcomingInterviews.slice(0, 5).map(i => `Interview: ${[i.company, i.role].filter(Boolean).join(' · ') || i.name}, ${when(i.interviewAt)}`),
  ];

  const text = `${hi(name)}

Your outreach, ${range}:
${tiles.map(([l, v, d]) => `- ${l}: ${v}${d ? ` (${d} vs the period before)` : ''}`).join('\n')}
${waiting.length ? `\nWaiting on you:\n${waiting.map(w => `- ${w}`).join('\n')}\n` : ''}
The full report is attached as a PDF, and it's in the app too: ${link('/analytics?view=reports')}${textFooter(manual ? null : unsub)}`;

  const html = layout({
    preheader: `${n(h.sent.value)} sent, ${n(h.replies.value)} replies.`,
    body: `
    <p style="margin:0 0 4px;font-size:17px;font-weight:600;color:#111827">Your outreach ${manual ? 'report' : 'week'}</p>
    <p style="margin:0 0 18px;color:#6b7280">${e(range)}</p>
    <table style="width:100%;border-collapse:separate;border-spacing:6px;margin:0 -6px 12px">
      <tr>${tiles.map(([l, v, d]) => `
        <td style="background:#f6f7f9;border-radius:8px;padding:10px;vertical-align:top;width:25%">
          <div style="font-size:10.5px;color:#6b7280;text-transform:uppercase;letter-spacing:.3px">${e(l)}</div>
          <div style="font-size:20px;font-weight:700;color:#111827;margin-top:2px">${e(v)}</div>
          <div style="font-size:11px;color:${d.startsWith('-') ? '#b91c1c' : '#15803d'};min-height:14px">${e(d)}</div>
        </td>`).join('')}
      </tr>
    </table>
    ${waiting.length ? `
    <p style="margin:0 0 6px;font-weight:600;color:#111827">Waiting on you</p>
    <ul style="margin:0 0 18px;padding-left:20px">${waiting.map(w => `<li style="margin-bottom:3px">${e(w)}</li>`).join('')}</ul>` : ''}
    <p style="margin:0 0 14px;color:#6b7280">The full report is attached as a PDF.</p>
    ${button(link('/analytics?view=reports'), 'View in the app')}`,
    footer: footerFor(manual ? null : unsub),
  });
  return { subject, text, html };
}

module.exports = { welcome, setupReminder, inactive, report };
