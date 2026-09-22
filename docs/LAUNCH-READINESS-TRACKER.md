# Agently launch readiness tracker

Created 21 September 2026. This is the working checklist for remediation and final review, not a certification that the application has no defects.

## Baseline and counting

Source: `C:/Users/DELL/Downloads/Agently Launch Gate_files/_t.html`, saved alongside `Agently Launch Gate.html`.

The embedded `board-seed` data has 54 open critical items: 45 todo, 4 untested, 3 in progress and 2 blocked. The saved rendered HTML has 52 open critical rows: it omits a1, s6 and s7 from that set and includes g4 instead. Preserve the original 54 below and add g4 separately; do not silently discard conflicting rows. Original IDs are retained for traceability.

All 54 remain open for our review. Source inspection already contradicts some old findings (including the single-row store and missing compiled Tailwind). Implementation found in source is not deployment or runtime proof.

The board also contains noncritical backlog and previously completed items. These are outside the original 54 count, but relevant ones must be considered in final regression review. Newly discovered defects are added below; they are never hidden by retaining a fixed denominator.

## Status and closure rules

- VERIFY: original finding needs validation against current source and deployment.
- FIX: confirmed defect awaiting implementation.
- IN PROGRESS: work exists but closure evidence is incomplete.
- INPUT: requires a product decision, account action, real participant or external reviewer.
- VERIFIED: closure evidence recorded with date, environment and version.
- NOT APPLICABLE: documented evidence and confirmed launch scope establish that the requirement does not apply. This is reported separately from verified fixes.

Moving an item to a later phase, accepting a risk or disabling an advertised feature does not automatically close it. A change of scope needs an explicit decision and verification that UI, marketing and runtime behavior match it. No item is closed merely because code exists, a syntax check passes or a tool call was attempted.

Owner key: Engineering = assistant implementation and verification; Shared = assistant preparation plus user decision/access/live participation; External = qualified reviewer or provider approval, coordinated by user.

## Original 54 open critical items

| # | ID | Item to resolve | Owner | Status | Required closure evidence |
|---|---|---|---|---|---|
| 1 | i10 | Decide auth rate limiter behavior during database failure | Shared | IN PROGRESS | Fail-closed implementation and isolated outage/recovery tests pass; deployed verification remains. |
| 2 | mb4 | Handle expired or revoked mobile sessions | Engineering | VERIFY | Device tests clear invalid credentials and return to sign-in without loops or silent failures. |
| 3 | mb5 | Exercise voice and chat from mobile | Shared | VERIFY | Real device tests cover conversation, failure/retry and corresponding server records. |
| 4 | mb6 | Distribute through TestFlight and Play internal testing | Shared | INPUT | Accepted builds installed and exercised by an external tester on each supported platform. |
| 5 | em1 | Reject provider email errors instead of reporting success | Engineering | IN PROGRESS | Local fix and 12 regression tests pass; deployment and controlled live confirmation remain. |
| 6 | em2 | Handle email bounces and suppression | Shared | IN PROGRESS | Signed receiver, pre-send guard and support response tested locally on Node 20; isolated PostgreSQL checks pass. Target Supabase/live provider/recovery checks remain. |
| 7 | t1 | Replace single shared state with tenant tables | Engineering | VERIFY | Current schema and deployed queries verified; two-tenant isolation tests cover relevant data. |
| 8 | t2 | Support multiple organizations | Engineering | VERIFY | Independent registrations create distinct organizations and cannot take over existing workspaces. |
| 9 | t3 | Associate all tenant records with their workspace | Engineering | VERIFY | Schema/query audit plus tests for leads, calls, agents, chatbots, members and sessions. |
| 10 | t4 | Use scoped writes and prevent concurrent lost updates | Engineering | VERIFY | Concurrent callback/write tests preserve records and prevent duplicate side effects. |
| 11 | t5 | Verify tenant database access policies | Engineering | VERIFY | Actual deployed policies/grants reviewed; cross-tenant and anonymous access rejected; service-role routes tested separately. |
| 12 | v1 | Verify inbound webhook and conversation flow | Engineering | VERIFY | Current voice architecture identified; signed callback tests cover greeting, turns, logs and leads. |
| 13 | v2 | Verify outbound initiation and callbacks | Engineering | VERIFY | Authorized initiation and status lifecycle tests; retries and duplicate callbacks behave correctly. |
| 14 | v5 | Protect stored Twilio credentials | Engineering | VERIFY | Current credential storage/read paths assessed; encryption/key handling and redaction verified where applicable. |
| 15 | v6 | Complete a real inbound telephone call | Shared | INPUT | Live call to an owned test number produces correct audio, transcript, lead/log and usage records. |
| 16 | v7 | Complete a real outbound call including machine detection | Shared | INPUT | Authorized test recipient and voicemail scenarios produce correct outcomes and metering. |
| 17 | v8 | Verify transfer and voicemail fallback | Shared | INPUT | Live successful/failed transfer and fallback scenarios complete without dropped or looping calls. |
| 18 | v9 | Decide recording policy and implement consent behavior | Shared / External | INPUT | Approved policy for intended markets reflected in greetings, recording controls, storage and retention tests. |
| 19 | a1 | Decide and validate the answering engine | Shared | VERIFY | Current engine documented, intended capabilities agreed and representative answers evaluated. |
| 20 | a2 | Match marketing claims to shipped capabilities | Shared | VERIFY | Claims inventory checked against passing feature tests; unsupported claims corrected. |
| 21 | a4 | Build answer-quality evaluation questions | Shared | INPUT | Representative questions and expected answers per launch vertical; agreed pass criteria and recorded results. |
| 22 | a5 | Deliver booking or remove unsupported booking claims | Shared | INPUT | Confirmed scope; real calendar booking/cancellation tests if offered, otherwise consistent accurate product wording. |
| 23 | b9 | Verify Stripe credential permissions | Shared | VERIFY | Required operations validated safely; no credential values logged; live-specific permissions checked separately. |
| 24 | b1 | Verify payment processing end to end | Shared | VERIFY | Payment, authenticated webhook, fulfillment and ledger reconciliation proven; approved live test where needed. |
| 25 | b2 | Make plan changes produce correct charges | Shared | VERIFY | Agreed billing model tested for upgrade/downgrade, failed payment and duplicate delivery; ledger reconciles. |
| 26 | b3 | Provide correct invoices or receipts | Shared | VERIFY | Successful transactions produce accessible, accurate tenant-scoped documents with correct amounts and references. |
| 27 | b4 | Enforce usage limits and credit rules | Engineering | VERIFY | Boundary, exhaustion and concurrent-usage tests reject disallowed work while preserving accurate usage. |
| 28 | b5 | Handle billing period rollover | Engineering | VERIFY | Clock-controlled tests prove correct boundaries, counters/queries, retries and no duplicate charges. |
| 29 | b6 | Validate pricing against actual operating costs | Shared | INPUT | Measured usage/cost reconciliation and user-approved prices/margins; assumptions documented. |
| 30 | c3 | Enforce widget origin policy | Shared | VERIFY | Intended embedding policy defined; allowed/disallowed origin tests pass. CORS is not treated as authentication. |
| 31 | c4 | Add public chat abuse and cost controls | Engineering | VERIFY | Rate, payload and spend limits tested, including failure behavior and concurrent requests. |
| 32 | p12 | Reconcile audited source with deployment | Shared | IN PROGRESS | Frontend/API/voice/worker versions and routing mapped to actual deployed artifacts; stale evidence flagged. |
| 33 | p1 | Establish CI in both repositories | Shared | IN PROGRESS | Workflows checked in to intended repositories and successful remote runs demonstrated; meaningful tests included as developed. |
| 34 | p13 | Safely retire legacy Vercel API | Shared | INPUT | Dependency/cron inventory, verified Lightsail Stripe delivery and fulfillment, rollback preparation, then explicit retirement approval. Protect frontend project. |
| 35 | p3 | Test backend database behavior against Supabase | Engineering | VERIFY | Isolated test database exercises actual queries, policies and transactions; no production test contamination. |
| 36 | p5 | Eliminate silent production JSON fallback | Engineering | VERIFY | Current persistence path inspected; missing database configuration fails visibly with no ephemeral writes. |
| 37 | p6 | Add error tracking and useful logs | Shared | VERIFY | Controlled failures reach monitoring with correlation IDs and useful context; credentials/customer content redacted. |
| 38 | p7 | Monitor callback and voice processing health | Shared | INPUT | Synthetic/failure checks trigger actionable alerts and demonstrate recovery notification. |
| 39 | p8 | Establish backups and prove restoration | Shared | INPUT | Backup configuration confirmed and isolated restore rehearsed; recovery time/data loss measured against agreed targets. |
| 40 | p10 | Protect service and carrier secrets operationally | Shared | VERIFY | Secret inventory/storage/access/rotation verified; builds exclude secret files and logs redact values. |
| 41 | p11 | Load-test concurrent voice callbacks | Shared | INPUT | Approved isolated workload meets agreed latency/error targets with no lost records or duplicate billing. |
| 42 | s6 | Obtain outbound-calling legal review | External | INPUT | Qualified counsel reviews actual launch markets, calling flow and consent/opt-out behavior; required actions resolved. |
| 43 | s7 | Complete applicable carrier registrations | Shared / External | INPUT | Applicability established for actual features/markets and required provider approvals evidenced. |
| 44 | s1 | Obtain independent security review | External | INPUT | Independent reviewer assesses deployed scope and fixes are retested; internal assistant review alone does not close this. |
| 45 | s2 | Harden website import against SSRF | Engineering | VERIFY | Private/reserved destinations, redirects, DNS changes and alternate address encodings tested across all fetch paths. |
| 46 | s3 | Publish an accurate privacy policy | Shared / External | INPUT | Actual data flows, processors, retention and requests documented; approved text published and checked. |
| 47 | s4 | Publish suitable telephony/billing terms | Shared / External | INPUT | Commercial terms and supported usage approved, consistent with product and published. |
| 48 | s5 | Publish subprocessors and prepare a DPA | Shared / External | INPUT | Complete vendor/data-flow inventory and reviewed documents available through the intended customer process. |
| 49 | s8 | Support tenant data export and deletion | Shared | VERIFY | Authorization/isolation tests plus end-to-end export/deletion rehearsal covering storage and retention exceptions. |
| 50 | f3 | Compile Tailwind instead of using runtime CDN | Engineering | VERIFY | Build source and deployed assets checked; no runtime Play CDN; production visual smoke tests pass. |
| 51 | g6 | Decide closed pilot versus paid public launch | Shared | INPUT | User decision specifies audience, markets, platforms, feature scope and paid/free conditions. |
| 52 | g1 | Run three businesses for a 30-day pilot | Shared | INPUT | Named consenting participants, completed observation period, results and all resulting blockers resolved. |
| 53 | g2 | Review a week of real call transcripts | Shared | INPUT | Authorized transcript review completed with privacy controls; recurring failures entered and resolved. |
| 54 | g3 | Establish support with a response commitment | Shared | INPUT | Owner/channel/hours agreed, customer instructions published and support delivery/escalation tested. |

## Additional findings

| ID | Finding | Status | Closure requirement |
|---|---|---|---|
| g4 | Twilio onboarding documentation is critical in the saved rendered snapshot but not in the embedded baseline | INPUT | Document the current provisioning model and have a new tester complete onboarding using it. |
| N001 | Duplicate `crons` keys in backend Vercel configuration discard the first schedule when parsed | IN PROGRESS | Local config now retains both jobs. Establish the intended scheduler owner on the current deployment and verify it; do not deploy this blindly alongside AWS jobs. |
| N002 | Authentication email subjects containing OTPs were persisted in email usage metadata | IN PROGRESS | Local redaction tests pass. Deploy, verify newly emitted records omit credentials, then review historical metadata retention through an approved cleanup process. |
| N003 | API Twilio billing cron calls a missing worker; scheduler ownership remains unverified | IN PROGRESS | Explicit unavailable response and async completion handling tested locally. Verify actual worker/source and one scheduler owner, resolve obsolete endpoint or implement required worker, deploy and reconcile billing results. |
| N004 | Worker can overwrite stored call-cost totals with partial provider results | IN PROGRESS | Failed/malformed pages and unfinished pagination now prevent writes; five local worker tests pass. Deployed verification and full billing reconciliation remain. |

Current accounting: 54 original items awaiting closure evidence + 1 additional board item + 4 newly discovered findings. No final closure has been claimed in this tracker.

## Existing work and evidence limits

- Local CI workflow files added in `agently/.github/workflows/ci.yml` and `agently-server/.github/workflows/ci.yml`. No successful GitHub run evidenced yet.
- Backend placeholder lint replaced with a syntax checker; previous run passed for 123 JavaScript files. This is syntax validation, not behavioral or security testing.
- Previous frontend TypeScript check completed, but a full production build was not conclusively verified. The escalated attempt showed transformation starting; the observed `dist/index.html` was older than that attempt. Re-run with a reliable completion/exit result before claiming build success.
- Previous source inspection found organization-scoped Supabase tables/queries and billing/voice infrastructure. Deployed schema, complete tenant isolation and live feature behavior remain to be verified.
- Existing frontend changes belong to the user/other work and must be preserved.
- Downloads originals have not been edited.

## Execution sequence

1. Establish the launch scope (g6) and deployment/source map (p12). Capture a clean baseline of builds, tests and source revisions.
2. Reassess every original finding. Record current evidence and distinguish confirmed defects from outdated descriptions. Start external coordination early through the user.
3. Resolve confirmed access/data protection, authentication/email, secrets and SSRF defects first, with focused regression tests.
4. Verify billing, metering and provider integration, then voice/chat/booking and mobile behavior. Prepare specific live test steps for the user where needed.
5. Complete monitoring, restoration, load testing, policies, onboarding and support; run the agreed pilot.
6. Final review on identified release versions: revisit all 54 items and additions, rerun appropriate tests and inspect deployment health. Reopen anything that fails.

## User input procedure

For each input-dependent item, prepare: the finding and evidence; the exact choice/action required; a recommended option and tradeoffs; clear steps the user can follow; and the verification that follows. Ask for input when it becomes necessary, while continuing independent engineering work. Never ask the user to paste secrets into chat.

Final acceptance means zero unresolved items within the agreed scope, with verified evidence and separately disclosed exclusions. It cannot guarantee absence of every possible future defect. External approvals and elapsed pilot periods remain pending until completed.

## Per-item evidence record

When working an item, append a record here containing ID, finding date, source revision, environment, confirmed behavior, change, test/result, any required user input and closure/reopen decision. Keep verification tied to the deployed release, not merely a local working copy.

### em1 and N002 — 21 September 2026, local implementation

- Environment: local `agently-server` working tree, Node 24.19.0; production and CI Node 20 have not been verified in this pass.
- Confirmed: `sendTrackedEmail` ignored resolved provider errors. The installed Resend SDK explicitly returns `{ data, error }` on API rejection. Callers therefore bypassed their existing error handling and usage was recorded for rejected sends.
- Change: require an error-free provider acknowledgement with a nonempty message ID before logging successful email usage. Throw a generic `EMAIL_SEND_FAILED` error on rejection or malformed acknowledgement, without copying provider details to the error message.
- Confirmed additional finding N002: login/verification subjects include the code, and `logEmailUsage` stores the subject in usage metadata.
- Change: omit subjects and arbitrary metadata for authentication/invitation emails; omit raw provider responses from usage logging. Preserve the provider message ID for reconciliation. Actual customer emails still contain their codes and links.
- Tests: `npm.cmd test` passes 12 isolated regression tests using the actual mail module and authentication delivery function, with stubbed provider/database dependencies. Covers rejected sends, malformed acknowledgements, transport exceptions, successful sends, usage logger failure, credential redaction, and both code flows returning retryable HTTP 502 and invalidating codes when sends fail. No real email or database requests were made.
- CI: added the test command to the existing backend workflow. Remote execution remains unverified.
- Remaining: deploy the reviewed backend changes through the reconciled deployment path; confirm an accepted send and inspect sanitized usage metadata; verify failure handling in a controlled nonproduction environment. Provider acceptance does not prove inbox delivery; bounce handling remains em2.
- Historical records were not inspected or modified. Existing recorded OTPs may remain in metadata and require a scoped retention/cleanup review. Do not print or export those values during investigation.
- Closure: local implementation verified; both items remain IN PROGRESS pending release evidence and the historical-data review for N002.

### i10 — 21 September 2026, decision requested

- Confirmed: `lib/auth-rate-limit.js` allows credential requests when the database RPC fails or returns no row.
- Recommended policy presented to user: temporarily reject affected authentication requests while the limiter is unavailable, with a retryable service-unavailable response. Existing sessions are outside this limiter's scope.
- Subsequently proceeded with the recommended fail-closed policy following the user's instruction to continue, announcing the policy before implementation.
- Change: RPC errors, exceptions, missing/ambiguous rows, nonboolean decisions and malformed retry intervals deny affected credential requests. `enforce` returns HTTP 503 with `AUTH_TEMPORARILY_UNAVAILABLE`, `retryable: true`, `retryAfterSeconds: 30`, and `Retry-After: 30`. Exhausted healthy counters still return 429 / `RATE_LIMITED`.
- Existing authenticated sessions are not revoked by this change. Healthy counters are checked afresh on each request; no restart or manual reset is needed for recovery.
- Logs contain a fixed unavailable-counter message, without raw database errors, email addresses or IP bucket values.
- Verification: nine isolated limiter tests cover every configured policy on RPC errors, thrown failures, malformed responses, normalized healthy requests, ordinary exhaustion, second-policy failure, early termination, immediate recovery and bounded retry intervals. Existing email tests also pass: `npm.cmd test` = 21/21; syntax validation = 126 JavaScript files. The test entry point is `test/run.js` and backend CI already runs `npm test`.
- Source review: all current auth route `enforce` call sites return early when denied. Follow-up found the frontend login replaces 5xx messages with generic retry guidance; it now explicitly handles `AUTH_TEMPORARILY_UNAVAILABLE` and nonretryable `EMAIL_DELIVERY_FAILED` with temporary-outage and address-check/support guidance. Frontend `npm run lint` (TypeScript) passed. No real device/UI outage exercise or actual deployed database outage was performed.
- Remaining: deploy reviewed changes, exercise a controlled limiter failure in staging, confirm the retryable response and recovery in web/mobile flows, and observe logs. Do not disable the live production database to test this. Status remains IN PROGRESS until release evidence is recorded.

### em2 — local implementation and Node 20 verification

- Added raw-body endpoint `POST /api/email/resend/webhook` before the global JSON parser, limited to 256 KB. Uses the official Svix verifier (pinned CommonJS-compatible 1.76.1) for signatures and timestamps.
- Handles signed bounced/complained/suppressed events for `RESEND_FROM_EMAIL`; unrelated senders and nonblocking events cannot clear blocks. Malformed and ambiguous multi-recipient failure events are rejected.
- Added migration `agently-server/migrations/20260921_email_delivery_blocks.sql`: service-role-only hashed-recipient block table and timestamp-ordered atomic upsert. No plaintext recipient, subject, OTP or raw event payload is stored. The new pre-send guard prevents mail to known blocks, including CC/BCC, and fails closed if block storage is unavailable.
- Authentication code flows now provide address-check/support guidance with retryable false for known blocks, while invalidating the issued code. All current backend Resend sends use the guarded mail helper (confirmed by source search).
- `npm exec --yes --package=node@20 -- node test/run.js` passed 31/31 tests. This also reverified em1/N002/i10 on Node 20. Local syntax checks passed for 128 JavaScript files.
- Added a rollback-only SQL test for duplicate/older events, support clearance, subsequent reblocking and client-role grants. On 22 September, Docker became available: migration applied twice successfully against isolated PostgreSQL 16.15, and the SQL test passed as `service_role`, including client read/write/function restrictions and RLS enabled. Fixture count after rollback was zero. The network-isolated, task-owned temporary container was stopped and automatically removed; the downloaded image remains cached. Added a disposable PostgreSQL CI job; remote job success remains unverified.
- Prepared `agently-server/docs/EMAIL-BOUNCE-ROLLOUT.md` with migration-first ordering, webhook setup, safe secret configuration, historical suppression coverage and scoped support recovery.
- Remaining: confirm behavior in the target Supabase environment, reconcile deployment source revision, apply production migration before the new API release, configure Resend's signing secret/events, verify actual provider retry/delivery and recovery, and review historical suppressions. No cloud writes or customer emails were made. em2 remains IN PROGRESS.

### p12 — read-only live AWS evidence

- AWS `get-container-services` confirmed `agently-ingest` state RUNNING, current deployment version 13, API image `:agently-ingest.api.14`, public endpoint container `api`.
- API origin: `https://agently-ingest.zxy7w9w65bv9y.us-east-1.cs.amazonlightsail.com`. This is the candidate origin for `/api/email/resend/webhook` after rollout.
- The query explicitly excluded environment variables and secrets. No deployment changes were made.
- This supersedes older runbook claims that the API is not on AWS, but does NOT yet prove the image's source commit matches local backend HEAD `e1eafab` plus pending changes. Frontend/voice/worker mapping and cron ownership remain open.

### p12, N001 and N003 — 22 September 2026, deployment/scheduler audit

- Read-only AWS inventory confirmed API image `:agently-ingest.api.14` and ingestion-worker image `:agently-ingest.ingest-worker.11` on deployment 13, plus voice image `:agently-calls.ws-server.12` on deployment 8. Both services RUNNING; source commits are not proven.
- EventBridge rules and Scheduler schedules were empty in `us-east-1`; this does not establish absence of Vercel, other-region or process-local jobs.
- Confirmed N003: API billing tracker is a placeholder lacking `runOnce`, which its cron route calls. Added explicit unavailable response, awaited completion for an installed worker and sanitized failure reporting. Actual billing aggregation remains unresolved, not fixed by this mitigation.
- Voice/ingestion source has a separate tracker defaulting enabled every 30 seconds; all three live container environments omit the disable flag. Duplicate polling is a risk requiring artifact/runtime verification, not a proven production incident. No live flags or schedules changed.
- Verification: all 35 backend tests passed; syntax checks passed for 130 JavaScript files; `git diff --check` passed. No live billing endpoint invoked and no provider calls made by the tests.
- Detailed map and release gates: `docs/DEPLOYMENT-AND-SCHEDULER-AUDIT.md`. No findings closed; scheduler ownership and deployed behavior still require evidence.

### N004 and scheduler follow-up — 22 September 2026

- Confirmed in local voice/worker source: provider page errors were caught inside the aggregation loop, returning partial totals as successful data; the 20-page ceiling likewise returned partial totals. These could overwrite last-known per-agent billing values.
- Change in `agently-ws-server/lib/billing_tracker.js`: failed/malformed call pages and incomplete pagination prevent the agent update. The existing outer catch preserves stored values and now logs a fixed message without a phone number/provider body. Later complete passes can recover.
- Five isolated worker regression tests passed on Node 24 and a temporary Node 20 runtime; worker syntax and diff checks passed. A Node 20 worker CI workflow was added, not yet run remotely. Tests use fake provider/database dependencies and do not start the application or contact customers/providers.
- AWS confirmed identical live voice/ingestion image digests, two voice replicas and one ingestion replica. This strengthens the duplicate-polling concern but does not prove the deployed source or successful polling. Recent log queries returned no events.
- Vercel inspection is blocked on CLI sign-in; user asked to run `vercel login`, without sharing tokens. No live schedules/settings/deployments were changed.
- N004 remains IN PROGRESS pending release verification. Rental estimates, billing-cycle semantics, price completeness, cross-process coordination and full reconciliation are not certified by this narrow fix.
