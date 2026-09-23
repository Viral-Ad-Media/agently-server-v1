# The API and its database are on different continents

Measured 22 Sep 2026. This is a decision paper, not a recommendation to act
today — the numbers are here so the choice is made on evidence rather than on
the fact that it sounds wrong.

## What it costs, measured

The API runs on Lightsail in **us-east-1**. Supabase project
`qozbmfwxlcuvwzbxtvnn` is in **eu-central-1**.

Method: `/health` touches no database; `/api/webhooks/health` performs exactly
one `select`. The difference is the round trip the API pays per query.

| | median |
|---|---|
| `/health` (no database) | 240 ms |
| `/api/webhooks/health` (one query) | 553 ms |
| **database round trip** | **~313 ms** |

That is per query, not per request. A handler doing ten sequential queries
spends **~3.1 s** crossing the Atlantic before doing any work of its own.

Two existing observations line up with this and stop being mysteries:

- the p3 integration suite takes **7–17 s** to check 15 tables — that is
  almost entirely latency, at roughly 313 ms each;
- a knowledge-discovery run once returned **502 with an empty body** from the
  load balancer. A long sequential job outliving the gateway timeout is the
  expected shape of this problem.

The client aborts at 15 s (`CLIENT_REQUEST_TIMEOUT_MS`) and Stripe retries at
about 10 s. Neither is being hit today — the p11 load test measured p95 at
1519 ms with 8.5 s of headroom — but the margin is made of round trips, and it
shrinks every time a handler gains a query.

## Options

**1. Move the API to eu-central-1.** Latency goes to roughly single-digit
milliseconds. Costs a new Lightsail container service, a new image push, DNS
or client cutover, and re-pointing the Stripe, Resend and Twilio webhooks. The
18 credentials and the Secrets Manager secret (`p10`) are region-scoped and
would need copying. **This is the only option that removes the problem.**

**2. Move the database to us-east-1.** Supabase cannot move a project between
regions in place: it is a new project plus a dump and restore, taking a
migration window with real downtime, and every connection string and key
changes. Strictly worse than option 1 for the same benefit, unless there is a
data-residency reason to prefer US hosting — there may be, and that is a legal
question (`s3`–`s5`), not a technical one.

**3. Reduce the number of round trips instead.** Batch sequential queries,
push multi-step work into RPCs, cache what does not change per request. Real
and useful regardless of where anything lives, but it fights the symptom: the
tenth query still costs 313 ms.

**4. Accept it and set a tripwire.** The p7/N014 alerting now exists; add a
latency budget alert so this surfaces when it starts mattering rather than
when a customer notices. Cheapest, and honest as long as it is a decision
rather than an omission.

## What would change the answer

- **EU data residency.** If `s3`–`s5` conclude that customer data should stay
  in the EU, option 2 is off and option 1 gets easier to justify.
- **Voice going live.** `v6`/`v7` are unexercised because no number is
  provisioned (`N012`). Real calls are latency-sensitive in a way HTTP is not,
  and a turn that waits on several sequential queries will be audible.
- **Traffic.** Today's volume is simulator traffic. 313 ms per query is
  survivable at this scale and is not at any real one.

## Recommendation

Not urgent, and not ignorable. **Do option 4 now** — a latency tripwire on the
alerting that already exists — and **do option 1 before voice goes live**,
because that is the point at which this stops being a number in a document and
starts being something a caller hears.

Related: `p11` (load), `N014` (alerting), `p10` (region-scoped secrets),
`N012` (no number yet), `s3`–`s5` (residency).
