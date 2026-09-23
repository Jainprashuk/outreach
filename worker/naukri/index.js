'use strict';

// The real Naukri driver. Everything that knows what Naukri's DOM looks like
// lives under this directory and nowhere else, so a selector fix never touches
// lifecycle code and the worker loop can be tested against ./stub.js.
//
// The interface is defined by ./stub.js — same function names, same signatures,
// same return shapes. If you change one, change both, or the stub stops being a
// meaningful test of the loop.
//
// Build order, deliberately: refresh first (one save button, applies to nothing,
// validates the CDP attach), then harvest (read-only), then apply (the only
// irreversible one) last.

const { connect, disconnect, loggedIn } = require('./session');
const { Checkpoint } = require('./guard');
const { refresh } = require('./refresh');
const { harvest } = require('./harvest');
const { apply } = require('./apply');

module.exports = {
  connect,
  disconnect,
  loggedIn,
  refresh,
  harvest,
  apply,
  Checkpoint,
};
