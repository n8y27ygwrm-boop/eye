import assert from 'node:assert/strict'
import { planLegacyActions, stableJSON, stableId, digest } from './legacy-actions.mjs'

export const PROJECT_ID='brblmltkxpblmtwcgtlm'
export const EXCLUDED_ID='7589a049-fee6-495b-991f-79b7514f706e'
export const EXCLUSION_REASON='User confirmed Brilliant hotel PROD_SMOKE_VERIFY_TEMP as a test artifact; exclude canonical import and preserve legacy source unchanged.'

export function approvePhase2B(reference,fresh,{timeZone}={}) {
  assert.equal(reference.project_id,PROJECT_ID,'Wrong reference project')
  assert.equal(fresh.project_id,PROJECT_ID,'Wrong fresh project')
  const material=({captured_at,...s})=>s
  assert.equal(stableJSON(material(fresh)),stableJSON(material(reference)),'STOP: legacy source snapshot changed since Phase 2A')
  const plan=planLegacyActions(fresh,{timeZone})
  assert.equal(plan.inventory.eligible,9,'STOP: original eligible count changed')
  assert.equal(plan.inventory.blocked,0,'STOP: malformed or invalid legacy source')
  assert.equal(plan.relationship_anomalies.length,0,'STOP: relationship anomalies')
  const excluded=plan.rows.find(r=>r.source==='clients'&&r.legacy_id===EXCLUDED_ID)
  assert.ok(excluded&&excluded.status==='proposed','STOP: exclusion source missing or invalid')
  assert.equal(excluded.legacy_source.row.business_name,'Brilliant hotel','STOP: excluded client name changed')
  assert.equal(excluded.legacy_source.row.next_action,'PROD_SMOKE_VERIFY_TEMP','STOP: excluded text changed')
  const approved=structuredClone(plan)
  const row=approved.rows.find(r=>r.source==='clients'&&r.legacy_id===EXCLUDED_ID)
  row.status='excluded';row.decision='EXCLUDE_CONFIRMED_TEST_ARTIFACT';row.exclusion_reason=EXCLUSION_REASON
  for(const r of approved.rows) if(r.status==='proposed')r.decision='IMPORT'
  const imports=approved.rows.filter(r=>r.status==='proposed')
  approved.source_inventory=structuredClone(approved.inventory)
  approved.inventory.proposed=imports.length
  approved.inventory.excluded=1
  assert.equal(imports.filter(r=>r.source==='clients').length,6,'STOP: approved follow-up count changed')
  assert.equal(imports.filter(r=>r.source==='ai_reminders').length,2,'STOP: approved reminder count changed')
  assert.equal(imports.filter(r=>r.category==='date_only').length,5,'STOP: date-only count changed')
  assert.equal(imports.filter(r=>r.proposed_action.state==='open').length,6)
  assert.equal(imports.filter(r=>r.proposed_action.state==='legacy_closed').length,2)
  approved.approval={project_id:PROJECT_ID,actions:8,events:8,excluded:1,exclusion_reason:EXCLUSION_REASON,
    approved_sources_sha256:digest(imports.map(r=>r.legacy_source)),snapshot_comparison:'identical_except_capture_time'}
  return approved
}

const quote=s=>`'${String(s).replaceAll("'","''")}'`
const json=v=>`${quote(JSON.stringify(v))}::jsonb`
export const fingerprintExpression=`(SELECT jsonb_object_agg(name,jsonb_build_object('count',n,'md5',h)) FROM (
  SELECT 'clients' name,count(*) n,md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY id),'')) h FROM public.clients t UNION ALL
  SELECT 'visits',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY id),'')) FROM public.visits t UNION ALL
  SELECT 'ai_reminders',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY id),'')) FROM public.ai_reminders t
) s)`

// Offline SQL generation only: no network, credentials, public RPC or schema
// change. An operator must target the verified project through the admin tool.
export function productionImportSQL(plan,legacyFingerprints) {
  assert.equal(plan.approval?.project_id,PROJECT_ID)
  const imports=plan.rows.filter(r=>r.status==='proposed')
  assert.equal(imports.length,8)
  assert.equal(plan.rows.filter(r=>r.status==='excluded'&&r.legacy_id===EXCLUDED_ID).length,1)
  const expectedLegacy=Object.fromEntries(['clients','visits','ai_reminders'].map(t=>[t,legacyFingerprints[t]]))
  assert.ok(Object.values(expectedLegacy).every(v=>Number.isInteger(v?.count)&&/^[0-9a-f]{32}$/.test(v.md5)))
  const guard=`IF ${fingerprintExpression} IS DISTINCT FROM ${json(expectedLegacy)} THEN RAISE EXCEPTION 'STOP: full legacy source drift'; END IF;`
  const body=`DECLARE
    r jsonb; expected public.client_actions; existing public.client_actions;
    event public.client_action_events; expected_event public.client_action_events;
    request uuid; event_id uuid; import_time timestamptz:=transaction_timestamp();
    actual_source jsonb; n_actions bigint; n_events bigint;
  BEGIN
    IF current_user<>'postgres' OR NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname=current_user) THEN
      RAISE EXCEPTION 'Verified migration admin required';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended('eye:phase2b:${PROJECT_ID}',0));
    ${guard}
    IF EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid IN ('public.client_actions'::regclass,'public.client_action_events'::regclass) AND NOT tgisinternal)
      OR EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid IN ('public.client_actions'::regclass,'public.client_action_events'::regclass) AND NOT convalidated)
      OR EXISTS(SELECT 1 FROM pg_class WHERE oid IN ('public.client_actions'::regclass,'public.client_action_events'::regclass) AND (NOT relrowsecurity OR NOT relforcerowsecurity)) THEN
      RAISE EXCEPTION 'Canonical boundary changed';
    END IF;
    SELECT count(*) INTO n_actions FROM public.client_actions;
    SELECT count(*) INTO n_events FROM public.client_action_events;
    IF n_actions NOT IN (0,8) OR n_events<>n_actions THEN RAISE EXCEPTION 'Unexpected canonical starting set'; END IF;
    IF EXISTS(SELECT 1 FROM public.client_actions WHERE creation_key=${quote(`legacy:clients:${EXCLUDED_ID}:followup`)}) THEN RAISE EXCEPTION 'Excluded artifact was imported'; END IF;
    FOR r IN SELECT value FROM jsonb_array_elements(${json(imports)}) LOOP
      SELECT * INTO expected FROM jsonb_populate_record(NULL::public.client_actions,r->'proposed_action');
      IF r->>'source'='clients' THEN
        SELECT jsonb_build_object('table','clients','row',jsonb_build_object('id',c.id,'owner_user_id',c.owner_user_id,'business_name',c.business_name,'next_action',c.next_action,'next_followup',c.next_followup,'created_at',c.created_at,'updated_at',c.updated_at)) INTO actual_source
          FROM public.clients c WHERE c.id=(r->>'legacy_id')::uuid AND c.owner_user_id=expected.owner_user_id;
      ELSE
        SELECT jsonb_build_object('table','ai_reminders','row',to_jsonb(s)) INTO actual_source FROM public.ai_reminders s
          WHERE s.id=(r->>'legacy_id')::uuid AND s.owner_user_id=expected.owner_user_id;
      END IF;
      IF actual_source IS DISTINCT FROM r->'legacy_source' THEN RAISE EXCEPTION 'STOP: source evidence changed for %',r->>'creation_key'; END IF;
      IF NOT EXISTS(SELECT 1 FROM auth.users WHERE id=expected.owner_user_id)
        OR NOT EXISTS(SELECT 1 FROM public.clients WHERE id=expected.client_id AND owner_user_id=expected.owner_user_id)
        OR (expected.source_visit_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.visits WHERE id=expected.source_visit_id AND owner_user_id=expected.owner_user_id AND client_id=expected.client_id)) THEN
        RAISE EXCEPTION 'Owner/client/visit relationship invalid';
      END IF;
      SELECT * INTO existing FROM public.client_actions WHERE owner_user_id=expected.owner_user_id AND creation_key=expected.creation_key;
      IF FOUND THEN
        expected.created_at:=existing.created_at;expected.updated_at:=existing.updated_at;
        IF to_jsonb(existing) IS DISTINCT FROM to_jsonb(expected) THEN RAISE EXCEPTION 'Canonical creation key conflict for %',expected.creation_key; END IF;
      ELSE
        expected.created_at:=import_time;expected.updated_at:=import_time;
        INSERT INTO public.client_actions SELECT expected.*;
      END IF;
      request:=(r->>'import_request_id')::uuid;event_id:=(r->>'import_event_id')::uuid;
      SELECT * INTO expected_event FROM jsonb_populate_record(NULL::public.client_action_events,jsonb_build_object(
        'id',event_id,'owner_user_id',expected.owner_user_id,'action_id',expected.id,'action_version',1,'request_id',request,
        'request_body',jsonb_build_object('operation','legacy_import','creation_key',expected.creation_key,'source_sha256',r->>'evidence_sha256'),
        'result',to_jsonb(expected),'event_type','imported','actor_user_id',NULL,'channel','migration',
        'related_visit_id',expected.source_visit_id,'before',NULL,'after',to_jsonb(expected),'legacy_source',r->'legacy_source','recorded_at',expected.created_at));
      SELECT * INTO event FROM public.client_action_events WHERE action_id=expected.id AND action_version=1;
      IF FOUND THEN
        IF to_jsonb(event) IS DISTINCT FROM to_jsonb(expected_event) THEN RAISE EXCEPTION 'Import event/evidence conflict for %',expected.creation_key; END IF;
      ELSIF existing.id IS NOT NULL THEN RAISE EXCEPTION 'Existing action lacks verified import event';
      ELSE INSERT INTO public.client_action_events SELECT expected_event.*;
      END IF;
    END LOOP;
    IF (SELECT count(*) FROM public.client_actions)<>8 OR (SELECT count(*) FROM public.client_action_events)<>8 THEN RAISE EXCEPTION 'Final canonical count mismatch'; END IF;
    ${guard}
  END;`
  return `BEGIN;
SET LOCAL standard_conforming_strings=on;
SET LOCAL TIME ZONE 'UTC';
SET LOCAL statement_timeout='20s';
SET LOCAL lock_timeout='2s';
DO ${quote(body)};
SELECT jsonb_build_object('observed_at',clock_timestamp(),'legacy_fingerprints',${fingerprintExpression},
'actions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.client_actions a),
'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.client_action_events e)) result;
COMMIT;`
}

export function withImportIdentities(plan) {
  const copy=structuredClone(plan)
  for(const r of copy.rows.filter(r=>r.status==='proposed')) {
    r.import_request_id=stableId(`${r.owner_user_id}:${r.creation_key}:import`)
    r.import_event_id=stableId(`${r.owner_user_id}:${r.creation_key}:event`)
    r.evidence_sha256=digest(r.legacy_source)
  }
  return copy
}
