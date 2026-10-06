-- 2026-10-05: calendar integrations (per-tenant OAuth) + appointments.
--
-- calendar_integrations holds one row per (organization, provider). Tokens are
-- AES-256-GCM envelopes (see lib/crypto.js) — never plaintext. expires_at and
-- status stay in clear so the refresh worker and the UI can read them without
-- decrypting.
--
-- appointments is the structured landing place for agent-made bookings. The
-- existing lead crm_stage='appointment_set' update is kept alongside; this
-- table carries the provider truth (external ids, cancel/reschedule links).

create table if not exists public.calendar_integrations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  provider text not null check (provider in ('google', 'calendly')),
  status text not null default 'connected'
    check (status in ('connected', 'needs_reconnect', 'disconnected', 'error')),
  provider_user_id text,
  provider_user_email text,
  provider_user_name text,
  -- Google: the calendar id bookings go into (default 'primary').
  calendar_id text,
  -- Calendly: the event type URI the agent books into, plus its display name.
  event_type_uri text,
  event_type_name text,
  access_token_encrypted text,
  refresh_token_encrypted text,
  expires_at timestamptz,
  scopes text,
  timezone text,
  last_error text,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, provider)
);

create index if not exists calendar_integrations_org_idx
  on public.calendar_integrations (organization_id);
create index if not exists calendar_integrations_status_idx
  on public.calendar_integrations (status) where status <> 'connected';

-- Matches every other table here: RLS on, no policy, service_role only.
alter table public.calendar_integrations enable row level security;

create table if not exists public.appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  integration_id uuid references public.calendar_integrations(id) on delete set null,
  lead_id uuid references public.leads(id) on delete set null,
  voice_agent_id uuid references public.voice_agents(id) on delete set null,
  call_record_id uuid references public.call_records(id) on delete set null,
  provider text not null check (provider in ('google', 'calendly')),
  external_event_id text,
  external_event_uri text,
  title text,
  attendee_name text,
  attendee_email text,
  attendee_phone text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  timezone text not null default 'America/New_York',
  status text not null default 'booked'
    check (status in ('booked', 'cancelled', 'rescheduled', 'no_show', 'completed')),
  cancel_url text,
  reschedule_url text,
  raw jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists appointments_org_idx
  on public.appointments (organization_id, starts_at desc);
create index if not exists appointments_status_idx
  on public.appointments (organization_id, status) where status = 'booked';
create index if not exists appointments_external_idx
  on public.appointments (provider, external_event_id);

alter table public.appointments enable row level security;
