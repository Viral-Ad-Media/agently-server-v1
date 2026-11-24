-- Outbound SMS log for lib/sms.js / api/routes/sms.js. Billing itself goes
-- through billing_usage_events + billing_wallet_transactions (usage ledger);
-- this table is the message history and delivery status.
create table if not exists public.sms_messages (
  id                 uuid primary key default gen_random_uuid(),
  organization_id    uuid not null references public.organizations(id) on delete cascade,
  lead_id            uuid,
  phone_number_id    uuid,
  from_number        text not null,
  to_number          text not null,
  body               text not null,
  segments           integer not null default 1,
  encoding           text,
  direction          text not null default 'outbound',
  status             text not null default 'sending',
  twilio_sid         text,
  error_code         text,
  error_message      text,
  estimated_cost_usd numeric(12,6),
  sent_by            uuid,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists sms_messages_org_created_idx on public.sms_messages (organization_id, created_at desc);
create index if not exists sms_messages_lead_idx on public.sms_messages (lead_id);
create unique index if not exists sms_messages_twilio_sid_idx on public.sms_messages (twilio_sid) where twilio_sid is not null;

alter table public.sms_messages enable row level security;
-- No policies: only the service role (the API) reads or writes it.
