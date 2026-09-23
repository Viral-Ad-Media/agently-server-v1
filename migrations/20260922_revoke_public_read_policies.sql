-- N015: remove public read access to tenant data.
--
-- Four PERMISSIVE policies grant SELECT with qual = true to roles
-- {anon, authenticated} on tables holding personal data:
--
--   realtime_read_leads          65 rows: name, phone, email, reason
--   realtime_read_call_records   150 rows: caller_name, caller_phone, transcript
--   realtime_read_organizations  58 rows
--   realtime_read_billing_wallets 48 rows: balances
--
-- The anon key is compiled into the public frontend bundle by design, so this
-- is not a theoretical grant: an anonymous GET against the live site's key
-- returned lead names, phones and emails, across every tenant.
--
-- They exist to make Supabase Realtime subscriptions work
-- (agently/services/realtime.ts subscribes to exactly these four tables). They
-- cannot be narrowed instead of dropped, because the frontend talks to
-- Supabase with the ANON key and no Supabase Auth session — the app
-- authenticates against the Agently API with its own JWT — so there is no
-- auth.uid() or org claim to scope a policy by. There is nothing to write a
-- correct policy against.
--
-- COST OF THIS FIX, stated plainly: live dashboard updates stop. Calls, leads,
-- wallet changes and organization edits will no longer push to the browser;
-- the UI falls back to refreshing when the user navigates or reloads. That is
-- a real regression and it is worth paying immediately.
--
-- The proper fix is to move realtime behind the API, which already
-- authenticates and already knows the organization — server-sent events or the
-- existing WebSocket. That is a separate piece of work.
--
-- REVERSIBLE: the recreate statements are at the bottom, commented out. If
-- something unexpected breaks, restoring them takes seconds — but understand
-- that restoring them restores the exposure.

begin;

drop policy if exists realtime_read_leads on public.leads;
drop policy if exists realtime_read_call_records on public.call_records;
drop policy if exists realtime_read_organizations on public.organizations;
drop policy if exists realtime_read_billing_wallets on public.billing_wallets;

commit;

-- Verification (expect zero rows for anon on each):
--   set role anon; select count(*) from public.leads; reset role;
--
-- ROLLBACK, which re-exposes the data:
--   create policy realtime_read_leads on public.leads
--     for select to anon, authenticated using (true);
--   create policy realtime_read_call_records on public.call_records
--     for select to anon, authenticated using (true);
--   create policy realtime_read_organizations on public.organizations
--     for select to anon, authenticated using (true);
--   create policy realtime_read_billing_wallets on public.billing_wallets
--     for select to anon, authenticated using (true);
