import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync,mkdirSync,rmSync,readFileSync } from 'node:fs'
import { join,resolve } from 'node:path'
import { approvePhase2B,withImportIdentities,productionImportSQL,fingerprintExpression,PROJECT_ID,EXCLUDED_ID } from '../lib/migration/phase2b-backfill.mjs'

const owner='00000000-0000-0000-0000-000000000001'
const id=(prefix,n)=>`${prefix}0000000-0000-0000-0000-${String(n).padStart(12,'0')}`
function fixture(){
  const clients=Array.from({length:6},(_,i)=>({id:id('3',i+1),owner_user_id:owner,business_name:`Client ${i+1}`,next_action:i===5?'Call $import$ \' original':null,next_followup:'2026-09-27',created_at:null,updated_at:null}))
  clients.push({id:EXCLUDED_ID,owner_user_id:owner,business_name:'Brilliant hotel',next_action:'PROD_SMOKE_VERIFY_TEMP',next_followup:'2026-11-20',created_at:null,updated_at:null})
  const reminders=Array.from({length:2},(_,i)=>({id:id('4',i+1),owner_user_id:owner,client_id:clients[i].id,visit_id:id('5',i+1),business_name:clients[i].business_name,description:'Call tomorrow at 10:00',action_type:'call',due_date:'2026-09-21',due_time:i===0?'14:30:00':null,priority:'medium',is_sent:false,is_dismissed:true,created_at:'2020-01-01T00:00:00+00:00',raw_trigger:'Original evidence'}))
  return {project_id:PROJECT_ID,captured_at:'2026-09-26T12:00:00Z',owners:[{owner_user_id:owner,clients,visits:reminders.map(r=>({id:r.visit_id,owner_user_id:owner,client_id:r.client_id})),ai_reminders:reminders}]}
}

test('Phase 2B approves exactly six follow-ups/two reminders and preserves excluded evidence',()=>{
  const s=fixture(),before=JSON.stringify(s),p=approvePhase2B(s,structuredClone(s))
  assert.equal(p.rows.filter(r=>r.status==='proposed').length,8)
  assert.equal(p.inventory.proposed,8);assert.equal(p.inventory.excluded,1);assert.equal(p.source_inventory.eligible,9)
  const excluded=p.rows.find(r=>r.legacy_id===EXCLUDED_ID)
  assert.equal(excluded.status,'excluded');assert.match(excluded.exclusion_reason,/User confirmed/)
  assert.equal(excluded.legacy_source.row.next_action,'PROD_SMOKE_VERIFY_TEMP')
  assert.equal(JSON.stringify(s),before)
})
test('fresh capture timestamp is allowed; any source change stops approval',()=>{
  const baseline=fixture(),fresh=structuredClone(baseline);fresh.captured_at='2026-09-26T13:00:00Z'
  assert.equal(approvePhase2B(baseline,fresh).approval.actions,8)
  fresh.owners[0].clients[0].next_followup='2026-09-28'
  assert.throws(()=>approvePhase2B(baseline,fresh),/STOP: legacy source snapshot changed/)
})
test('missing/changed test artifact cannot be excluded',()=>{
  for(const mutation of [s=>s.owners[0].clients.pop(),s=>s.owners[0].clients.at(-1).next_action='Actual work',s=>s.owners[0].clients.at(-1).business_name='Other']){
    const s=fixture();mutation(s);assert.throws(()=>approvePhase2B(s,s))
  }
})
test('changed eligibility, ownership or relationships fails closed',()=>{
  for(const mutation of [s=>s.owners[0].clients[0].next_followup=null,s=>s.owners[0].ai_reminders[0].owner_user_id='wrong',s=>s.owners[0].visits[0].client_id=id('3',3)]){
    const s=fixture();mutation(s);assert.throws(()=>approvePhase2B(s,s),/STOP/)
  }
})
test('wrong project fails before generating an import',()=>{
  const s=fixture();s.project_id='other';assert.throws(()=>approvePhase2B(s,s),/Wrong reference project/)
})
test('conservative date-only, prose time and separate duplicate candidates remain intact',()=>{
  const s=fixture(),p=approvePhase2B(s,s)
  assert.equal(p.rows.filter(r=>r.category==='date_only'&&r.proposed_action.description==='Follow-up — details not recorded').length,5)
  assert.equal(p.rows.find(r=>r.source==='ai_reminders'&&r.legacy_id===id('4',2)).proposed_action.due_time,null)
  assert.equal(p.rows.filter(r=>r.status==='proposed'&&r.client_id===id('3',1)).length,2)
  assert.ok(p.rows.filter(r=>r.source==='ai_reminders').every(r=>r.proposed_action.state==='legacy_closed'&&r.proposed_action.closed_at===null&&r.proposed_action.closed_by===null))
})
test('deterministic action, event and request identifiers survive exact reapproval',()=>{
  const s=fixture();assert.deepEqual(withImportIdentities(approvePhase2B(s,s)),withImportIdentities(approvePhase2B(s,s)))
})

test('production logic rehearses locally: exact retry, source conflict rollback and no source mutations',()=>{
  const root=mkdtempSync('/tmp/eye-phase2b-test-'),socket=join(root,'socket'),data=join(root,'data'),port=''+(59000+Math.floor(Math.random()*500)),repo=resolve('.')
  mkdirSync(socket);let started=false
  function run(bin,args,input){const r=spawnSync(bin,args,{input,encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});if(r.error||r.status!==0)throw new Error(r.error?.message??r.stderr);return r.stdout}
  const quote=v=>v===null?'NULL':`'${String(v).replaceAll("'","''")}'`
  const j=v=>`${quote(JSON.stringify(v))}::jsonb`
  try{
    run('initdb',['-D',data,'-A','trust','-U','postgres','--no-instructions'])
    run('pg_ctl',['-D',data,'-o',`-c listen_addresses= -c unix_socket_directories=${socket} -p ${port}`,'-l',join(root,'postgres.log'),'-w','start']);started=true
    const args=['-X','-v','ON_ERROR_STOP=1','-h',socket,'-p',port,'-U','postgres','-d','postgres']
    const sql=s=>run('psql',args,s),query=s=>JSON.parse(run('psql',[...args,'-q','-Atc',"SET TIME ZONE 'UTC';"+s]).trim())
    run('psql',[...args,'-f',join(repo,'test/fixtures/client-actions-bootstrap.sql')])
    for(const f of ['20260925221611_client_actions_phase1.sql','20260925221829_client_actions_auth_uid_privilege.sql','20260925222213_client_actions_identity_bridge.sql'])run('psql',[...args,'-f',join(repo,'supabase/migrations',f)])
    const s=fixture(),scope=s.owners[0]
    sql(`ALTER TABLE public.clients ADD COLUMN created_at timestamptz,ADD COLUMN updated_at timestamptz;
      ALTER TABLE public.ai_reminders ADD COLUMN owner_user_id uuid,ADD COLUMN client_id uuid,ADD COLUMN visit_id uuid,ADD COLUMN business_name text,ADD COLUMN description text,ADD COLUMN action_type text,ADD COLUMN due_date date,ADD COLUMN due_time time,ADD COLUMN priority text,ADD COLUMN is_sent boolean,ADD COLUMN is_dismissed boolean,ADD COLUMN created_at timestamptz,ADD COLUMN raw_trigger text;`)
    for(const c of scope.clients)sql(`INSERT INTO public.clients SELECT * FROM jsonb_populate_record(NULL::public.clients,${j(c)})`)
    for(const v of scope.visits)sql(`INSERT INTO public.visits SELECT * FROM jsonb_populate_record(NULL::public.visits,${j(v)})`)
    for(const r of scope.ai_reminders)sql(`INSERT INTO public.ai_reminders SELECT * FROM jsonb_populate_record(NULL::public.ai_reminders,${j(r)})`)
    const fingerprint=()=>query(`SELECT ${fingerprintExpression}`),legacyBefore=fingerprint()
    const canonical=()=>query(`SELECT jsonb_build_object('actions',(SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.client_actions a),'events',(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.client_action_events e))`)
    const plan=withImportIdentities(approvePhase2B(s,s)),statement=productionImportSQL(plan,legacyBefore)
    const before=Date.now();sql(statement);const first=canonical()
    assert.equal(first.actions.length,8);assert.equal(first.events.length,8)
    assert.ok(first.actions.every(a=>Date.parse(a.created_at)>=before&&a.closed_at===null&&a.closed_by===null))
    assert.ok(first.events.every(e=>e.actor_user_id===null&&e.event_type==='imported'))
    assert.ok(!first.actions.some(a=>a.client_id===EXCLUDED_ID))
    sql(statement);assert.deepEqual(canonical(),first);assert.deepEqual(fingerprint(),legacyBefore)
    const conflict=structuredClone(plan);conflict.rows.find(r=>r.status==='proposed').legacy_source.row.description='Conflicting evidence'
    assert.throws(()=>sql(productionImportSQL(conflict,legacyBefore)),/source evidence changed/)
    assert.deepEqual(canonical(),first)
    sql(`UPDATE public.clients SET next_action='Concurrent change' WHERE id=${quote(scope.clients[0].id)}::uuid`)
    assert.throws(()=>sql(statement),/full legacy source drift/);assert.deepEqual(canonical(),first)
    sql(`UPDATE public.clients SET next_action=NULL WHERE id=${quote(scope.clients[0].id)}::uuid`)
    assert.deepEqual(fingerprint(),legacyBefore)
    sql(`UPDATE public.client_action_events SET legacy_source='{}' WHERE id=${quote(first.events[0].id)}::uuid`)
    assert.throws(()=>sql(statement),/Import event\/evidence conflict/)
    assert.deepEqual(canonical().actions,first.actions)
  }finally{if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);rmSync(root,{recursive:true,force:true})}
})
