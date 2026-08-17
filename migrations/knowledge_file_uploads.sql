-- Knowledge Base file upload (PDF/DOCX/EPUB/TXT) ingestion.
-- Additive only: new tables, new storage bucket, new RPCs. Nothing existing
-- is altered. Chunks land in the EXISTING knowledge_chunks table in the same
-- shape scraper.service.js writes, so search_knowledge_chunks / knowledge-
-- retrieval.js need zero changes to pick them up.

create table if not exists public.knowledge_source_files (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null,
  knowledge_base_id uuid not null references public.knowledge_bases(id) on delete cascade,
  knowledge_source_id uuid references public.knowledge_sources(id) on delete set null,
  filename text not null,
  file_type text not null, -- pdf | docx | epub | txt
  file_size_bytes bigint,
  storage_path text not null,
  status text not null default 'uploading', -- uploading | processing | indexed | failed
  status_reason text,
  source text not null default 'upload', -- reserved: 'google_drive' later
  uploaded_by_user_id uuid,
  indexed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_knowledge_source_files_kb
  on public.knowledge_source_files (knowledge_base_id);
create index if not exists idx_knowledge_source_files_org
  on public.knowledge_source_files (organization_id);

create trigger update_knowledge_source_files_updated_at
  before update on public.knowledge_source_files
  for each row execute function update_updated_at_column();

create table if not exists public.knowledge_ingest_jobs (
  id uuid primary key default uuid_generate_v4(),
  organization_id uuid not null,
  knowledge_base_id uuid not null,
  source_file_id uuid not null references public.knowledge_source_files(id) on delete cascade,
  status text not null default 'queued', -- queued | running | completed | failed
  attempts integer not null default 0,
  last_error text,
  claimed_by text,
  claimed_at timestamptz,
  lease_expires_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_knowledge_ingest_jobs_claimable
  on public.knowledge_ingest_jobs (status, created_at);

create trigger update_knowledge_ingest_jobs_updated_at
  before update on public.knowledge_ingest_jobs
  for each row execute function update_updated_at_column();

-- Same FOR UPDATE SKIP LOCKED claim pattern as knowledge_claim_scrape_job().
-- No heartbeat/lease-renewal RPC: unlike a multi-page scrape (minutes), one
-- file parse+chunk+insert is seconds, so a single generous lease from claim
-- time is enough; a crashed worker's job is simply reclaimed once the lease
-- expires. attempts/last_error give retry instead of a mid-job pause/cancel
-- signal, which a job this short has no use for.
create or replace function public.knowledge_claim_ingest_job(
  p_worker_id text,
  p_lease_seconds integer default 120
)
returns setof public.knowledge_ingest_jobs
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  claimed_id uuid;
begin
  select id into claimed_id
  from public.knowledge_ingest_jobs
  where (
    status = 'queued'
    or (status = 'running' and lease_expires_at < now())
  )
  order by created_at asc
  for update skip locked
  limit 1;

  if claimed_id is null then
    return;
  end if;

  return query
  update public.knowledge_ingest_jobs
  set status = 'running',
      claimed_by = p_worker_id,
      claimed_at = now(),
      lease_expires_at = now() + make_interval(secs => greatest(30, p_lease_seconds)),
      attempts = attempts + 1,
      updated_at = now()
  where id = claimed_id
  returning *;
end;
$$;

insert into storage.buckets (id, name, public)
values ('knowledge-uploads', 'knowledge-uploads', false)
on conflict (id) do nothing;
