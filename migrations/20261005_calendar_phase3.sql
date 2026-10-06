-- 2026-10-05: calendar phase 3 — change notifications + reconciliation.
--
-- Adds the columns the sync engine needs on calendar_integrations:
--   webhook_subscription_uri   Calendly webhook subscription (invitee.created/canceled)
--   google_watch_channel_id    Google push channel id (≤64 chars)
--   google_watch_resource_id   Google push resource id (for channels.stop)
--   google_watch_expires_at    when the channel expires (sweeper renews <24h out)
--   google_sync_token_encrypted incremental-sync token, encrypted like other secrets
--
-- Also adds 'conflicted' to appointments.status: an external booking that
-- overlaps an agent-booked slot flags the appointment for tenant review
-- instead of silently cancelling either side.

alter table public.calendar_integrations
  add column if not exists webhook_subscription_uri text,
  add column if not exists google_watch_channel_id text,
  add column if not exists google_watch_resource_id text,
  add column if not exists google_watch_expires_at timestamptz,
  add column if not exists google_sync_token_encrypted text;

alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments
  add constraint appointments_status_check
  check (status in ('pending','booked','cancelled','rescheduled','no_show','completed','conflicted'));
