const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const root = path.resolve(__dirname, '..')
const resolveOriginal = Module._resolveFilename
Module._resolveFilename = function (request, parent, ...rest) {
  return resolveOriginal.call(this, request.startsWith('@/') ? path.join(root, request.slice(2)) : request, parent, ...rest)
}
require.extensions['.ts'] = function (module, filename) {
  const source = fs.readFileSync(filename, 'utf8')
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText
  module._compile(compiled, filename)
}

const { formatFollowupDateTime, formatHistoryDate } = require('../lib/followup.ts')
const { groupClientsByCoordinates, isUnlocated } = require('../lib/location/group.ts')
const { ActionStateStore } = require('../lib/actions/state.ts')
const { createLegacyActionService, mapLegacy } = require('../lib/actions/legacy.ts')

test('action detail shows stored time and leaves null time blank', () => {
  assert.equal(formatFollowupDateTime('2026-09-28', '10:00:00', { withYear: true }), '28 Shtator 2026 · 10:00')
  assert.equal(formatFollowupDateTime('2026-09-25', null, { withYear: true }), '25 Shtator 2026')
  assert.equal(formatFollowupDateTime(null, null, { withYear: true }), 'Pa afat')
  assert.equal(formatHistoryDate('2026-07-01'), '1 Korrik 2026')
})

test('map grouping keeps every overlapping client selectable and unlocated counts honest', () => {
  const shared = Array.from({ length: 33 }, (_, i) => ({ id: String(i), business_name: 'Client ' + i, lat: 41.3275459, lng: 19.8186982 }))
  const separate = { id: 'other', business_name: 'Other', lat: 41.4, lng: 19.9 }
  const unlocated = [{ id: 'no-url', lat: null, lng: null }, { id: 'url', lat: null, lng: null, maps_url: 'https://example.com' }]
  const clients = [...shared, separate, ...unlocated]
  assert.equal(clients.filter(isUnlocated).length, 2)
  const groups = groupClientsByCoordinates(clients)
  assert.equal(groups.size, 2)
  assert.deepEqual(groups.get('41.3275459,19.8186982').map(c => c.id), shared.map(c => c.id))
  assert.equal(groupClientsByCoordinates(clients.filter(c => c.id === 'other')).size, 1)
})

function action() {
  return { id: 'a1', owner_user_id: 'owner-a', client_id: 'c1', client_name_snapshot: 'Client',
    description: 'Call', due_date: '2026-09-28', due_time: '10:00:00', state: 'open',
    version: 1, allowed_operations: ['complete'] }
}
const complete = { operation: 'surface', intent: 'complete', requestId: 'r1', channel: 'client_detail', clientId: 'c1', actionId: 'a1', expectedVersion: 1 }

test('one completion leaves overdue, preserves history and client status, and ignores a concurrent repeat', async () => {
  let current = action()
  let mutationCalls = 0
  let finish
  const gate = new Promise(resolve => { finish = resolve })
  const client = { id: 'c1', status: 'prospect' }
  const service = {
    capabilities: { history: true, visitResolve: true, replace: true },
    listOpen: async () => current.state === 'open' ? [current] : [],
    forClient: async () => [current],
    history: async () => [{ id: 'event-1', event_type: 'completed', recorded_at: '2026-10-02T10:00:00Z' }],
    mutate: async () => { mutationCalls++; await gate; current = { ...current, state: 'completed', version: 2 }; return current },
  }
  const store = new ActionStateStore(service)
  await store.load()
  assert.equal(store.groups(new Date('2026-10-02T12:00:00Z')).overdue.length, 1)
  const first = store.mutate(complete)
  const repeat = await store.mutate({ ...complete, requestId: 'r2' })
  assert.deepEqual(repeat, { unchanged: true })
  assert.equal(mutationCalls, 1)
  finish()
  await first
  assert.equal(store.groups(new Date('2026-10-02T12:00:00Z')).overdue.length, 0)
  assert.equal((await store.history('a1'))[0].event_type, 'completed')
  assert.equal(client.status, 'prospect')
})

test('failed completion releases the pending guard for retry', async () => {
  let calls = 0
  const service = {
    listOpen: async () => [action()], forClient: async () => [action()], history: async () => [],
    mutate: async () => { calls++; if (calls === 1) throw Error('temporary failure'); return { ...action(), state: 'completed' } },
  }
  const store = new ActionStateStore(service)
  await store.load()
  await assert.rejects(store.mutate(complete), /temporary failure/)
  await store.mutate({ ...complete, requestId: 'retry' })
  assert.equal(calls, 2)
})

function fakeDb(tables) {
  const calls = []
  return {
    calls,
    from(table) {
      calls.push(table)
      let filters = []
      let patch = null
      const query = {
        select() { return query },
        eq(key, value) { filters.push([key, value]); return query },
        is(key, value) { filters.push([key, value]); return query },
        order() { return query },
        update(value) { patch = value; return query },
        async range() { return { data: tables[table].filter(row => filters.every(([key, value]) => row[key] === value)).map(row => ({ ...row })), error: null } },
        async maybeSingle() {
          const row = tables[table].find(item => filters.every(([key, value]) => item[key] === value))
          if (!row) return { data: null, error: null }
          if (patch) Object.assign(row, patch)
          return { data: { ...row }, error: null }
        },
      }
      return query
    },
  }
}

test('legacy reminder fixtures are owner scoped, timed or untimed, and dismiss only once', async () => {
  const owner = 'owner-a'
  const clientId = '11111111-1111-4111-8111-111111111111'
  const rows = [
    { id: 'timed', owner_user_id: owner, client_id: clientId, visit_id: 'v1', business_name: 'Client',
      description: 'Visit reminder', due_date: '2026-10-03', due_time: '14:30:00',
      is_dismissed: false, action_type: 'follow_up', priority: 'medium' },
    { id: 'untimed', owner_user_id: owner, client_id: clientId, visit_id: 'v1', business_name: 'Client',
      description: 'Untimed reminder', due_date: '2026-10-04', due_time: null,
      is_dismissed: false, action_type: 'follow_up', priority: 'medium' },
    { id: 'other-owner', owner_user_id: 'owner-b', client_id: 'c2', visit_id: 'v2', business_name: 'Other',
      description: 'Private', due_date: '2026-10-03', due_time: null,
      is_dismissed: false, action_type: 'follow_up', priority: 'medium' },
  ]
  const clients = [{ id: clientId, owner_user_id: owner, business_name: 'Client', status: 'prospect', next_action: null, next_followup: null }]
  const db = fakeDb({ clients, ai_reminders: rows })
  const service = createLegacyActionService(db, owner)
  const active = await service.listOpen()
  assert.equal(active.length, 2)
  assert.deepEqual(active.map(a => a.id).sort(), ['reminder:timed', 'reminder:untimed'])
  assert.equal(active.find(a => a.id === 'reminder:timed').due_time, '14:30:00')
  assert.equal(active.find(a => a.id === 'reminder:untimed').due_time, null)
  const selected = active.find(a => a.id === 'reminder:timed')
  const command = { operation: 'surface', intent: 'complete', requestId: '11111111-1111-4111-8111-111111111112', channel: 'field_control',
    clientId, actionId: selected.id, expectedVersion: null, expectedRevision: selected.revision }
  const result = await service.mutate(command)
  assert.equal(result.state, 'legacy_closed')
  assert.equal((await service.listOpen()).length, 1)
  await assert.rejects(service.mutate({ ...command, requestId: '11111111-1111-4111-8111-111111111113' }), /Action changed/)
  assert.equal(clients[0].status, 'prospect')
  assert.equal(rows[2].is_dismissed, false)
  assert.equal(db.calls.includes('client_actions'), false)
  assert.throws(() => mapLegacy('reminder', rows[2], owner), /owner mismatch/)
})
