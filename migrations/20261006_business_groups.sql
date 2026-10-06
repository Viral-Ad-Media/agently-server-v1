-- 2026-10-06: cross-business double-booking guard.
--
-- A single person can own several Agently businesses (separate organizations,
-- separate business emails/calendars). A business_groups row explicitly links
-- the businesses that share one owner's time — no heuristics, no email
-- matching. Availability checks and the pre-booking cross-check then filter
-- against every linked business's calendars.
--
-- Linking uses pairing codes because each login is scoped to one org: business
-- A creates the group and shows a code; the owner pastes it while logged into
-- business B. Codes are single-purpose and expire after 24h.
--
-- policy: 'flag_for_review' (book, then notify the tenant of the clash) or
-- 'block' (treat the slot as taken). One org belongs to at most one group.

create table if not exists public.business_groups (
  id uuid primary key default gen_random_uuid(),
  owner_label text not null default '',
  policy text not null default 'flag_for_review'
    check (policy in ('block', 'flag_for_review')),
  invite_code text,
  invite_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.business_group_members (
  group_id uuid not null references public.business_groups(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (group_id, organization_id)
);

-- One business in at most one group: keeps availability/cache semantics simple.
create unique index if not exists business_group_members_org_unique
  on public.business_group_members (organization_id);

alter table public.business_groups enable row level security;
alter table public.business_group_members enable row level security;
