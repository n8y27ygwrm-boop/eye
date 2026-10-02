-- Phase 2 Migration: Enforce Strict User Data Isolation
-- Applied ONLY AFTER the ownership-aware application code is deployed and verified in production.

-- 1. Assert that owner_user_id IS NOT NULL for every row
DO $$
DECLARE
  null_clients integer;
  null_visits integer;
  null_reminders integer;
BEGIN
  SELECT count(*) INTO null_clients FROM public.clients WHERE owner_user_id IS NULL;
  SELECT count(*) INTO null_visits FROM public.visits WHERE owner_user_id IS NULL;
  SELECT count(*) INTO null_reminders FROM public.ai_reminders WHERE owner_user_id IS NULL;

  IF null_clients > 0 OR null_visits > 0 OR null_reminders > 0 THEN
    RAISE EXCEPTION 'Enforce verification failed: null clients=%, null visits=%, null reminders=%. Please backfill before applying Phase 2.',
      null_clients, null_visits, null_reminders;
  END IF;
END $$;

-- 2. Set owner_user_id NOT NULL
ALTER TABLE public.clients ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE public.visits ALTER COLUMN owner_user_id SET NOT NULL;
ALTER TABLE public.ai_reminders ALTER COLUMN owner_user_id SET NOT NULL;

-- 3. Explicitly ensure ROW LEVEL SECURITY is enabled (standard ENABLE, not FORCE)
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_reminders ENABLE ROW LEVEL SECURITY;

-- 4. Remove known broad legacy policies
DROP POLICY IF EXISTS "Allow all" ON public.clients;
DROP POLICY IF EXISTS "authenticated full access" ON public.visits;
DROP POLICY IF EXISTS "User can manage own reminders" ON public.ai_reminders;

-- Also clean up any preexisting own-row policies before re-creating
DROP POLICY IF EXISTS "clients_select_owner" ON public.clients;
DROP POLICY IF EXISTS "clients_insert_owner" ON public.clients;
DROP POLICY IF EXISTS "clients_update_owner" ON public.clients;
DROP POLICY IF EXISTS "clients_delete_owner" ON public.clients;

DROP POLICY IF EXISTS "visits_select_owner" ON public.visits;
DROP POLICY IF EXISTS "visits_insert_owner" ON public.visits;
DROP POLICY IF EXISTS "visits_update_owner" ON public.visits;
DROP POLICY IF EXISTS "visits_delete_owner" ON public.visits;

DROP POLICY IF EXISTS "ai_reminders_select_owner" ON public.ai_reminders;
DROP POLICY IF EXISTS "ai_reminders_insert_owner" ON public.ai_reminders;
DROP POLICY IF EXISTS "ai_reminders_update_owner" ON public.ai_reminders;
DROP POLICY IF EXISTS "ai_reminders_delete_owner" ON public.ai_reminders;

-- 5. Create strict authenticated own-row policies

-- CLIENTS
CREATE POLICY "clients_select_owner" ON public.clients
  FOR SELECT TO authenticated
  USING (auth.uid() = owner_user_id);

CREATE POLICY "clients_insert_owner" ON public.clients
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = owner_user_id);

CREATE POLICY "clients_update_owner" ON public.clients
  FOR UPDATE TO authenticated
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

CREATE POLICY "clients_delete_owner" ON public.clients
  FOR DELETE TO authenticated
  USING (auth.uid() = owner_user_id);

-- VISITS (Strict ownership + relational integrity: cannot attach to another user's client)
CREATE POLICY "visits_select_owner" ON public.visits
  FOR SELECT TO authenticated
  USING (auth.uid() = owner_user_id);

CREATE POLICY "visits_insert_owner" ON public.visits
  FOR INSERT TO authenticated
  WITH CHECK (
    auth.uid() = owner_user_id
    AND (
      client_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.clients c
        WHERE c.id = visits.client_id AND c.owner_user_id = auth.uid()
      )
    )
  );

CREATE POLICY "visits_update_owner" ON public.visits
  FOR UPDATE TO authenticated
  USING (auth.uid() = owner_user_id)
  WITH CHECK (
    auth.uid() = owner_user_id
    AND (
      client_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.clients c
        WHERE c.id = visits.client_id AND c.owner_user_id = auth.uid()
      )
    )
  );

CREATE POLICY "visits_delete_owner" ON public.visits
  FOR DELETE TO authenticated
  USING (auth.uid() = owner_user_id);

-- AI_REMINDERS
CREATE POLICY "ai_reminders_select_owner" ON public.ai_reminders
  FOR SELECT TO authenticated
  USING (auth.uid() = owner_user_id);

CREATE POLICY "ai_reminders_insert_owner" ON public.ai_reminders
  FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = owner_user_id);

CREATE POLICY "ai_reminders_update_owner" ON public.ai_reminders
  FOR UPDATE TO authenticated
  USING (auth.uid() = owner_user_id)
  WITH CHECK (auth.uid() = owner_user_id);

CREATE POLICY "ai_reminders_delete_owner" ON public.ai_reminders
  FOR DELETE TO authenticated
  USING (auth.uid() = owner_user_id);
