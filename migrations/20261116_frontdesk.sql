-- Front Desk port (2026-11-16): price-sheet quotes with owner approval, and
-- the owner inbox for website chats. Requires 20261113_chat_media.sql.
--
-- NOT applied automatically. Apply to a test database first; do not run
-- against production until the feature has been tested locally and approved.
--
-- Every table is RLS-enabled with no policies, like the rest of the schema:
-- only the API's service role reads or writes them, and the API scopes every
-- query by organization_id.

-- ── Per-business Front Desk settings ────────────────────────────────────
create table if not exists public.frontdesk_settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  quotes_enabled boolean not null default false,
  -- Quotes whose top-of-range is at or under this go out automatically.
  -- 0 means every quote waits for the owner.
  auto_send_limit_cents integer not null default 0 check (auto_send_limit_cents >= 0),
  currency text not null default 'USD',
  range_low_pct integer not null default 90 check (range_low_pct between 50 and 100),
  range_high_pct integer not null default 120 check (range_high_pct between 100 and 200),
  -- [{code, label, unit, priceCents}]
  price_sheet jsonb not null default '[]'::jsonb,
  -- false restores the old behaviour: no chat transcript is stored at all.
  conversations_enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.frontdesk_settings enable row level security;

-- ── Quotes ──────────────────────────────────────────────────────────────
create table if not exists public.lead_quotes (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chatbot_id uuid references public.chatbots(id) on delete set null,
  lead_id uuid references public.leads(id) on delete cascade,
  session_id text,
  chat_media_id uuid references public.chat_media(id) on delete set null,
  status text not null default 'draft'
    check (status in ('draft', 'pending_approval', 'sent', 'accepted', 'declined', 'void')),
  lines jsonb not null default '[]'::jsonb,
  subtotal_cents integer not null default 0,
  low_cents integer not null default 0,
  high_cents integer not null default 0,
  currency text not null default 'USD',
  assessment jsonb,
  summary text not null default '',
  sent_to text,
  sent_at timestamptz,
  approved_by uuid,
  approved_at timestamptz,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_lead_quotes_org_status
  on public.lead_quotes (organization_id, status, created_at desc);
create index if not exists idx_lead_quotes_lead
  on public.lead_quotes (lead_id) where lead_id is not null;
create index if not exists idx_lead_quotes_session
  on public.lead_quotes (chatbot_id, session_id) where lead_id is null;
alter table public.lead_quotes enable row level security;

-- ── Chat conversations (owner inbox) ────────────────────────────────────
create table if not exists public.chat_conversations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chatbot_id uuid not null references public.chatbots(id) on delete cascade,
  session_id text not null,
  -- Deleting a lead deletes their transcripts with them.
  lead_id uuid references public.leads(id) on delete cascade,
  status text not null default 'ai' check (status in ('ai', 'human', 'closed')),
  unread_owner integer not null default 0,
  last_message_at timestamptz not null default now(),
  last_preview text not null default '',
  visitor_seen_at timestamptz,
  -- Set for a visitor who has not left contact details; purged after it passes.
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (chatbot_id, session_id)
);
create index if not exists idx_chat_conversations_org
  on public.chat_conversations (organization_id, last_message_at desc);
create index if not exists idx_chat_conversations_expiry
  on public.chat_conversations (expires_at) where lead_id is null;
alter table public.chat_conversations enable row level security;

create table if not exists public.chat_inbox_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.chat_conversations(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role text not null check (role in ('visitor', 'assistant', 'owner', 'system')),
  body text not null default '',
  media_id uuid references public.chat_media(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists idx_chat_messages_conversation
  on public.chat_inbox_messages (conversation_id, created_at);
alter table public.chat_inbox_messages enable row level security;
