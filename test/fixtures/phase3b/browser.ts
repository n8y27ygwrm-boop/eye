/** Installed only in an isolated QA copy, never in production lib/supabase. */
export function qaBrowserClient(): any {
  const handlers = new Set<(...args: any[]) => void>(), channels = new Set<any>()
  let previousOwner: string | null | undefined, previousChanges = -1
  const request = async (payload?: unknown) => { const r = await fetch('/api/qa/data', payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : undefined); return r.json() }
  let poll: ReturnType<typeof setInterval> | undefined
  const tick = async () => {
    const data = await request()
    if (data.owner !== previousOwner) { previousOwner = data.owner; handlers.forEach(fn => fn(data.owner ? 'SIGNED_IN' : 'SIGNED_OUT', data.owner ? { user: { id: data.owner } } : null)) }
    if (data.changes !== previousChanges) { previousChanges = data.changes; channels.forEach(c => { if (c.name.startsWith('operational-actions')) c.callbacks.forEach((fn: any) => fn({})) }) }
  }
  return {
    auth: {
      getUser: async () => { const data = await request(); previousOwner = data.owner; return { data: { user: data.owner ? { id: data.owner, email: 'qa@offline.invalid' } : null }, error: null } },
      onAuthStateChange: (fn: any) => { handlers.add(fn); if (!poll && typeof window !== 'undefined') poll = setInterval(tick, 400); return { data: { subscription: { unsubscribe: () => { handlers.delete(fn); if (!handlers.size && poll) { clearInterval(poll); poll = undefined } } } } } },
      signOut: async () => request({ control: 'logout' }),
    },
    from(table: string) { const ops: any[] = []; const query: any = {}; for (const method of ['select','eq','is','gte','lte','ilike','order','range','limit','update','insert','delete','single','maybeSingle']) query[method] = (...args: any[]) => { ops.push([method,...args]); return query }; query.then = (resolve: any, reject: any) => request({ table, ops }).then(resolve, reject); return query },
    channel(name: string) { const c: any = { name, callbacks: [], on: (_kind: any, _filter: any, fn: any) => { c.callbacks.push(fn); return c }, subscribe: () => { channels.add(c); return c } }; return c },
    removeChannel: async (c: any) => { channels.delete(c) },
  }
}
