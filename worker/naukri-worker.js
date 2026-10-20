#!/usr/bin/env node
'use strict';

// Naukri worker — worker/platform-worker.js with PLATFORM=naukri.
//
// Kept under its old name so `npm run naukri-worker`, the launchd / systemd
// units install-worker.sh wrote, start-all.sh and the test harness all keep
// working unchanged. Forced to Naukri: a stray PLATFORM in the environment must
// not turn this process into another site's worker.
//
//   npm run naukri-worker          (macOS or Linux; holds sleep off itself)

process.env.PLATFORM = 'naukri';
const worker = require('./platform-worker');

if (require.main === module) {
  worker.main().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = worker;
