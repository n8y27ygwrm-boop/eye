import type { Client } from '../types'

export function isUnlocated(client: Pick<Client, 'lat' | 'lng'>): boolean {
  return client.lat == null || client.lng == null
}

export function groupClientsByCoordinates(clients: Client[]): Map<string, Client[]> {
  const groups = new Map<string, Client[]>()
  for (const client of clients) {
    if (isUnlocated(client)) continue
    const key = `${client.lat},${client.lng}`
    const group = groups.get(key) ?? []
    group.push(client)
    groups.set(key, group)
  }
  return groups
}
