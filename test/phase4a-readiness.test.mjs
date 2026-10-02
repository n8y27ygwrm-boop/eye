import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { planLegacyActions, stableJSON } from '../lib/migration/legacy-actions.mjs'
import { PROJECT_ID } from '../lib/migration/phase2b-backfill.mjs'
import { EXCLUDED_ID } from '../lib/migration/phase2b-backfill.mjs'
import { issueConfirmation, verifyConfirmation } from '../lib/ai/actions/receipt.ts'
import { resolveActionAuthority } from '../lib/config/action-authority.ts'
import { reconcilePhase4A, validateProductionConfiguration, advanceCutover, proposedLegacyFreezeSQL, proposedNoopVerificationSQL } from '../lib/migration/phase4a-readiness.mjs'

const owner='00000000-0000-0000-0000-000000000001'
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`
function fixture() {
  const snapshot={project_id:PROJECT_ID,captured_at:'2026-09-26T12:00:00Z',owners:[{owner_user_id:owner,clients:[{id:id(2),owner_user_id:owner,business_name:'Client',next_action:'Call',next_followup:'2026-09-27',created_at:null,updated_at:null},{id:id(3),owner_user_id:owner,business_name:'No work',next_action:null,next_followup:null,created_at:null,updated_at:null}],visits:[{id:id(4),owner_user_id:owner,client_id:id(2)}],ai_reminders:[{id:id(5),owner_user_id:owner,client_id:id(2),visit_id:id(4),business_name:'Client',description:'Call at 10:00',action_type:'call',priority:'medium',due_date:'2026-09-28',due_time:null,is_dismissed:false,raw_trigger:'original'}]}]}
  const actions=planLegacyActions(snapshot).rows.filter(r=>r.eligible).map(r=>r.proposed_action)
  const canonical={actions,events:actions.map((a,i)=>({id:id(20+i),action_id:a.id,owner_user_id:owner,action_version:1,event_type:'imported',after:structuredClone(a),legacy_source:{}}))}
  return {reference:snapshot,fresh:structuredClone(snapshot),accepted:canonical,current:structuredClone(canonical)}
}
const reconcile=f=>reconcilePhase4A(f.reference,f.fresh,f.accepted,f.current)
const client=f=>f.fresh.owners[0].clients[0]
const reminder=f=>f.fresh.owners[0].ai_reminders[0]
const deltaRow=p=>p.rows.find(r=>r.delta!=='unchanged')

test('unchanged accepted sources generate zero writes and deterministic full reconciliation',()=>{
  const f=fixture(),p=reconcile(f);assert.equal(p.rows.length,3);assert.equal(p.operations.length,0);assert.equal(p.ready_for_delta_plan,true);assert.equal(p.execution_authorized,false);assert.deepEqual(reconcile(f),p)
})
test('changed-after-import follow-up preserves creation key, identity and original history',()=>{
  const f=fixture();client(f).next_action='Changed';const p=reconcile(f),o=p.operations[0];assert.equal(deltaRow(p).delta,'changed legacy action');assert.equal(o.kind,'update');assert.equal(o.action.id,f.accepted.actions.find(a=>a.creation_key===o.creation_key).id);assert.equal(o.action.version,2);assert.equal(o.actor_user_id,null);assert.equal(o.event_type,'updated');assert.equal(o.legacy_source.previous.row.next_action,'Call');assert.equal(o.legacy_source.current.row.next_action,'Changed')
})
test('cleared legacy follow-up proposes unknown historical closure without actor/time/completion',()=>{
  const f=fixture();client(f).next_action=null;client(f).next_followup=null;const p=reconcile(f),o=p.operations[0];assert.equal(deltaRow(p).delta,'cleared legacy action');assert.equal(o.kind,'legacy_close');assert.equal(o.action.state,'legacy_closed');assert.equal(o.action.closed_at,null);assert.equal(o.action.closed_by,null);assert.equal(o.event_type,'updated');assert.equal(o.action.description,'Call')
})
test('reminder dismissal after backfill records observed legacy_closed, not completed',()=>{
  const f=fixture();reminder(f).is_dismissed=true;const p=reconcile(f);assert.equal(deltaRow(p).delta,'dismissed reminder');assert.equal(p.operations[0].action.state,'legacy_closed');assert.equal(p.operations[0].action.closed_at,null);assert.equal(p.operations[0].actor_user_id,null)
})
test('new work in existing empty legacy slot has stable import identities',()=>{
  const f=fixture();f.fresh.owners[0].clients[1].next_followup='2026-09-29';const p=reconcile(f);assert.equal(deltaRow(p).delta,'new legacy action');assert.equal(p.operations[0].action.description,'Follow-up — details not recorded');assert.equal(p.expected.new_actions,1);assert.equal(p.expected.new_events,1);assert.equal(reconcile(f).operations[0].event_id,p.operations[0].event_id)
})
test('new client follow-up is accounted for without merging',()=>{
  const f=fixture();f.fresh.owners[0].clients.push({...client(f),id:id(6)});const p=reconcile(f);assert.equal(deltaRow(p).delta,'new legacy action');assert.equal(p.operations[0].kind,'import')
})
test('new reminder remains separate even for identical client/text',()=>{
  const f=fixture();f.fresh.owners[0].ai_reminders.push({...reminder(f),id:id(7),description:'Call'});const p=reconcile(f);assert.equal(deltaRow(p).delta,'new reminder');assert.equal(p.operations[0].kind,'import');assert.equal(p.current,undefined);assert.ok(p.duplicate_candidates.length>0)
})
test('changed reminder keeps prose time unstructured and preserves evidence',()=>{
  const f=fixture();reminder(f).description='Call at 11:00';const p=reconcile(f);assert.equal(deltaRow(p).delta,'changed reminder');assert.equal(p.operations[0].action.due_time,null);assert.equal(p.operations[0].legacy_source.previous.row.description,'Call at 10:00')
})
test('canonical action or append-only event conflict fails closed',()=>{
  for(const edit of [f=>f.current.actions[0].description='Conflict',f=>f.current.events[0].legacy_source={tampered:true},f=>f.current.actions.pop()]) {const f=fixture();edit(f);assert.equal(reconcile(f).ready_for_delta_plan,false)}
})
test('malformed schedule, cross-owner link and unscoped source block planning',()=>{
  for(const edit of [f=>reminder(f).due_date='2026-02-30',f=>reminder(f).owner_user_id=id(99),f=>reminder(f).client_id=id(99)]){const f=fixture();edit(f);assert.equal(reconcile(f).ready_for_delta_plan,false)}
  const f=fixture();assert.equal(reconcilePhase4A(f.reference,f.fresh,f.accepted,f.current,{clients:1}).ready_for_delta_plan,false)
})
test('deleted source / owner movement is not silently treated as completion',()=>{
  const f=fixture();f.fresh.owners[0].clients.shift();const p=reconcile(f);assert.equal(p.ready_for_delta_plan,false);assert.ok(p.rows.some(r=>r.reasons.includes('source_deleted_or_owner_changed')))
})
test('reopened dismissed reminder requires a human recurrence decision',()=>{
  const f=fixture();f.reference.owners[0].ai_reminders[0].is_dismissed=true;f.accepted.actions.find(a=>a.id===id(5)).state='legacy_closed';f.current=structuredClone(f.accepted);const p=reconcile(f);assert.equal(p.ready_for_delta_plan,false);assert.ok(p.rows.some(r=>r.reasons.includes('recurrence_requires_human_decision')))
})
test('planner never mutates legacy source or accepted canonical evidence',()=>{
  const f=fixture();client(f).next_action='Different';const before=stableJSON(f);reconcile(f);assert.equal(stableJSON(f),before)
})
test('no-op verification is read-only; nonzero/conflicting plans cannot emit executable import',()=>{
  const f=fixture(),p=reconcile(f),fp=Object.fromEntries(['clients','visits','ai_reminders','client_actions','client_action_events'].map(k=>[k,{count:0,md5:'d41d8cd98f00b204e9800998ecf8427e'}])),sql=proposedNoopVerificationSQL(p,fp);assert.match(sql,/BEGIN READ ONLY/);assert.doesNotMatch(sql,/\b(?:INSERT|UPDATE|DELETE)\b/);assert.throws(()=>proposedNoopVerificationSQL(p,{}),/Missing fingerprint coverage/);client(f).next_action='Changed';assert.throws(()=>proposedNoopVerificationSQL(reconcile(f),fp),/Nonzero delta/)
})
const initial=()=>({authority:'LEGACY',frozen:false,reconciled:false,canonical_writes:0})
const freeze=s=>advanceCutover(s,{type:'freeze',database_guard_verified:true,jobs_drained_or_preserved:true,epoch:'f1'})
const snapshot=s=>advanceCutover(s,{type:'snapshot',epoch:'f1',sha256:'current'})
const reconciled=s=>advanceCutover(snapshot(freeze(s)),{type:'reconcile',sha256:'current',verified:true})
test('race gate rejects snapshot before freeze and stale pre-freeze reconciliation',()=>{
  assert.throws(()=>snapshot(initial()));const s=snapshot(freeze(initial()));assert.throws(()=>advanceCutover(s,{type:'reconcile',sha256:'stale',verified:true}));assert.throws(()=>advanceCutover(s,{type:'snapshot',epoch:'old',sha256:'current'}));assert.throws(()=>advanceCutover(s,{type:'activate',configuration_verified:true,old_deployments_fenced:true}))
})
test('writer freeze requires verified database guard and preserved/drained jobs',()=>{
  assert.throws(()=>advanceCutover(initial(),{type:'freeze',database_guard_verified:false,jobs_drained_or_preserved:true}));assert.throws(()=>advanceCutover(initial(),{type:'freeze',database_guard_verified:true,jobs_drained_or_preserved:false}));assert.match(proposedLegacyFreezeSQL(),/ENABLE ALWAYS TRIGGER/g);assert.match(proposedLegacyFreezeSQL(),/SHARE ROW EXCLUSIVE/)
})
test('activation requires final reconciliation, configuration and old deployment fencing',()=>{
  const s=reconciled(initial());assert.throws(()=>advanceCutover(s,{type:'activate',configuration_verified:false,old_deployments_fenced:true}));assert.throws(()=>advanceCutover(s,{type:'activate',configuration_verified:true,old_deployments_fenced:false}));assert.equal(advanceCutover(s,{type:'activate',configuration_verified:true,old_deployments_fenced:true}).authority,'CANONICAL')
})
test('rollback after activation remains canonical in maintenance and preserves write count',()=>{
  const s=advanceCutover(reconciled(initial()),{type:'activate',configuration_verified:true,old_deployments_fenced:true});const w=advanceCutover(s,{type:'canonical_write'});assert.throws(()=>advanceCutover(w,{type:'rollback',canonical_writes_fenced:false}));const r=advanceCutover(w,{type:'rollback',canonical_writes_fenced:true});assert.equal(r.authority,'CANONICAL');assert.equal(r.canonical_writes,1);assert.equal(r.maintenance,true);assert.throws(()=>advanceCutover(r,{type:'canonical_write'}),/fenced/);assert.throws(()=>advanceCutover(r,{type:'abort_before_activation',verified_legacy_release:true}))
})
test('pre-activation abort can restore verified LEGACY while preserving canonical history',()=>{
  const r=advanceCutover(reconciled(initial()),{type:'abort_before_activation',verified_legacy_release:true});assert.equal(r.authority,'LEGACY');assert.equal(r.frozen,false);assert.equal(r.reconciled,false)
})
test('production config validation fails closed on absent/unverified/invalid evidence',()=>{
  const valid={environment_verified:true,deployed_authority:'LEGACY',secret_exists:true,secret_minimum_length:true,secret_server_only:true,secret_stable:true,deployed_matches_accepted:true,authenticated_http_read_verified:true};assert.equal(validateProductionConfiguration(valid).ready,true);assert.equal(validateProductionConfiguration({}).ready,false);for(const k of Object.keys(valid)){const v={...valid,[k]:k==='deployed_authority'?'UNKNOWN':false};assert.equal(validateProductionConfiguration(v).ready,false)}
})

test('reviewed artifact is excluded only while original evidence remains identical',()=>{
  const f=fixture(),artifact={id:EXCLUDED_ID,owner_user_id:owner,business_name:'Brilliant hotel',next_action:'PROD_SMOKE_VERIFY_TEMP',next_followup:'2026-11-20',created_at:null,updated_at:null};f.reference.owners[0].clients.push(artifact);f.fresh.owners[0].clients.push(structuredClone(artifact));const p=reconcile(f);assert.equal(p.rows.find(r=>r.legacy_id===EXCLUDED_ID).decision,'EXCLUDED');assert.equal(p.operations.length,0);f.fresh.owners[0].clients.at(-1).next_action='Real work';assert.equal(reconcile(f).ready_for_delta_plan,false)
})
test('real authority and receipt modules initialize with stable secret and reject invalid configuration',()=>{
  const action={id:id(30),type:'UPDATE_CLIENT_FOLLOWUP',targetId:id(2),targetName:'Client',payload:{next_followup:'2026-09-28'},expected:{next_followup:'2026-09-27',next_action:'Call'},confirmationText:'Confirm'};const secret='x'.repeat(32),receipt=issueConfirmation(owner,'CANONICAL',action,null,secret,1000);assert.equal(verifyConfirmation(owner,'CANONICAL',receipt,secret,1001).owner,owner);assert.throws(()=>verifyConfirmation(owner,'CANONICAL',receipt,'y'.repeat(32),1001));assert.throws(()=>issueConfirmation(owner,'CANONICAL',action,null,'',1000),/SECRET/);assert.throws(()=>issueConfirmation(owner,'CANONICAL',action,null,'short',1000),/SECRET/);assert.equal(resolveActionAuthority(undefined),'LEGACY');assert.throws(()=>resolveActionAuthority('INVALID'),/AUTHORITY/)
})

test('proposed database freeze drains an in-flight writer and blocks all later roles without changing source',async()=>{
  const root=mkdtempSync('/tmp/eye-phase4a-db-'),data=join(root,'data'),socket=join(root,'socket'),port=String(59500+Math.floor(Math.random()*400));mkdirSync(socket);let started=false
  function run(bin,args,input){const r=spawnSync('rtk',['proxy',bin,...args],{input,encoding:'utf8',timeout:60000});if(r.error||r.status!==0)throw new Error(r.error?.message??r.stderr);return r.stdout}
  function asyncRun(args,input){return new Promise((resolve,reject)=>{const p=spawn('rtk',['proxy','psql',...args],{stdio:['pipe','pipe','pipe']});let out='',err='';p.stdout.on('data',d=>out+=d);p.stderr.on('data',d=>err+=d);p.on('error',reject);p.on('close',code=>code===0?resolve(out):reject(new Error(err)));p.stdin.end(input)})}
  try{
    run('initdb',['-D',data,'-A','trust','-U','postgres','--no-instructions']);run('pg_ctl',['-D',data,'-o',`-c listen_addresses= -c unix_socket_directories=${socket} -p ${port}`,'-l',join(root,'postgres.log'),'-w','start']);started=true
    const args=['-X','-v','ON_ERROR_STOP=1','-h',socket,'-p',port,'-U','postgres','-d','postgres'];const sql=s=>run('psql',args,s)
    sql(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE SCHEMA eye_private; CREATE TABLE public.clients(id int primary key, next_action text); CREATE TABLE public.visits(id int); CREATE TABLE public.ai_reminders(id int,is_dismissed boolean); CREATE TABLE public.client_actions(id int); CREATE TABLE public.client_action_events(id int); INSERT INTO public.clients VALUES(1,'initial'); GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;`)
    const writer=asyncRun(args,`SET application_name='phase4a_test_writer'; BEGIN; UPDATE public.clients SET next_action='accepted concurrent write' WHERE id=1; SELECT pg_sleep(1.2); COMMIT;`)
    let inFlight=false
    for(let i=0;i<20;i++){await new Promise(r=>setTimeout(r,30));if(run('psql',[...args,'-q','-Atc',`SELECT count(*) FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='phase4a_test_writer' AND l.relation='public.clients'::regclass AND l.mode='RowExclusiveLock' AND l.granted;`]).trim()==='1'){inFlight=true;break}}
    assert.equal(inFlight,true,'In-flight writer barrier not established')
    const frozen=asyncRun(args,proposedLegacyFreezeSQL());await Promise.all([writer,frozen]);assert.match(sql('SELECT next_action FROM public.clients;'),/accepted concurrent write/)
    const source=sql('SELECT * FROM public.clients;')
    for(const statement of ["UPDATE public.clients SET next_action='lost' WHERE id=1","INSERT INTO public.ai_reminders VALUES(1,false)","INSERT INTO public.visits VALUES(1)","TRUNCATE public.clients","SET ROLE service_role; INSERT INTO public.ai_reminders VALUES(2,false)","SET session_replication_role=replica; UPDATE public.clients SET next_action='bypass' WHERE id=1"]){assert.throws(()=>sql(statement),/maintenance freeze/)}
    assert.equal(sql('SELECT * FROM public.clients;'),source)
    assert.match(sql("SELECT count(*) FROM pg_trigger WHERE tgname='phase4_legacy_frozen' AND tgenabled='A';"),/3/)
    const fpQuery=`SELECT jsonb_object_agg(name,jsonb_build_object('count',n,'md5',h)) FROM (${['clients','visits','ai_reminders','client_actions','client_action_events'].map(t=>`SELECT '${t}' name,count(*) n,md5(coalesce(string_agg(to_jsonb(t)::text,E'\\n' ORDER BY to_jsonb(t)::text),'')) h FROM public.${t} t`).join(' UNION ALL ')}) s;`
    const fp=JSON.parse(run('psql',[...args,'-q','-Atc',fpQuery]));const plan={ready_for_delta_plan:true,operations:[],project_id:PROJECT_ID};sql(proposedNoopVerificationSQL(plan,fp));const stale=structuredClone(fp);stale.clients.count++;assert.throws(()=>sql(proposedNoopVerificationSQL(plan,stale)),/stale Phase 4A plan/);assert.equal(sql('SELECT * FROM public.clients;'),source)
  }finally{if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);rmSync(root,{recursive:true,force:true})}
})
