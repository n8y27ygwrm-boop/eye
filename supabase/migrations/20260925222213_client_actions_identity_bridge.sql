-- The managed auth schema is owned by supabase_admin; postgres cannot grant its
-- USAGE to the action executor. This narrow identity bridge calls auth.uid()
-- without reading or mutating any table. All action writes still run as the
-- non-login, non-BYPASSRLS eye_action_executor role.
BEGIN;
DO $baseline$
BEGIN
  IF to_regprocedure('eye_private.run_action_command(text,uuid,uuid,bigint,jsonb,text)') IS NULL
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eye_action_executor') THEN
    RAISE EXCEPTION 'Canonical action command baseline is missing';
  END IF;
END;
$baseline$;

CREATE FUNCTION eye_private.action_uid() RETURNS uuid
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog
  AS $body$ SELECT auth.uid() $body$;
REVOKE ALL ON FUNCTION eye_private.action_uid() FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION eye_private.action_uid() TO eye_action_executor;

-- PostgreSQL requires a function owner to replace its body. Membership and
-- schema CREATE are temporary and removed before commit.
DO $membership$
BEGIN
  EXECUTE format('GRANT eye_action_executor TO %I', current_user);
END;
$membership$;
GRANT CREATE ON SCHEMA eye_private TO eye_action_executor;
ALTER FUNCTION eye_private.run_action_command(text,uuid,uuid,bigint,jsonb,text) OWNER TO postgres;
DO $replace$
DECLARE
  definition text;
BEGIN
  SELECT pg_get_functiondef('eye_private.run_action_command(text,uuid,uuid,bigint,jsonb,text)'::regprocedure)
    INTO definition;
  IF position('v_owner uuid := auth.uid();' IN definition) = 0 THEN
    RAISE EXCEPTION 'Canonical action command identity line changed unexpectedly';
  END IF;
  EXECUTE replace(definition, 'v_owner uuid := auth.uid();',
    'v_owner uuid := eye_private.action_uid();');
END;
$replace$;
ALTER FUNCTION eye_private.run_action_command(text,uuid,uuid,bigint,jsonb,text) OWNER TO eye_action_executor;
REVOKE CREATE ON SCHEMA eye_private FROM eye_action_executor;
DO $membership$
BEGIN
  EXECUTE format('REVOKE eye_action_executor FROM %I', current_user);
END;
$membership$;

-- Authenticated readers keep their existing auth.uid() path. The executor's
-- policies use the identity bridge, which it can execute without auth USAGE.
DROP POLICY client_actions_read_owner ON public.client_actions;
CREATE POLICY client_actions_read_owner ON public.client_actions FOR SELECT TO authenticated
  USING (owner_user_id = (SELECT auth.uid()));
CREATE POLICY client_actions_executor_read ON public.client_actions FOR SELECT TO eye_action_executor
  USING (owner_user_id = (SELECT eye_private.action_uid()));
DROP POLICY client_actions_insert_owner ON public.client_actions;
CREATE POLICY client_actions_insert_owner ON public.client_actions FOR INSERT TO eye_action_executor
  WITH CHECK (owner_user_id = (SELECT eye_private.action_uid()));
DROP POLICY client_actions_update_owner ON public.client_actions;
CREATE POLICY client_actions_update_owner ON public.client_actions FOR UPDATE TO eye_action_executor
  USING (owner_user_id = (SELECT eye_private.action_uid()))
  WITH CHECK (owner_user_id = (SELECT eye_private.action_uid()));

DROP POLICY client_action_events_read_owner ON public.client_action_events;
CREATE POLICY client_action_events_read_owner ON public.client_action_events FOR SELECT TO authenticated
  USING (owner_user_id = (SELECT auth.uid()));
CREATE POLICY client_action_events_executor_read ON public.client_action_events FOR SELECT TO eye_action_executor
  USING (owner_user_id = (SELECT eye_private.action_uid()));
DROP POLICY client_action_events_insert_owner ON public.client_action_events;
CREATE POLICY client_action_events_insert_owner ON public.client_action_events FOR INSERT TO eye_action_executor
  WITH CHECK (owner_user_id = (SELECT eye_private.action_uid())
    AND actor_user_id = (SELECT eye_private.action_uid()));

DROP POLICY clients_eye_action_executor_read ON public.clients;
CREATE POLICY clients_eye_action_executor_read ON public.clients FOR SELECT TO eye_action_executor
  USING (owner_user_id = (SELECT eye_private.action_uid()));
DROP POLICY visits_eye_action_executor_read ON public.visits;
CREATE POLICY visits_eye_action_executor_read ON public.visits FOR SELECT TO eye_action_executor
  USING (owner_user_id = (SELECT eye_private.action_uid()));
COMMIT;
