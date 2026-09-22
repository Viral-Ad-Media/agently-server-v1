# Authentication failure verification

## Local checks

Run `npm test` and `npm run lint` from `agently-server`. Tests use the real mail and limiter source with isolated dependencies; they do not send emails or touch a database.

## Expected behavior

| Situation | Expected outcome |
|---|---|
| Limiter database unavailable or returning malformed data | Affected auth request stops with 503, `AUTH_TEMPORARILY_UNAVAILABLE`, retryable true, and 30-second retry guidance. |
| Database healthy but attempt limit exhausted | 429, `RATE_LIMITED`, with the remaining wait. |
| Limiter recovers and counter allows request | Request proceeds without restarting the API. |
| Email provider rejects a verification/login code | 502, `EMAIL_DELIVERY_FAILED`; code invalidated and no successful-send usage event. |
| Email provider accepts a code | Normal code flow; message identifier logged, but no OTP subject, raw provider response or arbitrary credential metadata. |
| Email usage logger fails after acceptance | Send remains successful to avoid prompting duplicate sends. |

## Release verification

1. Record the reviewed source revision and deployed image before testing.
2. In an isolated staging deployment, simulate a rate-limit RPC failure using staging-only fault injection or database permissions. Keep production credentials and customer data out of this environment.
3. Exercise login, registration, code resend/verification and password reset. Confirm failed limiter requests stop before credential checks or email side effects, and that web/mobile clients display an actionable temporary error.
4. Restore the staging limiter. Confirm a permitted request succeeds and an exhausted counter still returns 429. Confirm existing sessions were not revoked by the limiter change.
5. Simulate provider email rejection in staging. Confirm both verification and login-code flows return the documented error, invalidate the issued code and do not record a successful send.
6. With an authorized test mailbox, verify the normal code flow and sanitized usage metadata after deployment. Provider acceptance alone does not prove inbox delivery; bounce handling is tracked separately as em2.
7. Record environment, revision, time, results and remaining issues in the workspace launch tracker. Never include OTPs, access tokens or credentials in evidence.

Rollback uses the previously verified API image through the existing deployment process. Reverting the limiter reintroduces the known unthrottled outage behavior; consider that tradeoff explicitly. This document does not authorize a deployment, live database disruption, or historical data deletion.
