-- Per-agent owner-authored qualification guidance. These fields configure
-- conversation and post-call analysis; they never create a booking by
-- themselves. Appointment writes continue through the confirmed calendar
-- workflow.
alter table public.voice_agents
  add column if not exists qualification_playbook text;

alter table public.voice_agents
  add column if not exists qualification_rules jsonb not null default '{}'::jsonb;

comment on column public.voice_agents.qualification_playbook is
  'Owner-authored questions and evidence the caller-facing agent should gather.';

comment on column public.voice_agents.qualification_rules is
  'Thresholds, booking criteria, and disqualifying signals used for caller guidance and post-call review.';
