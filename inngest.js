const { Inngest } = require('inngest');

// App id is env-configurable so the same codebase can back multiple independent
// deployments (job outreach, project outreach, ...) without their Inngest apps colliding.
const inngest = new Inngest({ id: process.env.INNGEST_APP_ID || 'outreach-app' });

module.exports = { inngest };
