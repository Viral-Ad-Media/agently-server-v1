# Connecting Twilio

For a new customer workspace. Written 22 Sep 2026 against the deployed build.

**Read this first.** Production currently holds **zero** provisioned numbers
(`twilio_phone_numbers` = 0 rows). Nothing below has been exercised against a
live carrier — `v6` and `v7` on the Launch Gate are still open for exactly that
reason. Treat this as the documented intent plus what the code actually does,
not as a procedure anyone has walked end to end.

---

## What a workspace needs

| Thing | Where it goes | Notes |
|---|---|---|
| Account SID | Settings → Twilio | Starts `AC`. Stored per workspace. |
| Auth token | Settings → Twilio | **Encrypted at rest** (`organizations.twilio_auth_token_encrypted`). The API only ever returns a `configured` boolean and the last four characters — never the value. |
| A phone number | Twilio console, then Settings | Must be voice-capable in the country you intend to answer. |

A workspace with no credentials falls back to the server-wide Twilio account.
That is convenient in development and **wrong in production**: calls bill to the
platform rather than the customer, and `ALLOW_OWNER_MASTER_TWILIO_SYNC` controls
whether it is permitted at all.

## Pointing the number at Agently

In the Twilio console, on the number's **Voice Configuration**:

- **A call comes in** → Webhook → `POST`
  `https://<api-host>/api/twilio/voice-inbound`
- **Call status changes** → `POST` `https://<api-host>/api/twilio/status`

The inbound handler resolves the voice agent **from the `To` number**, not from
a path parameter. So a number that is not in `twilio_phone_numbers` reaches the
API and finds no agent. Provisioning the number in Agently is not bookkeeping —
it is what makes the call answerable.

> Earlier internal notes pointed at `/api/twilio/voice/:id/inbound`. That route
> does not exist on the deployed build and returns 404. The paths above are the
> ones actually mounted (`api/routes/twilio.js`).

## Signature validation

Every inbound request is verified: HMAC-SHA1 over the sorted POST parameters,
compared with `timingSafeEqual`, using **that workspace's** auth token. A
mismatch is rejected before any handler runs.

Two consequences worth knowing before you debug:

- If the webhook URL in Twilio differs from the URL Agently sees — a trailing
  slash, `http` vs `https`, a proxy rewriting the host — the signature will not
  match and calls fail with no obvious cause.
- Changing the auth token in Twilio without updating it in Agently breaks every
  inbound call immediately.

## Checking it worked

```bash
# the API is up
curl -s -o /dev/null -w '%{http_code}\n' https://<api-host>/api/auth/config

# webhook health (needs the internal key)
curl -s -H "x-internal-key: $INTERNAL_BILLING_ADMIN_KEY" \
  'https://<api-host>/api/webhooks/health?window=60'
```

A real call should produce a `call_records` row **with a non-empty
`provider_call_id`**. That field is the test: all 150 existing rows have it
empty, which is how we know none of them came from a carrier.

## Things that will bite

- **Country permissions.** Twilio blocks outbound calling to most countries by
  default. `TWILIO_ALLOWED_COUNTRIES` and `TWILIO_HIGH_RISK_COUNTRIES` gate this
  on our side too; both have to agree.
- **Escalation needs a number.** `voice_agents.escalation_phone` is empty on the
  only agent in production, so the transfer branch has nowhere to dial and the
  call falls through instead of escalating.
- **A2P / carrier registration** (`s7`) is unresolved. In the US, unregistered
  traffic gets filtered or blocked, and that is a carrier decision no code
  change reaches.
- **Recording is off**, and turning it on is not just a flag — two-party-consent
  jurisdictions need disclosure before the first caller turn (`v9`).

## Related

`docs/LAUNCH-PROGRESS.md` · Launch Gate rows `v1`, `v2`, `v6`, `v7`, `v8`,
`N012` (no number provisioned), `s7` (A2P).
