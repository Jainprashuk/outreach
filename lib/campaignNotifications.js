const Campaign = require('../models/Campaign');
const CampaignRow = require('../models/CampaignRow');
const SendJob = require('../models/SendJob');
const mailer = require('./mailer');

const Template = require('../models/Template');
const L = require('./emailLayout');
const { appUrl } = require('./lifecycle/unsubscribe');
const { notifyCampaignDone } = require('./sendNotifications');

const safe = (value) => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
const n = (value) => Number(value || 0).toLocaleString('en-IN');
// Owners read these in India; the app's schedule is in IST everywhere else too.
const ist = (d) => new Date(d).toLocaleString('en-IN', {
  timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
}) + ' IST';
const istDay = (ymd) => new Date(`${ymd}T12:00:00+05:30`).toLocaleDateString('en-IN', {
  timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
});
const hour12 = (h) => `${((Number(h) + 11) % 12) + 1}:00 ${Number(h) < 12 ? 'am' : 'pm'}`;
const TRIGGER = { cron: 'Scheduled', manual: 'Run by hand', upload: 'On upload' };
const CAMPAIGN_STATUS = { draft: 'Draft', running: 'Running', paused: 'Paused', completed: 'Completed', failed: 'Failed' };
const JOB_STATUS = { pending: 'Waiting to start', processing: 'Sending', paused: 'Paused', done: 'Finished', cancelled: 'Cancelled' };
const campaignLink = (campaign) => (appUrl() ? `${appUrl()}/app/campaigns/${campaign._id}` : '');

const countItems = (items = []) => {
  const c = { sent: 0, failed: 0, skipped: 0, pending: 0 };
  for (const item of items) if (item.status in c) c[item.status] += 1;
  return c;
};

// The immutable campaign id prevents two campaigns with the same display name
// from being merged by Gmail's subject-based conversation heuristics. Do not
// reword it: Gmail also needs the subject unchanged to keep later alerts in
// the thread started by the first one.
const subjectFor = (campaign) => `[Outreach campaign ${String(campaign._id)}] ${safe(campaign.name)}`;

async function send(campaign, { text, html }) {
  // Notifications go to the campaign owner, from their own account.
  const sender = await mailer.getTransporterFor(campaign.userId);
  if (!sender) throw new Error('Campaign notification email is not configured.');
  const root = campaign.notificationThreadMessageId || null;
  const info = await sender.transporter.sendMail({
    from: `"${safe(sender.name) || 'Outreach'}" <${sender.email}>`,
    to: sender.email,
    subject: subjectFor(campaign),
    text,
    html,
    ...(root ? { inReplyTo: root, references: root } : {}),
  });
  // Store only the first message: every later alert replies to the same root,
  // which is more stable than chaining through messages Gmail may collapse.
  if (!root && info.messageId) {
    await Campaign.updateOne(
      { _id: campaign._id, userId: campaign.userId, notificationThreadMessageId: null },
      { $set: { notificationThreadMessageId: info.messageId } },
    );
  }
}

const releaseSummary = (release) => release.error
  ? `could not release contacts: ${release.error}`
  : `${n(release.released)} released, ${n(release.skipped)} skipped (${n(release.scanned)} checked)`;
const releaseLine = (release) =>
  `• ${istDay(release.releasedOn)} · ${TRIGGER[release.trigger] || release.trigger}: ${releaseSummary(release)}`;

const footer = 'An automatic update from your Outreach campaign. Every update for this campaign stays in this one thread.';
const textFooter = (link) => `\n${link ? `\nOpen the campaign: ${link}\n` : ''}${L.appTextLine()}\n--\n${footer}`;

/** Best-effort alert after a campaign batch's actual email work is complete. */
async function notifyCampaignRun(campaignId, jobId, report = null, userId = null) {
  const campaign = await Campaign.findOne({ _id: campaignId, ...(userId ? { userId } : {}) }).lean();
  if (!campaign || campaign.deleted) return;
  // The campaign document is the authority on the owner from here on.
  const owner = campaign.userId;
  const job = jobId
    ? await SendJob.findOne({ _id: jobId, userId: owner }, { status: 1, items: 1, createdAt: 1 }).lean()
    : null;
  const c = countItems(job?.items);
  const release = (campaign.releases || []).find(r => String(r.jobId) === String(jobId)) || (campaign.releases || []).at(-1);
  const problem = report?.error || release?.error || '';
  const link = campaignLink(campaign);

  const headline = problem ? 'This run hit a problem'
    : !job ? 'Nothing to send this run'
      : c.failed ? `Batch done: ${n(c.sent)} sent, ${n(c.failed)} failed`
        : `Batch done: ${n(c.sent)} sent`;
  const facts = [
    ['Campaign status', CAMPAIGN_STATUS[campaign.status] || campaign.status],
    job ? ['Batch', JOB_STATUS[job.status] || job.status] : null,
    job ? ['Started', ist(job.createdAt)] : null,
    release ? ['Run', TRIGGER[release.trigger] || release.trigger] : null,
    report ? ['Contacts checked', n(report.scanned)] : null,
    report ? ['Skipped as duplicates or invalid', n(report.skipped)] : null,
  ].filter(Boolean);

  const text = [
    `${headline} — ${campaign.name}`,
    '',
    job ? `Sent ${n(c.sent)} · Failed ${n(c.failed)} · Skipped ${n(c.skipped)}${c.pending ? ` · Still to send ${n(c.pending)}` : ''}` : 'No emails were queued in this run.',
    ...(problem ? ['', `Problem: ${problem}`] : []),
    '',
    ...facts.map(([k, v]) => `${k}: ${v}`),
  ].join('\n') + textFooter(link);

  const html = L.layout({
    preheader: job ? `${n(c.sent)} sent, ${n(c.failed)} failed, ${n(c.skipped)} skipped.` : 'No emails were queued in this run.',
    body: `
    ${L.heading(headline, campaign.name)}
    ${problem ? L.callout(`<strong>Problem:</strong> ${L.escapeHtml(problem)}`, { tone: 'plain' }) : ''}
    ${job ? L.stats([
    { label: 'Sent', value: n(c.sent) },
    { label: 'Failed', value: n(c.failed) },
    { label: 'Skipped', value: n(c.skipped) },
    { label: 'Still to send', value: n(c.pending) },
  ]) : L.para('No emails were queued in this run.')}
    ${L.rows(facts.map(([k, v]) => [k, v]))}
    ${link ? L.button(link, 'Open the campaign') : ''}`,
    footer,
  });
  await send(campaign, { text, html });
}
async function notifyCampaignJobFinished(jobId) {
  try {
    const job = await SendJob.findById(jobId, { campaignId: 1, status: 1, userId: 1 }).lean();
    if (!job?.campaignId || job.status !== 'done') return;
    await notifyCampaignRun(job.campaignId, job._id, null, job.userId);
    await notifyCampaignCompletion(job.campaignId, job.userId);
  } catch (err) {
    console.error(`Campaign batch notification failed for ${jobId}:`, err.message);
  }
}

/** Final scheduling history, sent once when the campaign moves to completed. */
async function notifyCampaignCompletion(campaignId, userId = null) {
  const campaign = await Campaign.findOne({ _id: campaignId, ...(userId ? { userId } : {}), deleted: { $ne: true } }).lean();
  if (!campaign || campaign.status !== 'completed' || campaign.completionNotifiedAt) return;
  // The campaign document is the authority on the owner from here on.
  const owner = campaign.userId;

  // A campaign is fully finished only after its final drip has finished too.
  const activeJobs = await SendJob.exists({ userId: owner, campaignId: String(campaign._id), status: { $in: ['pending', 'processing', 'paused'] } });
  if (activeJobs) return;

  const [grouped, jobs] = await Promise.all([
    CampaignRow.aggregate([
      { $match: { userId: owner, campaignId: campaign._id } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    SendJob.find({ userId: owner, _id: { $in: (campaign.releases || []).map(r => r.jobId).filter(Boolean) } },
      { status: 1, items: 1, createdAt: 1 }).lean(),
  ]);
  const counts = Object.fromEntries(grouped.map(row => [row._id, row.n]));
  const total = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const sentAll = jobs.reduce((sum, job) => sum + countItems(job.items).sent, 0);
  const failedAll = jobs.reduce((sum, job) => sum + countItems(job.items).failed, 0);
  const tpl = await Template.findOne({ userId: owner, key: campaign.templateKey }, { name: 1 }).lean();
  const releases = campaign.releases || [];
  const link = campaignLink(campaign);
  const completedAt = campaign.completedAt || new Date();
  // In-app first: the email below can fail (no mailer configured) and must not take this with it.
  await notifyCampaignDone(owner, campaign);

  const setup = [
    ['Template', tpl?.name || campaign.templateKey],
    ['Pace', `${n(campaign.contactsPerDay)} a day, up to ${n(campaign.ratePerHour)} an hour${campaign.runHourIst == null ? '' : `, from ${hour12(campaign.runHourIst)} IST`}`],
    ['Started', ist(campaign.createdAt)],
    ['Finished', ist(completedAt)],
  ];
  const contacts = [
    ['Released for sending', n(counts.released)],
    ['Skipped', n(counts.skipped)],
    ['Removed', n(counts.removed)],
    ...(counts.pending || counts.queued ? [['Never released', n((counts.pending || 0) + (counts.queued || 0))]] : []),
  ];

  const text = [
    `Campaign complete — ${campaign.name}`,
    '',
    `${n(sentAll)} emails sent${failedAll ? `, ${n(failedAll)} failed` : ''}, from ${n(total)} contacts over ${n(releases.length)} ${releases.length === 1 ? 'run' : 'runs'}.`,
    '',
    'Setup',
    ...setup.map(([k, v]) => `• ${k}: ${v}`),
    '',
    'Contacts',
    ...contacts.map(([k, v]) => `• ${k}: ${v}`),
    '',
    'Runs',
    ...(releases.length ? releases.map(releaseLine) : ['• No runs were recorded.']),
  ].join('\n') + textFooter(link);

  const html = L.layout({
    preheader: `${n(sentAll)} emails sent from ${n(total)} contacts.`,
    body: `
    ${L.heading('Campaign complete', campaign.name)}
    ${L.stats([
    { label: 'Emails sent', value: n(sentAll) },
    { label: 'Failed', value: n(failedAll) },
    { label: 'Contacts', value: n(total) },
    { label: 'Runs', value: n(releases.length) },
  ])}
    ${L.label('Setup')}${L.rows(setup)}
    ${L.label('Contacts')}${L.rows(contacts)}
    ${releases.length ? `${L.label('Runs')}${L.rows(releases.map(r => [`${istDay(r.releasedOn)} · ${TRIGGER[r.trigger] || r.trigger}`, r.error ? 'Problem' : `${n(r.released)} released`, r.error || (r.skipped ? `${n(r.skipped)} skipped` : '')]))}` : ''}
    ${link ? L.button(link, 'Open the campaign') : ''}`,
    footer,
  });

  await send(campaign, { text, html });
  await Campaign.updateOne(
    { _id: campaign._id, userId: owner, completionNotifiedAt: null },
    { $set: { completionNotifiedAt: new Date() } },
  );
}

module.exports = { notifyCampaignRun, notifyCampaignJobFinished, notifyCampaignCompletion };
