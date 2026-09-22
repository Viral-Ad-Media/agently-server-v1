-- Apply BEFORE deploying the email delivery guard. Hashes are personal data:
-- they minimize stored content but do not make recipients anonymous.
begin;

create table if not exists public.email_delivery_blocks (
  recipient_hash text primary key check (recipient_hash ~ '^[a-f0-9]{64}$'),
  blocked boolean not null default true,
  reason text not null check (reason in ('email.bounced', 'email.complained', 'email.suppressed')),
  event_id text not null,
  message_id text not null,
  occurred_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.email_delivery_blocks enable row level security;
revoke all on public.email_delivery_blocks from public, anon, authenticated;
grant select, insert, update, delete on public.email_delivery_blocks to service_role;

create or replace function public.record_email_delivery_block(
  p_recipient_hash text, p_event_id text, p_message_id text,
  p_reason text, p_occurred_at timestamptz
) returns void language plpgsql security invoker set search_path = public as $$
begin
  insert into public.email_delivery_blocks
    (recipient_hash, blocked, reason, event_id, message_id, occurred_at)
  values (p_recipient_hash, true, p_reason, p_event_id, p_message_id, p_occurred_at)
  on conflict (recipient_hash) do update set
    blocked = true, reason = excluded.reason, event_id = excluded.event_id,
    message_id = excluded.message_id, occurred_at = excluded.occurred_at,
    updated_at = now()
  -- Same event retries and late older events cannot undo a support clearance.
  where excluded.occurred_at > email_delivery_blocks.occurred_at;
end;
$$;
revoke all on function public.record_email_delivery_block(text,text,text,text,timestamptz) from public, anon, authenticated;
grant execute on function public.record_email_delivery_block(text,text,text,text,timestamptz) to service_role;

commit;
