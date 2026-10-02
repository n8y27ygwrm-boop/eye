import { fixtureDatabase, fixtureTables } from './database'
const key = Symbol.for('eye.offline.phase3b.fixture')
export function qaDatabase() {
  const root = globalThis as any
  if (!root[key]) root[key] = fixtureDatabase(fixtureTables(new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Tirane' })))
  return root[key] as ReturnType<typeof fixtureDatabase>
}
