# Incident and breach plan

Written 22 Sep 2026, the day a real one happened. That is the reason this is
short and specific rather than a template: **N015** was a live cross-tenant
exposure of 65 leads' names, phones and emails, found and closed the same day.
Everything below is what that incident actually needed, generalised only where
generalising was honest.

Nothing here is legal advice. The notification clocks are the ones the law
sets, and `s3`–`s5` need counsel; this document exists so that the technical
half is not being invented while a clock runs.

---

## What counts as what

| | example | first move |
|---|---|---|
| **Incident** | API down, webhooks failing, OTPs not delivering | restore service |
| **Breach** | personal data readable by someone who should not | **stop the exposure, then preserve evidence** |

The distinction matters because the instincts differ. For an incident you
restore and move on. For a breach, restoring too eagerly destroys the evidence
you will need to answer "how many, whose, for how long" — and those are the
questions a regulator and a customer both ask first.

## The first hour

1. **Stop it.** For N015 that was four `DROP POLICY` statements. Prefer the
   smallest change that closes the hole over the correct long-term fix.
2. **Write down the time** you stopped it, and the time you believe it started.
   The window is the single most consequential fact you will report.
3. **Do not delete anything.** Not logs, not rows, not the offending config.
   Redact later if you must (see `N002`), but not during.
4. **Confirm it is actually closed, from the outside.** N015 was verified by
   fetching the public bundle, extracting the anon key and re-querying as a
   stranger would. Internal checks can agree with an internal mistake.
5. **Say what you do not know.** "We are still establishing scope" is a
   complete and acceptable status.

## Establishing scope

These are the specific queries, because at 3am nobody invents them well.

```sql
-- Who was affected, and how many?
select count(*), count(distinct organization_id) from leads;

-- What was reachable? Re-run the exact probe that found it.
--   node scratchpad/anon-probe.js
--   node infra/security-sweep.js

-- When did it start? Find the migration or deploy that introduced it.
select * from supabase_migrations.schema_migrations order by version desc limit 20;
```

For an API-side incident, the request id in every structured log line (`p6`)
is what turns "a user says it failed around 2pm" into an exact request.
Webhook delivery history is in `webhook_deliveries` (`p7`), and
`GET /api/webhooks/health` gives a verdict without credentials to the box.

**Access logs are the known gap.** Supabase does not retain PostgREST request
logs long enough to prove *whether anyone actually read* exposed data — only
that they could have. Assume they did; that is the defensible position, and it
is what the notification decision should be based on.

## Who is told, and when

Confirm the clocks with counsel (`s3`–`s5`), but plan against these:

- **GDPR Art. 33** — supervisory authority within **72 hours** of becoming
  aware, unless the risk to individuals is unlikely.
- **GDPR Art. 34** — the individuals themselves, "without undue delay", where
  the risk is high.
- **US state laws** vary; several are "without unreasonable delay" with outer
  bounds of 30–60 days.

Affected here means the **tenant's customers**, not only the tenant. Agently
holds leads belonging to a business's own customers, so a breach reaches people
who have never heard of Agently — which is exactly why it is serious, and why
the tenant has to be told promptly enough to meet *their* obligations.

Order: stop it → scope it → tell affected tenants → notify authorities →
public statement if warranted. Do not let drafting the public statement delay
telling the tenants.

## Preserving evidence

- `pg_policies`, the deploy version, the image tag, and the manifest from
  `infra/deployed-build-manifest.js` — all four say what was running.
- Container logs: pull them **with `--start-time`**. Without it
  `get-container-log` returns a narrower window than you expect, which already
  hid the SSRF evidence for two attempts.
- Keep the failing probe script. Reproducing the exposure later, on demand, is
  worth more than a description of it.

## Afterwards

- A row on the Launch Gate with a dated measurement, not a summary.
- A **test that would have caught it**. N015 was found by the `p3` integration
  test that asks whether the anon key can read tenant data — written to check
  an assumption rather than to pass. That test now fails if the exposure
  returns.
- Say plainly in the write-up what the wrong belief was. N015 existed because
  "RLS is enabled with almost no policies" was read as a blanket deny without
  checking `pg_policies`. The audit measured the door and never checked the
  window.

## Contacts

| role | who |
|---|---|
| Incident lead | *(unassigned)* |
| Technical | *(unassigned)* |
| Legal / DPO | *(unassigned — `s6`)* |
| Hosting | AWS Lightsail, Supabase, Vercel |
| Email / carrier | Resend, Twilio |

**Fill these in.** An escalation path with blanks is the same shape as the
fail-open controls this codebase has now found four times: it looks like a
control and answers "yes" to nothing.

Related: `N015`, `N002`, `p6`, `p7`, `N014`, `s3`–`s5`, `g5`.
