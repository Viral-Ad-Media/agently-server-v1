-- 2026-10-07: which business calendar an agent books into.
--
-- One login runs several businesses, each with its own connected calendar.
-- Several agents can work for the same business, so this is many agents ->
-- one connection: every agent pointed at "Nutra Wellness" books into Nutra
-- Wellness's calendar, and they all share it.
--
-- NULL means "the organization's booking default" (is_booking_default), so a
-- tenant with one calendar sees no change and nothing has to be backfilled.
-- ON DELETE SET NULL: disconnecting a business drops its agents back to the
-- default instead of leaving them pointing at nothing.
--
-- Idempotent.

alter table public.voice_agents
  add column if not exists calendar_integration_id uuid
    references public.calendar_integrations(id) on delete set null;

create index if not exists voice_agents_calendar_integration_id_idx
  on public.voice_agents (calendar_integration_id)
  where calendar_integration_id is not null;
