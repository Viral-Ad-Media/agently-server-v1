# Handoff — Agently calendar work

Living document. **Update it as you go**; it is the only thing that lets the
next person (or the next AI) continue without re-deriving everything.

Last updated: 2026-10-07, end of the multi-account session.

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

`20261007_calendar_per_agent.sql` is **drafted but NOT run** (see §4).

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

**Gmail send/read is a Google *restricted* scope, not merely sensitive.**
Calendar is sensitive; Gmail is a tier above. Restricted scopes require an
annual **third-party security assessment** (CASA) before the app can be used
by anyone outside your test users. That is a real cost and a long lead time,
and it changes the economics of the feature.

Nothing about this is blocked technically — it is a compliance and budget
decision that should be made deliberately rather than discovered after the
code is written.

The sane first step, which needs **no** restricted scope:

1. Generalise the token vault. `lib/crypto.js` already binds ciphertext to
   `{organizationId, provider, connectionId}` and `calendar_integrations` is
   already one row per account. An email connection is the same shape with a
   different provider. Either widen that table's `provider` check or add a
   sibling table with the identical binding — **do not invent a second
   encryption scheme.**
2. Decide the *sending* path first. Transactional send through Resend (already
   wired, already has a webhook and delivery-block table) covers "the agent
   follows up by email" with **no Gmail scope at all**. Reading the owner's
   inbox is what needs CASA.
3. Only then, if inbox reading is genuinely required, start the assessment.

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
