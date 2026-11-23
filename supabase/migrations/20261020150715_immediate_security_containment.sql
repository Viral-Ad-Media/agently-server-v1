-- Internal data and RPCs are accessed only through the service-role backend.
-- Preserve owner execution semantics; remove the public entry points.
DO $$
DECLARE obj record;
BEGIN
  FOR obj IN
    SELECT n.nspname, c.relname FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('v','m')
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %I.%I FROM PUBLIC, anon, authenticated',obj.nspname,obj.relname);
    EXECUTE format('GRANT SELECT ON TABLE %I.%I TO service_role',obj.nspname,obj.relname);
  END LOOP;
  FOR obj IN
    SELECT p.oid::regprocedure AS signature FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.prosecdef
  LOOP
    EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM PUBLIC, anon, authenticated',obj.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',obj.signature);
  END LOOP;
END $$;
-- Public access for new objects must be an explicit, reviewed grant.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC, anon, authenticated;
NOTIFY pgrst, 'reload schema';
