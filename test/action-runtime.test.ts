import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveActionAuthority } from '../lib/config/action-authority'
import { createActionRuntime, selectActionService } from '../lib/actions/runtime'
import { createCanonicalActionService } from '../lib/actions/canonical'
import { createLegacyActionService } from '../lib/actions/legacy'
import { ActionError } from '../lib/actions/errors'
import { groupOpenActions } from '../lib/actions/queue'
import { ActionStateStore } from '../lib/actions/state'
import { issueConfirmation, verifyConfirmation } from '../lib/ai/actions/receipt'
import { prepareAIAction, confirmAIAction } from '../lib/ai/actions/runtime'
import { buildCompactCRMContext } from '../lib/ai/chat-context'
import type { ActionCommand, ActionService, CanonicalCommand, OperationalAction } from '../lib/actions/types'
import type { PendingCRMAction } from '../lib/ai/actions/types'

const owner = 'a1026b88-6a25-4548-a055-cf12ea436bf8'
const other = 'd0efc930-fec8-4766-b93e-c20eeea0cf0e'
const id = '6f1d6c46-ca43-8db7-8385-051222aaf0e6'
const clientId = '04b6d719-4616-443c-bcf3-7138574cd810'
const requestId = '31afbca6-471c-8335-811a-bf8d5d0e9bc1'
const nextId = 'd7584023-8a64-893c-800a-123ae7baa6ee'
const fields = { description: 'Call customer', action_type: 'call' as const, due_date: '2026-09-27', due_time: null, priority: 'medium' as const }
const newFields = { ...fields, origin: 'manual' as const, source_visit_id: null, source_excerpt: null, creation_key: `manual:${requestId}` }
function action(patch: Partial<OperationalAction> = {}): OperationalAction {
  return { id, owner_user_id: owner, client_id: clientId, client_name_snapshot: 'Mokador', ...fields, state: 'open', origin: 'legacy', version: 1,
    source_visit_id: null, source_excerpt: null, resolution_visit_id: null, replaces_action_id: null, creation_key: `legacy:clients:${clientId}:followup`,
    created_at: '2026-09-26T14:00:00Z', updated_at: '2026-09-26T14:00:00Z', closed_at: null, closed_by: null, closure_note: null, ...patch }
}
function fakeDatabase(tables: Record<string, any[]> = {}) {
  const touched: string[] = [], rpcCalls: { name: string; args: any }[] = []
  let error: { code: string; message: string } | null = null
  let rpcResult: any = action()
  const retries = new Map<string, any>()
  let changes = 0
  let user: string | null = owner
  const sb = {
    auth: { getUser: async () => ({ data: { user: user ? { id: user } : null }, error: null }) },
    from(table: string) {
      touched.push(table)
      const predicates: ((row: any) => boolean)[] = []
      let range: [number, number] | null = null, patch: any = null, single = false
      const query: any = {
        select: () => query, order: () => query,
        eq(key: string, val: any) { predicates.push(row => row[key] === val); return query },
        is(key: string, val: any) { predicates.push(row => row[key] === val); return query },
        limit: () => query, range(a: number, b: number) { range = [a, b]; return query },
        update(val: any) { patch = val; return query },
        maybeSingle() { single = true; return query },
        then(resolve: (value: any) => void) {
          let rows = (tables[table] ?? []).filter(row => predicates.every(p => p(row)))
          if (range) rows = rows.slice(range[0], range[1] + 1)
          if (patch && !error) { rows.forEach(row => Object.assign(row, patch)); changes += rows.length }
          return Promise.resolve({ data: error ? null : single ? rows[0] ?? null : structuredClone(rows), error, count: rows.length }).then(resolve)
        },
      }
      return query
    },
    async rpc(name: string, args: any) {
      rpcCalls.push({ name, args })
      if (error) return { data: null, error }
      const key = args.p_request_id
      if (retries.has(key)) {
        const prior = retries.get(key)
        return JSON.stringify(prior.args) === JSON.stringify(args) ? { data: prior.data, error: null } : { data: null, error: { code: '23505' } }
      }
      if (rpcResult) { changes++; retries.set(key, { args: structuredClone(args), data: structuredClone(rpcResult) }) }
      return { data: rpcResult, error: null }
    },
  } as unknown as SupabaseClient
  return { sb, tables, touched, rpcCalls, setError: (e: typeof error) => { error = e }, setRPC: (r: any) => { rpcResult = r }, changes: () => changes, setUser: (u: string | null) => { user = u } }
}
const proposal: PendingCRMAction = { id: requestId, type: 'UPDATE_CLIENT_FOLLOWUP', targetId: clientId, targetName: 'Mokador', confirmationText: 'Confirm?', payload: { next_followup: '2026-09-27', next_action: 'Call customer' }, expected: { next_followup: null, next_action: null } }
const edit: CanonicalCommand = { operation: 'edit', actionId: id, expectedVersion: 1, requestId, channel: 'api', fields }
const secret = 'test-only-secret-32-characters-long-enough'

describe('Phase 3A authority and authenticated runtime', () => {
  it('default stays LEGACY; invalid, blank, lower-case and whitespace fail closed', () => {
    assert.equal(resolveActionAuthority(undefined), 'LEGACY')
    assert.equal(resolveActionAuthority('CANONICAL'), 'CANONICAL')
    for (const value of ['', 'legacy', 'CANONICAL ', 'invalid']) assert.throws(() => resolveActionAuthority(value), { code: 'configuration' })
  })
  for (const mode of ['LEGACY', 'CANONICAL'] as const) it(`${mode} constructs and executes one authority only`, async () => {
    const selected: string[] = [], mutations: string[] = []
    const make = (m: typeof mode) => () => { selected.push(m); return { mode: m, mutate: async () => { mutations.push(m); return action() } } as unknown as ActionService }
    await selectActionService(mode, { LEGACY: make('LEGACY'), CANONICAL: make('CANONICAL') }).mutate(edit)
    assert.deepEqual(selected, [mode]); assert.deepEqual(mutations, [mode])
  })
  it('invalid mode invokes no factory', () => {
    assert.throws(() => selectActionService('BOTH' as any, { LEGACY: () => { throw Error('called') }, CANONICAL: () => { throw Error('called') } }), { code: 'configuration' })
  })
  it('runtime verifies identity; anonymous failure queries no table', async () => {
    const db = fakeDatabase(); db.setUser(null)
    await assert.rejects(createActionRuntime(db.sb), { code: 'unauthenticated' }); assert.deepEqual(db.touched, [])
  })
  it('resolved configuration overrides any browser preference and scopes by verified owner', async () => {
    const old = process.env.EYE_ACTION_AUTHORITY
    try {
      process.env.EYE_ACTION_AUTHORITY = 'CANONICAL'
      const db = fakeDatabase({ client_actions: [action(), action({ id: nextId, owner_user_id: other })] })
      const runtime = await createActionRuntime(db.sb)
      assert.equal(runtime.mode, 'CANONICAL'); assert.equal(runtime.owner, owner); assert.equal((await runtime.service.listOpen()).length, 1)
      assert.deepEqual(db.touched, ['client_actions'])
    } finally { if (old === undefined) delete process.env.EYE_ACTION_AUTHORITY; else process.env.EYE_ACTION_AUTHORITY = old }
  })
})
describe('canonical reads and derived queues', () => {
  it('open list is owner scoped, client list retains closed history, by ID denies other owner', async () => {
    const db = fakeDatabase({ client_actions: [action(), action({ id: nextId, state: 'legacy_closed' }), action({ id: requestId, owner_user_id: other })] })
    const service = createCanonicalActionService(db.sb, owner)
    assert.equal((await service.listOpen()).length, 1)
    assert.equal((await service.forClient(clientId)).length, 2)
    assert.equal((await service.byId(id))?.id, id)
    assert.equal(await service.byId(requestId), null)
  })
  it('paginates open reads past the default Data API row cap', async () => {
    const rows = Array.from({ length: 1101 }, () => action())
    const db = fakeDatabase({ client_actions: rows })
    assert.equal((await createCanonicalActionService(db.sb, owner).listOpen()).length, 1101)
    assert.equal(db.touched.length, 3)
  })
  it('history is owner and action scoped', async () => {
    const db = fakeDatabase({ client_action_events: [{ id: requestId, owner_user_id: owner, action_id: id }, { id: nextId, owner_user_id: other, action_id: id }] })
    assert.equal((await createCanonicalActionService(db.sb, owner).history(id)).length, 1)
  })
  it('timezone midnight yields overdue/today/upcoming/unscheduled; closed is excluded', () => {
    const rows = [action({ due_date: '2026-09-25' }), action({ due_date: '2026-09-26' }), action({ due_date: '2026-09-27' }), action({ due_date: null }), action({ state: 'legacy_closed' })]
    const groups = groupOpenActions(rows, new Date('2026-09-25T22:30:00Z'))
    assert.deepEqual(Object.values(groups).map(v => v.length), [1, 1, 1, 1])
    assert.equal(rows[4].state, 'legacy_closed')
  })
  it('query failure never returns an empty success', async () => {
    const db = fakeDatabase(); db.setError({ code: '08006', message: 'connection lost' })
    const service = createCanonicalActionService(db.sb, owner)
    for (const read of [() => service.listOpen(), () => service.byId(id), () => service.forClient(clientId), () => service.history(id)]) await assert.rejects(read(), { code: 'database' })
  })
})
describe('canonical transactional commands', () => {
  const commands: CanonicalCommand[] = [
    { operation: 'create', clientId, requestId, channel: 'api', fields: newFields }, edit,
    { ...edit, operation: 'reschedule' },
    { operation: 'complete', actionId: id, expectedVersion: 1, requestId, channel: 'api', resolutionVisitId: null, closureNote: null },
    { operation: 'cancel', actionId: id, expectedVersion: 1, requestId, channel: 'api', resolutionVisitId: null, closureNote: 'Cancelled by owner' },
    { operation: 'replace', actionId: id, expectedVersion: 1, requestId, channel: 'api', fields: newFields, closureNote: 'New plan' },
  ]
  for (const command of commands) it(`${command.operation} invokes only its Phase 1 RPC and returns authoritative result`, async () => {
    const db = fakeDatabase()
    db.setRPC(command.operation === 'replace' ? { replaced: action({ state: 'replaced', version: 2 }), successor: action({ id: nextId, replaces_action_id: id }) } : action({ version: 2, state: command.operation === 'complete' ? 'completed' : command.operation === 'cancel' ? 'cancelled' : 'open' }))
    const result = await createCanonicalActionService(db.sb, owner).mutate(command)
    assert.ok(result); assert.deepEqual(db.touched, [])
    const call = db.rpcCalls[0]
    assert.equal(call.name, `eye_action_${command.operation === 'reschedule' ? 'edit' : command.operation}`)
    assert.equal(call.args.p_request_id, requestId)
    if ('expectedVersion' in command) assert.equal(call.args.p_expected_version, 1)
    if ('fields' in command) assert.equal(call.args.p_description, fields.description)
    assert.equal(call.args.p_channel, 'api')
  })
  it('exact retry forwards identical args and returns original result; changed retry fails', async () => {
    const db = fakeDatabase(), service = createCanonicalActionService(db.sb, owner); db.setRPC(action({ version: 2 }))
    assert.deepEqual(await service.mutate(edit), await service.mutate(edit)); assert.equal(db.changes(), 1)
    await assert.rejects(service.mutate({ ...edit, fields: { ...fields, description: 'tampered retry' } }), { code: 'request_conflict' }); assert.equal(db.changes(), 1)
  })
  for (const [sqlCode, code] of [['40001', 'conflict'], ['42501', 'forbidden'], ['22023', 'invalid'], ['08006', 'database']]) it(`${sqlCode} maps deterministically to ${code}`, async () => {
    const db = fakeDatabase(); db.setError({ code: sqlCode, message: 'rejected' })
    await assert.rejects(createCanonicalActionService(db.sb, owner).mutate(edit), { code })
  })
  it('zero-row/malformed/mismatched-owner RPC result never reports success', async () => {
    for (const result of [null, [], {}, action({ owner_user_id: other })]) {
      const db = fakeDatabase(); db.setRPC(result)
      await assert.rejects(createCanonicalActionService(db.sb, owner).mutate(edit), ActionError)
    }
  })
  it('invalid version, time without date, impossible date and empty cancellation fail before DB', async () => {
    const db = fakeDatabase(), service = createCanonicalActionService(db.sb, owner)
    for (const command of [{ ...edit, expectedVersion: 0 }, { ...edit, fields: { ...fields, due_time: '10:00', due_date: null } }, { ...edit, fields: { ...fields, due_date: '2026-02-31' } }, { ...commands[4], closureNote: '' }]) await assert.rejects(service.mutate(command as ActionCommand), { code: 'invalid' })
    assert.equal(db.rpcCalls.length, 0)
  })
})
describe('legacy compatibility preserves source semantics', () => {
  it('reads only legacy; dismissed has no invented completion metadata/version', async () => {
    const db = fakeDatabase({ clients: [{ id: clientId, owner_user_id: owner, business_name: 'Mokador', next_followup: '2026-09-27', next_action: null }], ai_reminders: [{ id, owner_user_id: owner, client_id: clientId, business_name: 'Mokador', description: 'Call', action_type: 'call', priority: 'medium', is_dismissed: true }] })
    const service = createLegacyActionService(db.sb, owner)
    assert.equal((await service.listOpen())[0].description, 'Follow-up — details not recorded')
    const closed = (await service.forClient(clientId))[1]
    assert.equal(closed.state, 'legacy_closed'); assert.equal(closed.closed_at, null); assert.equal(closed.closed_by, null); assert.equal(closed.version, null)
    assert.ok(db.touched.every(table => ['clients', 'ai_reminders'].includes(table)))
    await assert.rejects(service.history(id), { code: 'unsupported' })
    await assert.rejects(service.mutate(edit), { code: 'unsupported' }); assert.equal(db.rpcCalls.length, 0)
  })
  it('legacy follow-up mutation uses only its existing CAS path', async () => {
    const db = fakeDatabase({ clients: [{ id: clientId, owner_user_id: owner, business_name: 'Mokador', status: 'prospect', next_action: null, next_followup: null }] })
    const result = await createLegacyActionService(db.sb, owner).mutate({ operation: 'legacy', action: proposal })
    assert.ok('due_date' in result); assert.equal(result.due_date, '2026-09-27'); assert.equal(db.changes(), 1); assert.equal(db.rpcCalls.length, 0)
    assert.ok(db.touched.every(table => ['clients', 'ai_reminders'].includes(table)))
  })
  it('legacy query errors reject instead of empty', async () => {
    const db = fakeDatabase(); db.setError({ code: '08006', message: 'unavailable' })
    await assert.rejects(createLegacyActionService(db.sb, owner).listOpen(), { code: 'database' })
  })
})
describe('state preparation distinguishes loading, empty, auth and failure', () => {
  it('successful empty has loaded state and four empty groups', async () => {
    const store = new ActionStateStore(createCanonicalActionService(fakeDatabase().sb, owner))
    assert.equal(store.snapshot().status, 'idle'); const loading = store.load(); assert.equal(store.snapshot().status, 'loading'); await loading
    assert.deepEqual(store.snapshot(), { status: 'loaded', actions: [] }); assert.deepEqual(Object.values(store.groups()!).map(a => a.length), [0, 0, 0, 0])
  })
  for (const code of ['unauthenticated', 'database'] as const) it(`${code} has its own error state, no empty groups`, async () => {
    const service = { listOpen: async () => { throw new ActionError(code, 'failure') } } as unknown as ActionService
    const store = new ActionStateStore(service); await store.load()
    assert.equal(store.snapshot().status, code === 'unauthenticated' ? 'authentication_error' : 'query_error'); assert.equal(store.groups(), null)
  })
  it('refresh after mutation uses authoritative data and reset invalidates in-flight load', async () => {
    let calls = 0
    const service = { listOpen: async () => { calls++; return [action()] }, mutate: async () => action(), forClient: async () => [action()], history: async () => [] } as unknown as ActionService
    const store = new ActionStateStore(service); await store.mutate(edit); assert.equal(calls, 1); assert.equal((await store.forClient(clientId)).length, 1); assert.deepEqual(await store.history(id), [])
    const load = store.load(); store.reset(); await load; assert.equal(store.snapshot().status, 'idle')
  })
  it('mutation success plus refresh failure is not rendered as loaded empty', async () => {
    const store = new ActionStateStore({ listOpen: async () => { throw new ActionError('database', 'read failed') }, mutate: async () => action() } as unknown as ActionService)
    await store.mutate(edit); assert.equal(store.snapshot().status, 'query_error')
  })
})
describe('AI confirmation integrity', () => {
  const command: CanonicalCommand = { ...edit, channel: 'ai_chat' }
  it('signed exact receipt binds owner, target, payload, version, mode and request ID', () => {
    const signed = issueConfirmation(owner, 'CANONICAL', proposal, command, secret, 1000)
    assert.deepEqual(verifyConfirmation(owner, 'CANONICAL', signed, secret, 1001).command, command)
    const mutations = [{ targetId: nextId }, { id: nextId }, { expected: { next_followup: '2026-09-28', next_action: null } }, { payload: { next_followup: '2026-09-28' } }, { confirmationText: 'changed' }]
    for (const change of mutations) assert.throws(() => verifyConfirmation(owner, 'CANONICAL', { ...signed, ...change } as PendingCRMAction, secret, 1001), { code: 'forbidden' })
    assert.throws(() => verifyConfirmation(other, 'CANONICAL', signed, secret, 1001), { code: 'forbidden' })
    assert.throws(() => verifyConfirmation(owner, 'LEGACY', signed, secret, 1001), { code: 'forbidden' })
    assert.throws(() => verifyConfirmation(owner, 'CANONICAL', signed, secret, 9999999), { code: 'forbidden' })
    assert.throws(() => verifyConfirmation(owner, 'CANONICAL', proposal, secret), { code: 'forbidden' })
  })
  it('editing signed server command bytes cannot change expected version', () => {
    const signed = issueConfirmation(owner, 'CANONICAL', proposal, command, secret, 1000)
    const [body, signature] = signed.confirmationToken!.split('.')
    const receipt = JSON.parse(Buffer.from(body, 'base64url').toString()); receipt.command.expectedVersion = 99
    signed.confirmationToken = `${Buffer.from(JSON.stringify(receipt)).toString('base64url')}.${signature}`
    assert.throws(() => verifyConfirmation(owner, 'CANONICAL', signed, secret, 1001), { code: 'forbidden' })
  })
  it('missing or weak secret fails closed', () => {
    assert.throws(() => issueConfirmation(owner, 'LEGACY', proposal, null, ''), { code: 'configuration' })
  })
  it('canonical AI confirmation invokes the same service/RPC; no legacy write', async () => {
    const old = process.env.EYE_AI_CONFIRMATION_SECRET; process.env.EYE_AI_CONFIRMATION_SECRET = secret
    try {
      const db = fakeDatabase({ client_actions: [action()], clients: [{ id: clientId, owner_user_id: owner, business_name: 'Mokador', status: 'prospect' }] })
      db.setRPC(action({ version: 2 }))
      const runtime = { mode: 'CANONICAL' as const, owner, service: createCanonicalActionService(db.sb, owner) }
      const planned = await prepareAIAction(runtime, db.sb, { type: 'UPDATE_CLIENT_FOLLOWUP', clientName: 'Mokador', dateSpec: { kind: 'relative_days', days: 1 } }, '2026-09-26')
      assert.ok(planned.ok); if (!planned.ok) return
      const result = await confirmAIAction(runtime, db.sb, planned.action)
      assert.equal(result.ok, true); assert.equal(db.rpcCalls[0].name, 'eye_action_edit'); assert.equal(db.rpcCalls[0].args.p_channel, 'ai_chat')
      assert.equal(db.changes(), 1); assert.ok(!db.touched.includes('ai_reminders'))
      await assert.rejects(confirmAIAction(runtime, db.sb, { ...planned.action, payload: { next_followup: '2027-01-01' } } as PendingCRMAction), { code: 'forbidden' }); assert.equal(db.changes(), 1)
    } finally { if (old === undefined) delete process.env.EYE_AI_CONFIRMATION_SECRET; else process.env.EYE_AI_CONFIRMATION_SECRET = old }
  })
  it('CRM context query failure prevents empty successful context', async () => {
    const db = fakeDatabase(); db.setError({ code: '08006', message: 'query error' })
    await assert.rejects(buildCompactCRMContext(db.sb, 'What is due?', '2026-09-26', owner), { code: 'database' })
  })
  it('canonical context uses canonical queue even if legacy data disagrees', async () => {
    const db = fakeDatabase({ client_actions: [action()], clients: [{ id: clientId, owner_user_id: owner, business_name: 'Mokador', status: 'prospect', zone: 'Tirana', next_action: 'LEGACY SHOULD NOT BE AUTHORITATIVE', next_followup: '2020-01-01' }] })
    const context = await buildCompactCRMContext(db.sb, 'What work is due?', '2026-09-26', owner, [], createCanonicalActionService(db.sb, owner))
    assert.ok(context.text.includes('Call customer')); assert.ok(!db.touched.includes('ai_reminders'))
  })
  it('legacy signed AI dismissal stays legacy_closed; altered confirmation performs zero writes', async () => {
    const old = process.env.EYE_AI_CONFIRMATION_SECRET; process.env.EYE_AI_CONFIRMATION_SECRET = secret
    try {
      const db = fakeDatabase({ ai_reminders: [{ id, owner_user_id: owner, client_id: clientId, business_name: 'Mokador', description: 'Call', action_type: 'call', priority: 'medium', is_dismissed: false }] })
      const runtime = { mode: 'LEGACY' as const, owner, service: createLegacyActionService(db.sb, owner) }
      const planned = await prepareAIAction(runtime, db.sb, { type: 'DISMISS_REMINDER', businessName: 'Mokador' }, '2026-09-26')
      assert.ok(planned.ok); if (!planned.ok) return
      await assert.rejects(confirmAIAction(runtime, db.sb, { ...planned.action, targetId: nextId }), { code: 'forbidden' }); assert.equal(db.changes(), 0)
      const confirmed = await confirmAIAction(runtime, db.sb, planned.action)
      assert.equal(confirmed.ok, true); assert.ok('result' in confirmed)
      const result = confirmed.result
      assert.ok(result && 'state' in result); assert.equal(result.state, 'legacy_closed'); assert.equal(result.closed_at, null); assert.equal(result.closed_by, null)
      assert.equal(db.changes(), 1); assert.equal(db.rpcCalls.length, 0)
    } finally { if (old === undefined) delete process.env.EYE_AI_CONFIRMATION_SECRET; else process.env.EYE_AI_CONFIRMATION_SECRET = old }
  })
  it('canonical proposal cannot promise to clear description and silently retain it', async () => {
    const db = fakeDatabase({ client_actions: [action()], clients: [{ id: clientId, owner_user_id: owner, business_name: 'Mokador', status: 'prospect' }] })
    const runtime = { mode: 'CANONICAL' as const, owner, service: createCanonicalActionService(db.sb, owner) }
    const planned = await prepareAIAction(runtime, db.sb, { type: 'UPDATE_CLIENT_FOLLOWUP', clientName: 'Mokador', dateSpec: { kind: 'relative_days', days: 1 }, nextAction: null }, '2026-09-26')
    assert.equal(planned.ok, false); assert.equal(db.changes(), 0)
  })
})
