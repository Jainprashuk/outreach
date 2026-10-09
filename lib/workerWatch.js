const ScrapeWorker = require('../models/ScrapeWorker');
const ScrapeSchedule = require('../models/ScrapeSchedule');
const NaukriWorker = require('../models/NaukriWorker');
const NaukriConfig = require('../models/NaukriConfig');
const Notification = require('../models/Notification');
const { notify } = require('./notify');

// A worker polls every 20s, so 3h of silence is a Mac that is off or asleep for
// longer than a night's lid-close, not a blip.
const WORKER_OFFLINE_MS = 3 * 3600 * 1000;

const KINDS = {
  scrape: {
    Worker: ScrapeWorker,
    // Users who expect the worker to be doing something: the daily schedule is on.
    expecting: () => ScrapeSchedule.distinct('userId', { enabled: true }),
    type: 'scrape.worker_offline', link: '/leads', label: 'scrape worker',
  },
  naukri: {
    Worker: NaukriWorker,
    expecting: () => NaukriConfig.distinct('userId', { 'schedule.enabled': true }),
    type: 'naukri.attention', link: '/naukri', label: 'Naukri worker',
  },
};

// One outage = one key: the worker's last heartbeat does not change until it returns.
const offlineKey = (kind, lastSeenAt) => `${KINDS[kind].type}:${kind}:${new Date(lastSeenAt).getTime()}`;

/**
 * Raise "worker hasn't reported in N hours" for every user whose worker has a
 * schedule switched on but has been silent for 3h+. Idempotent per outage, so it
 * is safe to call from any recurring tick. Never throws.
 */
async function checkWorkersOffline() {
  const cutoff = new Date(Date.now() - WORKER_OFFLINE_MS);
  for (const kind of Object.keys(KINDS)) {
    try {
      const { Worker, expecting, type, link, label } = KINDS[kind];
      const userIds = await expecting();
      if (!userIds.length) continue;
      const quiet = await Worker.find(
        { userId: { $in: userIds }, lastSeenAt: { $ne: null, $lt: cutoff } },
        { userId: 1, lastSeenAt: 1 },
      ).lean();
      for (const w of quiet) {
        const hours = Math.floor((Date.now() - w.lastSeenAt.getTime()) / 3600_000);
        await notify(w.userId, {
          type,
          title: `Your ${label} hasn't reported in ${hours} hours`,
          body: 'The Mac is probably asleep or off. Scheduled runs will not start until it is back.',
          link,
          dedupeKey: offlineKey(kind, w.lastSeenAt),
        });
      }
    } catch (err) {
      console.error(`workerWatch (${kind}) failed:`, err.message);
    }
  }
}

/**
 * Called from a heartbeat that ends an outage longer than WORKER_OFFLINE_MS.
 * Says "back online" only when the matching offline notification was raised.
 * Fire-and-forget; never throws.
 */
async function workerBack(userId, kind, prevSeenAt) {
  try {
    const was = await Notification.exists({ userId, dedupeKey: offlineKey(kind, prevSeenAt) });
    if (!was) return;
    await notify(userId, {
      type: 'scrape.worker_back',
      title: 'Worker is back online',
      body: `Your ${KINDS[kind].label} is reporting in again.`,
      link: KINDS[kind].link,
      dedupeKey: `scrape.worker_back:${kind}:${new Date(prevSeenAt).getTime()}`,
    });
  } catch (err) {
    console.error('workerBack failed:', err.message);
  }
}

module.exports = { checkWorkersOffline, workerBack, WORKER_OFFLINE_MS };
