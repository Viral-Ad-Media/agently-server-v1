-- Customer photos and video clips sent through the public chat widget
-- (Front Desk port). Additive only: one new column on chatbots, one new
-- table, one new private storage bucket, one trigger on leads.
--
-- Retention: rows with lead_id = null carry expires_at and are deleted (with
-- their storage objects) by lib/chat-media.js purgeExpiredChatMedia(). When a
-- lead is deleted its media is expired the same way, so the files go too.

alter table public.chatbots
  add column if not exists media_uploads_enabled boolean not null default true;

create table if not exists public.chat_media (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  chatbot_id uuid not null references public.chatbots(id) on delete cascade,
  voice_agent_id uuid,
  lead_id uuid references public.leads(id) on delete set null,
  session_id text,
  kind text not null check (kind in ('photo', 'video')),
  mime text not null,
  bytes bigint not null default 0,
  width integer,
  height integer,
  duration_ms integer,
  storage_path text not null,
  poster_path text,
  visitor_note text not null default '',
  analysis jsonb,
  analysis_status text not null default 'pending'
    check (analysis_status in ('pending', 'done', 'failed')),
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_chat_media_lead
  on public.chat_media (lead_id, created_at desc) where lead_id is not null;
create index if not exists idx_chat_media_session
  on public.chat_media (chatbot_id, session_id) where lead_id is null;
create index if not exists idx_chat_media_expiry
  on public.chat_media (expires_at) where lead_id is null;
create index if not exists idx_chat_media_org
  on public.chat_media (organization_id);

drop trigger if exists update_chat_media_updated_at on public.chat_media;
create trigger update_chat_media_updated_at
  before update on public.chat_media
  for each row execute function update_updated_at_column();

-- Same posture as the other API-only tables: RLS on, no policies. Only the
-- service role (the API) reads or writes, and the API scopes by organization.
alter table public.chat_media enable row level security;

-- Deleting a lead must not leave the customer's photos behind.
create or replace function public.chat_media_expire_for_deleted_lead()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  update public.chat_media
     set expires_at = now()
   where lead_id = old.id;
  return old;
end;
$$;

drop trigger if exists chat_media_expire_on_lead_delete on public.leads;
create trigger chat_media_expire_on_lead_delete
  before delete on public.leads
  for each row execute function public.chat_media_expire_for_deleted_lead();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'chat-media',
  'chat-media',
  false,
  27262976,
  array['image/jpeg', 'image/png', 'image/webp', 'video/webm', 'video/mp4', 'video/quicktime']
)
on conflict (id) do nothing;
