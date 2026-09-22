# Agently launch progress

Last updated: 22 September 2026.

This is the main progress summary for the launch-readiness work. Update it at the end of each work session and whenever an issue changes status, tests run, code is pushed, or a release is verified. This is maintained during our work, not by an unattended monitoring service.

## Current position

- Original launch checklist: **54 issues still awaiting complete closure evidence**.
- Additional items: **1 conflicting board item (g4) + 4 newly discovered findings (N001-N004)**. Total tracked: **59**.
- Fully verified/closed: **0**. Several local fixes are implemented and tested, but not deployed or verified end to end.
- Backend is on **AWS Lightsail**: API and ingestion worker on `agently-ingest`; voice on `agently-calls`. Vercel inspection concerns legacy API cleanup/schedulers, not a move of the backend back to Vercel.
- Current work has been pushed to `launch-readiness-2026-09-22` branches in all three repositories. No merge to `main`, production database migration, AWS deployment, or live scheduler change was performed. Hosting integrations may independently create branch previews; their state has not been inspected.

## Implemented and tested locally

| IDs | Change | Evidence | Still required |
|---|---|---|---|
| em1 | Reject failed/malformed email-provider acknowledgements; do not meter rejected sends | Backend regression tests | Release and controlled send/failure verification |
| N002 | Omit authentication subjects/arbitrary metadata and raw provider results from usage records | Credential-redaction tests | Release and approved historical-data review |
| i10 | Fail closed when authentication rate-limit storage fails; return retryable 503 | Outage, malformed-response and recovery tests | Controlled staging and web/mobile flow checks |
| em2 | Signed bounce/complaint/suppression receiver, hashed-recipient blocks and pre-send checks | Signature/guard tests; PostgreSQL 16.15 migration applied twice; service-role permissions/order/recovery tests passed | Target Supabase migration BEFORE deployment; Resend webhook/secret; live verification and historical suppression review |
| em2 / i10 | Clear blocked-email and temporary-auth-outage messages on login | Frontend TypeScript check; isolated change reviewed | Deployed UI/browser verification |
| N001 | Consolidate duplicate Vercel cron keys | Configuration review | Verify scheduler ownership before enabling/deploying schedules |
| N003 | Explicitly report missing billing worker; await installed worker and handle failures | Four backend test groups | Actual worker/endpoint ownership and billing reconciliation remain unresolved |
| N004 | Preserve stored worker billing totals when call-page fetches fail, are malformed, or hit pagination limit | Five worker tests on Node 20 and 24 | Worker release, reconciliation and broader billing correctness |
| p1 | Add backend, frontend and worker CI workflows; replace placeholder backend lint with syntax validation | Workflows pushed; local validation below | Verify successful remote CI |

## Verification evidence

- Backend: **35/35 tests passed**, syntax checks passed for **130 JavaScript files**; rerun before this push.
- Worker: **5/5 tests passed**, syntax check passed; rerun before this push. Node 20 and Node 24 runs passed in the preceding work.
- Frontend: working-tree TypeScript check passed previously. A full production build of the published snapshot is not yet certified.
- Database: isolated PostgreSQL **16.15** migration/reapplication and transactional regression checks passed; fixtures rolled back to zero rows; disposable container removed. This is not production Supabase proof.
- No real customer emails, calls, billing cron requests or production database writes were used in the regression tests.
- Remote CI and deployment status must be recorded separately; a successful push is not a deployment certification.

## Where we stopped / next work

1. **p5 — database fallback audit:** no local JSON persistence fallback found in inspected API runtime directories; Supabase client throws on missing configuration. Audit is incomplete and has not been marked closed.
2. Confirm source-to-image mapping and one owner for billing polling. AWS voice/ingestion images share a digest across two voice replicas and one ingestion replica; duplicate polling is a risk, not a proven incident.
3. Finish the remaining tenant isolation, SSRF, billing, voice/chat, mobile, monitoring, backup and release checks in the full checklist.
4. Coordinate migration-first email rollout and controlled staging verification. Do not deploy the guard before its database table exists.
5. Obtain the user's launch-scope decisions, provider/account setup and external/pilot evidence when needed. Legal/security review and elapsed pilot requirements cannot be closed by code tests.

Vercel CLI sign-in is optional for continuing AWS/local engineering; it is needed only to finish inspecting legacy Vercel schedules. Do not request or store tokens in this document.

## Repository publication

| Repository | Branch | Included scope |
|---|---|---|
| `Viral-Ad-Media/agently-server-v1` | `launch-readiness-2026-09-22` | Backend fixes, migration, tests/CI and canonical progress documents |
| `Viral-Ad-Media/agently-ws-server` | `launch-readiness-2026-09-22` | Partial-total safeguard and worker tests/CI |
| `Viral-Ad-Media/agently-frontend-v1` | `launch-readiness-2026-09-22` | Six-line login-message change and frontend CI only |

GitHub accepted all three branch pushes on 22 September 2026:

- Backend implementation and initial documentation: [`7d45078`](https://github.com/Viral-Ad-Media/agently-server-v1/commit/7d450780729b319e74446714f703cbdb5b0c3a0c).
- Worker safeguard/tests: [`1e0235e`](https://github.com/Viral-Ad-Media/agently-ws-server/commit/1e0235e318c09d8224e7a39150ad47754a138431).
- Frontend messages/CI: [`e8f8123`](https://github.com/Viral-Ad-Media/agently-frontend-v1/commit/e8f8123189a560971178d993f8cb63173f4bec30).

This publication-status update is a subsequent documentation-only commit on the backend branch. Check that branch's history for its current documentation revision. Remote CI results have not yet been verified; no pull request or merge was created.

Backend branch ancestry also includes the pre-existing local welcome-email commit `e1eafab`, which was one commit ahead of remote main before this work was committed.

Unrelated frontend changes in `.gitignore`, `App.tsx`, `services/api.ts`, the rest of `pages/Login.tsx`, `components/AuthCodePanel.tsx`, `pages/AcceptInvite.tsx`, and `brag-output/` are deliberately excluded and preserved locally. The small login-message change alone does not publish that unfinished authentication UI work.

## Full checklist and rollout instructions

- [All 54 original issues, additions and evidence](LAUNCH-READINESS-TRACKER.md)
- [Deployment and scheduler audit](DEPLOYMENT-AND-SCHEDULER-AUDIT.md)
- [Email bounce rollout — migration first](EMAIL-BOUNCE-ROLLOUT.md)
- [Authentication failure verification](AUTH-FAILURE-VERIFICATION.md)

These documents in the backend repository are canonical. Older files in the outer workspace `docs/` directory are historical working copies; the outer workspace is not a Git repository.

## Update rules

For each subsequent work session: update the date, affected IDs, implementation status, exact test results, remaining actions, commit/branch references and any deployed version. Preserve the original IDs and record new findings separately. Keep **implemented locally**, **pushed**, **deployed**, and **verified closed** distinct. Never store secrets, OTPs or customer content here.
