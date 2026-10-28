'use strict';

// Cutshort without a browser: PLATFORM=cutshort PLATFORM_STUB=1 npm run platform-worker
module.exports = require('../shared/stub').makeStub(require('./meta'));
