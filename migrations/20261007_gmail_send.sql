-- 2026-10-07: send email from the tenant's own Gmail.
--
-- SEND ONLY. The OAuth grant is gmail.send (a Google *sensitive* scope, same
-- tier as Calendar), so no inbox is ever read and no CASA security assessment
-- is required. Agently writes the draft itself; Gmail only delivers it.
--
-- email_integrations deliberately does NOT reuse calendar_integrations: the
-- calendar code enumerates every row of that table for availability and
-- booking-target selection, and a Gmail row there would be picked up by both.
-- The token vault is the SAME scheme (lib/crypto.js, ciphertext bound to
-- {organizationId, provider: "gmail", connectionId: <this row's id>}).
--
-- RLS is enabled with zero policies like the calendar tables: the API is the
-- service role and every query is scoped to organization_id in application
-- code. Idempotent.

create table if not exists public.email_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  -- 'outlook' (Microsoft Graph Mail.Send) is allowed now so adding it later
  -- needs no migration; only gmail is implemented today.
  provider text not null default 'gmail' check (provider in ('gmail', 'outlook')),
  label text,
  provider_user_id text,
  provider_user_email text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  expires_at timestamptz,
  scopes text,
  status text not null default 'connected'
    check (status in ('connected', 'needs_reconnect', 'disconnected')),
  last_error text,
  is_default boolean not null default false,
  -- Automations the tenant switched on for this sender, e.g.
  -- {"booking_confirmation": true}. Off unless set.
  automations jsonb not null default '{}'::jsonb,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists email_integrations_org_provider_account_key
  on public.email_integrations (organization_id, provider, coalesce(provider_user_id, ''));

create unique index if not exists email_integrations_one_default_per_org
  on public.email_integrations (organization_id) where is_default;

alter table public.email_integrations enable row level security;

-- Every send attempt, for the tenant's audit trail and the daily cap.
create table if not exists public.email_sends (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid references public.email_integrations(id) on delete set null,
  voice_agent_id uuid,
  lead_id uuid,
  appointment_id uuid,
  sent_by_user_id uuid,
  purpose text,
  to_email text not null,
  subject text,
  status text not null check (status in ('sent', 'failed', 'blocked')),
  provider_message_id text,
  error text,
  created_at timestamptz not null default now()
);

create index if not exists email_sends_org_created_idx
  on public.email_sends (organization_id, created_at desc);

alter table public.email_sends enable row level security;
