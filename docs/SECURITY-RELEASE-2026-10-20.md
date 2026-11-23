# Immediate security containment and sessions — 20 October 2026

## Released and verified

API: agently-ingest deployment **51**, image **:agently-ingest.api.54**.
Voice: agently-calls deployment **21**, image **:agently-calls.ws-server.55**, two nodes.
Both services RUNNING; both public health endpoints return HTTP 200.
The ingest-worker container/image and all unrelated service settings were preserved.
No frontend deployment or real test call was made.

## Security changes

- Revoked PUBLIC, anon and authenticated access to all 58 public views and all public SECURITY DEFINER functions. Preserved service_role access and tightened future object grants.
- Live catalog verification: **zero public view grants and zero public definer-function grants**. A HEAD request using the public client key to the private billing view returns **401**. All three new session RPCs are available to the service role only.
- Public Twilio HTTP endpoints now require provider signatures, including case/trailing-slash aliases. Validation uses canonical configured URLs, never caller-supplied Host headers, and supports the platform account and known subaccount signing tokens.
- Recording downloads ignore callback-supplied URLs. The server constructs the provider URL from validated IDs, verifies provider metadata matches the account/call/recording, disallows redirects, and limits download time and bytes. Credentials are never attached to an arbitrary callback URL.
- Provider WebSocket handshakes now require Twilio signatures. Authenticated browser-call handshakes require a valid purpose-scoped token bound to a live account session.
- The legacy **/realtime** WebSocket endpoint is deliberately contained with HTTP **410**. It remains unavailable until a budgeted, server-issued admission flow is integrated. The authenticated /api/webcall/stream path and signed phone-call paths remain enabled.
- General account APIs require session type, session ID, organization, epoch and a matching live server session. Legacy sid-less tokens and webcall/pending tokens are rejected.
- Role, tenant membership and session epoch are read live rather than served from the old authorization/profile cache.
- Session creation and concurrent-session eviction are serialized on the user row. Global logout increments the epoch and revokes sessions in one transaction.
- Password changes/reset, reset-token consumption and session revocation now commit in one transaction. A used reset token cannot be replayed.
- Revocation storage failures return retryable failures instead of success. Sensitive authenticated responses use Cache-Control: no-store.
- Open browser-call sessions recheck the underlying account session every 15 seconds; owner-tool dispatch also checks it. Paid connections close before best-effort final logging.

## Live session policy

| Control | Setting |
|---|---|
| Inactivity | 30 minutes since the last authenticated request |
| Absolute maximum / newly issued account token | Eight hours from sign-in |
| Concurrent sessions | Three per user, shared across API instances |
| Fourth sign-in | Revokes the oldest active session |
| Activity timestamp precision | Up to one minute |
| Super-admin maximum | 15 minutes, including an age check on previously issued tokens |

These are explicit AWS API environment settings and code ceilings; configuration cannot silently extend them to the old month-long policy.
Existing session rows were shortened to the eight-hour ceiling. Old/idle/legacy sessions must sign in again.
These are application sessions, not a new long-lived remembered-device or refresh-token mechanism.

The durations are a product policy within [OWASP's business-application guidance](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html), not a universal mandated standard.

## Local frontend only

Settings now includes signed-in device/session details, individual other-device revocation, and sign-out-everywhere.
A failed sign-out preserves the token and displays a retry message rather than implying that server revocation succeeded.
These UI changes are **not on the production frontend**. The backend device endpoints and shorter session policy are live.

## Verification

- Exact API image: **341 tests passed**.
- Exact voice image: **52 tests passed**.
- Local frontend: existing **64 tests passed**, plus **2 focused device/failure tests passed**; TypeScript check and production build passed. Existing large-bundle warning remains.
- Isolated PostgreSQL 16 tests exercised actual SQL functions: session cap, epoch invalidation, password change, reset-token replay rejection and public privilege denial; fixture transactions rolled back.
- Six simultaneous synthetic sign-ins created six session rows and left exactly **three active**. The disposable database is separate from production.
- The prior offline purpose-boundary reproduction now reports acceptedAsGeneralSession=false.
- Additional checks inside the released API image accepted legitimate synthetic subaccount HTTP/WebSocket signatures without a network. The disposable test database was removed after verification.
- Production probes: unsigned recording/status routes **403** (including uppercase/trailing-slash alias); unauthenticated device list **401**; signed GET to recording-status passes signature admission then returns expected **404** because no GET handler exists; unsigned provider WebSocket **403**; missing browser-call token **401**; legacy /realtime **410**.
- Production auth/config returns idle **1800** seconds and absolute **28800** seconds.
- These probes did not place a call, send an email or execute a billing/deletion function. Controlled rejected probes may appear in webhook/access logs.

## Applied migrations

Local filenames match the production migration history:
- 20261020150715_immediate_security_containment.sql
- 20261020151025_atomic_session_security_policy.sql
- 20261020152104_password_session_transaction.sql

The last migration also corrects creation timestamps to use the time after the user lock is acquired, so concurrently queued sign-ins are ordered correctly.

## Release images and build limitation

Registry upload digests:
- API: sha256:5a67c2415ae392a49c2ade93e853919e05da5738f8cd32a0e77b63ac486f1e18
- Voice: sha256:24f96848731e995cb64f958561a4d0e46f3bf6d9f234273ea5c481be27f329e6

Local tested OCI image IDs:
- API: sha256:a104bef18c0dbe087a76e01c77d74ce064f60240b4067a9a742ce41e34aa932d
- Voice: sha256:9e0d550317aa1ff6ced3319794f2a640491c64e30ee3e32c83cde9ec57747200

A supported Node 24 upgrade was attempted, but registry downloads stalled and then failed DNS resolution. To avoid delaying containment, Dockerfile.security overlays the current source on already verified local Node 20 bases:
- API base: sha256:55376b00fabe41f83213a6b1a7ec721bd5d2ad95f1fae41a4da000fd43f5915c
- Voice base: sha256:30254457ad9378d9fe8f65dee232113dda770e6c2bd725188f9879d89a8188a6

**Node 20 end-of-life and dependency advisories remain open.** Do not describe them as fixed by this release. The normal Dockerfiles/package engines remain on the existing runtime until the supported-runtime upgrade is tested and deployed.

## Still open after this first phase

1. Supported runtime and dependency updates.
2. Restore the legacy widget WebSocket voice flow using scoped admission, shared spend/rate limits and hard duration limits.
3. Shared browser-call concurrency reservations; the old per-process call counter still needs replacement. The three-session account/device cap is separate and is now atomic.
4. Full tenant A/B isolation testing, including binding provider callbacks/stream context to the correct tenant across every path.
5. Review historical access logs and coordinate provider credential rotation if required; this release does not establish whether prior credentials were accessed.
6. Worker/billing scheduler ownership, API capacity/failover, cache/region measurements, external alert verification, backup/recording restore rehearsal and staging load tests.
7. Real inbound/outbound/human-transfer acceptance and mobile session validation.
8. Production frontend remains unchanged by instruction; device UI, frontend security headers and storage hardening require a separately authorized frontend release.

Keep database revocations in place. Do not blindly roll back to an old unauthenticated callback image during a later release issue; use a forward fix or preserve ingress containment.

