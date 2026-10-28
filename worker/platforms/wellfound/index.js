'use strict';

// The real Wellfound driver: the shared job-site driver (../shared/driver.js)
// configured by ./meta.js. Same contract as worker/naukri/stub.js.
module.exports = require('../shared/driver').makeDriver(require('./meta'));
