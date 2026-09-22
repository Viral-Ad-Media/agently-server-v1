-- Run against an isolated test database AFTER the migration; always rolls back.
-- This checks actual database duplicate/ordering behavior, not a JS imitation.
begin;
-- Exercise the actual application role, rather than relying on postgres access.
set local role service_role;
do $$
declare
  h text := repeat('a', 64);
  t timestamptz := '2000-01-01T00:00:00Z';
  r public.email_delivery_blocks%rowtype;
begin
  if exists (select 1 from public.email_delivery_blocks where recipient_hash = h) then
    raise exception 'Test hash already exists; use an isolated database';
  end if;
  perform public.record_email_delivery_block(h, 'test-first', 'test-message', 'email.bounced', t);
  perform public.record_email_delivery_block(h, 'test-first', 'test-message', 'email.bounced', t);
  select * into strict r from public.email_delivery_blocks where recipient_hash = h;
  if not r.blocked or r.event_id <> 'test-first' then raise exception 'Duplicate handling failed'; end if;
  perform public.record_email_delivery_block(h, 'test-old', 'test-message', 'email.complained', t - interval '1 day');
  select * into strict r from public.email_delivery_blocks where recipient_hash = h;
  if r.event_id <> 'test-first' then raise exception 'Older event overwrote newer state'; end if;
  update public.email_delivery_blocks set blocked = false, occurred_at = t + interval '1 day' where recipient_hash = h;
  perform public.record_email_delivery_block(h, 'test-first', 'test-message', 'email.bounced', t);
  select * into strict r from public.email_delivery_blocks where recipient_hash = h;
  if r.blocked then raise exception 'Old replay undid support clearance'; end if;
  perform public.record_email_delivery_block(h, 'test-new', 'test-message', 'email.suppressed', t + interval '2 days');
  select * into strict r from public.email_delivery_blocks where recipient_hash = h;
  if not r.blocked or r.event_id <> 'test-new' then raise exception 'New failure did not reblock'; end if;
  if has_table_privilege('anon', 'public.email_delivery_blocks', 'SELECT')
    or has_table_privilege('authenticated', 'public.email_delivery_blocks', 'SELECT')
    or has_table_privilege('anon', 'public.email_delivery_blocks', 'INSERT, UPDATE, DELETE')
    or has_table_privilege('authenticated', 'public.email_delivery_blocks', 'INSERT, UPDATE, DELETE') then
    raise exception 'Client roles can access delivery blocks';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.email_delivery_blocks'::regclass) then
    raise exception 'Row level security is not enabled';
  end if;
  if has_function_privilege('anon', 'public.record_email_delivery_block(text,text,text,text,timestamptz)', 'EXECUTE')
    or has_function_privilege('authenticated', 'public.record_email_delivery_block(text,text,text,text,timestamptz)', 'EXECUTE') then
    raise exception 'Client roles can execute delivery block writer';
  end if;
end;
$$;
rollback;
