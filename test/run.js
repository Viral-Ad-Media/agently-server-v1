"use strict";
// node:test runs these registered tests without spawning subprocesses.
require("./email.test");
require("./auth-rate-limit.test");
require("./email-delivery.test");
require("./billing-sync.test");
