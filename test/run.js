"use strict";
// node:test runs these registered tests without spawning subprocesses.
require("./email.test");
require("./auth-rate-limit.test");
require("./email-delivery.test");
require("./billing-sync.test");
require("./super-admin-client-ip.test");
require("./safe-fetch.test");
require("./secrets.test");
require("./logger.test");
require("./account-data.test");
require("./webhook-monitor.test");
require("./call-outcome.test");
require("./public-abuse-limits.test");
require("./health-alerts.test");
