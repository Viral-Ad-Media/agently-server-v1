-- 2026-10-07: several calendar accounts per organization.
--
-- One Agently login can run several businesses, each with its own Google
-- account. calendar_integrations therefore becomes one row per *connected
-- account* instead of one row per (organization, provider):
--
--   1. unique (organization_id, provider) is replaced by uniqueness on
--      (organization_id, provider, provider_user_id), so the same account
--      cannot be connected twice while different accounts can.
--   2. label              -- tenant-facing name of the connection
--                            ("Nutra Wellness"); renameable.
--   3. is_booking_default -- the one connection the voice agent books INTO.
--                            At most one true per organization, enforced by a
--                            partial unique index rather than by app code.
--
-- Nothing here touches the token-encryption binding. lib/crypto.js binds
-- ciphertext to { organizationId, provider, connectionId } where connectionId
-- is this table's row id, so several rows per (org, provider) were already
-- safe: each row's tokens decrypt only under its own id.
--
-- business_groups (cross-ACCOUNT linking by invite code) is deliberately
-- untouched -- it serves genuinely separate tenants and is not the mechanism
-- for one tenant's several businesses.
--
-- Idempotent: every step is if-exists / if-not-exists and every backfill is
-- guarded, so this file is safe to re-run.

-- 1. uniqueness: one row per connected account ------------------------------

-- The original inline `unique (organization_id, provider)` from
-- 20261005_calendar_integrations.sql. Postgres named it this.
alter table public.calendar_integrations
  drop constraint if exists calendar_integrations_organization_id_provider_key;

-- ...and any copy of that rule living under another name (a hand-made index,
-- or a constraint renamed by a restore), so a re-run cannot leave the old
-- one-row-per-provider rule in force.
do $$
declare
  obj record;
begin
  for obj in
    select con.conname as name
      from pg_constraint as con
     where con.conrelid = 'public.calendar_integrations'::regclass
       and con.contype = 'u'
       and (
             select array_agg(att.attname::text order by att.attname)
               from pg_attribute as att
              where att.attrelid = con.conrelid
                and att.attnum = any (con.conkey)
           ) = array['organization_id', 'provider']
  loop
    execute format('alter table public.calendar_integrations drop constraint %I', obj.name);
  end loop;

  for obj in
    select cls.relname as name
      from pg_index as idx
      join pg_class as cls on cls.oid = idx.indexrelid
     where idx.indrelid = 'public.calendar_integrations'::regclass
       and idx.indisunique
       and idx.indpred is null      -- not a partial index
       and idx.indexprs is null     -- plain columns only: spares the new
                                    -- coalesce(provider_user_id, '') index
       and not exists (
             select 1 from pg_constraint as con where con.conindid = idx.indexrelid
           )
       and (
             select array_agg(att.attname::text order by att.attname)
               from pg_attribute as att
              where att.attrelid = idx.indrelid
                and att.attnum = any (idx.indkey)
           ) = array['organization_id', 'provider']
  loop
    execute format('drop index public.%I', obj.name);
  end loop;
end $$;

-- provider_user_id is nullable and older rows may carry NULL. A plain UNIQUE
-- treats NULLs as DISTINCT, so (org, google, NULL) could be inserted over and
-- over -- exactly the duplicate-account case this rule exists to stop. Keying
-- on coalesce(provider_user_id, '') makes "account id unknown" a single
-- reservable slot per (organization, provider) and works on every Postgres
-- version (UNIQUE ... NULLS NOT DISTINCT needs 15+). It is an expression
-- index, so reconnect logic must look rows up by the same three columns -- see
-- lib/calendar-tokens.js saveConnection -- and not rely on ON CONFLICT here.
create unique index if not exists calendar_integrations_org_provider_account_key
  on public.calendar_integrations (organization_id, provider, coalesce(provider_user_id, ''));

-- 2. label ------------------------------------------------------------------

alter table public.calendar_integrations
  add column if not exists label text;

-- Backfill only. New connections take the provider account's display name or
-- email (point 2, in app code); for the connection that already exists the
-- name the tenant recognises is their business, so the organization name wins
-- here and the provider's own name/email are the fallbacks. Rows that already
-- carry a label are skipped, so a tenant's rename survives a re-run.
-- updated_at is left alone: it tracks token writes, not cosmetic edits.
update public.calendar_integrations as ci
   set label = coalesce(
         nullif(btrim(org.name), ''),
         nullif(btrim(ci.provider_user_name), ''),
         nullif(btrim(ci.provider_user_email), ''),
         case ci.provider
           when 'google' then 'Google Calendar'
           when 'calendly' then 'Calendly'
           else ci.provider
         end
       )
  from public.organizations as org
 where org.id = ci.organization_id
   and nullif(btrim(ci.label), '') is null;

-- 3. is_booking_default -----------------------------------------------------

alter table public.calendar_integrations
  add column if not exists is_booking_default boolean not null default false;

-- "At most one default per organization" as a database invariant. Partial, so
-- the many false rows do not collide; a bad write fails loudly instead of
-- quietly giving an org two booking targets.
create unique index if not exists calendar_integrations_one_booking_default_per_org
  on public.calendar_integrations (organization_id)
  where is_booking_default;

-- Backfill: every organization that has a usable connection but no default
-- gets one, so the tenant's existing connection keeps receiving bookings the
-- moment this ships. Prefer a healthy connection, then the oldest, with id as
-- a deterministic tie-break. Orgs that already have a default are skipped,
-- which is what makes the re-run harmless.
with promote as (
  select distinct on (ci.organization_id) ci.id
    from public.calendar_integrations as ci
   where ci.status <> 'disconnected'
     and not exists (
           select 1
             from public.calendar_integrations as other
            where other.organization_id = ci.organization_id
              and other.is_booking_default
         )
   order by ci.organization_id,
            (ci.status = 'connected') desc,
            ci.connected_at,
            ci.id
)
update public.calendar_integrations
   set is_booking_default = true
 where id in (select id from promote);
