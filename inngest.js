const { Inngest } = require('inngest');

// App id is env-configurable so the same codebase can back multiple independent
// deployments (job outreach, project outreach, ...) without their Inngest apps colliding.
//
// checkpointing: false — SDK v4 checkpoints by default, but Inngest Cloud only uses
// it once the app is synced with that capability. After the 2026-10-09 sync every
// run on Vercel did its work and then crashed (FUNCTION_INVOCATION_FAILED) while
// checkpointing, so Inngest retried each one twice. Classic mode is what ran
// cleanly before that sync.
const inngest = new Inngest({ id: process.env.INNGEST_APP_ID || 'outreach-app', checkpointing: false });

module.exports = { inngest };
