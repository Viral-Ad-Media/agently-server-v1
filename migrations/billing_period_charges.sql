-- billing_period_charges
--
-- One row per organization per billing period. Exists so a charge can be
-- defended: it keeps the RAW usage that produced the number (call seconds,
-- event count, per-provider cost breakdown) alongside the computed charge and
-- the exact margin used, so any figure on an invoice can be recomputed from
-- first principles months later.
--
-- Written by lib/usage-billing-engine.js.
--
-- NOTE on what is charged here: direct provider cost (Twilio, ElevenLabs,
-- OpenAI, storage, email) is already charged per event through
-- billing_customer_usage_charges + billing_wallet_transactions. It is recorded
-- in this table for auditing only -- direct_charged_elsewhere is always true.
-- The only amount this table's engine debits is shared_billable_usd, the
-- marked-up slice of flat shared infrastructure (AWS Lightsail, Supabase),
-- which nothing else charges.

create table if not exists public.billing_period_charges (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null
    references public.organizations (id) on delete cascade,

  period_start timestamptz not null,
  period_end   timestamptz not null,

  -- how shared cost was split; 'cost_drivers' = the weighted COST_MODEL
  basis text not null default 'cost_drivers',

  -- raw usage, kept for dispute resolution
  call_seconds numeric(18, 3) not null default 0,
  event_count  integer        not null default 0,
  provider_breakdown jsonb    not null default '{}'::jsonb,

  -- the measured cost drivers behind the shared split (compute seconds, stored
  -- bytes, database events). Kept so a tenant can be shown WHY their share was
  -- what it was, not just what it cost.
  usage_drivers      jsonb    not null default '{}'::jsonb,

  -- direct provider cost, recorded for audit; charged per event elsewhere
  direct_cost_usd          numeric(18, 8) not null default 0,
  direct_charged_elsewhere boolean        not null default true,

  -- shared infrastructure: our cost, this org's share, and what they pay
  shared_cost_usd       numeric(18, 8) not null default 0,
  shared_share_percent  numeric(9, 4)  not null default 0,
  shared_billable_usd   numeric(18, 2) not null default 0,

  -- the margin actually applied, so the charge is reproducible even if the
  -- platform default changes later
  margin_percent    numeric(6, 3)  not null,
  margin_multiplier numeric(10, 4) not null,

  created_at timestamptz not null default now(),

  constraint billing_period_charges_period_order
    check (period_end > period_start),
  constraint billing_period_charges_unique_period
    unique (organization_id, period_start, period_end)
);

create index if not exists billing_period_charges_org_period_idx
  on public.billing_period_charges (organization_id, period_start desc);

create index if not exists billing_period_charges_period_idx
  on public.billing_period_charges (period_start desc);

-- Service-role only. Tenants read their charges through the API, which already
-- scopes by organization; no direct client access to this table.
alter table public.billing_period_charges enable row level security;
