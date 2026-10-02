/** Offline test data only. Never imported by application production modules. */
export const QA_OWNER = 'a1026b88-6a25-4548-a055-cf12ea436bf8'
export const QA_OTHER = 'd0efc930-fec8-4766-b93e-c20eeea0cf0e'
export const qaId = (n: number) => `04b6d719-4616-443c-bcf3-${String(n).padStart(12, '0')}`
export function fixtureTables(today = '2026-09-26'): Record<string, any[]> {
  const shift = (days: number) => { const d = new Date(today + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10) }
  const client = (n: number, name: string, text: string | null, date: string | null, owner = QA_OWNER) => ({ id: qaId(n), owner_user_id: owner, business_name: name, status: 'prospect', zone: 'Tirana', address: 'Test fixture address', contact_person: 'Test contact', phone: '000000000', email: null, lat: 41.325 + n * .002, lng: 19.81 + n * .002, next_action: text, next_followup: date, general_notes: 'Offline QA only', created_at: '2026-09-01T12:00:00Z', updated_at: '2026-09-01T12:00:00Z' })
  return {
    clients: [client(1, 'QA Text Date', 'Call about contract', shift(-1)), client(2, 'QA Date Only', null, today), client(3, 'QA Upcoming', 'Prepare delivery', shift(2)), client(4, 'QA Unscheduled', 'Discuss samples', null), client(5, 'QA No Action', null, null), client(6, 'Other Owner', 'Private action', today, QA_OTHER)],
    ai_reminders: [
      { id: qaId(20), owner_user_id: QA_OWNER, client_id: qaId(1), business_name: 'QA Text Date', description: 'Separate active reminder', due_date: today, due_time: null, action_type: 'call', priority: 'medium', visit_id: null, is_dismissed: false },
      { id: qaId(21), owner_user_id: QA_OWNER, client_id: qaId(1), business_name: 'QA Text Date', description: 'Historical dismissed reminder', due_date: shift(-2), due_time: null, action_type: 'call', priority: 'medium', visit_id: null, is_dismissed: true },
    ],
    visits: [{ id: qaId(30), owner_user_id: QA_OWNER, client_id: qaId(1), business_name: 'QA Text Date', visit_date: shift(-1), statusi: 'contacted', shenime: 'Last visit fixture', produkti: '', sasia: '', cmimi: null, created_at: shift(-1) + 'T12:00:00Z', updated_at: shift(-1) + 'T12:00:00Z' }],
    client_actions: [], client_action_events: [], visit_lists: [], visit_entries: [],
  }
}
export function fixtureDatabase(tables = fixtureTables(), initialOwner: string | null = QA_OWNER) {
  const trace: { table: string; mutation: boolean }[] = []
  let owner = initialOwner, failure: { code: string; message: string } | null = null
  let sequence = 100, changes = 0, beforeWrite: (() => void) | undefined
  const operations = (table: string, ops: any[]) => {
    if (table.startsWith('client_action')) throw Error('CANONICAL access forbidden in LEGACY QA')
    const mutation = ops.some(([op]: any[]) => ['update', 'insert', 'delete'].includes(op))
    trace.push({ table, mutation })
    if (failure) return { data: null, error: failure, count: null }
    if (mutation && beforeWrite) { const hook = beforeWrite; beforeWrite = undefined; hook() }
    let rows = (tables[table] ?? []).filter(row => row.owner_user_id === owner)
    for (const [op, key, value] of ops) {
      if (op === 'eq' || op === 'is') rows = rows.filter(row => (row[key] ?? null) === value)
      if (op === 'gte') rows = rows.filter(row => row[key] >= value)
      if (op === 'lte') rows = rows.filter(row => row[key] <= value)
      if (op === 'ilike') rows = rows.filter(row => String(row[key]).toLowerCase().includes(String(value).replaceAll('%', '').toLowerCase()))
    }
    const count = rows.length
    for (const [op, arg, opt] of ops) {
      if (op === 'order') rows.sort((a, b) => String(a[arg] ?? '').localeCompare(String(b[arg] ?? '')) * (opt?.ascending === false ? -1 : 1))
      if (op === 'range') rows = rows.slice(arg, opt + 1)
      if (op === 'limit') rows = rows.slice(0, arg)
      if (op === 'update') { rows.forEach(row => Object.assign(row, arg)); changes += rows.length }
      if (op === 'insert') { rows = (Array.isArray(arg) ? arg : [arg]).map(row => ({ id: qaId(sequence++), created_at: new Date().toISOString(), ...row })); (tables[table] ??= []).push(...rows); changes += rows.length }
      if (op === 'delete') { tables[table] = tables[table].filter(row => !rows.includes(row)); changes += rows.length }
    }
    return { data: structuredClone(ops.some(([op]: any[]) => ['single', 'maybeSingle'].includes(op)) ? rows[0] ?? null : rows), error: null, count }
  }
  const sb: any = {
    auth: { getUser: async () => ({ data: { user: owner ? { id: owner, email: 'qa@offline.invalid' } : null }, error: null }) },
    from(table: string) { const ops: any[] = []; const query: any = {}; for (const method of ['select','eq','is','gte','lte','ilike','order','range','limit','update','insert','delete','single','maybeSingle']) query[method] = (...args: any[]) => { ops.push([method, ...args]); return query }; query.then = (resolve: any, reject: any) => Promise.resolve().then(() => operations(table, ops)).then(resolve, reject); return query },
    rpc() { throw Error('Canonical RPC forbidden in LEGACY QA') },
  }
  return { sb, tables, trace, operations, changes: () => changes, setOwner: (id: string | null) => { owner = id }, owner: () => owner, setFailure: (on: boolean) => { failure = on ? { code: '08006', message: 'Offline QA database unavailable' } : null }, beforeWrite: (hook: () => void) => { beforeWrite = hook } }
}
