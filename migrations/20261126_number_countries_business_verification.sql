-- Platform country switches + business verification for regulated countries.
-- Additive only: two new tables, no change to existing ones.

-- Which countries tenants may buy numbers in and place outbound calls to.
-- Super Admin flips these. Inbound calls are never affected.
create table if not exists public.platform_number_countries (
  iso_country text primary key check (iso_country ~ '^[A-Z]{2}$'),
  enabled     boolean not null default false,
  updated_by  text,
  updated_at  timestamptz not null default now()
);

insert into public.platform_number_countries (iso_country, enabled) values
  ('US', true), ('CA', true),
  ('GB', false), ('AU', false), ('IE', false), ('NZ', false)
on conflict (iso_country) do nothing;

alter table public.platform_number_countries enable row level security;

-- One business verification per attempt. Statuses:
--   draft          created, documents being added
--   needs_changes  pre-check found problems; owner fixes and resubmits
--   submitted      sent for review
--   in_review      reviewer has picked it up
--   approved       numbers in this country/type can be bought
--   rejected       reviewer refused it; rejection_reason says why
create table if not exists public.business_verifications (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations(id) on delete cascade,
  iso_country         text not null,
  number_type         text not null default 'local',
  status              text not null default 'draft'
                      check (status in ('draft','needs_changes','submitted','in_review','approved','rejected')),
  business_name       text,
  details             jsonb not null default '{}'::jsonb,
  address             jsonb not null default '{}'::jsonb,
  documents           jsonb not null default '[]'::jsonb,
  issues              jsonb not null default '[]'::jsonb,
  rejection_reason    text,
  provider_account_sid text,
  provider_address_sid text,
  provider_end_user_sid text,
  provider_bundle_sid text,
  regulation_sid      text,
  created_by          uuid,
  submitted_at        timestamptz,
  decided_at          timestamptz,
  notified_status     text,
  last_checked_at     timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists business_verifications_org_idx
  on public.business_verifications (organization_id, iso_country, number_type, status);
create unique index if not exists business_verifications_bundle_idx
  on public.business_verifications (provider_bundle_sid)
  where provider_bundle_sid is not null;

alter table public.business_verifications enable row level security;

notify pgrst, 'reload schema';
