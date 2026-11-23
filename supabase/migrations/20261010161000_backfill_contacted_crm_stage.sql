update public.leads
set crm_stage = 'contacted',
    updated_at = now()
where status = 'contacted'
  and crm_stage = 'new';
