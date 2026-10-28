'use strict';

// Wellfound without a browser: PLATFORM=wellfound PLATFORM_STUB=1 npm run platform-worker
module.exports = require('../shared/stub').makeStub(require('./meta'));
