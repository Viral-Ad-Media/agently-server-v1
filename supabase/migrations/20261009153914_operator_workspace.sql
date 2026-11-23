-- Additive owner workspace configuration; service-role API only.
create table if not exists public.agent_operator_settings (
  voice_agent_id uuid primary key references public.voice_agents(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email_integration_id uuid references public.email_integrations(id) on delete set null,
  allow_shared_leads boolean not null default false,
  updated_at timestamptz not null default now()
);
alter table public.agent_operator_settings enable row level security;

create table if not exists public.agent_automations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  voice_agent_id uuid not null references public.voice_agents(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  name text not null,
  trigger_type text not null check (trigger_type in ('booking_confirmation','appointment_reminder','missed_call_follow_up','daily_summary')),
  approval_mode text not null default 'review' check (approval_mode in ('review','automatic')),
  status text not null default 'paused' check (status in ('active','paused')),
  config jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (voice_agent_id,trigger_type)
);
alter table public.agent_automations enable row level security;
create table if not exists public.agent_automation_runs (
  id uuid primary key default gen_random_uuid(),
  automation_id uuid not null references public.agent_automations(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  event_key text not null,
  status text not null default 'processing' check (status in ('processing','review','completed','failed','uncertain','cancelled')),
  encrypted_payload text,
  result jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (automation_id,event_key)
);
alter table public.agent_automation_runs enable row level security;
create index if not exists agent_automations_active on public.agent_automations(status);
create index if not exists agent_automation_runs_org on public.agent_automation_runs(organization_id,created_at desc);

create table if not exists public.operator_send_receipts (
  id text primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  status text not null check (status in ('processing','sent','failed','uncertain')),
  result jsonb,
  created_at timestamptz not null default now()
);
alter table public.operator_send_receipts enable row level security;

revoke all on public.agent_operator_settings, public.agent_automations, public.agent_automation_runs, public.operator_send_receipts from anon, authenticated;
grant all on public.agent_operator_settings, public.agent_automations, public.agent_automation_runs, public.operator_send_receipts to service_role;
