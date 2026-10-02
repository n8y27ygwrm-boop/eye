import assert from 'node:assert/strict'
import { planLegacyActions, stableJSON, stableId, digest } from './legacy-actions.mjs'
import { PROJECT_ID, EXCLUDED_ID, EXCLUSION_REASON } from './phase2b-backfill.mjs'

// Offline planning only. No credentials, network, SQL execution or runtime imports.
const identity = r => `${r.owner_user_id}:${r.source}:${r.legacy_id}`
const sourceKey = r => r.creation_key ?? `legacy:clients:${r.legacy_id}:followup`
const operational = r => {
  const v = r.legacy_source.row
  return r.source === 'clients'
    ? { owner: v.owner_user_id, text: v.next_action, date: v.next_followup }
    : Object.fromEntries(['owner_user_id','client_id','visit_id','business_name','description','action_type','priority','due_date','due_time','is_dismissed','raw_trigger'].map(k => [k,v[k] ?? null]))
}
const same = (a,b) => stableJSON(a) === stableJSON(b)

export function reconcilePhase4A(reference, fresh, accepted, current, unscoped = {}) {
  assert.equal(reference.project_id, PROJECT_ID, 'Wrong reference project')
  assert.equal(fresh.project_id, PROJECT_ID, 'Wrong fresh project')
  const oldPlan = planLegacyActions(reference), newPlan = planLegacyActions(fresh)
  const old = new Map(oldPlan.rows.map(r => [identity(r),r]))
  const now = new Map(newPlan.rows.map(r => [identity(r),r]))
  const actions = new Map(current.actions.map(a => [`${a.owner_user_id}:${a.creation_key}`,a]))
  assert.equal(actions.size,current.actions.length,'Duplicate canonical creation key')
  const expected = new Map(accepted.actions.map(a => [`${a.owner_user_id}:${a.creation_key}`,a]))
  const blocked = newPlan.relationship_anomalies.map(a => ({...a,reason:'ownership_or_relationship_anomaly'}))
  if (Object.values(unscoped).some(n => n !== 0)) blocked.push({reason:'unscoped_source_records',counts:unscoped})
  for (const a of current.actions) {
    const k = `${a.owner_user_id}:${a.creation_key}`
    if (!expected.has(k) || !same(a,expected.get(k))) blocked.push({reason:'canonical_changed_since_accepted_backfill',action_id:a.id})
  }
  for (const a of accepted.actions) if (!actions.has(`${a.owner_user_id}:${a.creation_key}`)) blocked.push({reason:'missing_accepted_canonical_action',action_id:a.id})
  if (!same([...current.events].sort((a,b)=>a.id.localeCompare(b.id)),[...accepted.events].sort((a,b)=>a.id.localeCompare(b.id)))) blocked.push({reason:'canonical_event_history_conflict'})
  const rows = [], operations = []
  for (const key of [...new Set([...old.keys(),...now.keys()])].sort()) {
    const before=old.get(key), after=now.get(key), r=after ?? before
    const creationKey=sourceKey(r), a=actions.get(`${r.owner_user_id}:${creationKey}`)
    const reasons=[...(after?.reasons ?? [])]
    let delta='unchanged', comparison='no_legacy_work', operation=null
    if (!after) { delta='malformed / blocked'; reasons.push('source_deleted_or_owner_changed') }
    else if (after.status==='blocked') delta='malformed / blocked'
    else if (!before) delta=r.source==='clients' ? (r.eligible ? 'new legacy action':'unchanged') : 'new reminder'
    else if (r.source==='clients') {
      if (before.eligible && !after.eligible) delta='cleared legacy action'
      else if (!before.eligible && after.eligible) delta='new legacy action'
      else if (!same(operational(before),operational(after))) delta='changed legacy action'
    } else if (before.legacy_source.row.is_dismissed===false && after.legacy_source.row.is_dismissed===true) delta='dismissed reminder'
    else if (!same(operational(before),operational(after))) delta='changed reminder'
    if (r.legacy_id===EXCLUDED_ID && r.source==='clients') {
      comparison='excluded test artifact'
      if (!before || !after || !same(before.legacy_source,after.legacy_source) || r.legacy_source.row.business_name!=='Brilliant hotel' || r.legacy_source.row.next_action!=='PROD_SMOKE_VERIFY_TEMP' || a) reasons.push('exclusion_evidence_conflict')
    } else if (delta!=='malformed / blocked') {
      if (delta==='unchanged') {
        comparison=r.eligible ? (a ? 'already represented exactly':'new legacy work absent from canonical') : 'no_legacy_work'
        if (r.eligible && !a) reasons.push('accepted_source_missing_canonical_import')
      } else if (!a && after?.eligible) {
        comparison='new legacy work absent from canonical'
        operation={kind:'import',action:structuredClone(after.proposed_action)}
      } else if (a) {
        comparison=delta==='cleared legacy action' ? 'legacy cleared after import' : 'legacy changed after import'
        if (a.origin!=='legacy' || !['open','legacy_closed'].includes(a.state)) reasons.push('canonical_lifecycle_conflict')
        // A reopening/recurrence cannot be deduced from one mutable source slot.
        if (a.state==='legacy_closed' && after?.proposed_action?.state==='open') reasons.push('recurrence_requires_human_decision')
        const close=delta==='cleared legacy action' || delta==='dismissed reminder'
        operation={kind:close?'legacy_close':'update',action:close?{...structuredClone(a),state:'legacy_closed',version:a.version+1,closed_at:null,closed_by:null,resolution_visit_id:null,closure_note:null}:{...structuredClone(after.proposed_action),id:a.id,creation_key:a.creation_key,version:a.version+1,created_at:a.created_at,closed_at:null,closed_by:null,resolution_visit_id:null,closure_note:null}}
      }
    }
    const row={source:r.source,legacy_id:r.legacy_id,owner_user_id:r.owner_user_id,client_id:r.client_id,client:r.legacy_source.row.business_name,category:r.category,eligible:after?.eligible ?? false,delta,comparison,creation_key:creationKey,canonical_action_id:a?.id ?? null,canonical_state:a?.state ?? null,review:r.review,duplicate_candidates:r.duplicate_candidates,source_metadata_changed:!!before&&!!after&&!same(before.legacy_source,after.legacy_source),reasons:[...new Set(reasons)].sort(),decision:r.legacy_id===EXCLUDED_ID?'EXCLUDED':operation?'PROPOSED_DELTA':'NO_WRITE',exclusion_reason:r.legacy_id===EXCLUDED_ID?EXCLUSION_REASON:null,previous_source:before?.legacy_source ?? null,current_source:after?.legacy_source ?? null}
    row.canonical_event_ids=a?current.events.filter(e=>e.action_id===a.id&&e.owner_user_id===a.owner_user_id).map(e=>e.id).sort():[]
    if(operation?.kind==='import'&&current.actions.some(x=>x.id===operation.action.id))row.reasons.push('deterministic_action_id_collision')
    if (row.reasons.length) {row.decision='BLOCKED';blocked.push({source:r.source,legacy_id:r.legacy_id,reasons:row.reasons})}
    else if(operation) {
      const evidence={previous:row.previous_source,current:row.current_source,observed_at:fresh.captured_at,observation_only:true}
      const request=stableId(`${r.owner_user_id}:${creationKey}:delta:${digest({evidence:{previous:evidence.previous,current:evidence.current},version:operation.action.version})}`)
      operation.action.updated_at='TRANSACTION_TIMESTAMP'
      if(operation.kind==='import')operation.action.created_at='TRANSACTION_TIMESTAMP'
      operations.push({...operation,creation_key:creationKey,expected_action:a??null,expected_events:current.events.filter(e=>e.action_id===a?.id),request_id:request,event_id:stableId(`${request}:event`),event_type:operation.kind==='import'?'imported':'updated',actor_user_id:null,channel:'migration',legacy_source:evidence,recorded_at:'TRANSACTION_TIMESTAMP'})
    }
    rows.push(row)
  }
  const counts={};for(const r of rows)counts[r.delta]=(counts[r.delta]??0)+1
  return {project_id:PROJECT_ID,captured_at:fresh.captured_at,reference_captured_at:reference.captured_at,source_sha256:digest(fresh),canonical_sha256:digest(current),rows,operations,blocked,duplicate_candidates:newPlan.duplicate_candidates,inventory:newPlan.inventory,counts,expected:{new_actions:operations.filter(o=>o.kind==='import').length,new_events:operations.length,final_actions:current.actions.length+operations.filter(o=>o.kind==='import').length,final_events:current.events.length+operations.length},ready_for_delta_plan:blocked.length===0,execution_authorized:false}
}

export function validateProductionConfiguration(e) {
  const blockers=[]
  if(e.environment_verified!==true) blockers.push('production_environment_unverified')
  if(e.deployed_authority!=='LEGACY') blockers.push('deployed_authority_not_verified_legacy')
  if(e.secret_exists!==true || e.secret_minimum_length!==true) blockers.push('confirmation_secret_unverified_or_invalid')
  if(e.secret_server_only!==true) blockers.push('confirmation_secret_scope_unverified')
  if(e.secret_stable!==true) blockers.push('confirmation_secret_stability_unverified')
  if(e.deployed_matches_accepted!==true) blockers.push('accepted_application_not_deployed')
  if(e.authenticated_http_read_verified!==true) blockers.push('authenticated_deployed_canonical_read_unverified')
  return {ready:blockers.length===0,blockers}
}

// A plan state machine, not an application authority selector or production writer.
export function advanceCutover(state, event) {
  const s=structuredClone(state)
  if(event.type==='freeze') {
    assert.equal(s.authority,'LEGACY');assert.equal(event.database_guard_verified,true);assert.equal(event.jobs_drained_or_preserved,true);assert.ok(typeof event.epoch==='string'&&event.epoch.length>0)
    s.frozen=true;s.freeze_epoch=event.epoch;s.snapshot_epoch=null;s.reconciled=false
  } else if(event.type==='snapshot') {
    assert.equal(s.frozen,true,'Freeze before final snapshot');assert.equal(event.epoch,s.freeze_epoch)
    s.snapshot_epoch=event.epoch;s.snapshot_sha256=event.sha256;s.reconciled=false
  } else if(event.type==='reconcile') {
    assert.equal(s.frozen,true);assert.equal(s.snapshot_epoch,s.freeze_epoch);assert.equal(event.sha256,s.snapshot_sha256);assert.equal(event.verified,true)
    s.reconciled=true
  } else if(event.type==='activate') {
    assert.equal(s.frozen,true);assert.equal(s.reconciled,true);assert.equal(s.snapshot_epoch,s.freeze_epoch);assert.equal(event.configuration_verified,true);assert.equal(event.old_deployments_fenced,true)
    s.authority='CANONICAL';s.canonical_writes=0
  } else if(event.type==='canonical_write') {
    assert.equal(s.authority,'CANONICAL');assert.ok(!s.maintenance&&!s.canonical_writes_fenced,'Canonical writes fenced');s.canonical_writes++
  } else if(event.type==='rollback') {
    assert.equal(s.frozen,true);assert.equal(event.canonical_writes_fenced,true)
    // Read-only maintenance rollback retains canonical authority/history once activated.
    s.maintenance=true;s.canonical_writes_fenced=true
  } else if(event.type==='abort_before_activation') {
    assert.equal(s.authority,'LEGACY');assert.equal(event.verified_legacy_release,true)
    s.frozen=false;s.reconciled=false;s.snapshot_epoch=null
  } else throw new Error('Unknown cutover event')
  return s
}

// Proposed only. Never invoked by app/runtime. Full maintenance freeze also
// protects relationship changes and queued service-role writes, with no bypass.
export function proposedLegacyFreezeSQL() {
  return `-- PROPOSAL ONLY: Phase 4A must not execute against production.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='30s';
LOCK TABLE public.clients, public.visits, public.ai_reminders IN SHARE ROW EXCLUSIVE MODE;
CREATE FUNCTION eye_private.phase4_legacy_frozen() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='55000', MESSAGE='Legacy operational maintenance freeze'; END;
$$;
REVOKE ALL ON FUNCTION eye_private.phase4_legacy_frozen() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER phase4_legacy_frozen BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.clients FOR EACH STATEMENT EXECUTE FUNCTION eye_private.phase4_legacy_frozen();
CREATE TRIGGER phase4_legacy_frozen BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.visits FOR EACH STATEMENT EXECUTE FUNCTION eye_private.phase4_legacy_frozen();
CREATE TRIGGER phase4_legacy_frozen BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.ai_reminders FOR EACH STATEMENT EXECUTE FUNCTION eye_private.phase4_legacy_frozen();
ALTER TABLE public.clients ENABLE ALWAYS TRIGGER phase4_legacy_frozen;
ALTER TABLE public.visits ENABLE ALWAYS TRIGGER phase4_legacy_frozen;
ALTER TABLE public.ai_reminders ENABLE ALWAYS TRIGGER phase4_legacy_frozen;
COMMIT;
`
}

// Exact observed plan is a no-op. Nonzero manifests deliberately cannot be
// turned into executable SQL here: they require separate operator review.
export function proposedNoopVerificationSQL(plan, fingerprints) {
  assert.equal(plan.ready_for_delta_plan,true,'Blocked reconciliation')
  assert.equal(plan.operations.length,0,'Nonzero delta requires review; no execution generator')
  assert.equal(plan.project_id,PROJECT_ID)
  assert.deepEqual(Object.keys(fingerprints).sort(),['clients','visits','ai_reminders','client_actions','client_action_events'].sort(),'Missing fingerprint coverage')
  assert.ok(Object.values(fingerprints).every(v=>Number.isSafeInteger(v.count)&&v.count>=0&&/^[0-9a-f]{32}$/.test(v.md5)),'Invalid fingerprints')
  const expected=JSON.stringify(fingerprints).replaceAll("'","''")
  return `-- READ-ONLY verification proposal; no import statements. Re-capture after freeze.
BEGIN READ ONLY;
DO $$ BEGIN
IF (SELECT jsonb_object_agg(name,jsonb_build_object('count',n,'md5',h)) FROM (
${['clients','visits','ai_reminders','client_actions','client_action_events'].map(t=>`SELECT '${t}' name,count(*) n,md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) h FROM public.${t} t`).join('\nUNION ALL\n')}
) s) IS DISTINCT FROM '${expected}'::jsonb THEN RAISE EXCEPTION 'STOP: stale Phase 4A plan'; END IF;
END $$;
ROLLBACK;
`
}
