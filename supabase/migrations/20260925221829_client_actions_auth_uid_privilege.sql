-- Add the schema visibility required for auth.uid() inside the restricted
-- non-login action executor. No legacy table or row changes.
BEGIN;
DO $baseline$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eye_action_executor')
     OR to_regclass('public.client_actions') IS NULL
     OR to_regclass('public.client_action_events') IS NULL THEN
    RAISE EXCEPTION 'Apply client_actions_phase1 before this privilege correction';
  END IF;
END;
$baseline$;
GRANT USAGE ON SCHEMA auth TO eye_action_executor;
COMMIT;
