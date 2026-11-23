# Handoff — Agently calendar work

Latest voice/backend release and local UI status (20 October 2026): see [Voice incident and local UI update](VOICE-INCIDENT-2026-10-20.md). Its deployment and test evidence supersedes the older voice rollout notes below. Frontend changes remain local.

Living document. **Update it as you go**; it is the only thing that lets the
next person (or the next AI) continue without re-deriving everything.

Last updated: 2026-10-08; see the later update in §8 for the latest AWS rollout status.

## 0. Session log (newest first)

**2026-10-08 — fresh live-call retest; caller and owner modes separated locally.**
- A fresh call against production `agently-calls` v10 connected, but Mimi said
  it could not access or book the calendar. The call was ended without saving a
  lead, call history entry, appointment, or email. This confirmed that the
  previously deployed websocket image did not have caller-facing calendar tools.
- Local websocket changes now default web calls to caller mode, expose only
  availability and booking when a connected calendar is available, and require
  an offered slot plus a clear spoken confirmation before booking. Owner tools
  require a signed `mode=owner` token and a verified user; owner mutations also
  require a clear confirmation after the agent's preview.
- Local API token issuance accepts caller/owner mode and restricts owner mode
  to Owner/Admin accounts. The local Operator page is reachable from the active
  agent badge, no longer appears in the sidebar, and has a separate owner voice
  session button with agent selection. Frontend remains local.
- The local text Operator successfully answered the read-only question about
  today's Nutra Wellness calendar. Tests: API **303/303**, websocket **26/26**,
  frontend **52/52**; frontend type check and production build pass.
- A read-only production schema check confirmed `owner_operator_actions`,
  Gmail tables, and `voice_agents.calendar_integration_id` are present. AWS
  dry runs show API v41 -> next image with 102 environment entries preserved,
  and voice v10 -> next image with 108 entries preserved; workers, scale, and
  health checks are unchanged in the plans.
- No AWS deployment occurred. Docker Desktop is installed, but its Linux
  engine cannot start because WSL returns `E_ACCESSDENIED`. The exact production
  images still need to be built and then deployed API-first, websocket-second.
- The current account credit was below the voice service's $3 minimum during
  this pass, so owner voice and the booking round trip still need a live retest
  after deployment and an eligible balance. No frontend deployment was made.

**2026-10-08 — Gmail + calendar + owner web-call round trip tested locally.**
- Gmail OAuth was connected for the test account. Sent two authorized messages
to that same account: the Gmail connection test and the appointment reschedule
confirmation. Both have `email_sends.status=sent` and provider message IDs.
- Booked a test appointment on Nutra Wellness's attached Google calendar.
Verified the Google event and an `appointment_booked` owner notification.
- In a verified owner web call, read the agenda, rescheduled a test appointment
through the owner tool, and sent its prepared confirmation email only after the
owner confirmed. The reschedule action succeeded and the new Google event was
confirmed; the old event was cancelled. An earlier call attempt created a
separate test event, also cancelled during cleanup.
- Cleanup verified that the test-created Google events are cancelled and
restored the voice agent's original calendar assignment. Test emails remain in
the test Gmail inbox and send log.
- The live schedule initially spoke a UTC timestamp as Lagos time. Fixed the
internal schedule response to include `localStart`/`localEnd` formatted in each
appointment's IANA timezone and instructed the owner agent to use those fields
without converting raw timestamps. Regression test covers Africa/Lagos. This
code is local only; the live call was not rerun after the display fix.
- Fixed stale linked-business availability cache invalidation after a booking
or cancellation. Regression test checks immediate slot removal/restoration.
- Validation: server affected suites **51/51**, owner-call suite **11/11**.
No deployment or commit performed.
- Remaining before production: deploy the API and ws-server changes together;
verify the exact Google OAuth callback/API enablement and production consent
screen state; then repeat the round trip on a designated test calendar.

**2026-10-08 — Gmail database setup APPLIED; Gmail CONNECTED locally.**
- Applied `migrations/20261007_gmail_send.sql` to the shared Agently Supabase
project. Verified `email_integrations` and `email_sends` exist with RLS enabled.
- Owner added localhost and AWS Gmail callback URLs to Google Cloud. Local
Connect Gmail returned to `/integrations` with the test Gmail as default sender.
- The per-agent calendar migration was subsequently applied as part of this
round-trip work; it was not pending at the end of the test.
- Google Cloud console configuration and production deployment remain
unverified. Do not assume production is ready from this local test.
**Milestone 4 (2026-10-08) — owner feedback fixes + web-call employee mode: DONE locally, NOT deployed, NOT committed.**
- OAuth now returns you to the page you started from: the start token
  carries a signed `returnTo` (in-app path only; `safeReturnTo` rejects
  `//host`, schemes, `..`, query strings — tested). Errors return there too.
- Calendly "redirect uri malformed or doesn't match": NOT a code bug. The
  Calendly OAuth app must list EXACTLY the redirect URI in use. Local uses
  `http://localhost:4000/api/integrations/calendly/callback`; production uses
  the Lightsail host. Calendly signup mid-OAuth also drops the flow — create
  the Calendly account first, then click Connect.
- Google was connecting fine (2 rows saved for org 747cf733…).
- Black background on /integrations: `BrandSurface` honoured OS dark mode and
  the landing page's saved `data-theme="dark"`; nothing else in the app does.
  In-app surface is now LIGHT ONLY until the whole app supports dark.
- Gmail card: missing table now shows "not switched on for this server yet"
  instead of the PostgREST error. `email_integrations.provider` allows
  'outlook' so Microsoft can be added without a migration.
- Web call = employee mode (verified owner only):
  - greeting: "Hi <owner>, it's <agent>. What can I do for you?" — never the
    customer greeting; customer persona prompt reframed as BUSINESS CONTEXT.
  - new tools: `reschedule_appointment` (book new, then cancel old),
    `describe_my_knowledge` (KB, sites, uploaded files, FAQ/product counts),
    `find_leads` (tag/name), `prepare_emails` (AI drafts per recipient: tag,
    lead ids, or an appointment's attendee — no send), `send_prepared_emails`
    (only a batch prepared on THIS call, once, after the owner says yes).
  - API: `api/routes/internal-owner.js` at `/api/internal/owner/*`, shared
    secret via new `middleware/internal-secret.js`. `/email/send` re-checks
    every address against the lead/appointment on file (tested + mutation).
- Tests: server **295/295**, ws-server **24/24**, frontend **51/51**, tsc clean.

**Milestone 3 — Gmail send-only (§4d): DONE locally, NOT deployed, NOT committed.**
- Owner decision (2026-10-07): Agently drafts personal emails per lead
  (follow-up, meeting invite, reschedule, send a link) and SENDS them from the
  tenant's Gmail. It does NOT read or manage the inbox — not in this version.
- Scope is `gmail.send` only = Google **sensitive** (same tier as Calendar):
  normal app verification, **no CASA**. `gmail.compose/modify/readonly` are
  restricted — `test/gmail-send.test.js` fails if any is added.
- Server: `lib/gmail-send.js`, `api/routes/email-gmail.js` (mounted
  `/api/email/gmail`), OAuth reuses the shared flow as provider `gmail`
  (`/api/integrations/gmail/start-token` -> `/gmail/callback`). Tokens in the
  NEW `email_integrations` table (same crypto binding), never in
  `calendar_integrations` (would leak into availability/booking selection).
  Every attempt logged in `email_sends`; daily cap 200/org
  (`GMAIL_DAILY_SEND_CAP`); suppression list (`assertEmailRecipientsAllowed`)
  enforced; CRLF header injection blocked; 401/403 -> needs_reconnect.
- Automation: per-sender toggle "email a personal confirmation when an agent
  books" (`automations.booking_confirmation`), fire-and-forget after booking.
- Frontend: `components/GmailSenderCard.tsx` (Integrations),
  `components/EmailComposeModal.tsx` ("Email from Gmail" on a lead in Leads):
  AI draft -> edit -> send. Nothing sends without the user pressing Send.
- Tests: server **289/289**, ws-server **21/21**, frontend **51/51**, tsc
  clean. Local API smoke: all new routes mount, answer 401 unauthenticated.

**BEFORE DEPLOYING (owner actions):**
1. Confirm `20261007_calendar_per_agent.sql` is applied before deploying
   per-agent calendar code. `20261007_gmail_send.sql` was applied and
   verified on 2026-10-08 (see the newest session entry).
2. Google Cloud console, the existing OAuth client: add authorized redirect
   URIs `https://<api-host>/api/integrations/gmail/callback` and
   `http://localhost:4000/api/integrations/gmail/callback`; ENABLE the Gmail
   API (APIs & Services -> Library -> Gmail API); add scope
   `.../auth/gmail.send` on the consent screen Data Access page and submit
   the verification update (sensitive scope, no CASA).
3. Optional env: `INTEGRATIONS_GMAIL_REDIRECT_URI` (else derived from the
   Google one), `GMAIL_DAILY_SEND_CAP`.
4. Deploy API image AND ws-server image (owner mode needs both). Then the
   frontend, with `APP_HASH_ROUTES=false` in the same window (§1).

**Next, not built:** an agent tool to send email during a call (deliberately
left out: a caller could steer it to arbitrary addresses; if added, restrict
the recipient to the lead's stored email / the booked attendee).

**Milestone 2 — owner mode (§4b): DONE locally, NOT deployed, NOT committed.**
- `agently-ws-server/lib/webcall-owner-tools.js`: `get_my_schedule` + the
  three calendar tools, owner instructions, and `resolveOwnerMode(db, claims)`.
- Owner mode is **derived, not hardcoded**: true only when the *verified*
  token carries a real `userId` and that user exists. Tools are absent
  otherwise (`openAiSessionConfig` only adds them on a boolean `true`), and
  `handleOwnerTool` refuses as a second gate. Phone path never loads the module.
- `get_my_schedule` -> new `POST /api/internal/calendar/schedule`: merged
  agenda across ALL the owner's businesses, labelled, cancelled excluded,
  compact payload (no emails). Secret-gated like the other internal routes.
- Took ONLY the owner-mode pieces from `handoff-20261007-owner-mode.zip`; the
  other ~25 files in it target a different tree and were not applied.
- Tests: server **276/276**, ws-server **21/21** (gate mutation-checked).
- Deploy: **both** images (API for `/schedule`, ws-server for the tools).

**Milestone 1 — DONE locally, NOT deployed, NOT committed.**
- §4a per-agent calendars: built. `voice_agents.calendar_integration_id`
  (many agents -> one business calendar; NULL = org default). Booking AND
  availability resolve the agent's calendar first. Picker:
  `agently/components/BusinessCalendarPicker.tsx`, in Agent Settings ->
  Knowledge tab, saves on change via `PATCH /api/voice-agents/:id
  {calendarIntegrationId}` (validated against the org's own connections).
  ws-server needed no change — it already sends `voiceAgentId`.
- §4c all fixed: availability + booking now **fail closed** (code
  `availability_unverified`; a Google account in needs_reconnect also counts);
  availability cache keyed by connection, not provider; `/bookings` returns
  `total` = rows returned + `truncated`, bad `from`/`to` -> 400;
  `markNeedsReconnect`/`refreshConnection` filter on `organization_id`.
- Calendly per-connection webhook: new URL
  `/api/integrations/calendly/webhook/:orgId/:connectionId`; the old org-only
  URL still served and attributes by event host. Re-running setup replaces a
  legacy subscription. Bookings now carry `integration_id`; conflicts only
  within the same Calendly account.
- Tests: server **275/275** (new `test/calendar-per-agent.test.js`, each fix
  mutation-checked), frontend **51/51**, `tsc` clean.
- **Deploy order:** run `migrations/20261007_calendar_per_agent.sql` BEFORE
  shipping the frontend picker (PATCH with the field fails until the column
  exists; booking itself tolerates the missing column).


---

## 1. State right now

| | |
|---|---|
| Production API | Lightsail `agently-ingest` **v40**, image `:agently-ingest.api.35`, RUNNING |
| ws-server | `agently-calls` **v10**, image `:agently-calls.ws-server.32` |
| Branch everywhere | `feature/v1.1` (backends pushed to GitHub; frontend **not** pushed — the owner does that) |
| Tests | server **260/260**, ws-server **13/13**, frontend **51/51**, `tsc` clean |
| Frontend in production | still the OLD build — the v1.1 frontend has not shipped |

**The frontend is deliberately behind.** The API emits fragment links
(`/#/billing`) because that is what the live frontend serves. When the new
frontend ships, set `APP_HASH_ROUTES=false` on the container **in the same
window** and every link flips at once. Leave it unset until then.

### Migrations applied to the live database

1. `20261005_calendar_integrations.sql`
2. `20261005_calendar_phase2.sql`
3. `20261005_calendar_phase3.sql`
4. `20261006_business_groups.sql`
5. `20261007_calendar_multi_account.sql`

`20261007_calendar_per_agent.sql` was subsequently applied; see the newer
session entries in §0. No agent-specific calendar assignment is currently set.

---

## 2. The shape of the feature

One Agently login runs several businesses. **Each business has its own Google
or Calendly account connected to the same login.** `calendar_integrations` is
one row per connected *account*, with `label` and `is_booking_default`.

- **Availability** merges across every connected calendar, so the agent cannot
  offer a slot the owner is busy on at another of their businesses.
- **Booking** writes to the one connection flagged `is_booking_default`.
- **The merged feed** (`GET /api/integrations/bookings`) shows every
  appointment across all accounts, each labelled.

`business_groups` (pairing two **separate Agently logins** by invite code) is a
different mechanism for a different situation. It still exists in the API and
database but **the Integrations screen no longer shows it** — having both on
one screen was two mechanisms for one job and sent the owner hunting for a
second login that does not exist.

### Why not "one calendar with tags"

The agent never chooses a calendar. It passes `agent.organization_id` and the
connection is resolved from that. Tenant isolation, per-calendar free/busy and
RLS all follow from that. A shared calendar with tags breaks all three.

---

## 3. Bugs already found and fixed — do not reintroduce

Each of these shipped, reached a user, and cost real time. The tests that now
guard them were each checked by mutation (break the code, watch the test fail).

| Bug | Why it hid |
|---|---|
| `saveConnection` used an undeclared `existing` | **Zero tests** on the function the whole feature rests on. 20 OAuth tests covered everything *around* the save. |
| Google event id prefixed `agently` | `y` is outside base32hex (`a`–`v`, `0`–`9`). Google answered `Invalid resource id value.` **No booking ever succeeded.** |
| `providerError` read `json.error` | Google returns `{error:{message}}`, so every failure logged `[object Object]` — the provider said what was wrong and we discarded it. |
| The booking catch logged nothing | A failed booking left no trace at all. Finding the cause needed a direct call to Google. |
| `saveConnection` nulled the refresh token | Google omits `refresh_token` on reconnect, so re-granting a scope **destroyed the live grant**, silently, an hour later. |
| `getConnectionByAccount` adopted any id-less row | Connecting a second business could overwrite the first's tokens. |
| `reconcileGoogleChanges` ignored `connection` | A push for business B cancelled business A's bookings. |
| `fake-supabase.select()` was a no-op | No test could verify the projection keeping token ciphertext out of `/status`. |

---

## 4. Open work, highest value first

### 4a. Per-agent calendars — **the limitation the owner hit**

`getBookingConnection(supabase, organizationId)` takes only the organization,
so **all 13 voice agents book into whichever single account is flagged**.
Connect three businesses and the Viral Ad Media agent files appointments into
Nutra Wellness's calendar.

Fix: `voice_agents.calendar_integration_id` (nullable uuid, references
`calendar_integrations(id) on delete set null`). Booking resolves the agent's
own connection first, falling back to the org default when unset — so nothing
changes for a tenant with one account. Plus a "Business calendar" picker in
Agent Settings. A migration is drafted at
`migrations/20261007_calendar_per_agent.sql` (**not run**).

### 4b. Owner mode on web calls — the "Jarvis" ask

The owner wants to ask their agent *"what's our schedule today?"* on a web
call, and have it answer, reschedule, and later send email.

The foundation exists: the webcall token already carries `userId` and `orgId`,
and `/verify-token` returns them. What is missing is a schedule-read tool and
threading the verified identity into the voice tool context on both paths.

> **THE RULE.** Owner-only tools must be **ABSENT from the tool list** when the
> speaker is not a verified owner — never merely refused when asked. An
> anonymous caller on the business's phone number must not be able to ask
> *"what's my schedule today"* and have the agent read out the appointment
> book. That is the tenant's customers' personal data, read aloud.
>
> Derive the flag from the **cryptographically verified token claims only**.
> Never from a body field, a header, or anything the speaker says.

A good draft exists in the owner's Downloads
(`handoff-20261007-owner-mode.zip`): `webcall-owner-tools.js` with
`get_my_schedule`, a chief-of-staff instructions builder, and a test pinning
that the phone path never loads the owner module. Its structural isolation is
right — owner tools in their own module, imported only by the webcall path.

**It has one defect: `enableOwnerTools: true` is hardcoded.** That is safe only
because both token routes in `api/routes/webcall.js` currently sit behind
`requireAuth`. `lib/public-abuse-limits.js` already carries per-org **hourly**
webcall token limits, which is the shape of a feature meant to face end
customers. The day a public webcall ships, that hardcoded `true` hands a
stranger the owner's agenda and no test fails. Derive it from `userId`.

### 4c. Findings from adversarial review, still open

- **Availability fails open.** `getCrossAccountBusy` catches a failed provider
  call and contributes zero busy blocks, so an expired token on business B
  silently re-opens all of B's busy time and the agent double-books. The merge
  exists to prevent exactly that. Fail closed.
- **Calendly cannot tell its accounts apart.** The webhook is mounted at
  `/api/integrations/calendly/webhook/:orgId` — per *organization*. Two
  Calendly accounts post to the same URL indistinguishably; the insert omits
  `integration_id`, so bookings arrive unlabelled and one account's event
  conflicts the other's appointment. Make the webhook per-connection;
  `setupCalendlyWebhook` already holds the connection. Keep the old URL working
  for subscriptions already registered with Calendly.
- Lower: `listMergedBookings` returns a pre-cap `total` that disagrees with the
  capped `bookings`; a malformed `from`/`to` throws `RangeError` and surfaces as
  500 rather than 400; `markNeedsReconnect` and `refreshConnection` write by row
  id with no `organization_id` filter (not reachable cross-tenant today, but it
  contradicts the module's own stated invariant).

### 4d. Email / Gmail — read this before starting

**Correction: `gmail.send` is sensitive, not restricted.** The current
feature sends from a connected Gmail account and drafts inside Agently;
it does not read mail or create drafts inside Gmail. Sensitive-scope app
verification applies for public use, but the send-only scope does not
require the restricted-scope security assessment.

`gmail.readonly`, `gmail.compose`, and `gmail.modify` are restricted scopes
and are not requested. See Google's current scope classification:
https://developers.google.com/workspace/gmail/api/auth/scopes

The implementation uses separate `email_integrations` and `email_sends`
tables with the existing token encryption scheme. Both tables are now
created; see the newest session entry for remaining Google setup steps.

---

## 5. Traps specific to this codebase

**`api/routes/index.js` is dead code.** Nothing requires it. The container runs
`node dev-server.js`, which loads `api/index.js`. It cannot resolve its own
siblings from where it sits. Every handoff ZIP so far has patched it, and those
route mounts do nothing. **Mount routes in `api/index.js`.**

**Handoff ZIPs are built against a different tree.** Extract to a staging
directory, diff every file against the working tree, and check what the package
would *revert* before applying anything. One ZIP would have undone the event-id
fix and put booking back to never working.

**`safeMount` means a broken deploy still looks healthy.** It serves a 503 for
one prefix instead of killing the container. Read the container log for
`FAILED to mount` after every deploy; `/health` will say ok regardless.

**RLS is enabled with zero policies and the API uses the service role.**
Postgres will not stop a bad query. Every read must be scoped to `req.orgId` in
application code. There has already been one live cross-tenant exposure here
(65 leads).

**A route that 404s after a change usually means a stale `node` process**, not
a missing route. `netstat -ano | grep ":4000 .*LISTENING"`, then
`taskkill //PID <pid> //F`.

**Local `.env` had `NODE_ENV=production`**, which made the laptop behave as the
live deployment: CORS stripped loopback origins, the OAuth cookie was `Secure`
over plain http, and every app link pointed at the live domain. It is now
`development`. Do not set it back.

---

## 6. Deploying

Full procedure with real commands: `docs/DEPLOYING-TO-AWS.md`.

The short version, from `Agently-AWS/`:

```bash
# pre-flight, mandatory when lib/email.js or lib/email-delivery.js changed
node -e "require('dotenv').config();(async()=>{const {assertEmailRecipientsAllowed}=require('./agently-server/lib/email-delivery');await assertEmailRecipientsAllowed({to:'agentlycallsupport@gmail.com'});console.log('ALLOWED')})()"

docker build -t agently-api:<tag> agently-server/
aws lightsail push-container-image --service-name agently-ingest --label api \
  --image agently-api:<tag> --profile agently --region us-east-1
node agently-ops/deploy-api-image.js :agently-ingest.api.N          # dry run
node agently-ops/deploy-api-image.js :agently-ingest.api.N --apply
```

Env vars go through `agently-ops/push-env-to-container.js`, which reads from
the gitignored `.env` so secrets never reach shell history. It refuses a
partial set. `--service agently-calls` targets the ws-server.

**Env first, image second** when new code needs a variable at boot.

---

## 7. Decisions already made — don't relitigate

- One Google/Calendly account **per business**, several per Agently login.
- `business_groups` stays in the codebase, stays off the Integrations screen.
- `is_booking_default` is per **organization** (one booking target), not per
  provider. Per-agent assignment (§4a) is the intended refinement.
- The app is being redesigned to the landing-page language: warm off-white,
  orange accent, DM Sans + IBM Plex Mono. **Not** the old slate/indigo.
- `APP_HASH_ROUTES` unset in production until the new frontend ships.

---

## 8. Owner Operator workspace — 2026-10-08

The owner-facing assistant is a separate authenticated page at `/operator`.
`agently/pages/Operator.tsx` has an owner/admin-only agent selector and chat;
the caller Live Call simulator and its route remain independent and unchanged.
The API is mounted at `/api/operator` from `api/index.js` (not the dead
`api/routes/index.js`).

The operator can read that agent's assigned calendar, scoped leads and calls,
outreach schedules, and assigned knowledge. Date-only calendar questions use
the selected calendar's timezone, including daylight-saving day boundaries.
Knowledge responses include source names/links. It can prepare Gmail drafts
and calendar reschedules, but writes are one-use, ten-minute review actions.
Their payloads are encrypted with
`CALENDAR_TOKEN_KEY`, bound to tenant and action id, and an Owner/Admin must
approve a separate card before the API sends or moves anything. Durable request
budgets use the existing `auth_rate_limit_hit()` database function.

Production status, 2026-10-08:

- Applied and verified `migrations/20261008_owner_operator_actions.sql` on the
  Agently Supabase project. `CALENDAR_TOKEN_KEY` is present in the API
  environment.
- Deployed `agently-ingest` on AWS Lightsail as version 41 using image
  `:agently-ingest.api.36`. The 102 API environment variables, ingest-worker
  image, and endpoint configuration were preserved. Updated
  `agently-ops/deployed-build.manifest.json` against that deployment.
- `/health` returns 200, and unauthenticated `POST /api/operator/chat` returns
  401, confirming the route is mounted. In the signed-in local page, the
  Operator successfully read Nutra Wellness's calendar and reported no
  appointments today.
- The user explicitly asked to keep the production frontend unchanged. No
  Vercel frontend deployment was made. For local verification only,
  `agently/.env.development.local` was temporarily pointed at the Lightsail API
  and has now been restored to `http://localhost:4000`.
- The full round-trip remains pending. The selected test agent is Mimi
  (inbound, Nutra Wellness knowledge base). Its Live Web Call stayed at
  “Connecting…” while microphone access was outstanding; reloading the page
  stopped that attempt. The user must handle microphone access directly before
  a new attempt. Starting the call consumed $0.01 in usage credit; no
  appointment, calendar update, or email has been created or sent.

### Later update, 2026-10-08

The status above describes an earlier deploy. The API was subsequently updated
to Lightsail version 43 (`:agently-ingest.api.37`), and the voice service reached
version 11 (`:agently-calls.ws-server.38`); both were observed RUNNING. Their
health endpoints returned 200 and the unauthenticated operator and web-call
routes returned 401. The API and voice service share matching internal and JWT
secrets. A voice-only configuration update, version 12, changed `API_URL` from
the retired Vercel backend to the Lightsail API. It was submitted, but the final
activation check was stopped by the Codex workspace's automatic approval review
when that workspace ran out of credits. Treat version 12 as **unverified** until
its RUNNING status and a fresh owner voice session are checked. This is separate
from the user's Agently usage balance, which the local dashboard displayed as
$12.84 after top-up.

No production frontend was deployed. The local frontend builds, its operator
page test passes, and the API and voice test suites pass (303 and 26 tests).
`agently/.env.development.local` currently points the local frontend at the
Lightsail API for personal verification; the older statement above about
restoring it to `http://localhost:4000` is superseded.

Current setup limits for the personal round-trip: both Google calendars use
Africa/Lagos and one is the organization booking default; no voice agent has
`calendar_integration_id` set, so each agent's booking falls back to that
default. Owner voice schedule reads are organization-wide across connected
calendars, whereas operator text calendar reads follow the selected agent.
Gmail is connected, but its automatic booking-confirmation automation is off.
The owner can prepare email and calendar changes for explicit review/approval.
Do not report the full live call → appointment → email → reschedule sequence as
newly verified from these automated tests.

### Voice reliability update, 2026-10-09

Supersedes the deployment status above: API version 44 (`:agently-ingest.api.39`)
and voice version 13 (`:agently-calls.ws-server.40`) were both verified RUNNING,
with ACTIVE deployments and HTTP 200 health checks. Version 12's AWS API_URL
configuration was verified before this update. Existing deployment settings,
worker image, and endpoints were retained. No production frontend deployment.

Voice changes: delayed-ASR-safe, single-use approval of a staged exact action;
business-calendar timezone/date context and local-day windows; offered-slot
comparison by instant; saved owner contact lookup and approved email correction;
email draft preparation using a specifically selected saved lead when a booking
has no attendee email; gpt-4o-transcribe with far-field noise reduction; queued
tool follow-up responses and suppression of interrupted response audio.
Local browser capture now uses an AudioWorklet where supported, with a fallback
and playback buffering. These changes require an actual microphone retest for
subjective audio quality; they do not guarantee isolation of background speech.

Local Bookings has provider-aware cancellation with confirmation for owner/admin,
plus an option to hide cancelled entries while retaining history. The signed-in
localhost:3000/bookings page was visually inspected and showed Olajuwon's existing
appointment, its Cancel button, and the hide-cancelled checkbox. No cancellation
was performed. Local preview was restarted on port 3000.

Validation: API suite 306/306, voice suite 30/30, bookings UI 8/8, operator UI 1/1;
frontend build/typecheck passed. OpenAI accepted both caller and owner realtime
configurations. Deployed owner and caller smoke sessions both became ready,
received agent greeting/audio, and ended successfully. Owner greeting addressed
the owner; caller greeting represented Nutra Wellness. These were greeting-only
checks, not conversational booking/email tests. No appointments or contacts were
changed and no email was sent by these checks. Brief voice usage was metered.

Remaining verification: user microphone test of booking approval, saved-lead
email preview/send, rescheduling, and background speech. The calendar assignment
and disabled automatic Gmail confirmation limitations in the preceding section
still apply; do not claim every agent is scoped to its own business calendar or
that the entire appointment/email round trip has passed.

### Operator workspace, agent boundaries, and automations — 2026-10-09

Supersedes the deployment and assignment limitations above. API version 45
(`:agently-ingest.api.41`) and voice version 14
(`:agently-calls.ws-server.42`) are RUNNING with ACTIVE deployments and HTTP
200 health checks. The API remains nano x1, voice remains small x2, and all
existing ports, health checks, worker settings, and environment values were
preserved. `AGENT_AUTOMATIONS_ENABLED=true` was added to the API only. No
production frontend or Vercel deployment was made; localhost:3000 serves the
updated local frontend.

The live Supabase project has both `operator_workspace` and
`backfill_agent_business_access` migrations. Every one of the 67 current agents
has an `agent_operator_settings` record. The 13 agents whose organizations have
connected Google accounts received explicit, valid calendar and Gmail sender
assignments; agents without a connected account remain unassigned. Owner
calendar, Gmail, lead, contact, and knowledge operations now require the
selected agent's tenant-scoped assignment. Shared unassigned leads are denied
unless an owner explicitly enables that option for the agent.

The local Operator page includes Business access, Automations, Knowledge
sources, and Action history. It provides visible, single-use approval cards for
calendar/contact/email changes in text and live voice sessions. Voice and click
approval share one action ledger, so one cannot execute after the other.
Persistent Gmail send receipts prevent duplicate sends after retries or an
unknown delivery result. Partial batches retain only unsent drafts. Failed
email runs can retry the email step without recreating an appointment.

Automation templates currently cover booking confirmations, appointment
reminders, missed-call follow-ups, and daily summaries. New rules are saved
paused; owners must activate them. Review mode is the default. Automatic mode
requires a separate explicit confirmation in the UI. Runs are deduplicated by
rule/event and use the selected agent's assigned Gmail and calendar at execution
time.

The local voice controls add microphone selection, a ten-second level check,
push-to-talk, input level, latency, interruption, dropped-input, and playback-gap
diagnostics. OpenAI accepted `gpt-4o-transcribe`, far-field noise reduction,
caller tools, and the expanded owner tool set. Deployed caller and owner smoke
sessions both became ready, streamed audio, received the correct role-specific
greeting, and ended successfully. These smoke checks did not mutate contacts or
appointments and sent no email.

Validation after the final changes: API 311/311, voice 32/32, frontend targeted
tests 9/9; frontend typecheck and production build passed. The remaining step is
the user's subjective microphone conversation and a deliberate real appointment
round trip from the local UI. Do not create a real automation, appointment, or
email merely for an automated smoke test.

### Hands-free voice and lead-qualification foundation — 2026-10-09

The local web-call UI no longer offers or starts in hold-to-talk mode. Calls
start unmuted and rely on the existing OpenAI server VAD, far-field noise
reduction, browser echo cancellation/noise suppression/automatic gain, and
barge-in. The ordinary Mute button remains available. Local `/operator` was
reloaded and visibly showed “Hands-free conversation” with no hold button.
This is a local frontend change only; no Vercel or production frontend deploy.

The archive `handoff-20261008-lead-qualification.zip` was reviewed as reference
material and was not copied over the current repositories. Its useful missing
layer was integrated with the newer CRM/operator/calendar code:

- `voice_agents.qualification_playbook` and `qualification_rules` now exist in
  live Supabase through migration `lead_qualification_playbook`.
- Agent Settings has per-agent playbook, qualified/nurture thresholds,
  possible disqualifying signals, and booking-readiness criteria.
- Caller prompts weave configured questions into normal conversation, do not
  expose scores, and explicitly forbid score-only booking. Owner conversations
  continue to forbid caller qualification.
- Completed calls with a configured playbook receive one transcript-grounded
  structured assessment. It records score, confidence, evidence, summary,
  intent, next action, estimated value, and review status. With no playbook,
  the extra model call is skipped and the existing heuristic scorer remains.
- AI may promote an ordinary new/contacted lead to `qualified`. It preserves
  appointment/proposal/won/lost stages, cannot create a booking, and flags a
  possible disqualification for owner review instead of marking the lead lost.

Production API version 46 (`:agently-ingest.api.43`) and voice version 15
(`:agently-calls.ws-server.44`) are RUNNING/ACTIVE with HTTP 200 health checks.
Existing environment counts, worker image, service sizes, scale, endpoints,
and health checks were preserved. Validation: API 313/313, voice 34/34,
frontend targeted tests 9/9, typecheck and production build passed.

Recommended next CRM slices build on this foundation instead of replacing it:
an explainable hot-lead queue, a kanban pipeline over the existing `crm_stage`,
and follow-up/nurture rules routed through the existing paused-by-default
automation review system. Add a playbook version/evaluation set before allowing
any automatic high-consequence stage or outreach decisions.
