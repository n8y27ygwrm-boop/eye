import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { planLegacyActions, stableJSON, stableId, digest, validDate } from '../lib/migration/legacy-actions.mjs'

const repo=resolve(fileURLToPath(new URL('..',import.meta.url)))
const literal = v => v === null ? 'NULL' : `'${String(v).replaceAll("'","''")}'`
function json(value) { return `${literal(JSON.stringify(value))}::jsonb` }
function run(binary,args,input) {
  const r=spawnSync(binary,args,{ input,encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024 })
  if (r.error || r.status!==0) throw new Error(`${binary} failed: ${r.error?.message??r.stderr}`)
  return r.stdout
}

// Generates import SQL for a disposable local database. Never installed as a
// public RPC or wired to the application. A key conflict verifies full evidence
// AND the authoritative stored action; it cannot hide changed source data.
export function importSQL(plan) {
  return `BEGIN; SET LOCAL standard_conforming_strings=on;\n`+plan.rows.filter(r=>r.status==='proposed').map(r=>{
    const a=r.proposed_action, request=stableId(`${a.owner_user_id}:${a.creation_key}:import`)
    const cols=Object.keys(a)
    const body = `DECLARE existing public.client_actions; evidence jsonb; expected public.client_actions; inserted_id uuid; BEGIN
      SELECT * INTO expected FROM jsonb_populate_record(NULL::public.client_actions,${json(a)});
      SELECT * INTO existing FROM public.client_actions WHERE owner_user_id=${literal(a.owner_user_id)}::uuid AND creation_key=${literal(a.creation_key)};
      IF FOUND THEN
        expected.created_at := existing.created_at;
        expected.updated_at := existing.updated_at;
        SELECT legacy_source INTO evidence FROM public.client_action_events WHERE action_id=existing.id AND action_version=1 AND event_type='imported' AND channel='migration';
        IF evidence IS DISTINCT FROM ${json(r.legacy_source)} OR to_jsonb(existing) IS DISTINCT FROM to_jsonb(expected) THEN
          RAISE EXCEPTION 'Source or canonical action conflict for creation key %',${literal(a.creation_key)};
        END IF;
      ELSE
        INSERT INTO public.client_actions (${cols.map(c=>`"${c}"`).join(',')})
          SELECT ${cols.map(c=>`expected."${c}"`).join(',')} RETURNING id INTO inserted_id;
        INSERT INTO public.client_action_events (id,owner_user_id,action_id,action_version,request_id,request_body,result,event_type,actor_user_id,channel,related_visit_id,before,after,legacy_source,recorded_at)
          VALUES (${literal(stableId(`${a.owner_user_id}:${a.creation_key}:event`))}::uuid,${literal(a.owner_user_id)}::uuid,inserted_id,1,${literal(request)}::uuid,
            ${json({ operation:'legacy_import', creation_key:a.creation_key,source_sha256:digest(r.legacy_source) })},to_jsonb(expected),'imported',NULL,'migration',${literal(a.source_visit_id)}::uuid,NULL,to_jsonb(expected),${json(r.legacy_source)},${literal(a.created_at)}::timestamptz);
      END IF;
    END;`
    return `DO ${literal(body)};`
  }).join('\n')+'\nCOMMIT;'
}

export function dryRun(snapshot,{ timeZone, outputDir }={}) {
  const original=stableJSON(snapshot),plan=planLegacyActions(snapshot,{timeZone})
  const root=mkdtempSync('/tmp/eye-legacy-rehearsal-'),socket=join(root,'socket'),data=join(root,'data')
  const port=String(56000+Math.floor(Math.random()*1000))
  mkdirSync(socket)
  let started=false
  try {
    // Socket-only PostgreSQL started here. No URL, host, credentials, connection
    // flags or environment-provided database target are accepted.
    run('initdb',['-D',data,'-A','trust','-U','postgres','--no-instructions'])
    run('pg_ctl',['-D',data,'-o',`-c listen_addresses= -c unix_socket_directories=${socket} -p ${port}`,'-l',join(root,'postgres.log'),'-w','start'])
    started=true
    const args=['-X','-v','ON_ERROR_STOP=1','-h',socket,'-p',port,'-U','postgres','-d','postgres']
    const sql = s => run('psql',args,s)
    run('psql',[...args,'-f',join(repo,'test/fixtures/client-actions-bootstrap.sql')])
    for(const file of ['20260925221611_client_actions_phase1.sql','20260925221829_client_actions_auth_uid_privilege.sql','20260925222213_client_actions_identity_bridge.sql']) run('psql',[...args,'-f',join(repo,'supabase/migrations',file)])
    const admin=[...args];admin[admin.indexOf('-U')+1]='eye_migration_admin'
    const adminSQL=s=>run('psql',admin,s)
    // Populate the legacy fixture only. Keep all original JSON in a separate
    // snapshot table so a fingerprint proves that the whole source survived.
    let seed=`BEGIN; SET LOCAL standard_conforming_strings=on;
      CREATE TABLE public.rehearsal_source (owner_user_id text, source text, legacy_id text, evidence jsonb);
      ALTER TABLE public.ai_reminders ADD COLUMN owner_user_id uuid, ADD COLUMN client_id uuid,
        ADD COLUMN visit_id uuid, ADD COLUMN business_name text, ADD COLUMN description text,
        ADD COLUMN action_type text, ADD COLUMN due_date date, ADD COLUMN due_time time,
        ADD COLUMN priority text, ADD COLUMN is_sent boolean, ADD COLUMN is_dismissed boolean,
        ADD COLUMN raw_trigger text, ADD COLUMN created_at timestamptz;\n`
    for(const scope of snapshot.owners){
      seed+=`INSERT INTO auth.users(id) VALUES (${literal(scope.owner_user_id)}::uuid) ON CONFLICT DO NOTHING;\n`
      for(const c of scope.clients) if(c.owner_user_id===scope.owner_user_id && typeof c.business_name==='string' && /^[0-9a-f-]{36}$/.test(c.id)) seed+=`INSERT INTO public.clients(id,owner_user_id,business_name,next_action,next_followup) VALUES (${literal(c.id)}::uuid,${literal(c.owner_user_id)}::uuid,${literal(c.business_name)},${literal(typeof c.next_action==='string'?c.next_action:null)},${literal(validDate(c.next_followup)?c.next_followup:null)}::date);\n`
    }
    for(const scope of snapshot.owners){
      for(const v of scope.visits) if(v.owner_user_id===scope.owner_user_id && /^[0-9a-f-]{36}$/.test(v.id) && (!v.client_id || snapshot.owners.some(s=>s.clients.some(c=>c.id===v.client_id)))) seed+=`INSERT INTO public.visits(id,owner_user_id,client_id) VALUES (${literal(v.id)}::uuid,${literal(v.owner_user_id)}::uuid,${literal(v.client_id??null)}::uuid);\n`
      for(const source of ['clients','visits','ai_reminders']) for(const r of scope[source]) seed+=`INSERT INTO public.rehearsal_source VALUES (${literal(scope.owner_user_id)},${literal(source)},${literal(r.id)},${json(r)});\n`
      for(const r of scope.ai_reminders) if(plan.rows.some(p=>p.source==='ai_reminders'&&p.legacy_id===r.id&&p.status==='proposed')) seed+=`INSERT INTO public.ai_reminders SELECT * FROM jsonb_populate_record(NULL::public.ai_reminders,${json(r)});\n`
    }
    adminSQL(seed+'COMMIT;')
    const fingerprint=()=>run('psql',[...admin,'-Atc',`SELECT md5(coalesce(string_agg(evidence::text,E'\n' ORDER BY owner_user_id,source,legacy_id),'')) FROM public.rehearsal_source`]).trim()
    const legacyFingerprint=()=>run('psql',[...admin,'-Atc',`SELECT md5((SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY id),'[]') FROM public.clients c)::text || (SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY id),'[]') FROM public.visits v)::text || (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY id),'[]') FROM public.ai_reminders r)::text)`]).trim()
    const sourceBefore=fingerprint(),legacyBefore=legacyFingerprint()
    const canonical=()=>JSON.parse(run('psql',[...admin,'-Atc',`SELECT jsonb_build_object('actions',coalesce((SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM public.client_actions a),'[]'),'events',coalesce((SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM public.client_action_events e),'[]'))`]).trim())
    const before=canonical()
    adminSQL(importSQL(plan))
    const first=canonical()
    adminSQL(importSQL(plan))
    const second=canonical()
    assert.deepEqual(second,first,'Second import changed canonical rows/events')
    const recaptured=structuredClone(snapshot)
    recaptured.captured_at=new Date(Date.parse(snapshot.captured_at)+86400000).toISOString()
    adminSQL(importSQL(planLegacyActions(recaptured,{timeZone})))
    assert.deepEqual(canonical(),first,'A new capture time changed existing imports')
    assert.equal(first.actions.length-before.actions.length,plan.inventory.proposed)
    assert.equal(first.events.length-before.events.length,plan.inventory.proposed)
    assert.equal(fingerprint(),sourceBefore,'Original evidence changed')
    assert.equal(legacyFingerprint(),legacyBefore,'Legacy fixture changed')
    assert.equal(stableJSON(snapshot),original,'Input snapshot mutated')
    // Reject changed source evidence and prove transaction rollback.
    const ready=plan.rows.find(r=>r.status==='proposed')
    let conflictRejected=null
    if(ready){
      const changed=structuredClone(plan),r=changed.rows.find(r=>r.creation_key===ready.creation_key)
      r.legacy_source.row.__changed_for_rehearsal=true
      const provisional=structuredClone(ready)
      provisional.creation_key='rehearsal:rollback-provisional'
      provisional.proposed_action.creation_key=provisional.creation_key
      provisional.proposed_action.id=stableId(provisional.creation_key)
      changed.rows.unshift(provisional)
      assert.throws(()=>adminSQL(importSQL(changed)),/Source or canonical action conflict/)
      assert.deepEqual(canonical(),first,'Conflict was not rolled back')
      conflictRejected=true
    }
    const proof={ target:'disposable_socket_only_local_postgresql', source_sha256:plan.source_sha256,
      first_run:{ created_actions:first.actions.length-before.actions.length,created_events:first.events.length-before.events.length },
      second_run:{ created_actions:0,created_events:0,identical_rows_and_events:true },
      source_evidence_unchanged:true,legacy_fixture_unchanged:true,input_unchanged:true,conflict_rejected:conflictRejected,
      changed_capture_time_idempotent:true,partial_import_rolled_back:conflictRejected,
      canonical_sha256:digest(first), rows:plan.rows.map(r=>({ source:r.source,legacy_id:r.legacy_id,creation_key:r.creation_key,first_run:r.status==='proposed'?'created':r.status,second_run:r.status==='proposed'?'already_present':r.status })) }
    if(outputDir){
      mkdirSync(outputDir,{recursive:true,mode:0o700});chmodSync(outputDir,0o700)
      for(const [file,value] of [['plan.json',plan],['rehearsal-proof.json',proof],['local-canonical.json',first]]){
        const path=join(outputDir,file);writeFileSync(path,JSON.stringify(value,null,2)+'\n',{mode:0o600});chmodSync(path,0o600)
      }
      const cell=v=>`"${String(v??'').replaceAll('"','""')}"`
      const columns=['legacy_source','legacy_id','owner_user_id','client_id','proposed_action_id','description','due_date','due_time','proposed_state','creation_key','migration_status','first_run','second_run','anomaly_review_reason']
      const csv=[columns.map(cell).join(','),...plan.rows.map(r=>[r.source,r.legacy_id,r.owner_user_id,r.client_id,r.proposed_action?.id,r.proposed_action?.description,r.proposed_action?.due_date,r.proposed_action?.due_time,r.proposed_action?.state,r.creation_key,r.status,r.status==='proposed'?'created_locally':r.status,r.status==='proposed'?'already_present':r.status,[...r.reasons,...r.review,...r.duplicate_candidates.map(k=>`duplicate_candidate:${k}`)].join('; ')].map(cell).join(','))].join('\n')+'\n'
      writeFileSync(join(outputDir,'reconciliation.csv'),csv,{mode:0o600})
    }
    return { plan,proof }
  } finally {
    if(started) run('pg_ctl',['-D',data,'-m','immediate','-w','stop'])
    rmSync(root,{recursive:true,force:true})
  }
}

if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2)
  if(args.length!==2 || args.some(a=>a.startsWith('-'))){
    console.error('Usage: node scripts/legacy-actions-dry-run.mjs SNAPSHOT.json OUTPUT_DIRECTORY (offline only)');process.exitCode=1
  }else{
    try{ const {plan,proof}=dryRun(JSON.parse(readFileSync(args[0],'utf8')),{outputDir:args[1]});const {rows,...summary}=proof;console.log(JSON.stringify({inventory:plan.inventory,proof:summary},null,2)) }
    catch(error){console.error(error.message);process.exitCode=1}
  }
}
