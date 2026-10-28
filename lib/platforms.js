// The job platforms the worker pipeline knows how to drive.
//
// One registry, read by the server (routes/naukri.js mounted per platform,
// claim, schedules, the UI's capability gating) and mirrored by each worker
// driver's `meta` (worker/platforms/<id>). Naukri is the original and keeps every
// path, field and default it had: a platform here is just "which rows and which
// settings", never a different pipeline.
//
// Capabilities say what the server may SCHEDULE on a platform. They start
// conservative for a new site and are switched on as its driver is proven:
//   refresh — re-save the profile (only sites that rank by recency)
//   harvest — collect listings
//   dryRun  — walk the apply flow and submit nothing
//   apply   — real applications (only after a clean dry run on the live site)
//   track   — read what recruiters did with your applications
//
// `sources` are the harvest choices the Harvest menu offers. `recommended` is
// whatever the site pushes at you (Naukri's Recommended jobs, Instahyre's
// matched opportunities); a site without one only has searches.

const PLATFORMS = {
  naukri: {
    id: 'naukri',
    label: 'Naukri',
    color: 'blue',
    capabilities: { refresh: true, harvest: true, dryRun: true, apply: true, track: true },
    sources: { searches: 'My searches', recommended: 'Recommended jobs' },
  },
  instahyre: {
    id: 'instahyre',
    label: 'Instahyre',
    color: 'teal',
    // apply: real apply built 2026-10-21 (worker/platforms/shared/driver.js
    // applyOne), counted only on the site's own success answer for that job id.
    capabilities: { refresh: false, harvest: true, dryRun: true, apply: true, track: true },
    sources: { searches: 'My searches', recommended: 'Matched opportunities' },
  },
  hirist: {
    id: 'hirist',
    label: 'Hirist',
    color: 'purple',
    // publicHarvest: its job search needs no login (verified), so a harvest
    // runs while you are logged out; check replies and apply still need one.
    // apply: real apply built 2026-10-21, same rule as Instahyre.
    capabilities: { refresh: false, harvest: true, dryRun: true, apply: true, track: true, publicHarvest: true },
    sources: { searches: 'My searches', recommended: 'My job feed' },
  },
  cutshort: {
    id: 'cutshort',
    label: 'Cutshort',
    color: 'orange',
    // Real apply mapped and proven 2026-10-28 (one real application, then
    // worker/platforms/shared/driver.js applyOne counts it only on the site's
    // own POST /sendreply/jobsignal answer). No `searches` source: Cutshort's
    // search is not URL-controlled, so it harvests the profile-matched list only.
    capabilities: { refresh: false, harvest: true, dryRun: true, apply: true, track: true },
    sources: { recommended: 'Matched jobs' },
  },
  wellfound: {
    id: 'wellfound',
    label: 'Wellfound',
    color: 'pink',
    // Feed-only like Cutshort: its job list is the saved search you set on
    // Wellfound itself (/jobs), read from its GraphQL answers. Real apply
    // mapped 2026-10-28: counted only on the CreateJobApplication answer.
    capabilities: { refresh: false, harvest: true, dryRun: true, apply: true, track: true },
    sources: { recommended: 'Your Wellfound search' },
  },
};

const PLATFORM_IDS = Object.keys(PLATFORMS);
// The non-Naukri ones, whose settings live under NaukriConfig.platforms.<id>.
const SITE_IDS = PLATFORM_IDS.filter(id => id !== 'naukri');

const isPlatform = (id) => Object.prototype.hasOwnProperty.call(PLATFORMS, id);
const labelOf = (id) => (PLATFORMS[id] ? PLATFORMS[id].label : String(id || 'Naukri'));
const capabilitiesOf = (id) => (PLATFORMS[id] ? PLATFORMS[id].capabilities : {});

// The Mongo filter that scopes a query to one platform.
//
// Naukri rows written before platforms existed have no `platform` field at all,
// so Naukri matches "naukri OR missing" — no migration, no backfill, and every
// old row is still Naukri's. 'all' (the All platforms view) scopes nothing.
function platformQuery(platform) {
  if (!platform || platform === 'all') return {};
  if (platform === 'naukri') return { platform: { $in: ['naukri', null] } };
  return { platform };
}

// A row's platform, for rows from before the field existed.
const platformOfDoc = (doc) => (doc && doc.platform) || 'naukri';

// Settings that belong to one platform. For Naukri they are the top-level
// fields of NaukriConfig, exactly where they always were; for every other
// platform they live under config.platforms.<id> with the same names, so a
// caller reads `site.schedule` and never branches on the platform.
const SITE_FIELDS = [
  'enabled', 'applyMode', 'readOnlySince',
  'schedule', 'worker', 'inboxTidy', 'searchLimits', 'searches', 'sources',
  'filters', 'apply', 'safety',
];

// The settings object for `platform`: the config itself for Naukri, the
// platform's subdocument otherwise (created on first use).
function siteOf(config, platform = 'naukri') {
  if (!platform || platform === 'naukri' || platform === 'all') return config;
  if (!isPlatform(platform)) throw new Error(`Unknown platform: ${platform}`);
  if (!config.platforms) config.platforms = {};
  if (!config.platforms[platform]) config.platforms[platform] = {};
  return config.platforms[platform];
}

// Off / dry run / on, as the Configuration card shows it.
//
// Naukri keeps its original switch (safety.dryRun) and gains only an explicit
// "off"; a Naukri config saved before this has applyMode null and behaves
// exactly as before. Another platform reads its own applyMode, and "on" is
// capped to "dry-run" until its real apply is proven (capabilities.apply).
function applyModeOf(site, platform = 'naukri') {
  if (!site) return 'off';
  const caps = capabilitiesOf(platform);
  if (platform === 'naukri' || !platform) {
    if (site.applyMode === 'off') return 'off';
    return site.safety && site.safety.dryRun ? 'dry-run' : 'on';
  }
  const mode = site.applyMode || 'off';
  if (mode === 'on' && !caps.apply) return caps.dryRun ? 'dry-run' : 'off';
  if (mode === 'dry-run' && !caps.dryRun) return 'off';
  return ['off', 'dry-run', 'on'].includes(mode) ? mode : 'off';
}

// Whether a run of `kind` may be created on this platform right now, by its
// capabilities and apply mode. Returns null when it may, or the reason not.
function kindBlocked(kind, site, platform = 'naukri') {
  const caps = capabilitiesOf(platform);
  const label = labelOf(platform);
  if (kind === 'probe') return null;
  if (kind === 'apply') {
    const mode = applyModeOf(site, platform);
    if (mode === 'off') return `Apply is off for ${label}. Turn it on in Configuration → Apply behaviour & safety.`;
    return null;
  }
  if (!caps[kind]) return `${label} has no ${kind === 'track' ? 'check replies' : kind === 'refresh' ? 'refresh profile' : kind} step`;
  return null;
}

// Whether the platform is switched on. Naukri is on unless you turn it off.
const isEnabled = (site, platform = 'naukri') => {
  if (!site) return platform === 'naukri';
  if (site.enabled === undefined || site.enabled === null) return platform === 'naukri';
  return !!site.enabled;
};

// What the client needs to draw the switcher and gate its buttons, without
// reading code.
const publicRegistry = () => PLATFORM_IDS.map(id => ({
  id, label: PLATFORMS[id].label, color: PLATFORMS[id].color,
  capabilities: PLATFORMS[id].capabilities, sources: PLATFORMS[id].sources,
}));

module.exports = {
  PLATFORMS, PLATFORM_IDS, SITE_IDS, SITE_FIELDS,
  isPlatform, labelOf, capabilitiesOf, platformQuery, platformOfDoc,
  siteOf, applyModeOf, kindBlocked, isEnabled, publicRegistry,
};
