# Deploying the backend to AWS

Written after the v1.1 deploy on 6 Oct 2026, from the commands that actually
ran. Every step below was used to take `agently-ingest` from v35 to v37 and
`agently-calls` from v8 to v10.

## What you are deploying to

Two Lightsail **container services**. They are separate deployments and
separate images.

| service | container | what it is |
|---|---|---|
| `agently-ingest` | `api` | the REST API. Also runs a second container, `ingest-worker`, which you leave alone |
| `agently-calls` | `ws-server` | the live-call websocket server |

Everything runs from `Agently-AWS/`, and the scripts live in `agently-ops/`.

### The one thing to understand before you touch anything

**Lightsail has no "change one setting" API.** Every deployment replaces the
*entire* service definition — every environment variable, both containers, the
ports, the public endpoint and its health check. Change the image by hand and
you can silently drop ninety environment variables, and production starts
running on defaults nobody chose.

That is the only reason the scripts in `agently-ops/` exist. They read the
running deployment, change the one thing you asked for, and write everything
else back verbatim. **Never hand-edit a deployment JSON in the console.**

Every script is a **dry run by default** and needs `--apply` to submit. Read
the dry run. It tells you the version it is starting from, what changes, and
what is carried over.

---

## Step 0 — pre-flight (skip this and you can take email down)

Only when the deploy touches `lib/email.js` or `lib/email-delivery.js`:

```bash
cd "C:/Users/DELL/Documents/Confidential -ViralAd Media/Agently-AWS/agently-server" && node -e "require('dotenv').config(); (async()=>{const {assertEmailRecipientsAllowed}=require('./lib/email-delivery'); try{await assertEmailRecipientsAllowed({to:'agentlycallsupport@gmail.com'}); console.log('ALLOWED');}catch(e){console.log('BLOCKED',e.code||e.message);}})()"
```

It must print `ALLOWED`. That guard fails **closed** — if the table it reads is
missing, it rejects every address including good ones, and all email stops.
This check caught exactly that before v15.

Also confirm the tests pass before building anything:

```bash
cd "C:/Users/DELL/Documents/Confidential -ViralAd Media/Agently-AWS/agently-server" && node test/run.js
```

## Step 1 — environment variables first, image second

Deploy env vars **before** the image when the new code needs them at boot. New
variables are inert to the old image, so this deploy changes no behaviour — but
it means the new image starts with everything it needs on its first boot.

Get them onto the container without putting secrets in your shell history:

```bash
cd "C:/Users/DELL/Documents/Confidential -ViralAd Media/Agently-AWS/agently-ops" && node push-env-to-container.js --vars NAME1,NAME2
```

That reads the values out of `agently-server/.env` and shows fingerprints, not
values. Add `--apply` when the dry run looks right. For the ws-server:

```bash
node push-env-to-container.js --vars INTERNAL_API_SECRET --from ../agently-ws-server/.env --service agently-calls --apply
```

It refuses to push a partial set, because a half-configured service is a real
restart into a broken state. `--allow-partial` overrides that deliberately.

> **Watch the redirect URIs.** Your local `.env` points OAuth callbacks at
> `localhost:4000`. Production must point at the Lightsail host. Do not push
> the local values — build the production set separately, as the v1.1 deploy
> did.

## Step 2 — build the image

```bash
cd "C:/Users/DELL/Documents/Confidential -ViralAd Media/Agently-AWS" && docker build -t agently-api:v1.1-$(git -C agently-server rev-parse --short HEAD) agently-server/
```

Tagging with the commit SHA means you can always tell which code an image is.
For the ws-server, build `agently-ws-server/` as `agently-ws:<tag>`.

## Step 3 — push it to Lightsail

```bash
aws lightsail push-container-image --service-name agently-ingest --label api --image agently-api:<tag> --profile agently --region us-east-1
```

The last line of the output is the only part you need:

```
Refer to this image as ":agently-ingest.api.31" in deployments.
```

For the ws-server: `--service-name agently-calls --label ws-server`.

## Step 4 — deploy the image

```bash
cd "C:/Users/DELL/Documents/Confidential -ViralAd Media/Agently-AWS/agently-ops" && node deploy-api-image.js :agently-ingest.api.31
```

Dry run first. Check it says `env vars carried over` with the number you
expect, and that `ingest-worker` is unchanged. Then `--apply`. For the
ws-server add `--service agently-calls`.

## Step 5 — wait, then verify

A deployment takes about three minutes and restarts the container once.

```bash
aws lightsail get-container-services --service-name agently-ingest --profile agently --region us-east-1 --query "containerServices[0].{state:state,version:currentDeployment.version,image:currentDeployment.containers.api.image}" --output json
```

Wait for `RUNNING` **and** the new version number. `DEPLOYING` with the old
version means it has not switched yet.

Then check it actually works, rather than assuming:

```bash
curl -s https://agently-ingest.zxy7w9w65bv9y.us-east-1.cs.amazonlightsail.com/health
```

And confirm the routes mounted. `safeMount` catches a broken route file and
serves a 503 for that prefix instead of killing the container — which is good,
but it means **a broken deploy can look healthy**. Read the log:

```bash
aws lightsail get-container-log --service-name agently-ingest --container-name api --profile agently --region us-east-1 --start-time "$(date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%SZ)" --output text | grep -iE "mounted|FAILED to mount"
```

`FAILED to mount` anywhere means that feature is down even though `/health`
says ok. Always pass `--start-time` — without it the log returns a narrower
window than you expect, which has hidden evidence before.

A quick route check is worth more than a health check:

- **404** — the route does not exist. The image did not take, or the route is not mounted.
- **401** — the route exists and wants auth. This is what you want to see.

## Step 6 — the real test

Log in for real and request an OTP. That exercises Supabase, Resend and the
session path in one action. A deploy is not verified until a human has logged
in.

---

## If something is wrong

Roll back by deploying the previous image label — the same Step 4 command with
the older tag. The previous image is still in the registry.

```bash
node deploy-api-image.js :agently-ingest.api.30 --apply
```

Environment variables do not roll back with the image, so if you changed both,
undo the variable too with `set-container-env.js --unset NAME --apply`.

---

## What the v1.1 deploy actually did

| | from | to |
|---|---|---|
| `agently-ingest` env | v35 | **v36** — 9 calendar variables added, 93 → 102 |
| `agently-ingest` image | `api.30` | **v37**, `api.31` |
| `agently-calls` env | v8 | **v9** — `INTERNAL_API_SECRET`, 107 → 108 |
| `agently-calls` image | `ws-server.12` | **v10**, `ws-server.32` |

Verified afterwards: `/health` ok, all three calendar routes answering 401
rather than 404, `mounted integrations`, `mounted business-groups` and
`mounted internal-calendar` in the log with no failures.

`APP_HASH_ROUTES` was deliberately left **unset**, so the API keeps emitting
`/#/…` links that the current production frontend can serve. When the frontend
ships, set it to `false` and every link flips at once.

One standing item: `ALLOW_LOCALHOST_ORIGIN=true` is set on production (since
before v35). It lets a page on a developer's machine make credentialed
requests to the live API. It is the bridge until a staging API exists, not the
destination.
