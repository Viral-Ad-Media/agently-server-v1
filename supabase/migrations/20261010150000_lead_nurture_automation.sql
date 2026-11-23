alter table public.agent_automations
  drop constraint if exists agent_automations_trigger_type_check;

alter table public.agent_automations
  add constraint agent_automations_trigger_type_check
  check (trigger_type in ('booking_confirmation','appointment_reminder','missed_call_follow_up','lead_nurture_follow_up','daily_summary'));
