-- EYE canonical action boundary. Additive: legacy action data and writers stay untouched.
-- Target project must be verified as brblmltkxpblmtwcgtlm before application.
BEGIN;

DO $baseline$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'id' AND udt_name = 'uuid' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'owner_user_id' AND udt_name = 'uuid' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'next_action' AND data_type = 'text'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'clients' AND column_name = 'next_followup' AND data_type = 'date'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'id' AND udt_name = 'uuid' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'owner_user_id' AND udt_name = 'uuid' AND is_nullable = 'NO'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'visits' AND column_name = 'client_id' AND udt_name = 'uuid'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'ai_reminders' AND column_name = 'id' AND udt_name = 'uuid'
  ) THEN
    RAISE EXCEPTION 'EYE schema baseline differs: verify clients, visits, ai_reminders before applying';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.clients'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.visits'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_reminders'::regclass) THEN
    RAISE EXCEPTION 'EYE schema baseline differs: legacy RLS must be enabled';
  END IF;
END;
$baseline$;

DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eye_action_executor') THEN
    CREATE ROLE eye_action_executor NOLOGIN NOINHERIT NOBYPASSRLS;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'eye_action_executor' AND (rolcanlogin OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Existing eye_action_executor role is privileged unexpectedly';
  END IF;
END;
$role$;

-- Managed PostgreSQL grants CREATEROLE without superuser powers. The migration
-- executor needs temporary role membership to transfer function ownership.
DO $membership$
BEGIN
  EXECUTE format('GRANT eye_action_executor TO %I', current_user);
END;
$membership$;

CREATE SCHEMA IF NOT EXISTS eye_private;
REVOKE ALL ON SCHEMA eye_private FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA eye_private TO eye_action_executor;
GRANT USAGE ON SCHEMA public TO eye_action_executor;
-- Required only while assigning function ownership. Removed below.
GRANT CREATE ON SCHEMA eye_private, public TO eye_action_executor;

-- Composite keys let foreign keys enforce owner and client consistency without
-- changing existing primary keys or legacy row values.
ALTER TABLE public.clients ADD CONSTRAINT clients_owner_id_action_key UNIQUE (owner_user_id, id);
ALTER TABLE public.visits ADD CONSTRAINT visits_owner_id_action_key UNIQUE (owner_user_id, id);
ALTER TABLE public.visits ADD CONSTRAINT visits_owner_client_id_action_key UNIQUE (owner_user_id, client_id, id);

CREATE TABLE public.client_actions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  client_id uuid,
  client_name_snapshot text NOT NULL CHECK (btrim(client_name_snapshot) <> ''),
  description text NOT NULL CHECK (btrim(description) <> ''),
  action_type text NOT NULL DEFAULT 'follow_up' CHECK (action_type IN ('call', 'meeting', 'deliver', 'follow_up')),
  due_date date,
  due_time time without time zone,
  priority text NOT NULL DEFAULT 'medium' CHECK (priority IN ('high', 'medium', 'low')),
  state text NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'completed', 'cancelled', 'replaced', 'legacy_closed')),
  origin text NOT NULL CHECK (origin IN ('manual', 'ai', 'legacy')),
  source_visit_id uuid,
  source_excerpt text,
  resolution_visit_id uuid,
  replaces_action_id uuid,
  creation_key text NOT NULL CHECK (btrim(creation_key) <> ''),
  version bigint NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  closed_by uuid REFERENCES auth.users(id),
  closure_note text,
  CONSTRAINT client_actions_date_time_check CHECK (due_time IS NULL OR due_date IS NOT NULL),
  CONSTRAINT client_actions_client_required_check CHECK (client_id IS NOT NULL OR origin = 'legacy'),
  CONSTRAINT client_actions_state_closure_check CHECK (
    (state = 'open' AND closed_at IS NULL AND closed_by IS NULL AND resolution_visit_id IS NULL)
    OR (state IN ('completed', 'cancelled', 'replaced') AND closed_at IS NOT NULL AND closed_by IS NOT NULL)
    OR (state = 'legacy_closed' AND origin = 'legacy' AND closed_at IS NULL AND closed_by IS NULL)
  ),
  CONSTRAINT client_actions_reason_check CHECK (state NOT IN ('cancelled', 'replaced') OR NULLIF(btrim(closure_note), '') IS NOT NULL),
  CONSTRAINT client_actions_owner_id_key UNIQUE (owner_user_id, id),
  CONSTRAINT client_actions_owner_client_id_key UNIQUE (owner_user_id, client_id, id),
  CONSTRAINT client_actions_creation_key UNIQUE (owner_user_id, creation_key),
  CONSTRAINT client_actions_client_fk FOREIGN KEY (owner_user_id, client_id)
    REFERENCES public.clients(owner_user_id, id) ON DELETE RESTRICT,
  CONSTRAINT client_actions_source_owner_fk FOREIGN KEY (owner_user_id, source_visit_id)
    REFERENCES public.visits(owner_user_id, id) ON DELETE RESTRICT,
  CONSTRAINT client_actions_source_client_fk FOREIGN KEY (owner_user_id, client_id, source_visit_id)
    REFERENCES public.visits(owner_user_id, client_id, id) ON DELETE RESTRICT,
  CONSTRAINT client_actions_resolution_owner_fk FOREIGN KEY (owner_user_id, resolution_visit_id)
    REFERENCES public.visits(owner_user_id, id) ON DELETE RESTRICT,
  CONSTRAINT client_actions_resolution_client_fk FOREIGN KEY (owner_user_id, client_id, resolution_visit_id)
    REFERENCES public.visits(owner_user_id, client_id, id) ON DELETE RESTRICT,
  CONSTRAINT client_actions_replaces_owner_fk FOREIGN KEY (owner_user_id, replaces_action_id)
    REFERENCES public.client_actions(owner_user_id, id) ON DELETE RESTRICT,
  CONSTRAINT client_actions_replaces_client_fk FOREIGN KEY (owner_user_id, client_id, replaces_action_id)
    REFERENCES public.client_actions(owner_user_id, client_id, id) ON DELETE RESTRICT,
  CONSTRAINT client_actions_not_self_replacement CHECK (replaces_action_id IS DISTINCT FROM id)
);

CREATE UNIQUE INDEX client_actions_one_successor_idx ON public.client_actions (owner_user_id, replaces_action_id)
  WHERE replaces_action_id IS NOT NULL;
CREATE INDEX client_actions_open_deadline_idx ON public.client_actions (owner_user_id, due_date, due_time, priority, created_at, id)
  WHERE state = 'open';
CREATE INDEX client_actions_client_state_idx ON public.client_actions (owner_user_id, client_id, state, created_at DESC);
CREATE INDEX client_actions_source_visit_idx ON public.client_actions (owner_user_id, source_visit_id) WHERE source_visit_id IS NOT NULL;
CREATE INDEX client_actions_resolution_visit_idx ON public.client_actions (owner_user_id, resolution_visit_id) WHERE resolution_visit_id IS NOT NULL;

CREATE TABLE public.client_action_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id uuid NOT NULL,
  action_id uuid NOT NULL,
  action_version bigint NOT NULL CHECK (action_version > 0),
  request_id uuid NOT NULL,
  request_body jsonb NOT NULL,
  result jsonb NOT NULL,
  event_type text NOT NULL CHECK (event_type IN ('created', 'updated', 'completed', 'cancelled', 'replaced', 'reopened', 'client_linked', 'imported')),
  actor_user_id uuid REFERENCES auth.users(id),
  channel text NOT NULL CHECK (channel IN ('client_detail', 'field_control', 'map', 'visit', 'ai_chat', 'migration', 'api')),
  related_visit_id uuid,
  before jsonb,
  after jsonb NOT NULL,
  legacy_source jsonb,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT client_action_events_action_fk FOREIGN KEY (owner_user_id, action_id)
    REFERENCES public.client_actions(owner_user_id, id) ON DELETE RESTRICT,
  CONSTRAINT client_action_events_visit_fk FOREIGN KEY (owner_user_id, related_visit_id)
    REFERENCES public.visits(owner_user_id, id) ON DELETE RESTRICT,
  CONSTRAINT client_action_events_version_key UNIQUE (action_id, action_version),
  CONSTRAINT client_action_events_request_action_key UNIQUE (owner_user_id, request_id, action_id)
);
CREATE INDEX client_action_events_owner_action_idx ON public.client_action_events (owner_user_id, action_id, action_version DESC);
CREATE INDEX client_action_events_request_idx ON public.client_action_events (owner_user_id, request_id);

ALTER TABLE public.client_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_actions FORCE ROW LEVEL SECURITY;
ALTER TABLE public.client_action_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.client_action_events FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.client_actions, public.client_action_events FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.client_actions, public.client_action_events TO authenticated;
GRANT SELECT, INSERT, UPDATE ON public.client_actions TO eye_action_executor;
GRANT SELECT, INSERT ON public.client_action_events TO eye_action_executor;
GRANT SELECT ON public.clients, public.visits TO eye_action_executor;

CREATE POLICY client_actions_read_owner ON public.client_actions FOR SELECT TO authenticated, eye_action_executor
  USING (owner_user_id = (SELECT auth.uid()));
CREATE POLICY client_actions_insert_owner ON public.client_actions FOR INSERT TO eye_action_executor
  WITH CHECK (owner_user_id = (SELECT auth.uid()));
CREATE POLICY client_actions_update_owner ON public.client_actions FOR UPDATE TO eye_action_executor
  USING (owner_user_id = (SELECT auth.uid())) WITH CHECK (owner_user_id = (SELECT auth.uid()));
CREATE POLICY client_action_events_read_owner ON public.client_action_events FOR SELECT TO authenticated, eye_action_executor
  USING (owner_user_id = (SELECT auth.uid()));
CREATE POLICY client_action_events_insert_owner ON public.client_action_events FOR INSERT TO eye_action_executor
  WITH CHECK (owner_user_id = (SELECT auth.uid()) AND actor_user_id = (SELECT auth.uid()));
CREATE POLICY clients_eye_action_executor_read ON public.clients FOR SELECT TO eye_action_executor
  USING (owner_user_id = (SELECT auth.uid()));
CREATE POLICY visits_eye_action_executor_read ON public.visits FOR SELECT TO eye_action_executor
  USING (owner_user_id = (SELECT auth.uid()));

-- The helper is not exposed to API roles. Public entrypoints below have typed
-- signatures, run as a non-login, non-BYPASSRLS executor, and share one transaction.
CREATE FUNCTION eye_private.run_action_command(
  p_operation text, p_request_id uuid, p_action_id uuid, p_expected_version bigint,
  p_payload jsonb, p_channel text
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog
AS $command$
DECLARE
  v_owner uuid := auth.uid();
  v_prior public.client_action_events%ROWTYPE;
  v_request jsonb;
  v_action public.client_actions%ROWTYPE;
  v_before jsonb;
  v_new public.client_actions%ROWTYPE;
  v_result jsonb;
  v_client public.clients%ROWTYPE;
  v_client_id uuid;
  v_visit_id uuid;
  v_description text;
  v_reason text;
  v_due_date date;
  v_due_time time;
  v_type text;
  v_priority text;
  v_origin text;
  v_creation_key text;
  v_now timestamptz := clock_timestamp();
BEGIN
  IF v_owner IS NULL OR current_user <> 'eye_action_executor' THEN
    RAISE EXCEPTION 'Authenticated action executor required' USING ERRCODE = '42501';
  END IF;
  IF p_request_id IS NULL OR p_operation NOT IN ('create', 'edit', 'complete', 'cancel', 'replace', 'reopen')
     OR p_channel NOT IN ('client_detail', 'field_control', 'map', 'visit', 'ai_chat', 'api') THEN
    RAISE EXCEPTION 'Invalid action command' USING ERRCODE = '22023';
  END IF;

  v_request := jsonb_build_object('operation', p_operation, 'action_id', p_action_id,
    'expected_version', p_expected_version, 'payload', p_payload, 'channel', p_channel);
  PERFORM pg_advisory_xact_lock(hashtextextended(v_owner::text || ':' || p_request_id::text, 0));
  SELECT * INTO v_prior FROM public.client_action_events
    WHERE owner_user_id = v_owner AND request_id = p_request_id LIMIT 1;
  IF FOUND THEN
    IF v_prior.request_body IS DISTINCT FROM v_request THEN
      RAISE EXCEPTION 'Request ID was already used with different arguments' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.result;
  END IF;
  v_now := clock_timestamp();

  IF p_operation = 'create' THEN
    IF p_action_id IS NOT NULL OR p_expected_version IS NOT NULL THEN
      RAISE EXCEPTION 'Create cannot target an existing action' USING ERRCODE = '22023';
    END IF;
    v_client_id := (p_payload->>'client_id')::uuid;
    IF v_client_id IS NULL THEN RAISE EXCEPTION 'Client is required' USING ERRCODE = '23502'; END IF;
    SELECT * INTO v_client FROM public.clients WHERE id = v_client_id AND owner_user_id = v_owner;
    IF NOT FOUND THEN RAISE EXCEPTION 'Client not owned or not found' USING ERRCODE = '42501'; END IF;
    v_visit_id := (p_payload->>'source_visit_id')::uuid;
    IF v_visit_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.visits WHERE id = v_visit_id AND owner_user_id = v_owner AND client_id = v_client_id
    ) THEN RAISE EXCEPTION 'Source visit is not owned by this client' USING ERRCODE = '42501'; END IF;
    v_description := NULLIF(btrim(p_payload->>'description'), '');
    v_type := p_payload->>'action_type';
    v_due_date := (p_payload->>'due_date')::date;
    v_due_time := (p_payload->>'due_time')::time;
    v_priority := p_payload->>'priority';
    v_origin := p_payload->>'origin';
    v_creation_key := NULLIF(btrim(p_payload->>'creation_key'), '');
    IF v_description IS NULL OR v_creation_key IS NULL OR v_origin NOT IN ('manual', 'ai') THEN
      RAISE EXCEPTION 'Description, creation key, and manual/AI origin are required' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.client_actions (owner_user_id, client_id, client_name_snapshot,
      description, action_type, due_date, due_time, priority, origin, source_visit_id,
      source_excerpt, creation_key, created_at, updated_at)
    VALUES (v_owner, v_client_id, v_client.business_name, v_description, v_type,
      v_due_date, v_due_time, v_priority, v_origin, v_visit_id,
      p_payload->>'source_excerpt', v_creation_key, v_now, v_now)
    RETURNING * INTO v_action;
    v_result := to_jsonb(v_action);
    INSERT INTO public.client_action_events (owner_user_id, action_id, action_version, request_id,
      request_body, result, event_type, actor_user_id, channel, related_visit_id, after)
    VALUES (v_owner, v_action.id, v_action.version, p_request_id,
      v_request, v_result, 'created', v_owner, p_channel, v_visit_id, v_result);
    RETURN v_result;
  END IF;

  IF p_action_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 1 THEN
    RAISE EXCEPTION 'Action ID and expected version are required' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO v_action FROM public.client_actions
    WHERE id = p_action_id AND owner_user_id = v_owner FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Action not owned or not found' USING ERRCODE = '42501'; END IF;
  IF v_action.version <> p_expected_version THEN
    RAISE EXCEPTION 'Action version conflict' USING ERRCODE = '40001';
  END IF;
  v_before := to_jsonb(v_action);

  IF p_operation = 'edit' THEN
    IF v_action.state <> 'open' THEN RAISE EXCEPTION 'Only open actions can be edited' USING ERRCODE = '22023'; END IF;
    v_description := NULLIF(btrim(p_payload->>'description'), '');
    v_type := p_payload->>'action_type';
    v_due_date := (p_payload->>'due_date')::date;
    v_due_time := (p_payload->>'due_time')::time;
    v_priority := p_payload->>'priority';
    UPDATE public.client_actions SET description = v_description, action_type = v_type,
      due_date = v_due_date, due_time = v_due_time, priority = v_priority,
      updated_at = v_now, version = version + 1
      WHERE id = v_action.id AND owner_user_id = v_owner RETURNING * INTO v_action;
  ELSIF p_operation IN ('complete', 'cancel') THEN
    IF v_action.state <> 'open' THEN RAISE EXCEPTION 'Only open actions can be closed' USING ERRCODE = '22023'; END IF;
    v_reason := NULLIF(btrim(p_payload->>'closure_note'), '');
    v_visit_id := (p_payload->>'resolution_visit_id')::uuid;
    IF p_operation = 'cancel' AND v_reason IS NULL THEN
      RAISE EXCEPTION 'Cancellation reason is required' USING ERRCODE = '22023';
    END IF;
    IF v_visit_id IS NOT NULL AND (v_action.client_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.visits WHERE id = v_visit_id AND owner_user_id = v_owner AND client_id = v_action.client_id
    )) THEN RAISE EXCEPTION 'Resolution visit is not owned by this client' USING ERRCODE = '42501'; END IF;
    UPDATE public.client_actions SET state = CASE WHEN p_operation = 'complete' THEN 'completed' ELSE 'cancelled' END,
      resolution_visit_id = v_visit_id, closed_at = v_now, closed_by = v_owner,
      closure_note = v_reason, updated_at = v_now, version = version + 1
      WHERE id = v_action.id AND owner_user_id = v_owner RETURNING * INTO v_action;
  ELSIF p_operation = 'replace' THEN
    IF v_action.state <> 'open' OR v_action.client_id IS NULL THEN
      RAISE EXCEPTION 'Only linked open actions can be replaced' USING ERRCODE = '22023';
    END IF;
    v_reason := NULLIF(btrim(p_payload->>'closure_note'), '');
    v_description := NULLIF(btrim(p_payload->>'description'), '');
    v_type := p_payload->>'action_type';
    v_due_date := (p_payload->>'due_date')::date;
    v_due_time := (p_payload->>'due_time')::time;
    v_priority := p_payload->>'priority';
    v_creation_key := NULLIF(btrim(p_payload->>'creation_key'), '');
    v_visit_id := (p_payload->>'source_visit_id')::uuid;
    IF v_reason IS NULL OR v_description IS NULL OR v_creation_key IS NULL
       OR p_payload->>'origin' NOT IN ('manual', 'ai') THEN
      RAISE EXCEPTION 'Replacement reason, description, and creation key required' USING ERRCODE = '22023';
    END IF;
    IF v_visit_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.visits WHERE id = v_visit_id AND owner_user_id = v_owner AND client_id = v_action.client_id
    ) THEN RAISE EXCEPTION 'Replacement visit is not owned by this client' USING ERRCODE = '42501'; END IF;
    UPDATE public.client_actions SET state = 'replaced', closed_at = v_now,
      closed_by = v_owner, closure_note = v_reason, resolution_visit_id = v_visit_id,
      updated_at = v_now, version = version + 1
      WHERE id = v_action.id AND owner_user_id = v_owner RETURNING * INTO v_action;
    INSERT INTO public.client_actions (owner_user_id, client_id, client_name_snapshot,
      description, action_type, due_date, due_time, priority, origin,
      source_visit_id, source_excerpt, replaces_action_id, creation_key, created_at, updated_at)
    VALUES (v_owner, v_action.client_id, v_action.client_name_snapshot, v_description,
      v_type, v_due_date, v_due_time, v_priority, p_payload->>'origin',
      v_visit_id, p_payload->>'source_excerpt', v_action.id, v_creation_key, v_now, v_now)
    RETURNING * INTO v_new;
    v_result := jsonb_build_object('replaced', to_jsonb(v_action), 'successor', to_jsonb(v_new));
    INSERT INTO public.client_action_events (owner_user_id, action_id, action_version, request_id,
      request_body, result, event_type, actor_user_id, channel, related_visit_id, before, after)
    VALUES (v_owner, v_action.id, v_action.version, p_request_id, v_request, v_result,
      'replaced', v_owner, p_channel, v_visit_id, v_before, to_jsonb(v_action));
    INSERT INTO public.client_action_events (owner_user_id, action_id, action_version, request_id,
      request_body, result, event_type, actor_user_id, channel, related_visit_id, after)
    VALUES (v_owner, v_new.id, v_new.version, p_request_id, v_request, v_result,
      'created', v_owner, p_channel, v_visit_id, to_jsonb(v_new));
    RETURN v_result;
  ELSIF p_operation = 'reopen' THEN
    IF v_action.state NOT IN ('completed', 'cancelled') THEN
      RAISE EXCEPTION 'Only completed/cancelled actions can be reopened' USING ERRCODE = '22023';
    END IF;
    UPDATE public.client_actions SET state = 'open', closed_at = NULL, closed_by = NULL,
      closure_note = NULL, resolution_visit_id = NULL, updated_at = v_now,
      version = version + 1 WHERE id = v_action.id AND owner_user_id = v_owner RETURNING * INTO v_action;
  END IF;

  v_result := to_jsonb(v_action);
  INSERT INTO public.client_action_events (owner_user_id, action_id, action_version, request_id,
    request_body, result, event_type, actor_user_id, channel, related_visit_id, before, after)
  VALUES (v_owner, v_action.id, v_action.version, p_request_id, v_request, v_result,
    CASE WHEN p_operation = 'edit' THEN 'updated' WHEN p_operation = 'reopen' THEN 'reopened'
      WHEN p_operation = 'complete' THEN 'completed' ELSE 'cancelled' END,
    v_owner, p_channel, v_visit_id, v_before, v_result);
  RETURN v_result;
END;
$command$;
REVOKE ALL ON FUNCTION eye_private.run_action_command(text, uuid, uuid, bigint, jsonb, text) FROM PUBLIC, anon, authenticated, service_role;
ALTER FUNCTION eye_private.run_action_command(text, uuid, uuid, bigint, jsonb, text) OWNER TO eye_action_executor;

CREATE FUNCTION public.eye_action_create(
  p_request_id uuid, p_client_id uuid, p_description text, p_action_type text,
  p_due_date date, p_due_time time, p_priority text, p_origin text,
  p_source_visit_id uuid, p_source_excerpt text, p_creation_key text,
  p_channel text
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $body$
  SELECT eye_private.run_action_command('create', p_request_id, NULL, NULL,
    jsonb_build_object('client_id', p_client_id, 'description', p_description,
      'action_type', p_action_type, 'due_date', p_due_date, 'due_time', p_due_time,
      'priority', p_priority, 'origin', p_origin, 'source_visit_id', p_source_visit_id,
      'source_excerpt', p_source_excerpt, 'creation_key', p_creation_key), p_channel);
$body$;

CREATE FUNCTION public.eye_action_edit(
  p_request_id uuid, p_action_id uuid, p_expected_version bigint,
  p_description text, p_action_type text, p_due_date date, p_due_time time,
  p_priority text, p_channel text
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $body$
  SELECT eye_private.run_action_command('edit', p_request_id, p_action_id, p_expected_version,
    jsonb_build_object('description', p_description, 'action_type', p_action_type,
      'due_date', p_due_date, 'due_time', p_due_time, 'priority', p_priority), p_channel);
$body$;

CREATE FUNCTION public.eye_action_complete(
  p_request_id uuid, p_action_id uuid, p_expected_version bigint,
  p_resolution_visit_id uuid, p_closure_note text, p_channel text
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $body$
  SELECT eye_private.run_action_command('complete', p_request_id, p_action_id, p_expected_version,
    jsonb_build_object('resolution_visit_id', p_resolution_visit_id,
      'closure_note', p_closure_note), p_channel);
$body$;

CREATE FUNCTION public.eye_action_cancel(
  p_request_id uuid, p_action_id uuid, p_expected_version bigint,
  p_resolution_visit_id uuid, p_closure_note text, p_channel text
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $body$
  SELECT eye_private.run_action_command('cancel', p_request_id, p_action_id, p_expected_version,
    jsonb_build_object('resolution_visit_id', p_resolution_visit_id,
      'closure_note', p_closure_note), p_channel);
$body$;

CREATE FUNCTION public.eye_action_replace(
  p_request_id uuid, p_action_id uuid, p_expected_version bigint,
  p_description text, p_action_type text, p_due_date date, p_due_time time,
  p_priority text, p_origin text, p_source_visit_id uuid, p_source_excerpt text,
  p_creation_key text, p_closure_note text, p_channel text
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $body$
  SELECT eye_private.run_action_command('replace', p_request_id, p_action_id, p_expected_version,
    jsonb_build_object('description', p_description, 'action_type', p_action_type,
      'due_date', p_due_date, 'due_time', p_due_time, 'priority', p_priority,
      'origin', p_origin, 'source_visit_id', p_source_visit_id,
      'source_excerpt', p_source_excerpt, 'creation_key', p_creation_key,
      'closure_note', p_closure_note), p_channel);
$body$;

CREATE FUNCTION public.eye_action_reopen(
  p_request_id uuid, p_action_id uuid, p_expected_version bigint, p_channel text
) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = pg_catalog AS $body$
  SELECT eye_private.run_action_command('reopen', p_request_id, p_action_id, p_expected_version,
    '{}'::jsonb, p_channel);
$body$;

DO $grant$
DECLARE f record;
BEGIN
  FOR f IN SELECT p.oid::regprocedure AS signature FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN (
      'eye_action_create', 'eye_action_edit', 'eye_action_complete',
      'eye_action_cancel', 'eye_action_replace', 'eye_action_reopen'
    ) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', f.signature);
    EXECUTE format('ALTER FUNCTION %s OWNER TO eye_action_executor', f.signature);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f.signature);
  END LOOP;
END;
$grant$;
REVOKE CREATE ON SCHEMA eye_private, public FROM eye_action_executor;
DO $membership$
BEGIN
  EXECUTE format('REVOKE eye_action_executor FROM %I', current_user);
END;
$membership$;
COMMIT;
