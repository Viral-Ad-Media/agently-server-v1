-- deleted_account_archive + a fix for account deletion
--
-- TWO THINGS, deliberately in one migration because the second depends on the
-- first existing before any delete runs again.
--
-- 1. FIX: billing_admin_delete_user_or_org_everything hard-references
--    public.organization_members, which does not exist in this database. The
--    organization-scope path survives it (its loops skip missing tables), but
--    the USER-scope path deletes from it unguarded, so deleting a single user
--    has been throwing 42P01 and failing outright.
--
-- 2. RETENTION: before anything is deleted, the basic account details are
--    copied into public.deleted_account_archive. Several jurisdictions require
--    a record of who held an account and what number they used to be
--    retained after the account itself is erased, and a released Twilio number
--    is otherwise untraceable back to who held it.
--
--    This stores identifying basics and a JSON snapshot, NOT the tenant's
--    content (no call recordings, transcripts, leads or chat history) — those
--    are still fully erased.

create table if not exists public.deleted_account_archive (
  id uuid primary key default gen_random_uuid(),

  deleted_at   timestamptz not null default now(),
  delete_scope text        not null,
  deleted_by_email text,

  user_id           uuid,
  user_email        text,
  user_name         text,
  organization_id   uuid,
  organization_name text,

  -- Numbers held at the moment of deletion. Once released back to Twilio the
  -- number is reissued to someone else, so this is the only remaining link
  -- between a number and who used to hold it.
  phone_numbers jsonb not null default '[]'::jsonb,

  wallet_balance_usd   numeric(18, 2),
  lifetime_charged_usd numeric(18, 2),
  lifetime_cost_usd    numeric(18, 2),
  account_created_at   timestamptz,

  user_snapshot         jsonb,
  organization_snapshot jsonb,

  retention_reason text not null default
    'Basic account details retained after erasure for audit and regulatory traceability.'
);

create index if not exists deleted_account_archive_deleted_at_idx
  on public.deleted_account_archive (deleted_at desc);
create index if not exists deleted_account_archive_email_idx
  on public.deleted_account_archive (lower(user_email));
create index if not exists deleted_account_archive_org_idx
  on public.deleted_account_archive (organization_id);

alter table public.deleted_account_archive enable row level security;

comment on table public.deleted_account_archive is
  'Post-deletion retention record. Identifying basics only; tenant content is erased.';


create or replace function public.billing_admin_delete_user_or_org_everything(
  p_user_id uuid DEFAULT NULL::uuid,
  p_user_email text DEFAULT NULL::text,
  p_organization_id uuid DEFAULT NULL::uuid,
  p_delete_scope text DEFAULT 'user'::text,
  p_confirm text DEFAULT NULL::text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
DECLARE
  v_table          TEXT;
  v_org            UUID := p_organization_id;
  v_deleted        JSONB := '{}'::jsonb;
  v_count          BIGINT;
  v_required       TEXT;
  v_has_org_col    BOOLEAN;
  r                RECORD;

  v_numbers        JSONB := '[]'::jsonb;
  v_balance        NUMERIC;
  v_charged        NUMERIC;
  v_cost           NUMERIC;
  v_org_name       TEXT;
  v_org_snapshot   JSONB;
  v_archived       BIGINT := 0;

  v_org_tables TEXT[] := ARRAY[
    'knowledge_change_events','knowledge_discovered_pages','knowledge_scrape_jobs',
    'knowledge_page_discoveries','knowledge_chunks','knowledge_products',
    'knowledge_sources','faqs','knowledge_bases','call_recordings','call_transcripts',
    'call_records','outreach_attempts','outreach_campaign_contacts','outreach_campaigns',
    'leads','chat_messages','chat_sessions','chatbots','voice_agents',
    'twilio_phone_numbers','twilio_accounts','billing_customer_usage_charges',
    'billing_wallet_transactions','billing_usage_events','billing_daily_usage_rollups',
    'billing_wallets','tenant_notifications','audit_logs','user_tour_progress',
    'organization_members','users'
  ];
BEGIN
  v_required := CASE
    WHEN p_delete_scope = 'organization' THEN 'DELETE_ORGANIZATION_DATA'
    ELSE 'DELETE_USER_DATA'
  END;

  IF p_confirm IS DISTINCT FROM v_required THEN
    RAISE EXCEPTION 'Confirmation required: expected %', v_required;
  END IF;

  IF v_org IS NULL AND p_user_id IS NOT NULL THEN
    SELECT u.organization_id INTO v_org FROM public.users u WHERE u.id = p_user_id;
  END IF;

  -- ── Retention snapshot, taken BEFORE anything is destroyed ──────────────
  IF v_org IS NOT NULL THEN
    SELECT to_jsonb(o), COALESCE(o.name, NULL)
      INTO v_org_snapshot, v_org_name
      FROM public.organizations o WHERE o.id = v_org;

    IF to_regclass('public.twilio_phone_numbers') IS NOT NULL THEN
      SELECT COALESCE(jsonb_agg(to_jsonb(t)), '[]'::jsonb) INTO v_numbers
        FROM public.twilio_phone_numbers t WHERE t.organization_id = v_org;
    END IF;

    IF to_regclass('public.billing_wallets') IS NOT NULL THEN
      SELECT w.balance_usd INTO v_balance
        FROM public.billing_wallets w WHERE w.organization_id = v_org LIMIT 1;
    END IF;

    IF to_regclass('public.billing_customer_usage_charges') IS NOT NULL THEN
      SELECT COALESCE(SUM(c.customer_charge_usd), 0), COALESCE(SUM(c.internal_cost_usd), 0)
        INTO v_charged, v_cost
        FROM public.billing_customer_usage_charges c WHERE c.organization_id = v_org;
    END IF;
  END IF;

  INSERT INTO public.deleted_account_archive (
    delete_scope, user_id, user_email, user_name,
    organization_id, organization_name, phone_numbers,
    wallet_balance_usd, lifetime_charged_usd, lifetime_cost_usd,
    account_created_at, user_snapshot, organization_snapshot
  )
  SELECT
    COALESCE(p_delete_scope, 'user'),
    u.id,
    COALESCE(u.email, p_user_email),
    NULLIF(TRIM(COALESCE(to_jsonb(u) ->> 'full_name', to_jsonb(u) ->> 'name', '')), ''),
    v_org, v_org_name, v_numbers,
    v_balance, v_charged, v_cost,
    (to_jsonb(u) ->> 'created_at')::timestamptz,
    to_jsonb(u), v_org_snapshot
  FROM public.users u
  WHERE (p_delete_scope = 'organization' AND v_org IS NOT NULL AND u.organization_id = v_org)
     OR (p_delete_scope <> 'organization' AND u.id = p_user_id);

  GET DIAGNOSTICS v_archived = ROW_COUNT;

  -- An organization with no user rows still deserves a record.
  IF v_archived = 0 AND p_delete_scope = 'organization' AND v_org IS NOT NULL THEN
    INSERT INTO public.deleted_account_archive (
      delete_scope, user_email, organization_id, organization_name,
      phone_numbers, wallet_balance_usd, lifetime_charged_usd, lifetime_cost_usd,
      organization_snapshot
    ) VALUES (
      'organization', p_user_email, v_org, v_org_name,
      v_numbers, v_balance, v_charged, v_cost, v_org_snapshot
    );
    v_archived := 1;
  END IF;

  v_deleted := v_deleted || jsonb_build_object('archived_accounts', v_archived);

  -- ── User scope ─────────────────────────────────────────────────────────
  IF p_delete_scope <> 'organization' THEN
    IF p_user_id IS NULL THEN
      RAISE EXCEPTION 'p_user_id is required for user-scope deletion';
    END IF;

    DELETE FROM public.user_tour_progress WHERE user_id = p_user_id;

    -- Guarded: this table does not exist in every deployment, and an
    -- unguarded reference here is what broke user deletion entirely.
    IF to_regclass('public.organization_members') IS NOT NULL THEN
      EXECUTE 'DELETE FROM public.organization_members WHERE user_id = $1' USING p_user_id;
    END IF;

    DELETE FROM public.users WHERE id = p_user_id;

    RETURN jsonb_build_object(
      'scope','user','user_id',p_user_id,'organization_id',v_org,
      'deleted', v_deleted || jsonb_build_object('users', 1)
    );
  END IF;

  IF v_org IS NULL THEN
    RAISE EXCEPTION 'p_organization_id could not be resolved for organization-scope deletion';
  END IF;

  -- Pass 1: the curated, FK-ordered list.
  FOREACH v_table IN ARRAY v_org_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.tables t
       WHERE t.table_schema='public' AND t.table_name=v_table AND t.table_type='BASE TABLE'
    ) THEN CONTINUE; END IF;

    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns c
       WHERE c.table_schema='public' AND c.table_name=v_table AND c.column_name='organization_id'
    ) INTO v_has_org_col;

    IF NOT v_has_org_col THEN CONTINUE; END IF;

    EXECUTE format('DELETE FROM public.%I WHERE organization_id = $1', v_table) USING v_org;
    GET DIAGNOSTICS v_count = ROW_COUNT;
    IF v_count > 0 THEN
      v_deleted := v_deleted || jsonb_build_object(v_table, v_count);
    END IF;
  END LOOP;

  -- Pass 2: sweep anything the curated list missed.
  FOR r IN
    SELECT c.table_name AS tn
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name
    WHERE c.table_schema = 'public'
      AND c.column_name = 'organization_id'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name <> ALL(v_org_tables)
      AND c.table_name <> 'organizations'
      AND c.table_name <> 'deleted_account_archive'   -- never erase the record of the erasure
    ORDER BY c.table_name
  LOOP
    BEGIN
      EXECUTE format('DELETE FROM public.%I WHERE organization_id = $1', r.tn) USING v_org;
      GET DIAGNOSTICS v_count = ROW_COUNT;
      IF v_count > 0 THEN
        v_deleted := v_deleted || jsonb_build_object(r.tn, v_count);
      END IF;
    EXCEPTION WHEN OTHERS THEN
      -- Record rather than abort: one stubborn FK must not strand the whole
      -- deletion half-done with no report of what remains.
      v_deleted := v_deleted || jsonb_build_object(r.tn || '_error', SQLERRM);
    END;
  END LOOP;

  DELETE FROM public.organizations WHERE id = v_org;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  IF v_count > 0 THEN
    v_deleted := v_deleted || jsonb_build_object('organizations', v_count);
  END IF;

  RETURN jsonb_build_object(
    'scope','organization','organization_id',v_org,'user_id',p_user_id,'deleted',v_deleted
  );
END;
$fn$;
