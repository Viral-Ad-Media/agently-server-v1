-- s8: erasure requests are recorded, reviewed and executed by a person.
-- Not a self-service delete: it is irreversible and it destroys records with
-- their own statutory retention.
create table if not exists public.account_erasure_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  requested_by uuid,
  requested_by_email text,
  reason text,
  status text not null default 'pending'
    check (status in ('pending','in_progress','completed','rejected','cancelled')),
  plan jsonb,
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  completed_by text,
  notes text
);

create index if not exists account_erasure_requests_org_idx
  on public.account_erasure_requests (organization_id, requested_at desc);
create index if not exists account_erasure_requests_status_idx
  on public.account_erasure_requests (status) where status = 'pending';

-- Matches every other table here: RLS on, no policy, service_role only.
alter table public.account_erasure_requests enable row level security;
