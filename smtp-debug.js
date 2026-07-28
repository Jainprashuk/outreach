// Standalone SMTP delivery test — no DB, no Inngest, no Vercel.
// Usage: node smtp-debug.js recipient@example.com
// Prints the full SMTP conversation, including Gmail's queue id for the accepted message.
require('dotenv').config();
const nodemailer = require('nodemailer');

const to = process.argv[2];
const user = process.env.SMTP_DEBUG_EMAIL || process.env.GMAIL_EMAIL;
const pass = process.env.SMTP_DEBUG_PASSWORD || process.env.GMAIL_APP_PASSWORD;

if (!to || !user || !pass) {
  console.error('Usage: node smtp-debug.js recipient@example.com');
  console.error('Needs GMAIL_EMAIL + GMAIL_APP_PASSWORD (or SMTP_DEBUG_* overrides) in .env');
  process.exit(1);
}

(async () => {
  const transporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user, pass },
    logger: true,  // print the SMTP conversation
    debug: true,   // include the protocol-level traffic
  });

  console.log(`\n--- verifying connection as ${user} ---`);
  await transporter.verify();

  // --rich replicates exactly what the app sends: display name, HTML part,
  // the real template body with its unrendered {{link}} variable.
  const rich = process.argv.includes('--rich');
  const body = "Hi Prashuk,\n\nI'm a developer and I built a small tool called BugTracker — it auto-captures JavaScript errors, API failures, and console issues from a frontend app and shows them live, so you find out about bugs before your users email you. One snippet, ~2 min to install.\n\nYou clearly run a real frontend app, so you're exactly who I want feedback from. Would you be up for trying it and telling me what's missing or annoying?\n\nHave a look: {{link}}\n\nYour Name";
  const toHtml = t => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/\n/g, '<br>');

  console.log(`\n--- sending to ${to} (${rich ? 'rich: app-identical' : 'plain'}) ---`);
  const info = await transporter.sendMail({
    from: rich ? `"Your Name" <${user}>` : user,
    to,
    subject: rich ? `quick one about test's frontend` : `smtp-debug ${new Date().toISOString()}`,
    text: rich ? body : 'Plain text delivery test, no links and no HTML.',
    ...(rich ? { html: toHtml(body) } : {}),
  });

  console.log('\n--- result ---');
  console.log('accepted :', info.accepted);
  console.log('rejected :', info.rejected);
  console.log('response :', info.response);   // e.g. "250 2.0.0 OK  1690... - gsmtp"
  console.log('messageId:', info.messageId);
  console.log('\nSearch the recipient mailbox for:');
  console.log(`  rfc822msgid:${info.messageId.replace(/[<>]/g, '')} in:anywhere`);
  process.exit(0);
})().catch(err => {
  console.error('\n--- FAILED ---');
  console.error(err);
  process.exit(1);
});
