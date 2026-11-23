# Agently platform security and reliability audit — 20 October 2026

**Subsequent remediation:** see [Immediate containment and session security release](SECURITY-RELEASE-2026-10-20.md) for deployed fixes, current session limits, tests and remaining work. Findings below describe the pre-remediation audit snapshot.

## Assessment

**The platform is operating, but it is not ready for an unrestricted production launch.** The most urgent problems are authorization boundaries and publicly granted database privileges. Scaling and caching improvements follow those fixes.

This was a read-only production audit: live AWS service configuration, Supabase catalog/function/view definitions and advisors, public HTTP response headers, source inspection, dependency-registry checks, and an offline authentication reproduction. No destructive function, forged provider callback, paid voice session, production load test, or customer-facing message was executed. Production settings were not changed. Frontend changes remain local.

The API source files cited below match the file hashes in the deployment-50 manifest. This is stronger than inspecting an unrelated checkout, but is not an independent extraction of the running container filesystem. Worker image 11 is older and has not been certified against the current voice source.

## Priority findings

### P0 — Public database privileges cross the application boundary

Live Supabase advisors report **58 views using owner privileges** and **12 SECURITY DEFINER functions executable by anon**, also executable by authenticated.

Catalog queries independently confirmed anonymous SELECT on 45 billing_admin views. For example, billing_admin_user_organization_usage is owned by postgres, has no security_invoker setting, and selects user names, emails, organization IDs and billing data without a caller-specific filter. billing_admin_wallet_overview similarly exposes organization-level wallet information.

Live definitions of billing_admin_charge_usage_event and billing_admin_delete_user_or_org_everything have anonymous EXECUTE grants and run as their owner. The inspected bodies have no caller authorization check. The deletion function's confirmation text is a confirmation guard, not authentication. Neither function was executed during this audit.

All **104 public base tables have RLS enabled**. That does not neutralize owner-privileged views or functions. The 103 “RLS enabled, no policy” informational notices represent deny-by-default tables for ordinary roles, not 103 proven data leaks. The service-role backend bypasses those policies, so route isolation still matters.

**Remediation:** revoke PUBLIC/anon/authenticated privileges from internal administrative views and functions while preserving required service_role access; inspect all 58 views and 12 functions; correct default privileges so future objects do not reopen access. Review dependencies before changing view execution mode. Prove denial through the Data API and test tenant A/B isolation. Review available access logs for possible prior use; this audit does not establish whether misuse occurred.

Sources: [Supabase view/RLS behavior](https://supabase.com/docs/guides/database/postgres/row-level-security), [view advisor remediation](https://supabase.com/docs/guides/database/database-linter?lint=0010_security_definer_view), [anonymous function advisor remediation](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable).

### P0 — Recording callbacks can select a URL that receives Twilio credentials

api/routes/twilio.js:1984 mounts recording-status without signature middleware. The handler uses supplied CallSid to find a real record and passes supplied RecordingUrl to downloadTwilioRecordingMp3. At line 242 that function sends the platform's Twilio Basic Authorization header to the supplied URL without an allowlist.

Combined, this creates a credential disclosure/SSRF path if an attacker obtains a valid call SID. It also permits false recording metadata. This was established from deployed-matching source; it was not exploited.

Other public Twilio status/TwiML routes likewise have no signature validation found in the mounted request path. The configurable twilio_validate_requests setting is serialized and stored, but no enforcement was found.

**Remediation:** verify Twilio signatures before side effects, resolving the correct account/subaccount token and canonical external URL. Resolve recording media using a verified provider recording SID/account instead of trusting a URL; require HTTPS/provider hosts, constrain redirects, bound download size/time, and never forward credentials to arbitrary hosts. Review exposure before deciding on credential rotation and coordinate rotation with number/webhook configuration.

Source: [Twilio signed-request validation](https://www.twilio.com/docs/usage/security).

### P1 — A webcall token is accepted as a full account session

lib/auth.js:200 rejects pending tokens, but does not require a session token type. It checks auth_sessions only when sid exists. api/routes/webcall.js:301 issues purpose=webcall tokens containing userId/orgId, signed with the same secret, without sid/sev.

An offline test with synthetic users and a stub database reproduced:
- acceptedAsGeneralSession: true
- hasServerSessionId: false
- no network or customer credentials used

This is a purpose-boundary failure, not a demonstration that arbitrary unsigned tokens work. A leaked webcall token can obtain general account API access for eligible users (the reproduction used session_epoch=0), instead of being restricted to a call. The acceptance is limited by token expiry and other account checks.

**Remediation:** require the exact session type and a valid, user/org-bound session record; reject purpose-scoped tokens at the general API boundary. Remove or explicitly time-bound legacy sid-less token compatibility. Add negative tests for every token purpose and logout/password-reset cases.

Reproduction: agently-ops/audit-session-boundary-20261020.js.

### P1 — Public voice WebSockets have inconsistent admission controls

agently-ws-server/ws-server.js:480 accepts upgrades to provider paths and /realtime without authentication at the upgrade boundary. Provider Media Streams signature validation was not found downstream.

lib/realtime-proxy.js:140 takes organization/chatbot context from query parameters, accepts a client system prompt, and opens a paid OpenAI connection at line 228. No token check, wallet admission check, shared abuse limiter, or application maximum session duration was found in that handler. Even the init-message timeout falls back to defaults and proceeds.

The separate /api/webcall/stream handler does validate a purpose-scoped token and wallet credit. Those protections do not protect /realtime.

**Remediation:** validate provider signatures for provider connections; require scoped admission for public browser voice, derive tenant ownership on the server, apply shared rate/spend/concurrency controls and hard duration limits, bound frames and reject idle unauthenticated sockets before opening paid connections. Audit all paths, including API-attached WebSockets.

Source: [Twilio Media Streams authentication requirement](https://www.twilio.com/docs/global-infrastructure/firewall-configurations/media-streams-configuration).

### P1 — Logout/revocation may report success after database errors

lib/auth-sessions.js:187 and :208 await Supabase updates without checking returned error fields. Supabase query failures normally return an error object rather than throwing. A failed revocation can therefore be followed by a successful logout response. The epoch increment is also a read-then-write operation rather than an atomic increment.

**Remediation:** check all revocation errors, make global revocation transactional/atomic, verify row ownership, and report retryable failure when revocation was not persisted. Test partial database failure. The live session-row check is a useful existing protection; preserve it.

### P1/P2 — Runtime and dependencies need a reviewed update

Dockerfiles target Node 20, which is now end of life. Upgrade to a currently supported release, verify native/document-processing dependencies and voice behavior, and pin a reviewed image digest.

Production-dependency audits of the local lockfiles returned:
| Repository | Critical | High | Moderate | Low |
|---|---:|---:|---:|---:|
| API | 1 | 1 | 3 | 0 |
| Voice | 1 | 6 | 4 | 1 |
| Frontend | 0 | 3 | 0 | 0 |

Examples include proxy-addr in both backends, ws/document-processing dependencies in voice, and react-router dependencies in frontend. These are registry advisories, not proof that every advisory is exploitable in this application. The API lockfile matches the deployment manifest; installed contents of every running image were not independently audited. Some document-parser findings have no automatic fix. Do not run an indiscriminate forced audit fix.

Source: [Node.js release support status](https://nodejs.org/en/about/eol).

## Session limits: current behavior

Live AWS contains no overrides for ordinary AUTH_SESSION_* settings, and no Secrets Manager override is configured. The deployed source defaults therefore apply.

| Control | Current behavior | Gap |
|---|---|---|
| Dashboard inactivity | 14 days | Long exposure on a shared/stolen unlocked device |
| Absolute login lifetime | 30 days | Appropriate only with deliberate device/persistence policy |
| Activity timestamp writes | At most every 15 minutes | Shortening idle policy also requires shortening touch interval |
| Session row | Checked live on each request when sid exists | Legacy/scoped sid-less acceptance bypasses this |
| User/org profile cache | 45 seconds; maximum about 2,000 entries per process | Role/account/epoch changes may be stale during cache lifetime |
| Logout / logout all | Routes and revocation records implemented | Returned database errors are not consistently enforced |
| Concurrent signed-in devices | No enforced maximum found | Needs an explicit policy and session/device controls |
| Super-admin | Separate token/secret, TOTP enforcement, 30-minute source default | Live override/device revocation behavior not fully recertified |
| Authenticated webcall | 5-minute session default; nominal 1 per organization | Concurrency is process-local and checked before later asynchronous work |

With two voice nodes, the nominal one-call limit is not platform-wide; simultaneous admission on one node can also race because counting happens after asynchronous context loading.

Suggested product policy: a 30–60 minute dashboard inactivity lock, a separate remembered-device mechanism, shorter privileged access with reauthentication for billing/credential/deletion actions, and a deliberate concurrent-device allowance (for example, three). These are proposed settings, not settings applied during this audit. Preserve the requirement that ordinary users should not need password+OTP every time they reopen the app.

Sources: lib/auth-sessions.js, lib/auth.js, api/routes/auth.js, lib/super-admin-auth.js, voice lib/webcall-stream.js; [OWASP session guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Load balancing, caching and weak connections

| Area | Verified state | Implication / next action |
|---|---|---|
| Voice service | Lightsail small, scale 2, deployment 20 | Built-in load balancing exists; two replicas do not make local counters shared |
| API + worker | Lightsail nano, scale 1, deployment 50 | One compute node is a capacity/availability bottleneck; API and worker compete for it |
| Autoscaling | Fixed live scale inspected; automatic scaling policy not verified | Define capacity targets and scaling procedure; do not claim automatic demand-based scaling |
| Region placement | Backends us-east-1; database eu-central-1 | Cross-region round trips accumulate on auth/retrieval/billing paths; measure latency before regional migration |
| Shared cache | No Redis/Valkey/Memcache configuration found | Not inherently a vulnerability: login/public-chat counters already use atomic Postgres RPCs |
| Cache correctness | Profile/precall caches are process-local | Keep keys tenant-scoped, bounded, short-lived and invalidate after writes; do not cache authorization truth |
| Static assets | Frontend source config caches hashed assets for a year | Appropriate; personalized API data needs a consistent private/no-store policy |
| Public chat | Shared per-IP/per-bot counters and daily spend brake exist | Good protection on HTTP chat; bypassing WebSocket paths must use equivalent enforcement |
| Billing poller | No BILLING_TRACKER_ENABLED=false override on voice; source defaults on, with only a process-local overlap guard | Both voice replicas are configured to poll; separate worker ownership and cross-node exclusion need verification |
| Outreach scheduler | Disabled in live AWS containers | Scheduled-call functionality needs an identified active owner/external schedule and a production acceptance test |
| Shutdown/readiness | Voice SIGTERM calls server.close; /health sends HTTP 200 even when reporting degraded billing | Explicit WebSocket draining, bounded shutdown and readiness semantics need testing |
| Alerting | HEALTH_ALERTS_ENABLED absent; source enables only for exact true | Built-in email alerter is unarmed; independent external monitoring was not verified |

Redis is optional. Atomic Postgres leases/reservations may be sufficient for this stage. Shared admission control and job ownership are required regardless of which storage is chosen. Do not solve the API bottleneck by scaling every background poller along with the API.

AWS reference: [Lightsail container nodes and load balancing](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-container-services.html).

## Frontend and database hardening

- Live /login returns HSTS, but no Content-Security-Policy, X-Frame-Options or X-Content-Type-Options headers. The account token is stored in localStorage in frontend source, increasing the consequence of any script injection. This is a hardening gap, not proof of an existing XSS exploit.
- API baseline HSTS/nosniff/frame protection is present. Its CSP is a framing restriction, not a complete script policy.
- Production explicitly allows localhost browser origins. That is a development exception and broadens trusted browser origins; it does not itself grant an unauthenticated caller an account token. Establish a real staging environment, then remove the exception.
- Supabase performance advisors flag 44 unindexed foreign keys, 26 duplicate indexes and 4 tables without primary keys. Inspect query plans and write cost before choosing indexes to add/drop. 83 unused-index notices are not permission to delete all those indexes.
- RLS and service-role API design need separate tenant-isolation tests across data, files, recordings, tools and billing. Enabled RLS alone does not certify backend queries.

## Work still unfinished or unverified

1. Close database privilege exposure, recording callback URL/signature handling, scoped-token acceptance and public voice admission.
2. Harden session revocation and device controls; agree policy before enforcing shorter sessions.
3. Upgrade runtime/dependencies with regression tests and rollback images.
4. Separate background workers, establish one billing/schedule owner and durable job/concurrency claims.
5. Establish staging with test provider credentials and isolated data; keep frontend deployment local as requested.
6. Verify external alerts, dependency failures, callback failure/retry behavior and incident escalation without sending unapproved test messages.
7. Verify actual backup retention/PITR and restore to an isolated target; include recording/storage objects. Database backups do not themselves restore stored audio files. [Supabase backup scope](https://supabase.com/docs/guides/platform/backups).
8. Run controlled capacity, failover and WebSocket draining tests in staging; record sustainable concurrent calls, API latency/error rate, database saturation and provider quotas. No supported concurrent-call capacity can be honestly quoted yet.
9. Finish a real inbound/outbound/transfer acceptance call, verify all parties' recording/transcripts and billing once each; recent code tests do not complete that human acceptance check.
10. Recertify mobile session behavior, legal/data-retention controls, account export/deletion, onboarding/support and the agreed launch scope. September's 54-item board is historical, not a current count of unfinished defects.
11. Commit and review exact release sources, verify CI and persist backend/worker image-to-source mapping. A deployment from a dirty worktree with a manifest is traceable, but still needs a reproducible release process.

## Recommended sequence

**Immediate containment:** database administrative grants → Twilio signatures and trusted recording media → token purpose boundary → public voice admission.

**Then:** session failure handling and device policy → runtime/dependency upgrades → worker ownership/shared reservations → API resilience and region/cache measurement → restore/load/failover proof → real call and launch acceptance.

No evidence of prior compromise was established by this audit. Absence of that evidence is not a finding that these paths were unused.

