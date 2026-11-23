-- Preserve today's default-account behavior while making the relationship
-- explicit. The owner can change each agent independently in Business access.
update public.voice_agents va
set calendar_integration_id = (
  select ci.id
  from public.calendar_integrations ci
  where ci.organization_id = va.organization_id
    and ci.status = 'connected'
  order by ci.is_booking_default desc, ci.connected_at asc, ci.id asc
  limit 1
)
where va.calendar_integration_id is null
  and exists (
    select 1 from public.calendar_integrations ci
    where ci.organization_id = va.organization_id and ci.status = 'connected'
  );

insert into public.agent_operator_settings (
  voice_agent_id, organization_id, email_integration_id, allow_shared_leads
)
select
  va.id,
  va.organization_id,
  (
    select ei.id
    from public.email_integrations ei
    where ei.organization_id = va.organization_id
      and ei.status = 'connected'
    order by ei.is_default desc, ei.connected_at asc, ei.id asc
    limit 1
  ),
  false
from public.voice_agents va
on conflict (voice_agent_id) do nothing;
