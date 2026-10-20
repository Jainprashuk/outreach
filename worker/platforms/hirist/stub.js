'use strict';

// Hirist without a browser: PLATFORM=hirist PLATFORM_STUB=1 npm run platform-worker
module.exports = require('../shared/stub').makeStub(require('./meta'));
