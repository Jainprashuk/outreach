// A curated list of well-known company boards, offered as a dropdown because no
// ATS vendor will enumerate its customers: Greenhouse /v1/boards is a 404,
// Lever /v0/postings is a 404, Ashby's board root is a 401. Without a directory
// the only alternatives are typing a token or a list like this one.
//
// PROVENANCE: every entry below was fetched through its real adapter on
// 2026-09-09 and returned a parseable posting set. Deliberately excluded:
//   - `greenhouse:remote`  → resolves to "General Assembly Remote Jobs", not remote.com
//   - `greenhouse:wise`    → resolves to "Wise Worksite Field Sales", not Wise the fintech
//   - `lever:leverdemo`, `lever:lever` → vendor demo/own boards
//   - `lever:palantir`     → timed out during verification, so unverified
//
// `approxRoles` is a SNAPSHOT from that date, useful only for ordering the list
// — it goes stale immediately. The live count always comes from Check/preview,
// and every pick is run through the preview endpoint before it can be added, so
// a token that has since gone stale surfaces as a clean 404 rather than bad data.

const STARTER_BOARDS = [
  // ── Greenhouse ────────────────────────────────────────────────────────────
  { source: 'greenhouse', token: 'spacex',        name: 'SpaceX',           approxRoles: 2348 },
  { source: 'greenhouse', token: 'databricks',    name: 'Databricks',       approxRoles: 869 },
  { source: 'greenhouse', token: 'stripe',        name: 'Stripe',           approxRoles: 617 },
  { source: 'greenhouse', token: 'anthropic',     name: 'Anthropic',        approxRoles: 595 },
  { source: 'greenhouse', token: 'datadog',       name: 'Datadog',          approxRoles: 449 },
  { source: 'greenhouse', token: 'mongodb',       name: 'MongoDB',          approxRoles: 403 },
  { source: 'greenhouse', token: 'elastic',       name: 'Elastic',          approxRoles: 354 },
  { source: 'greenhouse', token: 'waymo',         name: 'Waymo',            approxRoles: 342 },
  { source: 'greenhouse', token: 'cloudflare',    name: 'Cloudflare',       approxRoles: 336 },
  { source: 'greenhouse', token: 'okta',          name: 'Okta',             approxRoles: 308 },
  { source: 'greenhouse', token: 'verkada',       name: 'Verkada',          approxRoles: 292 },
  { source: 'greenhouse', token: 'brex',          name: 'Brex',             approxRoles: 282 },
  { source: 'greenhouse', token: 'samsara',       name: 'Samsara',          approxRoles: 250 },
  { source: 'greenhouse', token: 'gitlab',        name: 'GitLab',           approxRoles: 230 },
  { source: 'greenhouse', token: 'coinbase',      name: 'Coinbase',         approxRoles: 217 },
  { source: 'greenhouse', token: 'fivetran',      name: 'Fivetran',         approxRoles: 209 },
  { source: 'greenhouse', token: 'affirm',        name: 'Affirm',           approxRoles: 199 },
  { source: 'greenhouse', token: 'pinterest',     name: 'Pinterest',        approxRoles: 185 },
  { source: 'greenhouse', token: 'airbnb',        name: 'Airbnb',           approxRoles: 171 },
  { source: 'greenhouse', token: 'lyft',          name: 'Lyft',             approxRoles: 159 },
  { source: 'greenhouse', token: 'figma',         name: 'Figma',            approxRoles: 157 },
  { source: 'greenhouse', token: 'twilio',        name: 'Twilio',           approxRoles: 152 },
  { source: 'greenhouse', token: 'reddit',        name: 'Reddit',           approxRoles: 144 },
  { source: 'greenhouse', token: 'rubrik',        name: 'Rubrik',           approxRoles: 137 },
  { source: 'greenhouse', token: 'robinhood',     name: 'Robinhood',        approxRoles: 126 },
  { source: 'greenhouse', token: 'asana',         name: 'Asana',            approxRoles: 112 },
  { source: 'greenhouse', token: 'nuro',          name: 'Nuro',             approxRoles: 108 },
  { source: 'greenhouse', token: 'oura',          name: 'Ōura',             approxRoles: 107 },
  { source: 'greenhouse', token: 'instacart',     name: 'Instacart',        approxRoles: 103 },
  { source: 'greenhouse', token: 'justworks',     name: 'Justworks',        approxRoles: 95 },
  { source: 'greenhouse', token: 'gusto',         name: 'Gusto',            approxRoles: 92 },
  { source: 'greenhouse', token: 'duolingo',      name: 'Duolingo',         approxRoles: 89 },
  { source: 'greenhouse', token: 'astranis',      name: 'Astranis',         approxRoles: 88 },
  { source: 'greenhouse', token: 'vercel',        name: 'Vercel',           approxRoles: 87 },
  { source: 'greenhouse', token: 'mixpanel',      name: 'Mixpanel',         approxRoles: 83 },
  { source: 'greenhouse', token: 'motional',      name: 'Motional',         approxRoles: 73 },
  { source: 'greenhouse', token: 'n26',           name: 'N26',              approxRoles: 68 },
  { source: 'greenhouse', token: 'chime',         name: 'Chime',            approxRoles: 65 },
  { source: 'greenhouse', token: 'monzo',         name: 'Monzo',            approxRoles: 65 },
  { source: 'greenhouse', token: 'faire',         name: 'Faire',            approxRoles: 61 },
  { source: 'greenhouse', token: 'tailscale',     name: 'Tailscale',        approxRoles: 56 },
  { source: 'greenhouse', token: 'launchdarkly',  name: 'LaunchDarkly',     approxRoles: 53 },
  { source: 'greenhouse', token: 'peloton',       name: 'Peloton',          approxRoles: 47 },
  { source: 'greenhouse', token: 'dropbox',       name: 'Dropbox',          approxRoles: 43 },
  { source: 'greenhouse', token: 'amplitude',     name: 'Amplitude',        approxRoles: 38 },
  { source: 'greenhouse', token: 'webflow',       name: 'Webflow',          approxRoles: 26 },
  { source: 'greenhouse', token: 'coursera',      name: 'Coursera',         approxRoles: 24 },
  { source: 'greenhouse', token: 'khanacademy',   name: 'Khan Academy',     approxRoles: 23 },
  { source: 'greenhouse', token: 'cockroachlabs', name: 'Cockroach Labs',   approxRoles: 21 },
  { source: 'greenhouse', token: 'greenhouse',    name: 'Greenhouse',       approxRoles: 18 },
  { source: 'greenhouse', token: 'airtable',      name: 'Airtable',         approxRoles: 16 },
  { source: 'greenhouse', token: 'planetscale',   name: 'PlanetScale',      approxRoles: 13 },
  { source: 'greenhouse', token: 'udemy',         name: 'Udemy',            approxRoles: 12 },
  { source: 'greenhouse', token: 'typeform',      name: 'Typeform',         approxRoles: 11 },
  { source: 'greenhouse', token: 'calendly',      name: 'Calendly',         approxRoles: 9 },
  { source: 'greenhouse', token: 'netlify',       name: 'Netlify',          approxRoles: 1 },
  { source: 'greenhouse', token: 'poshmark',      name: 'Poshmark',         approxRoles: 0 },

  // ── Ashby ─────────────────────────────────────────────────────────────────
  // Ashby exposes no company name, so these display names are hand-written
  // (the adapter would otherwise title-case the slug into "Openai").
  { source: 'ashby', token: 'openai',     name: 'OpenAI',      approxRoles: 780 },
  { source: 'ashby', token: 'snowflake',  name: 'Snowflake',   approxRoles: 369 },
  { source: 'ashby', token: 'clickhouse', name: 'ClickHouse',  approxRoles: 179 },
  { source: 'ashby', token: 'ramp',       name: 'Ramp',        approxRoles: 145 },
  { source: 'ashby', token: 'cohere',     name: 'Cohere',      approxRoles: 143 },
  { source: 'ashby', token: 'notion',     name: 'Notion',      approxRoles: 131 },
  { source: 'ashby', token: 'plaid',      name: 'Plaid',       approxRoles: 104 },
  { source: 'ashby', token: 'replit',     name: 'Replit',      approxRoles: 74 },
  { source: 'ashby', token: 'ashby',      name: 'Ashby',       approxRoles: 70 },
  { source: 'ashby', token: 'temporal',   name: 'Temporal',    approxRoles: 66 },
  { source: 'ashby', token: 'supabase',   name: 'Supabase',    approxRoles: 60 },
  { source: 'ashby', token: 'benchling',  name: 'Benchling',   approxRoles: 49 },
  { source: 'ashby', token: 'sentry',     name: 'Sentry',      approxRoles: 40 },
  { source: 'ashby', token: 'miro',       name: 'Miro',        approxRoles: 39 },
  { source: 'ashby', token: 'render',     name: 'Render',      approxRoles: 35 },
  { source: 'ashby', token: 'linear',     name: 'Linear',      approxRoles: 29 },
  { source: 'ashby', token: 'strava',     name: 'Strava',      approxRoles: 27 },
  { source: 'ashby', token: 'confluent',  name: 'Confluent',   approxRoles: 22 },
  { source: 'ashby', token: 'airbyte',    name: 'Airbyte',     approxRoles: 12 },
  { source: 'ashby', token: 'posthog',    name: 'PostHog',     approxRoles: 10 },
  { source: 'ashby', token: 'zapier',     name: 'Zapier',      approxRoles: 7 },
  { source: 'ashby', token: 'cedar',      name: 'Cedar',       approxRoles: 3 },
  { source: 'ashby', token: 'deel',       name: 'Deel',        approxRoles: 0 },
  { source: 'ashby', token: 'loom',       name: 'Loom',        approxRoles: 0 },
  { source: 'ashby', token: 'planet',     name: 'Planet',      approxRoles: 0 },
  { source: 'ashby', token: 'snyk',       name: 'Snyk',        approxRoles: 0 },

  // ── Lever ─────────────────────────────────────────────────────────────────
  { source: 'lever', token: 'zoox',  name: 'Zoox',  approxRoles: 245 },
  { source: 'lever', token: 'ro',    name: 'Ro',    approxRoles: 47 },
  { source: 'lever', token: 'neon',  name: 'Neon',  approxRoles: 13 },
  { source: 'lever', token: 'whoop', name: 'Whoop', approxRoles: 0 },
];

/** When the approxRoles snapshot was taken, so the UI can say so honestly. */
const VERIFIED_ON = '2026-09-09';

module.exports = { STARTER_BOARDS, VERIFIED_ON };
