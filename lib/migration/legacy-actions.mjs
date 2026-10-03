import { createHash } from 'node:crypto'
import { resolveSchedulingTimeZone, SCHEDULING_TIME_ZONE } from '../config/scheduling.ts'

// Offline conversion only. This module has no database or network dependency.
export const stableJSON = value => JSON.stringify(sortJSON(value))
function sortJSON(value) {
  if (Array.isArray(value)) return value.map(sortJSON)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, sortJSON(value[k])]))
  return value
}
export const digest = value => createHash('sha256').update(stableJSON(value)).digest('hex')
export function stableId(key) {
  const h = createHash('sha256').update(`eye:legacy-actions:v1:${key}`).digest('hex').split('')
  h[12] = '8'; h[16] = '8' // UUIDv8, domain-separated deterministic hash.
  const s = h.join('').slice(0, 32)
  return `${s.slice(0,8)}-${s.slice(8,12)}-${s.slice(12,16)}-${s.slice(16,20)}-${s.slice(20)}`
}
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v)
const present = v => v !== null && v !== undefined
const text = v => typeof v === 'string' && v.trim().length > 0
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0,4) === '0000') return false
  const d = new Date(`${value}T00:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0,10) === value
}
const validTime = v => typeof v === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/.test(v)

// Enumerate applicable offsets, then verify the wall clock round trip. Never pick
// an offset for a DST gap or fold; those require explicit reconciliation.
export function wallClockMatches(date, time, zone) {
  const wall = Date.parse(`${date}T${time.slice(0,5)}:00Z`)
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23' })
  const local = ms => {
    const p = Object.fromEntries(fmt.formatToParts(ms).map(x => [x.type,x.value]))
    return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}`
  }
  const offsets = new Set()
  for (let h=-36; h<=36; h+=3) {
    const probe = wall + h*3600000
    offsets.add(Date.parse(local(probe)+'Z')-probe)
  }
  return [...offsets].filter(offset => local(wall-offset) === `${date}T${time.slice(0,5)}:00`).length
}

export function planLegacyActions(snapshot, { timeZone } = {}) {
  const zone = resolveSchedulingTimeZone(timeZone ?? SCHEDULING_TIME_ZONE)
  if (!Array.isArray(snapshot.owners) || typeof snapshot.captured_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(snapshot.captured_at) || !Number.isFinite(Date.parse(snapshot.captured_at))) throw new Error('Invalid snapshot envelope')
  const owners = new Set()
  const clients = new Map(), visits = new Map(), seen = new Set()
  for (const scope of snapshot.owners) {
    if (!uuid(scope.owner_user_id) || owners.has(scope.owner_user_id)) throw new Error('Invalid or duplicate snapshot owner')
    owners.add(scope.owner_user_id)
    for (const table of ['clients','visits','ai_reminders']) {
      if (!Array.isArray(scope[table])) throw new Error(`Missing snapshot table: ${table}`)
      for (const row of scope[table]) {
        const identity = `${table}:${row.id}`
        if (seen.has(identity)) throw new Error(`Duplicate snapshot source identity: ${identity}`)
        seen.add(identity)
        if (table === 'clients') clients.set(row.id, row)
        if (table === 'visits') visits.set(row.id, row)
      }
    }
  }
  const rows = [], relationships = []
  const linkReasons = (row, owner, clientId, visitId) => {
    const errors = []
    if (!uuid(row.id)) errors.push('invalid_source_id')
    if (!uuid(row.owner_user_id) || row.owner_user_id !== owner) errors.push('invalid_ownership')
    if (present(clientId)) {
      const c = clients.get(clientId)
      if (!uuid(clientId) || !c) errors.push('missing_client')
      else if (c.owner_user_id !== owner) errors.push('cross_owner_client')
    }
    if (present(visitId)) {
      const v = visits.get(visitId)
      if (!uuid(visitId) || !v) errors.push('missing_visit')
      else {
        if (v.owner_user_id !== owner) errors.push('cross_owner_visit')
        if (present(clientId) && v.client_id !== clientId) errors.push('visit_client_mismatch')
        if (present(v.client_id)) {
          const c = clients.get(v.client_id)
          if (!c) errors.push('visit_missing_client')
          else if (c.owner_user_id !== owner) errors.push('visit_cross_owner_client')
        }
      }
    }
    return errors
  }
  for (const scope of snapshot.owners) {
    for (const v of scope.visits) {
      const reasons = linkReasons(v, scope.owner_user_id, v.client_id, null)
      if (reasons.length) relationships.push({ source:'visits', legacy_id:v.id, owner_user_id:scope.owner_user_id, reasons })
    }
    for (const source of ['clients','ai_reminders']) for (const legacy of scope[source]) {
      const owner = scope.owner_user_id
      const client = source === 'clients'
      const hasText = client ? text(legacy.next_action) : true
      const date = (client ? legacy.next_followup : legacy.due_date) ?? null
      const time = client ? null : legacy.due_time ?? null
      const eligible = !client || hasText || present(date) || (present(legacy.next_action) && typeof legacy.next_action !== 'string')
      const clientId = client ? legacy.id : legacy.client_id ?? null
      const visitId = client ? null : legacy.visit_id ?? null
      const reasons = linkReasons(legacy, owner, clientId, visitId)
      const review = []
      const key = eligible ? (client ? `legacy:clients:${legacy.id}:followup` : `legacy:ai_reminders:${legacy.id}`) : null
      const category = client ? (hasText ? (present(date) ? 'text_and_date' : 'text_only') : (present(date) ? 'date_only' : 'neither')) : (legacy.is_dismissed === true ? 'dismissed' : legacy.is_dismissed === false ? 'active' : 'null_dismissal')
      if (client && present(legacy.next_action) && typeof legacy.next_action !== 'string') reasons.push('invalid_followup_text')
      if (eligible && !text(legacy.business_name)) reasons.push('empty_client_name')
      for (const field of ['business_name','next_action','description','raw_trigger']) {
        if (typeof legacy[field] === 'string' && legacy[field].includes('\u0000')) reasons.push(`invalid_nul_${field}`)
      }
      if (present(date) && !validDate(date)) reasons.push('invalid_date')
      if (present(time) && !validTime(time)) reasons.push('invalid_time')
      if (present(time) && !present(date)) reasons.push('time_without_date')
      if (validDate(date) && validTime(time)) {
        const matches = wallClockMatches(date, time, zone)
        if (matches === 0) reasons.push('nonexistent_local_time')
        if (matches > 1) reasons.push('ambiguous_local_time')
      }
      if (!client) {
        if (!text(legacy.description)) reasons.push('empty_description')
        if (present(legacy.raw_trigger) && typeof legacy.raw_trigger !== 'string') reasons.push('invalid_source_excerpt')
        if (present(legacy.action_type) && !['call','meeting','deliver','follow_up'].includes(legacy.action_type)) reasons.push('invalid_action_type')
        if (present(legacy.priority) && !['high','medium','low'].includes(legacy.priority)) reasons.push('invalid_priority')
        if (present(legacy.is_dismissed) && typeof legacy.is_dismissed !== 'boolean') reasons.push('invalid_dismissal_state')
        if (!present(legacy.action_type)) review.push('null_type_default_follow_up')
        if (!present(legacy.priority)) review.push('null_priority_default_medium')
        if (!present(legacy.is_dismissed)) review.push('null_dismissal_open_unresolved')
        if (!present(clientId)) review.push('unresolved_client_link')
        if (!present(time) && /\b\d{1,2}:\d{2}\b/.test(legacy.description ?? '')) review.push('time_in_text_not_structured')
      }
      if (category === 'date_only') review.push('details_not_recorded')
      if (client && /PROD_SMOKE|SMOKE_VERIFY|TEMP/.test(legacy.next_action ?? '')) review.push('possible_test_artifact')
      const row = { source, legacy_id:legacy.id, owner_user_id:owner, client_id:clientId,
        category, eligible, creation_key:key, status: reasons.length ? 'blocked' : eligible ? 'proposed' : 'no_action',
        reasons:[...new Set(reasons)].sort(), review:[...new Set(review)].sort(), duplicate_candidates:[],
        proposed_action:null, legacy_source:{ table:source, row:structuredClone(legacy) } }
      if (eligible) row.proposed_action = {
        id:client ? stableId(`${owner}:${key}`) : legacy.id,
        owner_user_id:owner, client_id:clientId, client_name_snapshot:legacy.business_name,
        description:client ? (hasText ? legacy.next_action : 'Follow-up — details not recorded') : legacy.description,
        action_type:client ? 'follow_up' : legacy.action_type ?? 'follow_up', due_date:date, due_time:time,
        priority:client ? 'medium' : legacy.priority ?? 'medium', state:!client && legacy.is_dismissed === true ? 'legacy_closed' : 'open',
        origin:'legacy', source_visit_id:visitId, source_excerpt:client ? null : legacy.raw_trigger ?? null,
        creation_key:key, version:1, created_at:snapshot.captured_at, updated_at:snapshot.captured_at,
        closed_at:null, closed_by:null, closure_note:null, resolution_visit_id:null, replaces_action_id:null,
      }
      rows.push(row)
    }
  }
  rows.sort((a,b) => `${a.owner_user_id}:${a.source}:${a.legacy_id}`.localeCompare(`${b.owner_user_id}:${b.source}:${b.legacy_id}`))
  const proposals = rows.filter(r => r.eligible)
  const norm = s => String(s).normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()
  const duplicates = []
  for (let i=0;i<proposals.length;i++) for (let j=i+1;j<proposals.length;j++) {
    const a=proposals[i], b=proposals[j], x=a.proposed_action, y=b.proposed_action
    if (a.owner_user_id !== b.owner_user_id || !a.client_id || a.client_id !== b.client_id) continue
    const exact = norm(x.description) === norm(y.description)
    const tokensA=new Set(norm(x.description).split(' ')), tokensB=new Set(norm(y.description).split(' '))
    const overlap=[...tokensA].filter(t=>tokensB.has(t)).length/Math.max(tokensA.size,tokensB.size)
    const incomplete = a.category === 'date_only' || b.category === 'date_only'
    if (!exact && !incomplete && !(overlap>=0.6 && x.due_date === y.due_date)) continue
    const reason=exact ? 'same_client_similar_description' : incomplete ? 'same_client_incomplete_details' : 'same_client_similar_text_and_date'
    a.duplicate_candidates.push(b.creation_key); b.duplicate_candidates.push(a.creation_key)
    duplicates.push({ owner_user_id:a.owner_user_id, client_id:a.client_id, keys:[a.creation_key,b.creation_key], reason })
  }
  const ids = new Map()
  for (const r of proposals) {
    const id=r.proposed_action.id
    if (ids.has(id)) for (const q of [r,ids.get(id)]) { q.status='blocked'; q.reasons.push('action_id_collision') }
    else ids.set(id,r)
  }
  const counts = {}
  for (const r of rows) counts[`${r.source}:${r.category}`]=(counts[`${r.source}:${r.category}`]??0)+1
  return { version:1, time_zone:zone, captured_at:snapshot.captured_at, source_sha256:digest(snapshot),
    rows, duplicate_candidates:duplicates, relationship_anomalies:relationships,
    inventory:{ counts, source_records:rows.length, eligible:proposals.length, proposed:rows.filter(r=>r.status==='proposed').length, blocked:rows.filter(r=>r.status==='blocked').length, no_action:rows.filter(r=>r.status==='no_action').length,
      owners:snapshot.owners.map(s=>({ owner_user_id:s.owner_user_id, clients:s.clients.length, visits:s.visits.length, reminders:s.ai_reminders.length, eligible:rows.filter(r=>r.owner_user_id===s.owner_user_id&&r.eligible).length })) } }
}

// An in-memory sink for focused tests; local PostgreSQL rehearsal verifies the
// actual Phase 1 unique constraints and action/event transaction separately.
export function rehearseInMemory(plan, store = new Map()) {
  const outcomes = []
  for (const r of plan.rows) {
    if (r.status !== 'proposed') { outcomes.push({ key:r.creation_key, status:r.status }); continue }
    const key = `${r.owner_user_id}:${r.creation_key}`
    const prior=store.get(key)
    if (prior) {
      const material = ({ created_at, updated_at, ...action }) => action
      outcomes.push({ key, status:stableJSON(prior.legacy_source) === stableJSON(r.legacy_source) && stableJSON(material(prior.action)) === stableJSON(material(r.proposed_action)) ? 'already_present' : 'source_or_action_conflict' })
    } else if ([...store.values()].some(v=>v.action.id===r.proposed_action.id)) outcomes.push({ key,status:'action_id_collision' })
    else {
      store.set(key,{ action:structuredClone(r.proposed_action), legacy_source:structuredClone(r.legacy_source), event_type:'imported', actor_user_id:null })
      outcomes.push({ key,status:'created' })
    }
  }
  return { store, outcomes }
}
