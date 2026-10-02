import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { persistCanonicalReminder, assertJobAuthority } from '../lib/actions/reminder-handover'
import { verifiedJobClient } from '../lib/actions/job-session'
import { backgroundReminderOutcome, assertDigestAvailable } from '../lib/actions/background-policy'
import { createCanonicalActionService } from '../lib/actions/canonical'
import { readDigestActions } from '../lib/actions/digest-source'
import { confirmationReadiness, readCanonicalReadiness } from '../lib/actions/readiness'
import { assertOperationalWritesEnabled } from '../lib/config/write-maintenance'
import { handleVisitReminder, runReminderExtraction, persistActionableReminder } from '../lib/inngest/functions/process-visit-reminder'
import { fullLegacyFreezeSQL, canonicalFenceSQL, releaseCanonicalFenceSQL, narrowLegacyGuardsSQL, releaseFullLegacyFreezeSQL, cutoverTrafficPlan } from '../lib/migration/phase4b-controls.mjs'

const owner='00000000-0000-4000-8000-000000000001', client='10000000-0000-4000-8000-000000000001', visit='20000000-0000-4000-8000-000000000001'
const input={visit_id:visit,owner_user_id:owner,client_id:client,business_name:'Owner One Client',visit_date:'2026-09-26',shenime:'Call tomorrow'}
const extraction={hasReminder:true,description:'Call tomorrow',actionType:'call' as const,dueDate:'2026-09-27',dueTime:null,priority:'medium' as const,rawTrigger:'Call tomorrow',summary:null}
const row={id:'30000000-0000-4000-8000-000000000001',owner_user_id:owner,client_id:client,client_name_snapshot:'Owner One Client',description:'Call tomorrow',action_type:'call',due_date:'2026-09-27',due_time:null,priority:'medium',state:'open',origin:'ai',version:1,source_visit_id:visit,source_excerpt:null,resolution_visit_id:null,replaces_action_id:null,creation_key:`visit-reminder:${visit}`,created_at:'2026-09-26T00:00:00Z',updated_at:'2026-09-26T00:00:00Z',closed_at:null,closed_by:null,closure_note:null}
function db(rpc?: any, rows:any[]=[row]) {
  const tables:string[]=[],writes:any[]=[]
  const sb:any={auth:{getUser:async()=>({data:{user:{id:owner}},error:null})},rpc:rpc??(async(name:any,args:any)=>{writes.push({name,args});return{data:row,error:null}}),from:(table:string)=>{
    tables.push(table);const q:any={select:()=>q,eq:()=>q,in:()=>q,order:()=>q,range:()=>q,
      maybeSingle:async()=>({data:table==='visits'?{id:visit,owner_user_id:owner,client_id:client,shenime:input.shenime}:table==='clients'?{id:client}:null,error:null}),
      then:(resolve:any)=>resolve({data:table==='client_actions'?rows:[{...row,business_name:row.client_name_snapshot}],error:null})};return q
  }};return {sb,tables,writes}
}
function mode(value:string){process.env.EYE_ACTION_AUTHORITY=value;process.env.EYE_ACTION_MAINTENANCE='OFF'}

test('canonical Inngest handler performs zero steps and retains event identity',async()=>{
  mode('CANONICAL');let steps=0
  const result=await handleVisitReminder({event:{id:'event-original',data:{visitId:visit,ownerUserId:owner}},step:{run:async()=>{steps++;throw Error('DB/extraction step forbidden')}}})
  assert.equal(steps,0);assert.equal(result.hasReminder,false)
  assert.equal('persisted' in result && result.persisted,false)
  assert.equal('outcome' in result && result.outcome,'no_background_write')
  assert.deepEqual('evidence' in result && result.evidence,{eventId:'event-original',visitId:visit,ownerUserId:owner})
})
test('canonical policy requires no owner credential, even during maintenance',async()=>{
  mode('CANONICAL');process.env.EYE_ACTION_MAINTENANCE='ON'
  assert.equal(backgroundReminderOutcome()?.reason,'canonical_interactive_only')
  await assert.rejects(verifiedJobClient(owner),/disabled/);mode('LEGACY')
  assert.equal(backgroundReminderOutcome(),null)
})
test('retired canonical writer never reads or dispatches an RPC',async()=>{
  mode('CANONICAL');const x=db();const r=await persistCanonicalReminder(input,extraction,x.sb)
  assert.equal(r.persisted,false);assert.equal(r.hasReminder,false);assert.equal(x.tables.length,0);assert.equal(x.writes.length,0)
  await assert.rejects(persistActionableReminder(input,extraction,x.sb));assert.equal(x.tables.length,0)
  mode('LEGACY');await assert.rejects(persistCanonicalReminder(input,extraction,x.sb))
})
test('canonical extraction never reads operational tables or invokes providers',async()=>{
  mode('CANONICAL');const x=db();const r=await runReminderExtraction(input,x.sb,[],'CANONICAL')
  assert.equal(r.hasReminder,false);assert.equal(r.outcome,'no_background_write');assert.deepEqual(x.tables,[])
})
test('invalid authority and malformed job identity fail before steps',async()=>{
  let steps=0;const step={run:async()=>{steps++;throw Error('unexpected step')}}
  mode('bad');await assert.rejects(handleVisitReminder({event:{data:{visitId:visit,ownerUserId:owner}},step}))
  mode('CANONICAL');await assert.rejects(handleVisitReminder({event:{data:{visitId:'',ownerUserId:owner}},step}))
  assert.equal(steps,0);mode('LEGACY')
})
test('LEGACY reminder insertion preserves deterministic ID and duplicate behavior',async()=>{
  mode('LEGACY');let calls=0;const sb:any={from:(t:string)=>{assert.equal(t,'ai_reminders');return{insert:(r:any)=>({select:()=>({single:async()=>{calls++;return calls===1?{data:{id:r.id},error:null}:{data:null,error:{code:'23505'}}}})})}}};const a=await persistActionableReminder(input,extraction,sb),b=await persistActionableReminder(input,extraction,sb);assert.equal(a.id,b.id);assert.equal(b.alreadyExists,true)
})
test('LEGACY digest retains owner/today-visit selection; canonical digest fails before reads',async()=>{
  const legacy=db();mode('LEGACY');await readDigestActions(owner,[visit],legacy.sb)
  assert.deepEqual(legacy.tables,['ai_reminders']);mode('CANONICAL')
  const canonical=db();await assert.rejects(readDigestActions(owner,[visit],canonical.sb),/Canonical digest unavailable/)
  assert.deepEqual(canonical.tables,[]);assert.throws(assertDigestAvailable);mode('LEGACY')
})
test('readiness reads canonical with owner verification while authority stays LEGACY',async()=>{
  mode('LEGACY');const x=db();const r=await readCanonicalReadiness(x.sb);assert.equal(r.mode,'LEGACY');assert.equal(r.readOnly,true);assert.equal(x.writes.length,0);assert.equal(r.data.length,1)
})
test('AI signing readiness requires stable server secret and exposes status only',()=>{
  const old=process.env.EYE_AI_CONFIRMATION_SECRET;try{delete process.env.EYE_AI_CONFIRMATION_SECRET;assert.throws(()=>confirmationReadiness(owner,'LEGACY'));process.env.EYE_AI_CONFIRMATION_SECRET='s'.repeat(32);assert.deepEqual(confirmationReadiness(owner,'LEGACY'),{mode:'LEGACY',initialized:true,serverOnly:true,readOnly:true,missingReceiptRejected:true,invalidReceiptRejected:true});assert.deepEqual(confirmationReadiness(owner,'LEGACY'),confirmationReadiness(owner,'LEGACY'))}finally{if(old)process.env.EYE_AI_CONFIRMATION_SECRET=old;else delete process.env.EYE_AI_CONFIRMATION_SECRET}
})
test('invalid maintenance and changed authority block writes; old deployment plan fences DB',()=>{
  mode('LEGACY');assert.throws(()=>assertJobAuthority('CANONICAL'));process.env.EYE_ACTION_MAINTENANCE='bad';assert.throws(assertOperationalWritesEnabled);const p=cutoverTrafficPlan(['old']);assert.equal(p.activationAuthorized,false);assert.equal(p.rollback.authority,'CANONICAL');assert.equal(p.rollback.allowOldLegacyRollback,false);assert.match(p.fencing,/ALWAYS/);mode('LEGACY')
})
test('production routes expose authenticated readiness with no test imports or mutation override',()=>{
  for(const f of ['app/api/actions/route.ts','app/api/chat/action/route.ts']){const source=readFileSync(f,'utf8');assert.match(source,/requireAuthenticatedUser/);assert.match(source,/export async function GET/);assert.doesNotMatch(source,/fixtures|phase3b\/|process\.env\.NEXT_PUBLIC_EYE/)}
  const enqueue=readFileSync('app/api/reminders/enqueue/route.ts','utf8');assert.match(enqueue,/backgroundReminderOutcome/);assert.ok(enqueue.indexOf('if (skipped) return') < enqueue.indexOf('await inngest.send'));assert.doesNotMatch(enqueue,/verifiedJobClient/);assert.doesNotMatch(enqueue,/access_token|refresh_token/)
})

test('real Phase 1 RPC retries import one action/event; executable fences retain canonical reads and block old writers',async()=>{
  const root=mkdtempSync('/tmp/eye-phase4b-db-'),data=join(root,'data'),socket=join(root,'socket'),port=String(61000+Math.floor(Math.random()*400));mkdirSync(socket);let started=false
  function run(bin:string,args:string[],input?:string){const r=spawnSync('rtk',['proxy',bin,...args],{input,encoding:'utf8',timeout:60000});if(r.error||r.status!==0)throw Error(r.error?.message??r.stderr);return r.stdout}
  try{
    run('initdb',['-D',data,'-A','trust','-U','postgres','--no-instructions']);run('pg_ctl',['-D',data,'-o',`-c listen_addresses= -c unix_socket_directories=${socket} -p ${port}`,'-l',join(root,'postgres.log'),'-w','start']);started=true
    const args=['-X','-v','ON_ERROR_STOP=1','-h',socket,'-p',port,'-U','postgres','-d','postgres'];const sql=(s:string)=>run('psql',args,s)
    sql(readFileSync('test/fixtures/client-actions-bootstrap.sql','utf8').replaceAll('-0000-0000-0000-', '-0000-4000-8000-'));for(const file of ['20260925221611_client_actions_phase1.sql','20260925221829_client_actions_auth_uid_privilege.sql','20260925222213_client_actions_identity_bridge.sql'])sql(readFileSync('supabase/migrations/'+file,'utf8'))
    const admin=['-X','-v','ON_ERROR_STOP=1','-h',socket,'-p',port,'-U','eye_migration_admin','-d','postgres'];const exec=(s:string)=>run('psql',admin,s)
    exec("ALTER TABLE public.visits ADD COLUMN shenime text; ALTER TABLE public.ai_reminders ADD COLUMN owner_user_id uuid; ALTER TABLE public.ai_reminders ADD COLUMN is_dismissed boolean; CREATE POLICY owner_clients ON public.clients FOR SELECT TO authenticated USING(owner_user_id=auth.uid()); CREATE POLICY owner_visits ON public.visits FOR SELECT TO authenticated USING(owner_user_id=auth.uid());")
    // Call the production adapter; the fake transport delegates to the REAL transaction RPC.
    const commands:string[]=[]
    const sbRpc=db(async(name:string,a:any)=>{const value=(v:any)=>v===null?'NULL':"'"+String(v).replaceAll("'","''")+"'";const body=`SELECT public.${name}(${Object.entries(a).map(([k,v])=>`${k} => ${value(v)}`).join(',')}) result;`;const command=`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${owner}'; ${body} COMMIT;`;commands.push(command);const out=run('psql',[...admin,'-q','-At'],command);return{data:JSON.parse(out.trim()),error:null}})
    mode('CANONICAL')
    // Explicit authenticated interaction retains the real RPC retry/fence verification.
    const interactive=(description:string)=>createCanonicalActionService(sbRpc.sb,owner).mutate({operation:'create',requestId:'40000000-0000-4000-8000-000000000001',channel:'client_detail',clientId:client,fields:{description,action_type:'call',due_date:'2026-09-27',due_time:null,priority:'medium',origin:'manual',source_visit_id:visit,creation_key:'explicit-user-test',source_excerpt:null}})
    await interactive(extraction.description!);await interactive(extraction.description!);const command=commands[0]
    const counts=()=>run('psql',[...admin,'-q','-Atc',"SELECT (SELECT count(*) FROM public.client_actions)||':'||(SELECT count(*) FROM public.client_action_events)"]).trim();assert.equal(counts(),'1:1');await assert.rejects(interactive('Different'));assert.equal(counts(),'1:1')
    exec(canonicalFenceSQL());assert.throws(()=>exec(command),/permission denied|maintenance fence/);assert.equal(counts(),'1:1');assert.match(exec(`SET ROLE authenticated; SET request.jwt.claim.sub='${owner}'; SELECT description FROM public.client_actions;`),/Call tomorrow/)
    exec(fullLegacyFreezeSQL());assert.throws(()=>exec("UPDATE public.clients SET business_name='paused'"),/maintenance freeze/);exec(narrowLegacyGuardsSQL());exec(releaseFullLegacyFreezeSQL());exec("UPDATE public.clients SET business_name='allowed CRM metadata' WHERE id='"+client+"'")
    for(const statement of ["UPDATE public.clients SET next_action='old UI' WHERE id='"+client+"'","INSERT INTO public.ai_reminders(id) VALUES(gen_random_uuid())","UPDATE public.visits SET client_id=NULL WHERE id='"+visit+"'","TRUNCATE public.ai_reminders","SET session_replication_role=replica; UPDATE public.clients SET next_action='bypass' WHERE id='"+client+"'"]){assert.throws(()=>exec(statement),/fenced/)}
    exec(releaseCanonicalFenceSQL());exec(command);assert.equal(counts(),'1:1');assert.equal(sbRpc.writes.length,0)
  }finally{mode('LEGACY');if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);rmSync(root,{recursive:true,force:true})}
})
