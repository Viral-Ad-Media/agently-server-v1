-- 2026-10-05: calendar phase 2 — booking settings + pending appointment status.
--
-- booking_settings (jsonb) lets each tenant tune Google-calendar booking:
--   { "slotMinutes": 30, "windowDays": 14,
--     "workingHours": { "mon": [["09:00","17:00"]], ... },  -- connection timezone
--     "sendUpdates": "all" }
-- Defaults are applied in code when keys are absent.

alter table public.calendar_integrations
  add column if not exists booking_settings jsonb not null default '{}'::jsonb;

-- 'pending' covers the window between creating the appointment row (which
-- gives us the idempotency key) and the provider confirming the booking.
alter table public.appointments drop constraint if exists appointments_status_check;
alter table public.appointments
  add constraint appointments_status_check
  check (status in ('pending','booked','cancelled','rescheduled','no_show','completed'));

-- Consumed OAuth start-token nonces. The /start-token URL authorizes one
-- OAuth start redirect; inserting its nonce here at /start time makes the
-- "single-use" claim true even across API instances. Rows are tiny and
-- pruned opportunistically (nonces expire after 2 minutes anyway).
create table if not exists public.oauth_start_nonces (
  nonce text primary key,
  organization_id uuid not null,
  provider text not null,
  consumed_at timestamptz not null default now()
);
alter table public.oauth_start_nonces enable row level security;
