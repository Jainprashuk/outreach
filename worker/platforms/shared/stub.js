'use strict';

// A fake driver for a new platform — no browser, nothing real touched.
//
// Built on the Naukri stub (worker/naukri/stub.js, the interface document), so
// every platform's loop — claim, progress, ingest, result, track, finish, the
// checkpoint path — is exercised the same way:
//
//   PLATFORM=instahyre PLATFORM_STUB=1 npm run platform-worker
//
// Same env knobs as the Naukri stub (NAUKRI_STUB_FAIL, NAUKRI_STUB_CHECKPOINT,
// NAUKRI_STUB_EMPTY, NAUKRI_STUB_JOBS, NAUKRI_STUB_TRACK); PLATFORM_STUB_*
// spellings are accepted too. Like the real driver, it refuses a real apply
// while the platform's apply is not proven.

const base = require('../../naukri/stub');
const { NotSupported } = require('./guard');

for (const k of ['FAIL', 'CHECKPOINT', 'EMPTY', 'JOBS', 'TRACK']) {
  if (process.env[`PLATFORM_STUB_${k}`] !== undefined && process.env[`NAUKRI_STUB_${k}`] === undefined) {
    process.env[`NAUKRI_STUB_${k}`] = process.env[`PLATFORM_STUB_${k}`];
  }
}

function makeStub(meta) {
  async function harvest(session, opts) {
    const out = await base.harvest(session, opts);
    const feedOrigin = (meta.feeds[0] && meta.feeds[0].origin) || 'recommended';
    out.jobs = out.jobs.map((j, i) => ({
      ...j,
      url: `${meta.origin}/job/${j.sourceId}`,
      // The first recommended job comes in as recruiter interest on a site
      // that has it (Instahyre), so that path is exercised too.
      origins: j.origins.map(o => (o === 'recommended' ? (meta.recruiterFeed && i % 4 === 0 ? 'recruiter' : feedOrigin) : o)),
    }));
    if (!meta.feeds.length) out.recommended = 0;
    return out;
  }
  async function apply(session, opts) {
    if (!opts.dryRun && !meta.capabilities.apply) {
      throw new NotSupported(`Real apply on ${meta.label} is not built yet — only a dry run is. Nothing was sent.`);
    }
    return base.apply(session, opts);
  }
  async function refresh(session, opts) {
    if (!meta.capabilities.refresh) throw new NotSupported(`${meta.label} has no refresh profile step`);
    return base.refresh(session, opts);
  }
  return {
    meta, connect: base.connect, disconnect: base.disconnect, loggedIn: base.loggedIn,
    refresh, harvest, apply, track: base.track, Checkpoint: base.Checkpoint, NotSupported,
  };
}

module.exports = { makeStub };
