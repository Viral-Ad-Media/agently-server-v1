# Email bounce handling: rollout and support

## What is implemented

`POST /api/email/resend/webhook` verifies the raw JSON bytes with Svix and the endpoint signing secret, including timestamp validation. It processes `email.bounced`, `email.complained`, and `email.suppressed` for the configured sender address (`RESEND_FROM_EMAIL`). Other senders and events are ignored. An unexpected multi-recipient failure is rejected rather than guessing which recipient failed.

Signed failures persist via a database upsert that ignores older or duplicate event timestamps. A failed write returns 503 to request retry. No subject, OTP, raw webhook payload, email body or plaintext recipient address is stored; the normalized address is SHA-256 hashed for matching. Hashes remain personal data and the table is service-role-only.

All mail through `lib/email.js` checks To/CC/BCC against this table before sending. Known blocks prevent sends; unavailable block storage also prevents sends. Authentication code flows provide a nonretryable support/address-check message for known blocked addresses. The original send can still be accepted before a later bounce arrives; this feature prevents subsequent attempts once the failure event has been received.

## Required order — prepared, not executed

1. Choose an isolated Supabase test database. Apply `migrations/20260921_email_delivery_blocks.sql`, then run `test/email-delivery-migration.sql`. The test rolls back its fixtures. Confirm duplicate events, late events, support clearance and role restrictions pass.
2. Run `npm ci`, `npm test`, and `npm run lint` using the deployment's Node 20 runtime. The current 31-test suite has also passed locally via a temporary Node 20 runtime; CI execution remains to be evidenced. A disposable PostgreSQL CI job now runs the SQL migration/test separately.
3. Verify the actual API deployment target, source revision and sender. Use the same reviewed sender address in both the mail configuration and Resend. Do not create this webhook on the frontend or the legacy API slated for retirement.
4. Apply the reviewed migration to production BEFORE deploying the guard. A missing table makes email sends fail closed. This requires a database change; coordinate its execution explicitly.
5. Create a webhook in the appropriate Resend account with the confirmed API origin plus `/api/email/resend/webhook`. Subscribe to `email.bounced`, `email.complained`, and `email.suppressed`. Obtain its signing secret and set `RESEND_WEBHOOK_SECRET` in the API's deployment environment. Never paste the secret into chat, source or evidence files. Initial delivery may fail until the new API release is deployed; verify retries afterward.
6. Deploy the reviewed release with its lockfile and new environment setting. Existing sender/key settings remain necessary. Confirm the migration is visible with the deployed service-role credentials.
7. In staging, exercise authentic signed provider events and invalid signatures, then check one controlled mailbox flow. Replay a failure; verify one block remains and subsequent code sends produce the support message without a provider send/usage event. Check normal delivery still works. Record the actual provider delivery status and deployed revision.
8. Review Resend's EXISTING suppressions for the configured sender. New webhooks do not automatically backfill earlier failures. Replaying historical relevant events or an explicitly scoped import is needed to cover known predeployment failures. Do not blanket-clear suppressions.

## User actions when ready

The account owner needs to provide access to the chosen test database and perform/approve the production migration, create the Resend webhook, securely configure its signing secret and approve the reviewed deployment. These steps are not complete yet. Read-only AWS inspection confirmed the API public endpoint on `agently-ingest`, deployment version 13, image `:agently-ingest.api.14`. The candidate webhook URL is `https://agently-ingest.zxy7w9w65bv9y.us-east-1.cs.amazonlightsail.com/api/email/resend/webhook`; the deployed source revision still needs reconciliation before rollout (p12).

## Support recovery

1. Confirm the requester's identity and mailbox spelling/ownership. Investigate the provider failure. A spam complaint must not be cleared without an appropriate consent review.
2. Fix the underlying mailbox issue and review the provider suppression with the Resend account owner. Clearing only Agently's record cannot restore provider delivery.
3. Compute the recipient hash using the same normalization as `recipientHash` in `lib/email-delivery.js`; avoid storing plaintext addresses in shell history or tickets.
4. Through an authorized database session, clear only the reviewed recipient, keeping a timestamp tombstone so old webhook retries cannot reblock it. Substitute the reviewed 64-character hash; do not run an unscoped update:

```sql
update public.email_delivery_blocks
set blocked = false, occurred_at = now(), updated_at = now()
where recipient_hash = '<reviewed-recipient-sha256>' and blocked = true
returning recipient_hash, blocked, occurred_at;
```

5. Confirm exactly the intended row changed and test delivery with the mailbox owner's participation. A genuinely new failure will block the recipient again. Ordinary `email.delivered` events never automatically clear blocks.

No self-service/public unblock endpoint is provided. Maintain a support audit record without OTPs or secrets. Table retention and deletion should be included in the data-retention review (s8).

## References

- [Resend webhook signature verification](https://resend.com/docs/webhooks/verify-webhooks-requests)
- [Resend event types](https://resend.com/docs/webhooks/event-types)
- [Per-recipient event visibility](https://resend.com/changelog/webhook-event-visibility)

## Verification limits

On 22 September 2026, the migration applied successfully twice against a disposable, network-isolated PostgreSQL 16.15 container. The SQL regression test passed as `service_role`: duplicate/older events, support clearance, subsequent reblocking, client-role read/write/function restrictions and RLS enabled. Fixtures rolled back to zero rows and the temporary container was removed. This validates SQL behavior with simulated Supabase roles, not the target Supabase configuration.

All 31 backend regression tests and syntax checks passed again; frontend TypeScript checks passed after adding explicit blocked-recipient and temporary-auth-outage guidance to the login screen. No browser/device exercise was performed.

Local JavaScript tests exercise the real signature library, handler, recipient guard and authentication error behavior with database stubs. Target Supabase access, production policies and actual provider retry delivery still require verification. em2 remains open until these deployment and recovery steps are proven.
