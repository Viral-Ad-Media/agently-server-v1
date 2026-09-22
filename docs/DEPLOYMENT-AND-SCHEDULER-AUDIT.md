# Deployment and scheduler audit

Read-only AWS evidence collected 22 September 2026 in profile `agently`, region `us-east-1`. No deployment, scheduler, provider or customer-data writes were performed.

## Live artifact map

| Component | Service / container | Deployment | Image | Evidence limit |
|---|---|---|---|---|
| REST API | agently-ingest / api | 13 | :agently-ingest.api.14 | Source commit not proven |
| Ingestion worker | agently-ingest / ingest-worker | 13 | :agently-ingest.ingest-worker.11 | Source commit and running job behavior not proven |
| Voice | agently-calls / ws-server | 8 | :agently-calls.ws-server.12 | Source commit and running job behavior not proven |
| Web frontend | Local Vercel configuration | Unverified | Unverified | Local default API points to Lightsail; deployed build/override still needs inspection |

Both AWS services reported RUNNING. API public endpoint is container `api`; voice public endpoint is `ws-server`. RUNNING is not a feature or billing certification.

Local revisions inspected: API `e1eafab` plus pending changes, frontend `bcb992b` plus pre-existing and pending changes, voice `9570bc0`. Do not label these as deployed revisions without artifact evidence.

## Scheduled work

| Work | Local source | Observed configuration | Remaining check |
|---|---|---|---|
| Vendor rates, provider resources, organization full costs | API `/api/billing-usage/vendor-rate-sync/cron` | Backend Vercel config declares daily 06:00 UTC | Identify actual Vercel/external scheduler and successful runs |
| API Twilio billing sync | API `/api/twilio/_internal/billing-sync` | Backend Vercel config declares daily 02:00 UTC, but API tracker exports no `runOnce` | Resolve whether this endpoint is required before scheduling it |
| Per-number Twilio polling | Voice repo `lib/billing_tracker.js`, started by `ws-server.js` | Source defaults ON every 30 seconds unless `BILLING_TRACKER_ENABLED=false`; flag absent from all three live container environments | Verify image contents and actual execution; establish exactly one intended owner |

AWS EventBridge `list-rules` and Scheduler `list-schedules` returned empty lists in the checked region. This does not exclude another region/account, Vercel, database jobs, external schedulers, or process-local intervals.

The voice tracker comment recommends disabling it on call containers and keeping it on the ingestion worker. This is source intent, not confirmed deployment state. Its `_running` guard is process-local, so it cannot prevent two replicas/services polling the same records. Do not copy the worker into the API or enable more schedules merely to make the cron return success.

## Local mitigation and verification

Confirmed N003: the API route called `runOnce()` on a placeholder that only exports `start()`. Before this change, authenticated invocations would throw and return 500. If a future implementation returned a promise, the old fire-and-forget call would acknowledge before completion and bypass its asynchronous failure handler.

The route now uses `lib/billing-sync-handler.js`: retains existing credential methods, returns explicit 503 `BILLING_SYNC_UNAVAILABLE` when no worker exists, awaits an installed worker, and returns a sanitized 500 on rejection. This does not implement billing aggregation, prove its accuracy, or prevent cross-process duplicates. An installed worker must also propagate its internal failures; the voice implementation currently catches some errors internally.

Verification: 35 backend tests pass, including unauthorized access, the actual placeholder module, both credential methods, deferred completion, synchronous and asynchronous failures, and error redaction. Syntax validation passed for 130 JavaScript files. No live cron was invoked.

## Release gates

### Follow-up evidence and worker safeguard

- AWS image inventory confirms the live voice and ingestion-worker tags share digest `sha256:7e13ea91979998fcdfb3bf66185a69c44badd84762a206ea7873cf3779fa91c6`. `agently-calls` has scale 2; `agently-ingest` scale 1. This proves shared image content across three replicas, not which billing code is inside or that polling succeeds.
- The API image digest is `sha256:3d0d18da4cc25699abfaef42ca5b0d06a26db47312ca280ae892f3038dbb1e2a`. Inspected local Docker image digests did not match these registry digests; no source equivalence was inferred from tag names.
- Log queries for both worker containers from `2026-09-21T22:22:01Z` returned zero events and no next-page token. Absence of these logs is not evidence of absence of polling. Only aggregate counts were printed; no customer content was exported.
- The Vercel CLI has no existing login credentials. Its login prompt was stopped; the user must complete `vercel login` before remote scheduler inspection can continue. Local Vercel configuration alone does not prove an active schedule.
- Additional finding N004: the voice-repo worker swallowed failed Twilio call-page requests and could write partial call-cost totals over stored totals. It also silently truncated results at 20 pages per direction. The local fix skips the agent update on failed/malformed call pages or an unfinished pagination limit, preserving prior values until a complete pass succeeds. Failure logs for this path omit phone numbers and provider response bodies.
- Five isolated worker tests pass on Node 24 and a temporary Node 20 runtime, covering failure on the first/later page or second direction, network/404/malformed data, the pagination cap, successful scoped writes, and recovery. Added a Node 20 worker CI workflow; remote execution is not yet verified. No Twilio requests or database writes occurred in these tests.
- This safeguard does not settle scheduler ownership, rental-cost estimation, billing-period semantics, call-price completeness or full-ledger correctness. It has not been deployed.

### Remaining release steps

1. Tie the API/worker/voice images and frontend build to reviewed source revisions; preserve existing deployment/environment settings without exporting secrets into evidence.
2. Inventory Vercel and any other scheduler executions, plus the actual worker process configuration and replicas. Inspect only sanitized logs/evidence.
3. Confirm one owner for per-number polling and one owner for daily vendor/resource/reconciliation work. Prepare an explicit deployment/configuration change for approval; do not disable all owners during transition.
4. Verify isolated billing correctness, retry/idempotency, partial-failure visibility and rollover before enabling or moving jobs. The API placeholder is not an acceptable production worker.
5. Confirm successful runs and ledger reconciliation after the approved release, then retire redundant schedules. Keep the Vercel frontend protected when reviewing legacy API retirement.
