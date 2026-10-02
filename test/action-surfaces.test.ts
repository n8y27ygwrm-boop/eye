import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { fixtureDatabase, QA_OWNER, QA_OTHER, qaId } from './fixtures/phase3b/database'
import { createLegacyActionService } from '../lib/actions/legacy'
import { ActionStateStore } from '../lib/actions/state'
import { deriveClientAttention } from '../lib/actions/attention'
import { validateVisitActionPlan, applyVisitActionPlan } from '../lib/actions/visit'
import { parseSurfaceCommand, canonicalSurfaceCommand } from '../lib/actions/surface'
import { prepareAIAction, confirmAIAction } from '../lib/ai/actions/runtime'
import { classifyConfirmationMessage } from '../lib/ai/confirmation'
import type { SurfaceCommand, ActionService } from '../lib/actions/types'

const requestId = '31afbca6-471c-8335-811a-bf8d5d0e9bc1'
const fields = { description: 'Updated follow-up', action_type: 'follow_up' as const, due_date: '2026-09-28', due_time: null, priority: 'medium' as const }
const base: SurfaceCommand = { operation: 'surface', intent: 'create', channel: 'client_detail', requestId, clientId: qaId(5), fields }
async function target(service: ActionService, id: string, intent: SurfaceCommand['intent']): Promise<SurfaceCommand> { const a = await service.byId(id); assert.ok(a); return { ...base, intent, actionId: id, clientId: a.client_id, expectedVersion: a.version, expectedRevision: a.revision } }

describe('Phase 3B LEGACY parity and no canonical access', () => {
  it('projects text/date, date-only, text-only, no follow-up, active and dismissed reminders truthfully', async () => {
    const db = fixtureDatabase(), service = createLegacyActionService(db.sb, QA_OWNER)
    const open = await service.listOpen()
    assert.equal(open.length, 5)
    assert.equal((await service.byId('client:' + qaId(2)))?.description, 'Follow-up — details not recorded')
    assert.equal((await service.byId('client:' + qaId(4)))?.due_date, null)
    assert.equal(await service.byId('client:' + qaId(5)), null)
    assert.equal(await service.byId('client:' + qaId(6)), null)
    const dismissed = await service.byId('reminder:' + qaId(21)); assert.ok(dismissed)
    assert.equal(dismissed.state, 'legacy_closed'); assert.equal(dismissed.closed_at, null); assert.equal(dismissed.closed_by, null); assert.equal(dismissed.version, null)
    assert.ok(db.trace.every(t => ['clients','ai_reminders'].includes(t.table))); assert.equal(db.changes(), 0)
  })
  for (const intent of ['edit', 'reschedule', 'complete'] as const) it(`shared ${intent} preserves supported legacy behavior`, async () => {
    const db = fixtureDatabase(), service = createLegacyActionService(db.sb, QA_OWNER)
    const c = await target(service, 'client:' + qaId(2), intent)
    await service.mutate(c)
    const row = db.tables.clients[1]
    if (intent === 'complete') { assert.equal(row.next_action, null); assert.equal(row.next_followup, null); assert.equal(await service.byId(c.actionId!), null) }
    if (intent === 'reschedule') { assert.equal(row.next_action, null); assert.equal(row.next_followup, fields.due_date) }
    if (intent === 'edit') { assert.equal(row.next_action, fields.description); assert.equal(row.next_followup, fields.due_date) }
    assert.equal(db.changes(), 1); assert.equal(db.tables.client_actions.length, 0); assert.equal(db.tables.client_action_events.length, 0)
  })
  it('creates only on empty client and fails stale/conflicting retries', async () => {
    const db = fixtureDatabase(), s = createLegacyActionService(db.sb, QA_OWNER)
    await s.mutate(base); await assert.rejects(s.mutate(base), { code: 'conflict' }); assert.equal(db.changes(), 1)
    const c = await target(s, 'client:' + qaId(1), 'edit'); db.tables.clients[0].next_action = 'Changed externally'
    await assert.rejects(s.mutate(c), { code: 'conflict' }); assert.equal(db.changes(), 1)
  })
  it('dismisses reminder into legacy_closed without completion facts', async () => {
    const db = fixtureDatabase(), s = createLegacyActionService(db.sb, QA_OWNER), c = await target(s, 'reminder:' + qaId(20), 'complete')
    const result = await s.mutate(c); assert.ok('state' in result); assert.equal(result.state, 'legacy_closed'); assert.equal(result.closed_at, null); assert.equal(result.closed_by, null)
    await assert.rejects(s.mutate(c), { code: 'conflict' }); assert.equal(db.changes(), 1)
  })
  it('both client and reminder CAS reject races occurring after validation', async () => {
    for (const [id, table, row, field] of [['client:' + qaId(1), 'clients', 0, 'next_action'], ['reminder:' + qaId(20), 'ai_reminders', 0, 'description']] as const) {
      const db = fixtureDatabase(), s = createLegacyActionService(db.sb, QA_OWNER), c = await target(s, id, 'complete')
      db.beforeWrite(() => { db.tables[table][row][field] = 'Concurrent change' })
      await assert.rejects(s.mutate(c), { code: 'conflict' }); assert.equal(db.changes(), 0)
    }
  })
  it('unsupported type/time/priority/replace/visit completion and cross-owner target perform zero writes', async () => {
    const db = fixtureDatabase(), s = createLegacyActionService(db.sb, QA_OWNER), c = await target(s, 'client:' + qaId(1), 'edit')
    for (const command of [{ ...c, intent: 'replace' }, { ...c, intent: 'cancel' }, { ...c, channel: 'visit', intent: 'complete' }, { ...c, fields: { ...fields, due_time: '10:00' } }, { ...c, fields: { ...fields, action_type: 'call' } }, { ...c, fields: { ...fields, priority: 'high' } }]) await assert.rejects(s.mutate(command as SurfaceCommand), { code: 'unsupported' })
    await assert.rejects(s.mutate({ ...c, clientId: qaId(5) }), { code: 'invalid' })
    await assert.rejects(s.mutate({ ...base, clientId: qaId(6) }), { code: 'not_found' }); assert.equal(db.changes(), 0)
  })
  it('malformed schedule and AI surface-channel bypass fail closed', () => {
    for (const c of [{ ...base, channel: 'ai_chat' }, { ...base, fields: { ...fields, due_date: '2026-02-31' } }, { ...base, fields: { ...fields, due_date: null, due_time: '10:00' } }]) assert.throws(() => parseSurfaceCommand(c), { code: 'invalid' })
    const translated = canonicalSurfaceCommand(base); assert.equal(translated.operation, 'create'); assert.ok('fields' in translated); assert.equal(translated.fields.creation_key, 'surface:' + requestId)
  })
})
describe('Phase 3B single store, attention and visit plans', () => {
  it('all four groups and client nearest attention share queue semantics', async () => {
    const db = fixtureDatabase(), s = new ActionStateStore(createLegacyActionService(db.sb, QA_OWNER)); await s.load()
    const groups = s.groups(new Date('2026-09-26T12:00:00Z'))!; assert.deepEqual(Object.values(groups).map(a => a.length), [1,2,1,1])
    const state = s.snapshot(); assert.equal(state.status, 'loaded'); if (state.status !== 'loaded') return
    for (const [n, group] of [[1,'overdue'],[2,'today'],[3,'upcoming'],[4,'unscheduled'],[5,null]] as const) assert.equal(deriveClientAttention(state.actions, qaId(n), new Date('2026-09-26T12:00:00Z')).group, group)
  })
  it('mounted subscribers observe refreshed mutation and account reset removes caches', async () => {
    const db = fixtureDatabase(), service = createLegacyActionService(db.sb, QA_OWNER), store = new ActionStateStore(service); await store.load(); await store.forClient(qaId(1))
    const views: string[][] = [[],[],[]]; const unsub = views.map(view => store.subscribe(() => { const state = store.snapshot(); view.push(state.status === 'loaded' ? String(state.actions.length) : state.status) }))
    await store.mutate(await target(service, 'client:' + qaId(1), 'complete'))
    assert.ok(views.every(v => v.at(-1) === '4')); assert.equal(store.clientSnapshot(qaId(1)), undefined)
    store.reset(); assert.ok(views.every(v => v.at(-1) === 'idle')); db.setOwner(QA_OTHER); await store.load(); assert.equal(store.snapshot().status, 'loaded'); unsub.forEach(fn => fn())
  })
  it('background refresh during mutation is not mistaken for account change', async () => {
    const db = fixtureDatabase(), service = createLegacyActionService(db.sb, QA_OWNER), store = new ActionStateStore(service)
    const command = await target(service, 'client:' + qaId(1), 'complete'); const mutation = store.mutate(command); await store.refresh(); await mutation; assert.equal(store.snapshot().status, 'loaded')
  })
  it('reset rejects in-flight mutation without restoring old data', async () => {
    let resolve!: () => void; const gate = new Promise<void>(r => { resolve = r })
    const store = new ActionStateStore({ mutate: async () => { await gate; return { unchanged: true } }, listOpen: async () => [] } as unknown as ActionService)
    const pending = store.mutate({ ...base, intent: 'leave' }); store.reset(); resolve(); await assert.rejects(pending, { code: 'unauthenticated' }); assert.equal(store.snapshot().status, 'idle')
  })
  it('refresh invalidates older client/history reads instead of restoring stale caches', async () => {
    let resolve!: () => void; const gate = new Promise<void>(r => { resolve = r })
    const store = new ActionStateStore({ listOpen: async () => [], forClient: async () => { await gate; return [] }, history: async () => { await gate; return [] } } as unknown as ActionService)
    const client = store.forClient(qaId(1)), history = store.history(qaId(20)); await store.refresh(); resolve()
    await assert.rejects(client, { code: 'conflict' }); await assert.rejects(history, { code: 'conflict' }); assert.equal(store.clientSnapshot(qaId(1)), undefined); assert.equal(store.historySnapshot(qaId(20)), undefined)
  })
  it('logout clears caches and shows authentication failure rather than loading or empty work', async () => {
    const store = new ActionStateStore(createLegacyActionService(fixtureDatabase().sb, QA_OWNER)); await store.load(); await store.forClient(qaId(1)); store.reset('unauthenticated')
    assert.equal(store.snapshot().status, 'authentication_error'); assert.equal(store.groups(), null); assert.equal(store.clientSnapshot(qaId(1)), undefined)
  })
  it('reset after authoritative save keeps a late refresh from restoring old-account data', async () => {
    let resolve!: () => void; const gate = new Promise<void>(r => { resolve = r })
    const store = new ActionStateStore({ mutate: async () => ({ unchanged: true }), listOpen: async () => { await gate; return [] } } as unknown as ActionService)
    await store.mutate({ ...base, intent: 'leave' }); store.reset(); resolve(); await Promise.resolve(); assert.equal(store.snapshot().status, 'idle')
  })
  it('query and authentication failures never become empty work', async () => {
    const db = fixtureDatabase(), s = new ActionStateStore(createLegacyActionService(db.sb, QA_OWNER)); db.setFailure(true); await s.load(); assert.equal(s.snapshot().status, 'query_error'); assert.equal(s.groups(), null)
    const anonymous = new ActionStateStore({ listOpen: async () => { const { ActionError } = await import('../lib/actions/errors'); throw new ActionError('unauthenticated', 'Log in') } } as unknown as ActionService); await anonymous.load(); assert.equal(anonymous.snapshot().status, 'authentication_error')
    db.setFailure(false); db.tables.clients.forEach(c => { c.next_action = null; c.next_followup = null }); db.tables.ai_reminders.forEach(r => { r.is_dismissed = true }); await s.load(); assert.deepEqual(Object.values(s.groups()!).map(a => a.length), [0,0,0,0])
  })
  it('visit leave performs zero writes; resolve and replace reject before persistence', async () => {
    const db = fixtureDatabase(), service = createLegacyActionService(db.sb, QA_OWNER), before = JSON.stringify(db.tables)
    validateVisitActionPlan({ intent: 'leave' }, service.capabilities); await applyVisitActionPlan(service, { intent: 'leave' }, qaId(30), qaId(1)); assert.equal(JSON.stringify(db.tables), before)
    for (const intent of ['resolve','replace'] as const) assert.throws(() => validateVisitActionPlan({ intent, command: { ...base, channel: 'visit', intent: intent === 'resolve' ? 'complete' : 'replace' } }, service.capabilities), { code: 'unsupported' })
    const plan = { intent: 'create' as const, command: { ...base, channel: 'visit' as const } }; validateVisitActionPlan(plan, service.capabilities); await applyVisitActionPlan(service, plan, qaId(30), qaId(5)); assert.equal(db.changes(), 1)
    assert.deepEqual(db.tables.client_actions, [])
  })
})
describe('Phase 3B AI and visible surface boundary', () => {
  it('signed AI uses the same legacy service; tampered/unsigned/change instruction do not mutate', async () => {
    const old = process.env.EYE_AI_CONFIRMATION_SECRET; process.env.EYE_AI_CONFIRMATION_SECRET = 'offline-test-secret-with-32-characters'
    try {
      const db = fixtureDatabase(), service = createLegacyActionService(db.sb, QA_OWNER), runtime = { owner: QA_OWNER, mode: 'LEGACY' as const, service }
      const proposal = await prepareAIAction(runtime, db.sb, { type: 'UPDATE_CLIENT_FOLLOWUP', clientName: 'QA No Action', dateSpec: { kind: 'relative_days', days: 1 }, nextAction: 'AI follow-up' }, '2026-09-26'); assert.ok(proposal.ok); if (!proposal.ok) return
      assert.ok(proposal.action.confirmationToken); assert.equal(classifyConfirmationMessage('change it to Friday'), 'none')
      await assert.rejects(confirmAIAction(runtime, db.sb, { ...proposal.action, confirmationToken: undefined }), { code: 'forbidden' })
      await assert.rejects(confirmAIAction(runtime, db.sb, { ...proposal.action, targetId: qaId(6) }), { code: 'forbidden' }); assert.equal(db.changes(), 0)
      await confirmAIAction(runtime, db.sb, proposal.action); assert.equal(db.changes(), 1); assert.equal(db.tables.clients[4].next_action, 'AI follow-up'); assert.deepEqual(db.tables.client_actions, [])
    } finally { if (old === undefined) delete process.env.EYE_AI_CONFIRMATION_SECRET; else process.env.EYE_AI_CONFIRMATION_SECRET = old }
  })
  it('visible surfaces consume shared state and have no direct operational field access', () => {
    for (const file of ['FieldControlPanel','ClientList','MapView','SidePanel','VisitModal','AIChat']) {
      const text = readFileSync(`components/${file}.tsx`, 'utf8'); const ast = ts.createSourceFile(file + '.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
      const violations: string[] = []; function visit(node: ts.Node) { if (ts.isPropertyAccessExpression(node) && ['next_action','next_followup'].includes(node.name.text)) violations.push(node.getText(ast)); if (ts.isStringLiteral(node) && node.text === 'ai_reminders') violations.push(node.text); ts.forEachChild(node, visit) } visit(ast)
      assert.deepEqual(violations, [], file); assert.match(text, /actionAttention|actionState|operationalActions/, file)
    }
    const ctx = readFileSync('contexts/AppContext.tsx','utf8'); assert.match(ctx, /useSyncExternalStore/); assert.match(ctx, /operationalActions\.reset\(\)/); assert.match(ctx, /validateVisitActionPlan/)
    const ai = readFileSync('components/AIChat.tsx','utf8'); assert.match(ai, /confirmationToken/); assert.match(ai, /setPendingAction\(null\)[\s\S]*fetch\('\/api\/chat'/)
  })
})
