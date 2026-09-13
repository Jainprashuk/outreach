const ActivityLog = require('../models/ActivityLog');

const clean = value => String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim().slice(0, 500);

async function logEvent({ category, action, message, meta = {} }) {
  return ActivityLog.create({ category: clean(category), action: clean(action), message: clean(message), meta });
}

// Covers meaningful user/API mutations consistently without logging reads,
// searches, filters, polling, or request bodies containing contact data.
function auditHttpMutations(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method) || req.path.startsWith('/inngest') || req.path.startsWith('/logs')) return next();
  const path = req.path.replace(/^\//, '');
  const area = path.split('/')[0] || 'system';
  res.on('finish', () => {
    const verbs = { POST: 'created or started', PUT: 'updated', PATCH: 'updated', DELETE: 'deleted' };
    logEvent({
      category: area,
      action: res.statusCode >= 200 && res.statusCode < 300 ? req.method.toLowerCase() : 'failed',
      message: res.statusCode >= 200 && res.statusCode < 300
        ? `${area[0].toUpperCase() + area.slice(1)} ${verbs[req.method]}`
        : `${area[0].toUpperCase() + area.slice(1)} action failed (HTTP ${res.statusCode})`,
      meta: { path: req.path, method: req.method, statusCode: res.statusCode },
    }).catch(err => console.error('Activity log write failed:', err.message));
  });
  next();
}

module.exports = { logEvent, auditHttpMutations };
