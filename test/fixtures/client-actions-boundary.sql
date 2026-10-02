\set ON_ERROR_STOP on
SET plpgsql.check_asserts = on;
DO $security$
BEGIN
  IF has_table_privilege('authenticated', 'public.client_actions', 'INSERT')
     OR has_table_privilege('authenticated', 'public.client_actions', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.client_action_events', 'INSERT')
     OR has_table_privilege('eye_action_executor', 'public.client_action_events', 'UPDATE')
     OR has_table_privilege('anon', 'public.client_actions', 'SELECT')
     OR has_function_privilege('anon', 'public.eye_action_create(uuid,uuid,text,text,date,time without time zone,text,text,uuid,text,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.eye_action_create(uuid,uuid,text,text,date,time without time zone,text,text,uuid,text,text,text)', 'EXECUTE')
     OR (SELECT rolbypassrls OR rolcanlogin FROM pg_roles WHERE rolname = 'eye_action_executor')
     OR NOT has_function_privilege('eye_action_executor', 'eye_private.action_uid()', 'EXECUTE')
     OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.client_actions'::regclass)
     OR NOT (SELECT relrowsecurity AND relforcerowsecurity FROM pg_class WHERE oid = 'public.client_action_events'::regclass)
  THEN RAISE EXCEPTION 'Canonical boundary grants, role or RLS are unsafe'; END IF;
END;
$security$;
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000001', false);

DO $test$
DECLARE
  v_id uuid;
  v_result jsonb;
  v_repeat jsonb;
  v_successor uuid;
  v_other uuid;
  v_count integer;
BEGIN
  v_result := public.eye_action_create(
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'Call client', 'call', '2026-09-28', NULL, 'high', 'manual',
    '20000000-0000-0000-0000-000000000001', 'Visit promise', 'test:one', 'visit');
  v_id := (v_result->>'id')::uuid;
  ASSERT v_result->>'state' = 'open';
  ASSERT (v_result->>'version')::bigint = 1;

  v_repeat := public.eye_action_create(
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'Call client', 'call', '2026-09-28', NULL, 'high', 'manual',
    '20000000-0000-0000-0000-000000000001', 'Visit promise', 'test:one', 'visit');
  ASSERT v_repeat = v_result;
  SELECT count(*) INTO v_count FROM public.client_action_events WHERE action_id = v_id;
  ASSERT v_count = 1;

  BEGIN
    PERFORM public.eye_action_create(
      '30000000-0000-0000-0000-000000000001',
      '10000000-0000-0000-0000-000000000001',
      'Changed payload', 'call', '2026-09-28', NULL, 'high', 'manual',
      NULL, NULL, 'test:one', 'visit');
    RAISE EXCEPTION 'Changed idempotency payload was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  BEGIN
    PERFORM public.eye_action_create(
      '30000000-0000-0000-0000-000000000002',
      '10000000-0000-0000-0000-000000000002',
      'Foreign client', 'call', NULL, NULL, 'medium', 'manual',
      NULL, NULL, 'test:foreign', 'api');
    RAISE EXCEPTION 'Cross-owner client accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.eye_action_create(
      '30000000-0000-0000-0000-000000000012',
      '10000000-0000-0000-0000-000000000001',
      'Same owner wrong client visit', 'call', NULL, NULL, 'medium', 'manual',
      '20000000-0000-0000-0000-000000000003', NULL, 'test:wrong-client-visit', 'visit');
    RAISE EXCEPTION 'Same-owner, different-client visit accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.eye_action_create(
      '30000000-0000-0000-0000-000000000003',
      '10000000-0000-0000-0000-000000000001',
      'Foreign visit', 'call', NULL, NULL, 'medium', 'manual',
      '20000000-0000-0000-0000-000000000002', NULL, 'test:foreign-visit', 'visit');
    RAISE EXCEPTION 'Cross-owner visit accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.client_actions (client_name_snapshot, description, origin, creation_key)
      VALUES ('Bypass', 'Bypass', 'manual', 'bypass');
    RAISE EXCEPTION 'Direct table write accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  v_result := public.eye_action_edit('30000000-0000-0000-0000-000000000004',
    v_id, 1, 'Call tomorrow', 'call', '2026-09-29', '09:30', 'medium', 'client_detail');
  ASSERT (v_result->>'version')::bigint = 2;
  ASSERT v_result->>'description' = 'Call tomorrow';

  BEGIN
    PERFORM public.eye_action_complete('30000000-0000-0000-0000-000000000005',
      v_id, 1, NULL, NULL, 'field_control');
    RAISE EXCEPTION 'Stale version accepted';
  EXCEPTION WHEN serialization_failure THEN NULL;
  END;

  BEGIN
    PERFORM public.eye_action_complete('30000000-0000-0000-0000-000000000014',
      v_id, 2, '20000000-0000-0000-0000-000000000002', NULL, 'field_control');
    RAISE EXCEPTION 'Foreign resolution visit accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  v_result := public.eye_action_complete('30000000-0000-0000-0000-000000000006',
    v_id, 2, '20000000-0000-0000-0000-000000000001', 'Done', 'field_control');
  ASSERT v_result->>'state' = 'completed';
  ASSERT v_result->>'closed_at' IS NOT NULL;
  v_repeat := public.eye_action_complete('30000000-0000-0000-0000-000000000006',
    v_id, 2, '20000000-0000-0000-0000-000000000001', 'Done', 'field_control');
  ASSERT v_repeat = v_result;

  v_result := public.eye_action_reopen('30000000-0000-0000-0000-000000000007',
    v_id, 3, 'client_detail');
  ASSERT v_result->>'state' = 'open' AND v_result->>'closed_at' IS NULL;

  v_result := public.eye_action_replace('30000000-0000-0000-0000-000000000008',
    v_id, 4, 'Deliver sample', 'deliver', '2026-09-30', NULL, 'high', 'manual',
    '20000000-0000-0000-0000-000000000001', 'New promise',
    'test:successor', 'Plan changed', 'visit');
  v_successor := (v_result->'successor'->>'id')::uuid;
  ASSERT v_result->'replaced'->>'state' = 'replaced';
  ASSERT v_result->'successor'->>'state' = 'open';
  SELECT count(*) INTO v_count FROM public.client_action_events
    WHERE request_id = '30000000-0000-0000-0000-000000000008';
  ASSERT v_count = 2;

  v_result := public.eye_action_cancel('30000000-0000-0000-0000-000000000009',
    v_successor, 1, NULL, 'No longer needed', 'client_detail');
  ASSERT v_result->>'state' = 'cancelled';
  v_repeat := public.eye_action_replace('30000000-0000-0000-0000-000000000008',
    v_id, 4, 'Deliver sample', 'deliver', '2026-09-30', NULL, 'high', 'manual',
    '20000000-0000-0000-0000-000000000001', 'New promise',
    'test:successor', 'Plan changed', 'visit');
  ASSERT v_repeat->'successor'->>'id' = v_successor::text;
  SELECT count(*) INTO v_count FROM public.client_action_events
    WHERE request_id = '30000000-0000-0000-0000-000000000008';
  ASSERT v_count = 2;
  SELECT count(*) INTO v_count FROM public.client_action_events WHERE action_id = v_id;
  ASSERT v_count = 5;

  BEGIN
    UPDATE public.client_action_events SET event_type = 'updated' WHERE action_id = v_id;
    RAISE EXCEPTION 'History edit accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    PERFORM public.eye_action_reopen('30000000-0000-0000-0000-000000000010',
      v_id, 5, 'api');
    RAISE EXCEPTION 'Replaced action reopened';
  EXCEPTION WHEN invalid_parameter_value THEN NULL;
  END;
END;
$test$;

RESET ROLE;
SELECT set_config('test.owner_one_action_id', id::text, false)
  FROM public.client_actions WHERE creation_key = 'test:one';
SET ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000002', false);
DO $test$
DECLARE v_count integer;
BEGIN
  SELECT count(*) INTO v_count FROM public.client_actions;
  ASSERT v_count = 0;
  SELECT count(*) INTO v_count FROM public.client_action_events;
  ASSERT v_count = 0;
  BEGIN
    PERFORM public.eye_action_complete('30000000-0000-0000-0000-000000000011',
      current_setting('test.owner_one_action_id')::uuid, 5, NULL, NULL, 'api');
    RAISE EXCEPTION 'Cross-owner action mutation accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  PERFORM public.eye_action_create(
    '30000000-0000-0000-0000-000000000013',
    '10000000-0000-0000-0000-000000000002',
    'Own work', 'follow_up', NULL, NULL, 'low', 'manual',
    NULL, NULL, 'test:owner-two', 'api');
  SELECT count(*) INTO v_count FROM public.client_actions;
  ASSERT v_count = 1;
END;
$test$;
