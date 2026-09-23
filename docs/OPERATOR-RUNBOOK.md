# Operator runbook — the 35 items only you can do

Written 22 Sep 2026 against the live system. Work top to bottom: the order is
chosen so nothing waits on something further down.

**Before you start, know these three facts about your own system.** Each one
is measured, not assumed.

| | |
|---|---|
| AWS account | `808180619849`, profile `agently`, region `us-east-1` |
| API | `https://agently-ingest.zxy7w9w65bv9y.us-east-1.cs.amazonlightsail.com` |
| Website | `https://www.agentlycall.com` (Vercel, project `agently-frontend-v1`) |
| Database | Supabase `qozbmfwxlcuvwzbxtvnn`, **eu-central-1** |
| Secret | `arn:aws:secretsmanager:us-east-1:808180619849:secret:agently/api-DIl9iX` |
| Super-admin | `support@agentlycall.com` |
| Alerts go to | `viraladmediacontent@gmail.com` |

> **Odd thing worth knowing before you read on:** the production container has
> `AGENTLY_ENV=aws-staging`. It is serving real traffic while labelled staging.
> Nothing depends on it today, but it will mislead somebody eventually.

---

## Order, and why

| # | Session | Closes | Time |
|---|---|---|---|
| 1 | Twilio: buy and wire one number | **6 rows** | 30 min |
| 2 | AWS: finish the secrets migration | 1 row | 20 min |
| 3 | The billing decision | **8 rows** | 30 min thinking |
| 4 | Legal: one brief | **6 rows** | 30 min to write, then wait |
| 5 | Launch shape | **4 rows** | 20 min thinking |
| 6 | Mobile: TestFlight + Play | **3 rows** | 2 h first time |
| 7 | Five one-off clicks | 5 rows | 20 min |
| 8 | Four judgement calls | 4 rows | 20 min |

Sessions 1–2 are mechanical. Sessions 3, 5 and 8 are decisions — you can make
them in a coffee shop. Session 4 unblocks the longest clock, so **write that
brief early even if you do nothing else today.**

---

# Session 1 — Twilio: buy and wire one number

**Closes `N012`, `v1`, `v2`, `v8`; makes `v6`/`v7` possible. Six rows for about $1/month.**

Right now `twilio_phone_numbers` has **zero rows**. No number has ever been
provisioned, which is why every voice row is untestable rather than untested,
and why all 150 `call_records` have an empty `provider_call_id` — none of them
came from a carrier.

Your Twilio account SID is `AC379c…818d` (already on the container).

### 1.1 Buy the number

1. Go to **console.twilio.com** and sign in.
2. Make sure the account selector at the top-left shows the account ending
   `818d`. If you have sub-accounts, the number must be bought in **that** one.
3. Left sidebar → **Phone Numbers** → **Manage** → **Buy a number**.
4. Set **Country** to one of `US, CA, GB, AU, IE, NZ` — those are the only ones
   the backend allows (`TWILIO_ALLOWED_COUNTRIES`). **US** is the safe pick;
   it is also the default for outbound.
5. Under **Capabilities**, tick **Voice**. (Tick **SMS** too if you ever want
   `k3` follow-up texts — it costs nothing extra to have it.)
6. **Search**, pick any number, **Buy**.

### 1.2 Point it at Agently

1. Still in **Phone Numbers → Manage → Active numbers**, click the number you
   just bought.
2. Scroll to **Voice Configuration**.
3. **A call comes in**: set the dropdown to **Webhook**, paste this URL, method
   **HTTP POST**:
   ```
   https://agently-ingest.zxy7w9w65bv9y.us-east-1.cs.amazonlightsail.com/api/twilio/voice-inbound
   ```
4. **Call status changes**: set to **Webhook**, method **HTTP POST**:
   ```
   https://agently-ingest.zxy7w9w65bv9y.us-east-1.cs.amazonlightsail.com/api/twilio/status
   ```
5. **Save configuration**.

> These are the paths that actually exist on the deployed API. Older internal
> notes said `/api/twilio/voice/:id/inbound` — that returns 404. Use the two
> above.

> **Get the URL exactly right, including `https` and no trailing slash.** Every
> request is signature-checked using the URL Twilio sends and the URL we see.
> A mismatch fails with no useful error.

### 1.3 Register it in Agently

The inbound handler finds the voice agent **from the `To` number**. A number
Twilio knows about but Agently does not will reach the API and find nothing.

1. Sign in to **https://www.agentlycall.com**.
2. Go to **Settings → Twilio** (or the Phone Numbers screen).
3. Add the number you bought and attach it to your voice agent (**Maya** is the
   only one in production).

### 1.4 Fill in the escalation number

Maya's `escalation_phone` is **empty**, so "transfer me to a human" currently
has nowhere to dial and the call falls through instead of escalating.

1. **Agent Settings → Maya → Escalation**.
2. Put a real phone number in. Your own mobile is fine for testing.

### 1.5 Make one real call

1. Ring the number from your phone.
2. Let the greeting play, say something, let it answer, then say **"transfer me
   to a human"** and confirm your escalation phone rings.
3. Hang up.

### Verify

Tell me it's done and I will check `call_records` for a row with a **non-empty
`provider_call_id`** — that field is how we know a call came from a carrier
rather than the simulator.

**Do not skip the real call.** Everything before it proves configuration;
only the call proves voice.

---

# Session 2 — AWS: finish the secrets migration

**Closes `p10`.** The secret already exists and holds all 18 credentials,
verified. What is missing is the container's ability to read it.

You already created the IAM user `agently-api-secrets` and its policy. You also
created an access key in a shell that has since closed, so that key is
orphaned — we will make a fresh one and delete the old.

### 2.1 Create a key and store it where it survives

Open **PowerShell** (your own terminal, not the chat) and run this as one line.
It creates the key and writes it straight into your AWS credentials file
without ever displaying it:

```powershell
$k = aws iam create-access-key --user-name agently-api-secrets --profile agently | ConvertFrom-Json; Add-Content "$env:USERPROFILE\.aws\credentials" "`n[agently-api-secrets]`naws_access_key_id = $($k.AccessKey.AccessKeyId)`naws_secret_access_key = $($k.AccessKey.SecretAccessKey)"; Write-Host "stored key ...$($k.AccessKey.AccessKeyId.Substring(16))"
```

It prints only the last four characters. That is deliberate.

### 2.2 Delete the orphaned key

1. Go to **console.aws.amazon.com/iam** → **Users** → **agently-api-secrets**
   → **Security credentials**.
2. You should see **two** access keys. The one created a moment ago is the one
   whose last four characters PowerShell just printed.
3. On the **other** one: **Actions → Deactivate**, then **Actions → Delete**.
4. Confirm.

> Leaving a key you cannot use is not harmless — it is a live credential with
> no owner, and it will still work if someone finds it.

### 2.3 Check the policy is right

While you are on that user, click the **Permissions** tab. You should see an
inline policy (named `ReadOneSecret`) containing exactly:

```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:us-east-1:808180619849:secret:agently/api-*"
}
```

If the Action list is wider than that single entry, narrow it. This user should
be able to do one thing.

### 2.4 Hand it back to me

Tell me the profile is in place. I will then run a dry run, confirm the key can
actually read the secret **before** deploying anything, deploy it, and check
the container log for the line naming all 18 keys. Only after that line appears
do the plaintext copies get removed.

> **What this is actually worth, so the row is not oversold:** it turns 18
> readable credentials into one readable key pair, and it gives you a CloudTrail
> record of every read, which you have none of today. Lightsail cannot do
> better than that — it has no secrets integration and no task roles. Removing
> the bootstrap credential entirely needs ECS/Fargate.

---

# Session 3 — The billing decision

**Closes or resolves `N009`, `b1`, `b2`, `b3`, `b4`, `b5` — six rows — and
unblocks `b6` and `b9`.**

### What is actually true today

The billing engine is **built and switched off**. On the container right now:

```
BILLING_CREDIT_ENFORCEMENT_MODE = observe
BILLING_DISABLE_CUSTOMER_CHARGES = true
BILLING_AUTO_CHARGE_WALLET = true
```

Enforcement still bites — a wallet at $0 returns 402 and blocks the action.
What is switched off is **charging**. Stripe is live and configured, the
webhook endpoint has been verified receiving real production events, and the
ledger holds 6,799 usage rows. You are metering everything and billing nobody.

### The decision

Pick one. Both are defensible; drifting is not.

**A. Turn charging on before launch.** You start collecting money. It also
means `b3` (real invoices), `b5` (period reset) and `b7` (failed payment,
dunning, cancellation) stop being optional, because a customer whose card
declines needs a defined outcome. Budget real time for that.

**B. Launch with billing off, deliberately.** A free pilot. Metering keeps
running so you learn your unit economics against real traffic before pricing.
Then `b1`–`b5` stop being launch-critical and become a post-pilot project —
which is a legitimate way to clear six rows, and an honest one as long as the
board says "deferred" rather than "done".

**B pairs naturally with a closed pilot in Session 5.** If you pick a closed
pilot there and charging here, you are building invoicing for three friendly
customers — possible, but ask whether it is where the week should go.

### If you pick A

Tell me and I will:
1. Confirm the restricted Stripe key can actually **write**, not just read
   (`b9`) — that needs your sign-off because it touches live Stripe.
2. Flip the three flags in one deploy.
3. Watch the first real charge end to end.

**Do not flip these flags yourself.** They are the difference between charging
nobody and charging everybody, and the order matters.

### If you pick B

Just say so. I will mark `N009`, `b1`–`b5` as *deliberately deferred* with the
reason on the board, and they stop counting against launch.

---

# Session 4 — Legal: one brief

**Closes `s3`, `s4`, `s5`, `s6`, `s7` and `v9` — six rows — with one
engagement. Start this first; it has the longest clock.**

You need a lawyer who does **US telecoms (TCPA) and data protection**. Not
two lawyers; most privacy practices cover both.

### What to send them

Copy this, fill the brackets, send it:

> We operate an AI voice and chat receptionist platform (agentlycall.com) for
> small service businesses. We are pre-launch with [58] workspaces on the
> system and are preparing to take payment.
>
> **What the product does.** It answers inbound phone calls with an AI agent,
> makes outbound follow-up calls, runs a website chat widget, and stores the
> leads and call transcripts generated. Voice runs on Twilio; transcription and
> generation on OpenAI; email on Resend; data in Supabase, hosted in the EU
> (eu-central-1). Our application servers are in the US (us-east-1).
>
> **We need six things.**
> 1. A **privacy policy** that describes this product accurately, including
>    that we process call audio and transcripts containing the personal data of
>    our customers' customers — people who have no relationship with us.
> 2. **Terms of service** for a metered telephony product: per-minute and
>    per-message charges, a prepaid wallet, and what happens when it runs out.
> 3. A **subprocessor list and a DPA** we can sign with customers. Our
>    subprocessors are Twilio, OpenAI, ElevenLabs, Resend, Supabase, AWS and
>    Vercel.
> 4. **TCPA review of outbound calling**: consent, time-of-day restrictions,
>    do-not-call handling, and what our customers must warrant to us about
>    their own lists.
> 5. **A2P / carrier registration** guidance for the US, and whether our use
>    case needs it before we send or call at volume.
> 6. A **call recording policy**. We do not record today. We need to know what
>    disclosure is required before the first caller turn in two-party-consent
>    states, and whether we should ship recording at all initially.
>
> We are a data **processor** for our customers' data and a **controller** for
> our own account data. Please confirm whether you agree with that split.

### While you wait

Nothing else blocks on this. Recording (`v9`) stays off until they answer —
that is the right default, not a delay.

---

# Session 5 — Launch shape

**Closes or reframes `g6`, `g1`, `g2`, `g3` — four rows.**

`g1` is currently written as *"run three real businesses on it, free, for
thirty days."* That is a **thirty-day clock**. If it stays launch-critical, you
cannot launch for a month regardless of anything else. This session is where
you decide whether you meant that.

### The choice

**Closed pilot.** Three to five businesses you can phone. No public signup, no
payment. `g1` and `g2` (a week of transcripts) are the *point* of a pilot
rather than blockers on it, and `g3`'s support SLA can be "text me".

**Paid public.** Anyone can sign up and be charged. Then `g1`, `g2`, `g3`,
support, status page (`g5`) and the whole of Session 3 are genuinely required,
and you should assume weeks, not days.

### `g3` — support channel

Whichever you pick, you need one place a customer can reach a human and a
stated time you will answer.

Cheapest honest version: an email address that reaches you, published in the
app and on the site, with "we reply within one business day" next to it. That
closes `g3`. A helpdesk product is not required.

Tell me which shape you picked and I will re-score those four rows against it.

---

# Session 6 — Mobile: TestFlight and Play

**Closes `mb4`, `mb5`, `mb6`.** The app is at
`C:\Users\DELL\Desktop\agently_base44\agently-mobile-claude`. Login, OTP and
sessions already work on a real device; nothing else has been driven from one.

### 6.1 iOS — TestFlight

1. You need an **Apple Developer Program** membership ($99/year). If you do not
   have one, start it now — approval can take a day or two.
2. In the mobile project, build for release with EAS:
   ```bash
   npx eas build --platform ios --profile production
   ```
3. When it finishes, submit it:
   ```bash
   npx eas submit --platform ios
   ```
4. Go to **appstoreconnect.apple.com** → **My Apps** → your app →
   **TestFlight**. The build appears after processing (10–30 min).
5. Add yourself under **Internal Testing** and install via the TestFlight app.

### 6.2 Android — internal track

1. You need a **Google Play Console** account ($25, one-off).
2. Build and submit:
   ```bash
   npx eas build --platform android --profile production
   npx eas submit --platform android
   ```
3. **play.google.com/console** → your app → **Testing → Internal testing** →
   **Create new release**, attach the build, **Review**, **Start rollout**.
4. Copy the opt-in link from that page and open it on an Android device.

### 6.3 Exercise it — this is `mb4` and `mb5`

On a real device, with the build from the store rather than a dev server:

- **`mb5`** — start a voice call and send a chat message. Only login has ever
  been driven from a device.
- **`mb4`** — the revoked-session path. Sign in, then tell me: I will revoke
  that session server-side while you hold the phone. **Watch what happens.**
  The risk is that you land on a screen that silently fails rather than being
  returned to sign-in. That is the whole row.

### Note on `mb7`

The API URL is compiled into the binary. If the API host ever changes, every
installed build is stranded with no way to retarget it. Not blocking, but
decide the forced-upgrade path before you have real users on the store.

---

# Session 7 — Five one-off clicks

### 7.1 `N005` — one super-admin sign-in

Two-factor is enforced now and the seed is on the container, but **nobody has
ever signed in through it**. Until someone does, we do not know it works.

1. Go to the super-admin sign-in and use **support@agentlycall.com**.
2. Enter the password, then the 6-digit code from your authenticator.
3. Tell me if it worked — and tell me immediately if it did **not**, because a
   failure here means the seed on the container and the one in your
   authenticator disagree.

> Failing closed is intentional: if the seed goes missing, nobody gets in until
> it is restored. That is the right trade for an account that can act as any
> tenant, and it is why this needs testing before you rely on it.

### 7.2 `N014` — arm the alerter

Built and deployed, switched **off**. Arming it starts sending real email to
`viraladmediacontent@gmail.com` when the webhook path goes unhealthy.

It alerts **once** on going bad, then stays quiet for an hour, and announces
recovery once. It will not flood you.

Just say "arm it" and I will set the flag and deploy.

> It runs inside the API, so it catches a *sick* process, not a *dead* one. For
> liveness you want an external checker polling
> `GET /api/webhooks/health` with the `x-internal-key` header — any uptime
> service will do. That is `g5`-adjacent and worth 10 minutes one day.

### 7.3 `p8` — backups

I cannot read your backup configuration; the Supabase management API does not
expose it.

1. **supabase.com/dashboard** → project **agently** → **Settings** →
   **Database** → scroll to **Backups**.
2. Tell me: what is the **retention** (7 days? 30?) and is **Point-in-Time
   Recovery** on or off?
3. Then, the part that actually closes this row — **restore something**:
   - **Database → Backups → Restore**, pick a recent one.
   - Restore it to a **new branch or project**, never over production.
   - Check a table has the rows you expect.
   - Delete the restored copy.

> An untested backup is a belief, not a control. The ledger alone is 6,799 rows.

### 7.4 `s1` — book a security reviewer

The automated sweep is clean: auth gates refuse anonymous callers, error
responses leak nothing, 6 high dependency advisories fixed, security headers
deployed. That clears the ground so a reviewer does not spend day one on it.

What it cannot do is bring adversarial intent. **The live data exposure we
found today was not found by a scanner** — it came from a test written to check
an assumption. That is what you are paying a human for.

Ask for a **web application penetration test**, roughly 3–5 days, scoped to:
the public API, the embedded chat widget, the authentication and session
system, and multi-tenant isolation. Give them the Launch Gate board.

### 7.5 `b9` — prove the Stripe key can write

The live restricted key is set and reads fine. Whether it can **write** — create
a charge, issue a refund — has never been tested, and finding out during your
first real customer payment is the wrong time.

This touches live Stripe, so it is your call. Say the word and I will do the
smallest possible write and reverse it. Or do it yourself from the Stripe
dashboard.

---

# Session 8 — Four judgement calls

Quick answers; each closes or advances a row.

### 8.1 `a5` — ship booking or leave it unsold

The claims are gone (I removed all five today, including a dead "Booking
Engine" toggle that was wired to nothing). So nothing is being mis-sold right
now. The remaining question is whether to **build** it.

Real work: a calendar integration (Google/Calendly), availability lookup, a
booking write, and confirmation. Assume a week, not an afternoon. Leaving it
out is entirely defensible for a v1 receptionist.

**Answer needed:** build it now, or explicitly not for v1?

### 8.2 `N010` — the region split

Your API is in us-east-1; your database is in eu-central-1. Measured cost:
**~313 ms per query**. Ten sequential queries is 3.1 seconds of pure Atlantic.
There is headroom today, but it is made of round trips.

Full analysis in `docs/N010-REGION-SPLIT.md`. My recommendation: a latency
tripwire now, and **move the API to eu-central-1 before voice goes live** —
that is when this stops being a number and becomes something a caller hears.

**Answer needed:** move it, or accept it with a tripwire?

### 8.3 `p12` — commit the code

Production is running from **42 uncommitted files on your laptop**. Not a
commit, not a branch, not a remote. If that machine died, the running code
could not be reconstructed.

I have not committed anything because your standing instruction is that
everything stays local until you say otherwise. **I think that instruction has
outlived its usefulness** — it was protecting you from unreviewed changes, and
it is now the single largest operational risk on the board.

**Answer needed:** may I commit to the `launch-readiness-2026-09-22` branch and
push? Nothing merges to `main` without you.

### 8.4 HSTS preload, and three advisories

Two small ones:

- **HSTS preload.** The header is live with a two-year max-age but is *not*
  preloaded. Preloading is close to irreversible and bakes into browsers.
  Worth doing once you are certain every subdomain will be HTTPS forever.
  **Not now** is the right answer unless you are certain.
- **Three moderate dependency advisories** remain, fixable only by major
  version bumps that could break things. **Answer needed:** shall I attempt
  them on a branch and run the suite, or leave them?

---

# The two that are mine

Not waiting on you, listed so the ledger adds up:

- **`a4`** — answer quality. The harness is built and first numbers are taken:
  literal recall 83%, paraphrase 80%, typo 57% at recall@5. The paraphrase
  cliff we expected is not there; the fuzzy matching is the weak part. Mine to
  improve.
- **`p1`** — CI. Workflows exist and are committed in all three repos, but the
  frontend one runs no tests and I cannot read run history (`gh` is not
  installed and `GITHUB_TOKEN` was pruned). Mine, once `p12` is answered.

---

# Fastest path if you only have one hour

1. **Send the legal brief** (Session 4). Longest clock, 30 minutes.
2. **Answer Session 8.3** — one word, removes the biggest operational risk.
3. **Buy the Twilio number** (1.1 and 1.2). Six rows for a dollar.

Everything else can wait for the next sitting.
