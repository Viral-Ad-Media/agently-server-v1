"use strict";

// Compatibility alias. ws-server.js requires "./lib/billing-tracker" (hyphen),
// which is the real implementation. Some older code paths referenced the
// underscore spelling; this keeps both working so a future rename can't
// silently break the billing gate again.
module.exports = require("./billing-tracker");
