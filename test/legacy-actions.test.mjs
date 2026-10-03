import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { planLegacyActions, rehearseInMemory, stableId } from '../lib/migration/legacy-actions.mjs'
import { dryRun } from '../scripts/legacy-actions-dry-run.mjs'

const owner='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002'
const c1='30000000-0000-0000-0000-000000000001',c2='30000000-0000-0000-0000-000000000002'
const r1='40000000-0000-0000-0000-000000000001',v1='50000000-0000-0000-0000-000000000001'
const client=(extra={})=>({id:c1,owner_user_id:owner,business_name:'Client',next_action:null,next_followup:null,...extra})
const reminder=(extra={})=>({id:r1,owner_user_id:owner,business_name:'Client',client_id:c1,visit_id:null,description:'Call',action_type:'call',priority:'medium',due_date:null,due_time:null,is_dismissed:false,is_sent:false,created_at:'2020-01-01T00:00:00Z',raw_trigger:null,...extra})
const snapshot=(clients=[client()],reminders=[],visits=[])=>({captured_at:'2026-09-26T12:00:00Z',owners:[{owner_user_id:owner,clients,ai_reminders:reminders,visits}]})
const proposed=(s)=>planLegacyActions(s).rows.filter(r=>r.eligible)

for(const [name,extra,description,date,category] of [
  ['text and date',{next_action:'  Call exactly  ',next_followup:'2026-09-27'},'  Call exactly  ','2026-09-27','text_and_date'],
  ['text only',{next_action:'Call'},'Call',null,'text_only'],
  ['date only',{next_followup:'2026-09-27'},'Follow-up — details not recorded','2026-09-27','date_only'],
]) test(`client mapping: ${name}`,()=>{
  const [r]=proposed(snapshot([client(extra)]))
  assert.equal(r.category,category);assert.equal(r.status,'proposed')
  assert.equal(r.proposed_action.description,description);assert.equal(r.proposed_action.due_date,date)
  assert.equal(r.proposed_action.due_time,null);assert.equal(r.proposed_action.state,'open')
  assert.equal(r.proposed_action.origin,'legacy');assert.equal(r.proposed_action.action_type,'follow_up')
  assert.equal(r.creation_key,`legacy:clients:${c1}:followup`)
})
test('neither and whitespace-only follow-ups create no action',()=>{
  for(const next_action of [null,'','  \t\n']){
    const plan=planLegacyActions(snapshot([client({next_action})]))
    assert.equal(plan.rows[0].status,'no_action');assert.equal(plan.inventory.eligible,0)
    assert.equal(rehearseInMemory(plan).store.size,0)
  }
})
test('active reminder preserves source and schedule',()=>{
  const original=reminder({due_date:'2026-09-28',due_time:'14:30:00.123456',raw_trigger:'Original text',is_sent:true})
  const [r]=proposed(snapshot([client()],[original]))
  assert.equal(r.proposed_action.state,'open');assert.equal(r.proposed_action.id,r1)
  assert.equal(r.proposed_action.due_time,'14:30:00.123456');assert.equal(r.proposed_action.source_excerpt,'Original text')
  assert.deepEqual(r.legacy_source.row,original)
})
test('dismissed reminder is legacy_closed with no fabricated actor/time',()=>{
  const [r]=proposed(snapshot([client()],[reminder({is_dismissed:true})]))
  assert.equal(r.proposed_action.state,'legacy_closed')
  assert.equal(r.proposed_action.closed_at,null);assert.equal(r.proposed_action.closed_by,null)
  assert.equal(r.proposed_action.resolution_visit_id,null)
  assert.equal(r.proposed_action.created_at,'2026-09-26T12:00:00Z')
  assert.equal(r.legacy_source.row.created_at,'2020-01-01T00:00:00Z')
})
test('null dismissal/type/priority use approved defaults and explicit review flags',()=>{
  const [r]=proposed(snapshot([client()],[reminder({is_dismissed:null,action_type:null,priority:null})]))
  assert.equal(r.proposed_action.state,'open');assert.equal(r.proposed_action.action_type,'follow_up')
  assert.equal(r.proposed_action.priority,'medium');assert.equal(r.review.length,3)
  assert.equal(r.legacy_source.row.is_dismissed,null)
})
test('reruns preserve one action and imported event per creation key',()=>{
  const s=snapshot([client({next_action:'Call'})],[reminder()]),p=planLegacyActions(s)
  const first=rehearseInMemory(p),second=rehearseInMemory(p,first.store)
  assert.equal(first.store.size,2);assert.ok(second.outcomes.every(o=>o.status==='already_present'))
  s.captured_at='2026-09-27T12:00:00Z'
  assert.ok(rehearseInMemory(planLegacyActions(s),first.store).outcomes.every(o=>o.status==='already_present'))
  assert.ok([...first.store.values()].every(v=>v.actor_user_id===null&&v.event_type==='imported'))
})
test('changed source or canonical action conflicts rather than overwriting',()=>{
  const s=snapshot([client({next_action:'Call'})]),p=planLegacyActions(s),first=rehearseInMemory(p)
  s.owners[0].clients[0].next_action='Changed'
  assert.equal(rehearseInMemory(planLegacyActions(s),first.store).outcomes[0].status,'source_or_action_conflict')
  assert.equal([...first.store.values()][0].action.description,'Call')
})
test('similar and identical candidates remain separate',()=>{
  const p=planLegacyActions(snapshot([client({next_action:'Call'})],[reminder()]))
  assert.equal(p.duplicate_candidates.length,1);assert.equal(rehearseInMemory(p).store.size,2)
  assert.notEqual(p.rows[0].creation_key,p.rows[1].creation_key)
})
test('date-only candidate cannot be silently merged with reminder',()=>{
  const p=planLegacyActions(snapshot([client({next_followup:'2026-09-28'})],[reminder({is_dismissed:true})]))
  assert.equal(p.duplicate_candidates[0].reason,'same_client_incomplete_details')
  assert.equal(rehearseInMemory(p).store.size,2)
})
test('unlinked reminders are kept without guessing from name or visit',()=>{
  const [r]=proposed(snapshot([client()],[reminder({client_id:null,visit_id:v1})],[{id:v1,owner_user_id:owner,client_id:c1}]))
  assert.equal(r.status,'proposed');assert.equal(r.proposed_action.client_id,null)
  assert.ok(r.review.includes('unresolved_client_link'))
})
test('same-owner visit and client remain linked',()=>{
  const [r]=proposed(snapshot([client()],[reminder({visit_id:v1})],[{id:v1,owner_user_id:owner,client_id:c1}]))
  assert.equal(r.status,'proposed');assert.equal(r.proposed_action.source_visit_id,v1)
})
test('invalid ownership blocks migration',()=>{
  for(const owner_user_id of [null,'invalid',other]){
    const [r]=proposed(snapshot([client()],[reminder({owner_user_id})]))
    assert.equal(r.status,'blocked');assert.ok(r.reasons.includes('invalid_ownership'))
  }
})
test('cross-owner client and visit links block migration',()=>{
  const s=snapshot([client()],[reminder({client_id:c2,visit_id:v1})])
  s.owners.push({owner_user_id:other,clients:[client({id:c2,owner_user_id:other})],ai_reminders:[],visits:[{id:v1,owner_user_id:other,client_id:c2}]})
  const [r]=proposed(s)
  assert.equal(r.status,'blocked');assert.ok(r.reasons.includes('cross_owner_client'));assert.ok(r.reasons.includes('cross_owner_visit'))
})
test('missing client and visit links block migration',()=>{
  const [r]=proposed(snapshot([client()],[reminder({client_id:c2,visit_id:v1})]))
  assert.deepEqual(r.reasons,['missing_client','missing_visit']);assert.equal(r.status,'blocked')
})
test('same-owner visit attached to different client blocks migration',()=>{
  const [r]=proposed(snapshot([client(),client({id:c2})],[reminder({visit_id:v1})],[{id:v1,owner_user_id:owner,client_id:c2}]))
  assert.ok(r.reasons.includes('visit_client_mismatch'));assert.equal(r.status,'blocked')
})
test('invalid visit-only context is explicitly inventoried',()=>{
  const p=planLegacyActions(snapshot([client()],[],[{id:v1,owner_user_id:owner,client_id:c2}]))
  assert.equal(p.relationship_anomalies.length,1);assert.ok(p.relationship_anomalies[0].reasons.includes('missing_client'))
})
for(const [label,extra,reason] of [
  ['impossible date',{due_date:'2026-02-30'},'invalid_date'],
  ['infinite date',{due_date:'infinity'},'invalid_date'],
  ['time without date',{due_time:'10:00:00'},'time_without_date'],
  ['bad time',{due_date:'2026-09-27',due_time:'25:00:00'},'invalid_time'],
  ['DST gap',{due_date:'2026-03-29',due_time:'02:30:00'},'nonexistent_local_time'],
  ['DST fold',{due_date:'2026-10-25',due_time:'02:30:00'},'ambiguous_local_time'],
]) test(`malformed schedule: ${label}`,()=>{
  const s=snapshot([client()],[reminder(extra)])
  const a=planLegacyActions(s),b=planLegacyActions(s)
  assert.deepEqual(a,b);const [r]=a.rows.filter(r=>r.eligible)
  assert.equal(r.status,'blocked');assert.ok(r.reasons.includes(reason));assert.equal(rehearseInMemory(a).store.size,0)
  assert.deepEqual(r.legacy_source.row,reminder(extra))
})
test('invalid client follow-up dates are blocked',()=>{
  assert.ok(proposed(snapshot([client({next_followup:'2026-02-30'})]))[0].reasons.includes('invalid_date'))
})
test('configured timezone controls DST validation',()=>{
  const s=snapshot([client()],[reminder({due_date:'2026-03-29',due_time:'02:30:00'})])
  assert.equal(planLegacyActions(s,{timeZone:'UTC'}).rows.find(r=>r.eligible).status,'proposed')
  assert.throws(()=>planLegacyActions(s,{timeZone:'Invalid/Zone'}),/Invalid EYE scheduling/)
  const script=`import { planLegacyActions } from './lib/migration/legacy-actions.mjs'; console.log(planLegacyActions(${JSON.stringify(s)}).time_zone)`
  const child=spawnSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',env:{...process.env,NEXT_PUBLIC_EYE_SCHEDULING_TIME_ZONE:'UTC'}})
  assert.equal(child.status,0,child.stderr);assert.equal(child.stdout.trim(),'UTC')
})
test('malformed dismissal, enums, descriptions and excerpts are blocked',()=>{
  for(const extra of [{is_dismissed:'false'},{action_type:'other'},{priority:'urgent'},{description:''},{raw_trigger:{}},{description:'\u0000'}]){
    assert.equal(proposed(snapshot([client()],[reminder(extra)]))[0].status,'blocked')
  }
})
test('complete coverage and zero mutation of deeply frozen source',()=>{
  const s=snapshot([client(),client({id:c2,next_followup:'2026-09-27'})],[reminder({is_dismissed:true})])
  const before=JSON.stringify(s)
  const freeze=v=>{if(v&&typeof v==='object'){Object.values(v).forEach(freeze);Object.freeze(v)}};freeze(s)
  const p=planLegacyActions(s);rehearseInMemory(p)
  assert.equal(JSON.stringify(s),before);assert.equal(p.rows.length,3);assert.equal(p.inventory.eligible,2);assert.equal(p.inventory.no_action,1)
})
test('input order does not change mappings or stable keys',()=>{
  const s=snapshot([client({next_action:'Call'}),client({id:c2,next_followup:'2026-09-27'})],[reminder()])
  const p=planLegacyActions(s);s.owners[0].clients.reverse()
  assert.deepEqual(planLegacyActions(s).rows,p.rows);assert.equal(stableId('key'),stableId('key'))
})
test('duplicate snapshot identity is rejected instead of silently skipped',()=>{
  assert.throws(()=>planLegacyActions(snapshot([client(),client()])),/Duplicate snapshot source identity/)
})
test('action ID collisions are reported without mutating the store',()=>{
  const p=planLegacyActions(snapshot([client({next_action:'Call'})])),r=p.rows[0]
  const store=new Map([['different-key',{action:{id:r.proposed_action.id}}]])
  assert.equal(rehearseInMemory(p,store).outcomes[0].status,'action_id_collision');assert.equal(store.size,1)
})
test('real local PostgreSQL import preserves source and action/event idempotency',()=>{
  const s=snapshot([
    client({next_action:"Call $import$ ' quote \\ backslash"}),
    client({id:c2,next_followup:'2026-09-27'}),
    client({id:'30000000-0000-0000-0000-000000000003',next_action:'Unscheduled'}),
    client({id:'30000000-0000-0000-0000-000000000004'}),
  ],[
    reminder({visit_id:v1,is_dismissed:true}),
    reminder({id:'40000000-0000-0000-0000-000000000002',client_id:null,description:'Unlinked'}),
    reminder({id:'40000000-0000-0000-0000-000000000003',due_time:'10:00:00'}),
  ],[{id:v1,owner_user_id:owner,client_id:c1}])
  const {proof,plan}=dryRun(s)
  assert.equal(plan.inventory.blocked,1);assert.equal(proof.first_run.created_actions,5)
  assert.equal(proof.first_run.created_events,5);assert.equal(proof.second_run.created_actions,0)
  assert.equal(proof.conflict_rejected,true);assert.equal(proof.legacy_fixture_unchanged,true)
})
