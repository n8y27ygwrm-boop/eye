CREATE ROLE anon NOLOGIN;
CREATE ROLE authenticated NOLOGIN;
CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE SET search_path = pg_catalog
AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO PUBLIC;
CREATE TABLE public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  business_name text NOT NULL,
  next_action text,
  next_followup date
);
CREATE TABLE public.visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL REFERENCES auth.users(id),
  client_id uuid REFERENCES public.clients(id)
);
CREATE TABLE public.ai_reminders (id uuid PRIMARY KEY);
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_reminders ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.clients, public.visits TO authenticated;
INSERT INTO auth.users (id) VALUES
  ('00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-000000000002');
INSERT INTO public.clients (id, owner_user_id, business_name) VALUES
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'Owner One Client'),
  ('10000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'Owner One Other Client'),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', 'Owner Two Client');
INSERT INTO public.visits (id, owner_user_id, client_id) VALUES
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000003'),
  ('20000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000002');
-- Match the managed project's migration role: owner/CREATEROLE/BYPASSRLS, not superuser.
CREATE ROLE eye_migration_admin SUPERUSER LOGIN;
ALTER SCHEMA auth OWNER TO eye_migration_admin;
SET ROLE eye_migration_admin;
GRANT USAGE ON SCHEMA auth TO postgres;
ALTER ROLE postgres NOSUPERUSER CREATEROLE BYPASSRLS;
RESET ROLE;
