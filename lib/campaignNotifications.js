const Campaign = require('../models/Campaign');
const CampaignRow = require('../models/CampaignRow');
const SendJob = require('../models/SendJob');
const mailer = require('./mailer');

const safe = (value) => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
const n = (value) => Number(value || 0).toLocaleString('en-IN');
// The immutable campaign id prevents two campaigns with the same display name
// from being merged by Gmail's subject-based conversation heuristics.
const subjectFor = (campaign) => `[Outreach campaign ${String(campaign._id)}] ${safe(campaign.name)}`;

async function send(campaign, text) {
  const sender = mailer.senderConfig;
  if (!mailer.transporter || !sender.email) throw new Error('Campaign notification email is not configured.');
  const root = campaign.notificationThreadMessageId || null;
  const info = await mailer.transporter.sendMail({
    from: `"${safe(sender.name) || 'Outreach'}" <${sender.email}>`,
    to: sender.email,
    subject: subjectFor(campaign),
    text,
    ...(root ? { inReplyTo: root, references: root } : {}),
  });
  // Store only the first message: every later alert replies to the same root,
  // which is more stable than chaining through messages Gmail may collapse.
  if (!root && info.messageId) {
    await Campaign.updateOne(
      { _id: campaign._id, notificationThreadMessageId: null },
      { $set: { notificationThreadMessageId: info.messageId } },
    );
  }
}

const releaseLine = (release) => {
  const state = release.error ? `Error: ${release.error}` : 'Queued successfully';
  return `• ${release.releasedOn} (${release.trigger}): ${n(release.released)} queued, ${n(release.skipped)} skipped, ${n(release.scanned)} scanned — ${state}`;
};

/** Best-effort alert after a campaign batch's actual email work is complete. */
async function notifyCampaignRun(campaignId, jobId, report = null) {
  const campaign = await Campaign.findById(campaignId).lean();
  if (!campaign || campaign.deleted) return;
  const job = jobId ? await SendJob.findById(jobId, { status: 1, items: 1, createdAt: 1 }).lean() : null;
  const items = job?.items || [];
  const sent = items.filter(item => item.status === 'sent').length;
  const failed = items.filter(item => item.status === 'failed').length;
  const skipped = items.filter(item => item.status === 'skipped').length;
  const pending = items.filter(item => item.status === 'pending').length;
  const release = (campaign.releases || []).find(r => String(r.jobId) === String(jobId)) || (campaign.releases || []).at(-1);
  const text = [
    `Campaign batch complete: ${campaign.name}`,
    '',
    `Campaign status: ${campaign.status}`,
    job ? `Send job status: ${job.status}` : 'No send job was created for this run.',
    job ? `Results: ${n(sent)} sent, ${n(failed)} failed, ${n(skipped)} skipped, ${n(pending)} pending` : '',
    job ? `Batch started: ${job.createdAt.toISOString()}` : '',
    report ? `Rows scanned: ${n(report.scanned)}; campaign rows skipped: ${n(report.skipped)}` : '',
    report?.error ? `Issue: ${report.error}` : '',
    release ? `History entry: ${releaseLine(release)}` : '',
    '',
    'This is an automatic Outreach campaign batch result.',
  ].filter(Boolean).join('\n');
  await send(campaign, text);
}

async function notifyCampaignJobFinished(jobId) {
  try {
    const job = await SendJob.findById(jobId, { campaignId: 1, status: 1 }).lean();
    if (!job?.campaignId || job.status !== 'done') return;
    await notifyCampaignRun(job.campaignId, job._id);
    await notifyCampaignCompletion(job.campaignId);
  } catch (err) {
    console.error(`Campaign batch notification failed for ${jobId}:`, err.message);
  }
}

/** Final scheduling history, sent once when the campaign moves to completed. */
async function notifyCampaignCompletion(campaignId) {
  const campaign = await Campaign.findOne({ _id: campaignId, deleted: { $ne: true } }).lean();
  if (!campaign || campaign.status !== 'completed' || campaign.completionNotifiedAt) return;

  // A campaign is fully finished only after its final drip has finished too.
  const activeJobs = await SendJob.exists({ campaignId: String(campaign._id), status: { $in: ['pending', 'processing', 'paused'] } });
  if (activeJobs) return;

  const [grouped, jobs] = await Promise.all([
    CampaignRow.aggregate([
      { $match: { campaignId: campaign._id } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    SendJob.find({ _id: { $in: (campaign.releases || []).map(r => r.jobId).filter(Boolean) } },
      { status: 1, items: 1, createdAt: 1 }).lean(),
  ]);
  const counts = Object.fromEntries(grouped.map(row => [row._id, row.n]));
  const jobHistory = jobs.length ? jobs.map(job => {
    const items = job.items || [];
    const sent = items.filter(item => item.status === 'sent').length;
    const failed = items.filter(item => item.status === 'failed').length;
    const skipped = items.filter(item => item.status === 'skipped').length;
    const pending = items.filter(item => item.status === 'pending').length;
    return `• ${job.createdAt.toISOString()}: ${job.status} — ${n(sent)} sent, ${n(failed)} failed, ${n(skipped)} skipped, ${n(pending)} pending`;
  }) : ['• No send jobs were created.'];

  const text = [
    `Campaign complete: ${campaign.name}`,
    '',
    'Campaign configuration',
    `• Template: ${campaign.templateKey}`,
    `• Daily limit: ${campaign.contactsPerDay}; hourly rate: ${campaign.ratePerHour}; start hour: ${campaign.runHourIst}:00 IST`,
    `• Created: ${campaign.createdAt.toISOString()}`,
    `• Completed: ${campaign.completedAt ? campaign.completedAt.toISOString() : new Date().toISOString()}`,
    '',
    'Final row history',
    `• Total: ${n(Object.values(counts).reduce((total, value) => total + value, 0))}`,
    `• Released: ${n(counts.released)}; skipped: ${n(counts.skipped)}; removed: ${n(counts.removed)}; pending: ${n(counts.pending)}; queued: ${n(counts.queued)}`,
    '',
    'Campaign runs',
    ...((campaign.releases || []).map(releaseLine)),
    '',
    'Send-job status at completion',
    ...jobHistory,
    '',
    'This is the complete history for this campaign.',
  ].join('\n');

  await send(campaign, text);
  await Campaign.updateOne(
    { _id: campaign._id, completionNotifiedAt: null },
    { $set: { completionNotifiedAt: new Date() } },
  );
}

module.exports = { notifyCampaignRun, notifyCampaignJobFinished, notifyCampaignCompletion };
