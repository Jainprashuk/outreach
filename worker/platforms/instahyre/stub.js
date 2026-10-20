'use strict';

// Instahyre without a browser: PLATFORM=instahyre PLATFORM_STUB=1 npm run platform-worker
module.exports = require('../shared/stub').makeStub(require('./meta'));
