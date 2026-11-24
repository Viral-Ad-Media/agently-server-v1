-- Platform feature kill switches, flipped from the Super Admin "Features" tab.
-- Read by agently-server/lib/feature-flags.js (production only; local/dev APIs
-- report every feature as on). A missing row means the code default applies.
create table if not exists public.platform_feature_flags (
  key        text primary key,
  enabled    boolean not null default true,
  updated_by text,
  updated_at timestamptz not null default now()
);

alter table public.platform_feature_flags enable row level security;
-- No policies: only the service role (the API) reads or writes it.

insert into public.platform_feature_flags (key, enabled) values
  ('gmail', true),
  ('calendar', true),
  ('sms', false)
on conflict (key) do nothing;
