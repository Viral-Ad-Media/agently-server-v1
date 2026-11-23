-- Approved owner-operator actions. Draft contents are encrypted by the API;
-- only action metadata and ciphertext are stored here. Rows are one-use and
-- expire quickly, so a replayed browser request cannot repeat a send/book.
create table if not exists public.owner_operator_actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.users(id) on delete cascade,
  voice_agent_id uuid not null references public.voice_agents(id) on delete cascade,
  action_type text not null check (action_type in ('send_emails', 'reschedule_appointment')),
  encrypted_payload text not null,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'completed', 'failed', 'cancelled', 'expired')),
  expires_at timestamptz not null,
  confirmed_at timestamptz,
  completed_at timestamptz,
  result jsonb,
  created_at timestamptz not null default now()
);

create index if not exists owner_operator_actions_pending_idx
  on public.owner_operator_actions (organization_id, user_id, status, expires_at);

alter table public.owner_operator_actions enable row level security;
