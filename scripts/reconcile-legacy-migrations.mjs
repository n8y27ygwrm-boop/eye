import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync } from 'node:fs'
import { resolve,join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo=resolve(fileURLToPath(new URL('..',import.meta.url)))
const versions=['20260919123500_add_clients_next_action.sql','20260920183000_add_ai_reminders_due_time.sql','20260920193000_user_data_isolation_phase1_expand.sql','20260920194000_user_data_isolation_phase2_enforce.sql']
const run=(bin,args,input)=>{
  const r=spawnSync(bin,args,{input,encoding:'utf8',timeout:60000})
  if(r.error||r.status!==0)throw new Error(`${bin}: ${r.error?.message??r.stderr}`)
  return r.stdout
}
export function reconcile(schema,columns){
  const root=mkdtempSync('/tmp/eye-migration-reconcile-'),data=join(root,'data'),socket=join(root,'socket'),port=String(58000+Math.floor(Math.random()*1000))
  mkdirSync(socket);let started=false
  try{
    run('initdb',['-D',data,'-A','trust','-U','postgres','--no-instructions'])
    run('pg_ctl',['-D',data,'-o',`-c listen_addresses= -c unix_socket_directories=${socket} -p ${port}`,'-l',join(root,'postgres.log'),'-w','start']);started=true
    const args=['-X','-v','ON_ERROR_STOP=1','-h',socket,'-p',port,'-U','postgres','-d','postgres']
    const sql=s=>run('psql',args,s)
    sql(`CREATE ROLE authenticated NOLOGIN; CREATE SCHEMA auth;
      CREATE TABLE auth.users(id uuid PRIMARY KEY);
      INSERT INTO auth.users VALUES ('a1026b88-6a25-4548-a055-cf12ea436bf8');
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS 'SELECT NULL::uuid';
      CREATE TABLE public.clients(id uuid PRIMARY KEY,business_name text,next_followup date);
      CREATE TABLE public.visits(id uuid PRIMARY KEY,client_id uuid,visit_date date);
      CREATE TABLE public.ai_reminders(id uuid PRIMARY KEY,is_dismissed boolean);
      INSERT INTO public.clients VALUES ('30000000-0000-0000-0000-000000000001','Fixture',NULL);
      INSERT INTO public.visits VALUES ('50000000-0000-0000-0000-000000000001','30000000-0000-0000-0000-000000000001',CURRENT_DATE);
      INSERT INTO public.ai_reminders VALUES ('40000000-0000-0000-0000-000000000001',false);`)
    for(const file of versions)run('psql',[...args,'-f',join(repo,'supabase/migrations',file)])
    const catalog=JSON.parse(run('psql',[...args,'-Atc',`SELECT jsonb_build_object(
      'columns',(SELECT jsonb_agg(jsonb_build_object('table',table_name,'column',column_name,'type',data_type,'nullable',is_nullable,'default',column_default)) FROM information_schema.columns WHERE table_schema='public' AND (column_name='owner_user_id' OR (table_name='clients' AND column_name='next_action') OR (table_name='ai_reminders' AND column_name='due_time'))),
      'constraints',(SELECT jsonb_agg(jsonb_build_object('table',c.relname,'name',p.conname,'validated',p.convalidated,'definition',pg_get_constraintdef(p.oid))) FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid WHERE p.conname LIKE '%owner_user_id_fkey'),
      'indexes',(SELECT jsonb_agg(to_jsonb(i)) FROM pg_indexes i WHERE schemaname='public' AND indexname LIKE 'idx_%'),
      'policies',(SELECT jsonb_agg(to_jsonb(p)) FROM pg_policies p WHERE schemaname='public'),
      'rls',(SELECT jsonb_agg(jsonb_build_object('table',relname,'enabled',relrowsecurity,'forced',relforcerowsecurity)) FROM pg_class WHERE oid IN ('public.clients'::regclass,'public.visits'::regclass,'public.ai_reminders'::regclass)),
      'backfill_fixture',(SELECT owner_user_id FROM public.clients LIMIT 1))`]).trim())
    const comparisons=[]
    const compare=(kind,expected,actual)=>{
      const equal=JSON.stringify(expected)===JSON.stringify(actual)
      comparisons.push({kind,expected,actual,match:equal})
      assert.deepEqual(actual,expected,`Live ${kind} differs from replayed migration`)
    }
    for(const e of catalog.columns) compare(`column:${e.table}.${e.column}`,e,columns.columns.find(a=>a.table===e.table&&a.column===e.column))
    for(const e of catalog.constraints) compare(`constraint:${e.name}`,e,schema.constraints.find(a=>a.table===e.table&&a.name===e.name))
    for(const e of catalog.indexes){
      const a=schema.indexes.find(a=>a.indexname===e.indexname&&a.tablename===e.tablename)
      compare(`index:${e.indexname}`,e.indexdef,a?.indexdef)
    }
    for(const e of catalog.policies){
      const a=schema.policies.find(a=>a.policyname===e.policyname&&a.tablename===e.tablename)
      compare(`policy:${e.policyname}`,e,a)
    }
    for(const e of catalog.rls)compare(`rls:${e.table}`,e,schema.rls.find(a=>a.table===e.table))
    assert.equal(catalog.backfill_fixture,'a1026b88-6a25-4548-a055-cf12ea436bf8')
    assert.ok(Object.values(schema.null_owners).every(n=>n===0),'Live null owners remain')
    const extras=schema.policies.filter(a=>!catalog.policies.some(e=>e.policyname===a.policyname))
    assert.deepEqual(extras.map(p=>p.policyname).sort(),['clients_eye_action_executor_read','visits_eye_action_executor_read'])
    assert.ok(extras.every(p=>p.cmd==='SELECT'&&p.roles.length===1&&p.roles[0]==='eye_action_executor'))
    return { matched:true,comparisons,additional_phase1_policies:extras,
      versions:versions.map(file=>({file,effects:'present',history_check:'not performed by this offline catalog tool; see saved migration-history exports',provenance:'unknown; compatible with out-of-band application or removed historical metadata',
        superseded:file.includes('phase1_expand')?'nullable owner stage superseded by phase2_enforce':null})),
      historical_backfill:'Local replay proves what the SQL does, not who applied it in production. Live zero-null owners do not prove historical assignment provenance.',
      metadata_written_by_this_tool:false }
  }finally{
    if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop'])
    rmSync(root,{recursive:true,force:true})
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    if(process.argv.length!==5)throw new Error('Usage: node scripts/reconcile-legacy-migrations.mjs SCHEMA.json COLUMNS.json OUTPUT.json')
    const result=reconcile(JSON.parse(readFileSync(process.argv[2],'utf8')),JSON.parse(readFileSync(process.argv[3],'utf8')))
    writeFileSync(process.argv[4],JSON.stringify(result,null,2)+'\n',{mode:0o600})
    console.log(JSON.stringify({matched:result.matched,checks:result.comparisons.length,metadata_written_by_this_tool:false}))
  }catch(e){console.error(e.message);process.exitCode=1}
}
