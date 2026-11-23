-- Sessions are created/revoked under the user's row lock, across all API nodes.
CREATE OR REPLACE FUNCTION public.auth_create_session(
 p_user_id uuid,p_organization_id uuid,p_expected_epoch integer,
 p_client text,p_request_ip text,p_user_agent text,
 p_absolute_seconds integer DEFAULT 28800,p_idle_seconds integer DEFAULT 1800,p_max_sessions integer DEFAULT 3)
RETURNS TABLE(id uuid,created_at timestamptz,absolute_expires_at timestamptz,session_epoch integer)
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.users%ROWTYPE; s public.auth_sessions%ROWTYPE; stamp timestamptz:=clock_timestamp();
BEGIN
 SELECT * INTO u FROM public.users WHERE users.id=p_user_id FOR UPDATE;
 IF NOT FOUND OR u.organization_id IS DISTINCT FROM p_organization_id OR coalesce(u.session_epoch,0)<>p_expected_epoch THEN
  RAISE EXCEPTION 'Authentication must be restarted' USING ERRCODE='42501';
 END IF;
 UPDATE public.auth_sessions SET revoked_at=stamp,revoked_reason='expired'
 WHERE user_id=p_user_id AND revoked_at IS NULL AND
 (auth_sessions.absolute_expires_at<=stamp OR auth_sessions.created_at<=stamp-make_interval(secs=>least(greatest(p_absolute_seconds,300),28800))
 OR last_seen_at<=stamp-make_interval(secs=>least(greatest(p_idle_seconds,60),1800)));
 INSERT INTO public.auth_sessions(user_id,organization_id,absolute_expires_at,client,request_ip,user_agent,created_at,last_seen_at)
 VALUES(p_user_id,p_organization_id,stamp+make_interval(secs=>least(greatest(p_absolute_seconds,300),28800)),left(p_client,40),left(p_request_ip,100),left(p_user_agent,400),stamp,stamp) RETURNING * INTO s;
 UPDATE public.auth_sessions SET revoked_at=stamp,revoked_reason='session_limit'
 WHERE auth_sessions.id IN (SELECT a.id FROM public.auth_sessions a WHERE a.user_id=p_user_id AND a.revoked_at IS NULL ORDER BY a.created_at DESC,a.id DESC OFFSET least(greatest(p_max_sessions,1),3));
 RETURN QUERY SELECT s.id,s.created_at,s.absolute_expires_at,coalesce(u.session_epoch,0)::integer;
END $$;
CREATE OR REPLACE FUNCTION public.auth_revoke_user_sessions(p_user_id uuid,p_reason text DEFAULT 'logout_all')
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE epoch integer;
BEGIN
 UPDATE public.users SET session_epoch=coalesce(session_epoch,0)+1 WHERE id=p_user_id RETURNING session_epoch INTO epoch;
 IF NOT FOUND THEN RAISE EXCEPTION 'Account not found' USING ERRCODE='42501'; END IF;
 UPDATE public.auth_sessions SET revoked_at=clock_timestamp(),revoked_reason=left(p_reason,100) WHERE user_id=p_user_id AND revoked_at IS NULL;
 RETURN epoch;
END $$;
REVOKE ALL ON FUNCTION public.auth_create_session(uuid,uuid,integer,text,text,text,integer,integer,integer) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.auth_revoke_user_sessions(uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.auth_create_session(uuid,uuid,integer,text,text,text,integer,integer,integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.auth_revoke_user_sessions(uuid,text) TO service_role;
-- Existing rows also obey the new maximum; token validation separately applies it.
UPDATE public.auth_sessions SET absolute_expires_at=least(absolute_expires_at,created_at+interval '8 hours');
WITH ranked AS (SELECT id,row_number() OVER(PARTITION BY user_id ORDER BY created_at DESC,id DESC) AS position FROM public.auth_sessions WHERE revoked_at IS NULL AND absolute_expires_at>now() AND last_seen_at>now()-interval '30 minutes')
UPDATE public.auth_sessions SET revoked_at=now(),revoked_reason='session_limit' WHERE id IN(SELECT id FROM ranked WHERE position>3);
NOTIFY pgrst,'reload schema';
CREATE OR REPLACE FUNCTION public.auth_replace_password(
 p_user_id uuid,p_password_hash text,p_expected_hash text DEFAULT NULL,p_reset_id uuid DEFAULT NULL,p_reset_hash text DEFAULT NULL)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE u public.users%ROWTYPE; r public.password_reset_tokens%ROWTYPE; epoch integer;
BEGIN
 SELECT * INTO u FROM public.users WHERE id=p_user_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Authentication must be restarted' USING ERRCODE='42501'; END IF;
 IF p_reset_id IS NOT NULL THEN
  SELECT * INTO r FROM public.password_reset_tokens WHERE id=p_reset_id AND user_id=p_user_id FOR UPDATE;
  IF NOT FOUND OR r.used IS TRUE OR r.token_hash IS DISTINCT FROM p_reset_hash OR r.expires_at<=clock_timestamp() THEN
   RAISE EXCEPTION 'Reset link is no longer valid' USING ERRCODE='42501';
  END IF;
 ELSIF u.password_hash IS DISTINCT FROM p_expected_hash THEN
  RAISE EXCEPTION 'Authentication must be restarted' USING ERRCODE='42501';
 END IF;
 IF p_password_hash IS NULL OR length(p_password_hash)<50 THEN RAISE EXCEPTION 'Invalid password hash'; END IF;
 UPDATE public.users SET password_hash=p_password_hash,password_changed_at=clock_timestamp(),updated_at=clock_timestamp(),session_epoch=coalesce(session_epoch,0)+1 WHERE id=p_user_id RETURNING session_epoch INTO epoch;
 UPDATE public.auth_sessions SET revoked_at=clock_timestamp(),revoked_reason='password_changed' WHERE user_id=p_user_id AND revoked_at IS NULL;
 UPDATE public.password_reset_tokens SET used=true,used_at=clock_timestamp() WHERE user_id=p_user_id AND used=false;
 RETURN epoch;
END $$;
REVOKE ALL ON FUNCTION public.auth_replace_password(uuid,text,text,uuid,text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.auth_replace_password(uuid,text,text,uuid,text) TO service_role;
