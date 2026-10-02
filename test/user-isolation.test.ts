import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { orchestrateUpsertVisit, type LifecycleDbAdapter } from '../lib/lifecycle'
import {
  loadAuthoritativeRecord,
  persistActionableReminder,
} from '../lib/inngest/functions/process-visit-reminder'
import { buildCompactCRMContext } from '../lib/ai/chat-context'
import { deterministicReminderId } from '../lib/ai/idempotency'
import { NonRetriableError } from 'inngest'
import type { Client, Visit, VisitExtractionInput, VisitAIExtraction } from '../lib/types'

const USER_A = 'a1026b88-6a25-4548-a055-cf12ea436bf8'
const USER_B = 'b2037c99-7b36-5659-b166-de23fb547cf9'

/**
 * Simulated PostgreSQL Database with Row-Level Security (RLS) engine
 * accurately modeling:
 * - clients RLS (auth.uid() = owner_user_id)
 * - visits RLS (auth.uid() = owner_user_id AND (client_id IS NULL OR client.owner_user_id = auth.uid()))
 * - ai_reminders RLS (auth.uid() = owner_user_id)
 */
class SimulatedRlsDatabase {
  clients: (Client & { owner_user_id: string })[] = []
  visits: (Visit & { owner_user_id: string })[] = []
  reminders: any[] = []

  createClient(currentUserId: string | null) {
    return {
      from: (table: string) => {
        let filters: Record<string, any> = {}
        let rangeFilter: [number, number] | null = null

        let countOption: string | undefined = undefined
        let headOption = false
        let limitVal: number | null = null
        let orderConfig: { col: string; ascending: boolean } | null = null

        const builder = {
          select: (fields?: string, options?: { count?: string; head?: boolean }) => {
            if (options?.count) countOption = options.count
            if (options?.head) headOption = true
            return builder
          },
          order: (col: string, options?: { ascending?: boolean }) => {
            orderConfig = { col, ascending: options?.ascending !== false }
            return builder
          },
          range: (from: number, to: number) => {
            rangeFilter = [from, to]
            return builder
          },
          limit: (n: number) => {
            limitVal = n
            return builder
          },
          eq: (col: string, val: any) => {
            filters[col] = val
            return builder
          },
          gte: (col: string, val: any) => {
            filters[col + '__gte'] = val
            return builder
          },
          lte: (col: string, val: any) => {
            filters[col + '__lte'] = val
            return builder
          },
          in: (col: string, vals: any[]) => {
            filters[col + '__in'] = vals
            return builder
          },
          or: (clause: string) => builder,

          then: (resolve?: (val: any) => any, reject?: (err: any) => any) => {
            return executeSelect().then(res => res).then(resolve, reject)
          },

          maybeSingle: async () => {
            const res = await executeSelect()
            return { data: res.data[0] || null, error: null }
          },
          single: async () => {
            const res = await executeSelect()
            if (res.data.length === 0) return { data: null, error: new Error('Row not found') }
            return { data: res.data[0], error: null }
          },

          insert: (payload: any) => ({
            select: () => ({
              single: async () => {
                return executeInsert(payload)
              },
            }),
            then: async (resolve: any) => {
              const res = await executeInsert(payload)
              resolve(res)
            },
          }),

          update: (patch: any) => ({
            eq: (col: string, val: any) => {
              filters[col] = val
              return {
                eq: (c2: string, v2: any) => {
                  filters[c2] = v2
                  return {
                    select: () => ({ single: async () => executeUpdate(patch) }),
                    then: async (resolve: any) => resolve(executeUpdate(patch)),
                  }
                },
                select: () => ({ single: async () => executeUpdate(patch) }),
                then: async (resolve: any) => resolve(executeUpdate(patch)),
              }
            }
          }),

          delete: () => ({
            eq: (col: string, val: any) => {
              filters[col] = val
              return {
                then: async (resolve: any) => resolve(executeDelete()),
              }
            }
          }),
        }

        const executeSelect = async () => {
          let source: any[] = []
          if (table === 'clients') source = this.clients
          else if (table === 'visits') source = this.visits
          else if (table === 'ai_reminders') source = this.reminders

          // RLS Policy Check for SELECT: auth.uid() = owner_user_id (if not admin/service role)
          let visible = source.filter(row => {
            if (currentUserId !== null && row.owner_user_id !== currentUserId) {
              return false
            }
            return true
          })

          for (const [k, v] of Object.entries(filters)) {
            if (k.endsWith('__in')) {
              const baseCol = k.replace('__in', '')
              visible = visible.filter(r => (v as any[]).includes(r[baseCol]))
            } else if (k.endsWith('__gte')) {
              const baseCol = k.replace('__gte', '')
              visible = visible.filter(r => r[baseCol] !== null && r[baseCol] !== undefined && r[baseCol] >= v)
            } else if (k.endsWith('__lte')) {
              const baseCol = k.replace('__lte', '')
              visible = visible.filter(r => r[baseCol] !== null && r[baseCol] !== undefined && r[baseCol] <= v)
            } else {
              visible = visible.filter(r => r[k] === v)
            }
          }

          if (orderConfig) {
            const { col, ascending } = orderConfig
            visible = [...visible].sort((a, b) => {
              const valA = a[col] ?? ''
              const valB = b[col] ?? ''
              if (valA < valB) return ascending ? -1 : 1
              if (valA > valB) return ascending ? 1 : -1
              return 0
            })
          }

          const totalMatched = visible.length

          if (limitVal !== null) {
            visible = visible.slice(0, limitVal)
          }

          if (rangeFilter) {
            visible = visible.slice(rangeFilter[0], rangeFilter[1] + 1)
          }

          return {
            data: headOption ? [] : visible,
            count: countOption ? totalMatched : null,
            error: null,
          }
        }

        const executeInsert = async (payload: any) => {
          const rows = Array.isArray(payload) ? payload : [payload]
          for (const item of rows) {
            const ownerId = item.owner_user_id || currentUserId
            // RLS WITH CHECK (auth.uid() = owner_user_id)
            if (currentUserId !== null && ownerId !== currentUserId) {
              return { data: null, error: new Error('RLS check violation: auth.uid() != owner_user_id') }
            }

            // For visits, verify client relationship
            if (table === 'visits' && currentUserId !== null && item.client_id) {
              const clientMatch = this.clients.find(c => c.id === item.client_id && c.owner_user_id === currentUserId)
              if (!clientMatch) {
                return { data: null, error: new Error('RLS check violation: visit client_id does not belong to owner') }
              }
            }

            const newRow = {
              ...item,
              id: item.id || `gen-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
              owner_user_id: ownerId,
            }
            if (table === 'clients') this.clients.push(newRow)
            else if (table === 'visits') this.visits.push(newRow)
            else if (table === 'ai_reminders') {
              // Check primary key conflict for idempotency
              if (this.reminders.some(r => r.id === newRow.id)) {
                return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint' } }
              }
              this.reminders.push(newRow)
            }
          }
          return { data: rows[0], error: null }
        }

        const executeUpdate = async (patch: any) => {
          let source: any[] = []
          if (table === 'clients') source = this.clients
          else if (table === 'visits') source = this.visits
          else if (table === 'ai_reminders') source = this.reminders

          let updatedCount = 0
          for (const row of source) {
            let matches = true
            for (const [k, v] of Object.entries(filters)) {
              if (row[k] !== v) { matches = false; break }
            }
            if (matches) {
              // RLS USING (auth.uid() = owner_user_id)
              if (currentUserId !== null && row.owner_user_id !== currentUserId) {
                continue
              }
              Object.assign(row, patch)
              updatedCount++
            }
          }
          return { count: updatedCount, error: null }
        }

        const executeDelete = async () => {
          let source: any[] = []
          if (table === 'clients') source = this.clients
          else if (table === 'visits') source = this.visits
          else if (table === 'ai_reminders') source = this.reminders

          let deletedCount = 0
          for (let i = source.length - 1; i >= 0; i--) {
            const row = source[i]
            let matches = true
            for (const [k, v] of Object.entries(filters)) {
              if (row[k] !== v) { matches = false; break }
            }
            if (matches) {
              // RLS USING (auth.uid() = owner_user_id)
              if (currentUserId !== null && row.owner_user_id !== currentUserId) {
                continue
              }
              source.splice(i, 1)
              deletedCount++
            }
          }
          return { count: deletedCount, error: null }
        }

        return builder
      }
    }
  }
}

describe('SECURITY/HARDENING — User Data Isolation Regression Suite', () => {

  // 1. User A can read own client
  it('1. User A can read own client', async () => {
    const db = new SimulatedRlsDatabase()
    db.clients.push({
      id: 'client-a-1',
      owner_user_id: USER_A,
      business_name: 'Biznesi i User A',
      status: 'prospect',
      business_type: null,
      zone: 'Z4',
      address: 'Tirane',
      lat: null,
      lng: null,
      phone: null,
      contact_person: null,
      general_notes: null,
      next_action: null,
      next_followup: null,
      decline_reason: null,
      order_value: null,
      source: null,
      maps_url: null,
      created_at: '2026-09-20T10:00:00Z',
      updated_at: null,
    })

    const clientForUserA = db.createClient(USER_A)
    const { data: readClient } = await clientForUserA
      .from('clients')
      .select('*')
      .eq('id', 'client-a-1')
      .maybeSingle()

    assert.ok(readClient)
    assert.equal(readClient?.id, 'client-a-1')
    assert.equal(readClient?.owner_user_id, USER_A)
  })

  // 2. User B cannot read User A client
  it('2. User B cannot read User A client', async () => {
    const db = new SimulatedRlsDatabase()
    db.clients.push({
      id: 'client-a-secret',
      owner_user_id: USER_A,
      business_name: 'Top Secret Biznes User A',
      status: 'prospect',
      business_type: null,
      zone: 'Z4',
      address: 'Tirane',
      lat: null,
      lng: null,
      phone: null,
      contact_person: null,
      general_notes: null,
      next_action: null,
      next_followup: null,
      decline_reason: null,
      order_value: null,
      source: null,
      maps_url: null,
      created_at: '2026-09-20T10:00:00Z',
      updated_at: null,
    })

    const clientForUserB = db.createClient(USER_B)
    const { data: readClient } = await clientForUserB
      .from('clients')
      .select('*')
      .eq('id', 'client-a-secret')
      .maybeSingle()

    assert.equal(readClient, null, 'User B must not receive User A client row under RLS')
  })

  // 3. User B cannot update User A client
  it('3. User B cannot update User A client', async () => {
    const db = new SimulatedRlsDatabase()
    db.clients.push({
      id: 'client-a-immutable',
      owner_user_id: USER_A,
      business_name: 'Emri Origjinal',
      status: 'prospect',
      business_type: null,
      zone: 'Z4',
      address: 'Tirane',
      lat: null,
      lng: null,
      phone: null,
      contact_person: null,
      general_notes: null,
      next_action: null,
      next_followup: null,
      decline_reason: null,
      order_value: null,
      source: null,
      maps_url: null,
      created_at: '2026-09-20T10:00:00Z',
      updated_at: null,
    })

    const clientForUserB = db.createClient(USER_B)
    const { count } = await (clientForUserB as any)
      .from('clients')
      .update({ business_name: 'Hacked by User B' })
      .eq('id', 'client-a-immutable')

    assert.equal(count, 0, 'User B update must modify 0 rows of User A')
    assert.equal(db.clients[0].business_name, 'Emri Origjinal', 'User A client must remain unmodified')
  })

  // 4. User B cannot delete User A client
  it('4. User B cannot delete User A client', async () => {
    const db = new SimulatedRlsDatabase()
    db.clients.push({
      id: 'client-a-undeletable',
      owner_user_id: USER_A,
      business_name: 'Biznes A i paprekshëm',
      status: 'prospect',
      business_type: null,
      zone: 'Z4',
      address: 'Tirane',
      lat: null,
      lng: null,
      phone: null,
      contact_person: null,
      general_notes: null,
      next_action: null,
      next_followup: null,
      decline_reason: null,
      order_value: null,
      source: null,
      maps_url: null,
      created_at: '2026-09-20T10:00:00Z',
      updated_at: null,
    })

    const clientForUserB = db.createClient(USER_B)
    const { count } = await (clientForUserB as any)
      .from('clients')
      .delete()
      .eq('id', 'client-a-undeletable')

    assert.equal(count, 0, 'User B delete must remove 0 rows')
    assert.equal(db.clients.length, 1, 'User A client must remain in database')
  })

  // 5. User B cannot create a visit attached to User A client
  it('5. User B cannot create a visit attached to User A client (RLS and Lifecycle validation)', async () => {
    const db = new SimulatedRlsDatabase()
    const clientA: Client & { owner_user_id: string } = {
      id: 'client-a-target',
      owner_user_id: USER_A,
      business_name: 'Target Client User A',
      status: 'prospect',
      business_type: null,
      zone: 'Z4',
      address: 'Tirane',
      lat: null,
      lng: null,
      phone: null,
      contact_person: null,
      general_notes: null,
      next_action: null,
      next_followup: null,
      decline_reason: null,
      order_value: null,
      source: null,
      maps_url: null,
      created_at: '2026-09-20T10:00:00Z',
      updated_at: null,
    }
    db.clients.push(clientA)

    // 5a. Database RLS engine rejection
    const clientForUserB = db.createClient(USER_B)
    const dbRes = await (clientForUserB as any).from('visits').insert({
      id: 'visit-b-cross',
      client_id: 'client-a-target',
      owner_user_id: USER_B,
      business_name: 'Illegal cross-user visit',
      visit_date: '2026-09-20',
      statusi: 'Catalog sent',
      shenime: 'Cross user visit',
      created_at: '2026-09-20T11:00:00Z',
      updated_at: null,
    })
    assert.ok(dbRes.error, 'Database RLS must reject attaching visit to other user client')

    // 5b. Application layer lifecycle rejection
    // User B's loaded client list (RLS-filtered) does not contain User A's client
    const userBClients: Client[] = [] // User B has no clients loaded
    const adapterB: LifecycleDbAdapter = {
      createClient: async () => ({ data: null, error: null }),
      deleteClient: async () => ({ error: null }),
      updateClientStatus: async () => ({ error: null }),
      createVisit: async (v) => ({ data: v as any, error: null }),
      updateVisit: async () => ({ data: null, error: null }),
      deleteVisit: async () => ({ error: null }),
    }

    const result = await orchestrateUpsertVisit({
      payload: {
        client_id: 'client-a-target',
        owner_user_id: USER_B,
        business_name: 'Target Client User A',
        visit_date: '2026-09-20',
        statusi: 'Catalog sent',
        shenime: 'Note',
        location_url: null,
      },
      clients: userBClients,
      adapter: adapterB,
    })

    assert.equal(result.ok, false)
    assert.match(result.error || '', /nuk ju përket juve|nuk ekziston/)
  })

  // 6. User B can create own client
  it('6. User B can create own client', async () => {
    const db = new SimulatedRlsDatabase()
    const clientForUserB = db.createClient(USER_B)

    const newClientPayload = {
      business_name: 'Klient i Ri User B',
      status: 'prospect',
      owner_user_id: USER_B,
      zone: 'Z1',
    }

    const { data: createdClient, error } = await (clientForUserB as any)
      .from('clients')
      .insert(newClientPayload)

    assert.equal(error, null)
    assert.ok(createdClient)
    assert.equal(createdClient.owner_user_id, USER_B)
    assert.equal(db.clients.length, 1)
    assert.equal(db.clients[0].owner_user_id, USER_B)
  })

  // 7. User A cannot read User B client
  it('7. User A cannot read User B client', async () => {
    const db = new SimulatedRlsDatabase()
    db.clients.push({
      id: 'client-b-private',
      owner_user_id: USER_B,
      business_name: 'Biznes Privat User B',
      status: 'Customer/Purchase',
      business_type: 'Cafe',
      zone: 'Z2',
      address: 'Blloku',
      lat: null,
      lng: null,
      phone: null,
      contact_person: null,
      general_notes: null,
      next_action: null,
      next_followup: null,
      decline_reason: null,
      order_value: null,
      source: null,
      maps_url: null,
      created_at: '2026-09-20T10:00:00Z',
      updated_at: null,
    })

    const clientForUserA = db.createClient(USER_A)
    const { data: readClient } = await clientForUserA
      .from('clients')
      .select('*')
      .eq('id', 'client-b-private')
      .maybeSingle()

    assert.equal(readClient, null, 'User A must not be permitted to read User B client')
  })

  // 8. Visit ownership propagates correctly
  it('8. Visit ownership propagates correctly', async () => {
    let persistedVisit: any = null
    const adapter: LifecycleDbAdapter = {
      createClient: async (c) => ({ data: { id: 'c-new-b', ...c } as any, error: null }),
      deleteClient: async () => ({ error: null }),
      updateClientStatus: async () => ({ error: null }),
      createVisit: async (v) => {
        persistedVisit = v
        return { data: { id: 'v-new-b', ...v } as any, error: null }
      },
      updateVisit: async () => ({ data: null, error: null }),
      deleteVisit: async () => ({ error: null }),
    }

    const res = await orchestrateUpsertVisit({
      payload: {
        business_name: 'Biznes i Ri nga User B',
        visit_date: '2026-09-20',
        owner_user_id: USER_B,
        statusi: 'prospect',
        shenime: 'Takim i pare',
        client_id: null,
        location_url: null,
      },
      clients: [],
      adapter,
    })

    assert.equal(res.ok, true)
    assert.ok(persistedVisit)
    assert.equal(persistedVisit.owner_user_id, USER_B, 'Visit must carry authenticated user ID')
  })

  // 9. Reminder ownership propagates from authoritative visit
  it('9. Reminder ownership propagates from authoritative visit', async () => {
    let insertedReminder: any = null
    const mockAdminSb: any = {
      from: (table: string) => ({
        insert: (row: any) => {
          insertedReminder = row
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: row.id }, error: null })
            })
          }
        }
      })
    }

    const authoritativeInput: VisitExtractionInput = {
      visit_id: 'v-b-100',
      owner_user_id: USER_B,
      client_id: 'c-b-200',
      business_name: 'Biznes B',
      visit_date: '2026-09-20',
      shenime: 'Telefono neser ne 10:00',
    }

    const extraction: VisitAIExtraction = {
      hasReminder: true,
      actionType: 'call',
      description: 'Telefono neser ne 10:00',
      dueDate: '2026-09-21',
      dueTime: '10:00',
      priority: 'high',
      rawTrigger: 'telefono neser',
      summary: 'Kerkese',
    }

    const persistRes = await persistActionableReminder(authoritativeInput, extraction, mockAdminSb)
    assert.equal(persistRes.alreadyExists, false)
    assert.equal(insertedReminder.owner_user_id, USER_B, 'Reminder must inherit owner_user_id from authoritative visit')
  })

  // 10. Inngest cannot process visitId under the wrong ownerUserId
  it('10. Inngest cannot process visitId under the wrong ownerUserId', async () => {
    const db = new SimulatedRlsDatabase()
    // Visit belongs to User A
    db.visits.push({
      id: 'visit-a-101',
      owner_user_id: USER_A,
      visit_date: '2026-09-20',
      business_name: 'Kafe Bar A',
      shenime: 'Porosia neser ne 10:00',
      client_id: null,
      location_url: null,
      statusi: null,
      created_at: '2026-09-20T10:00:00Z',
      updated_at: null,
    })

    const adminSb = db.createClient(null) // admin bypasses RLS, but query filters by owner_user_id

    // Attempting to load visit-a-101 claiming it belongs to USER_B must reject
    await assert.rejects(
      async () => {
        await loadAuthoritativeRecord('visit-a-101', USER_B, adminSb as any)
      },
      (err: any) => err instanceof NonRetriableError,
      'Must throw NonRetriableError when visit does not belong to ownerUserId'
    )

    // Loading with legitimate USER_A succeeds
    const recordA = await loadAuthoritativeRecord('visit-a-101', USER_A, adminSb as any)
    assert.equal(recordA.hasNotes, true)
    assert.equal(recordA.input?.visit_id, 'visit-a-101')
    assert.equal(recordA.input?.owner_user_id, USER_A)
  })

  // 11. Idempotency still works
  it('11. Idempotency still works across duplicate executions', async () => {
    const db = new SimulatedRlsDatabase()
    const adminSb = db.createClient(null)

    const input: VisitExtractionInput = {
      visit_id: 'visit-idempotent-1',
      owner_user_id: USER_A,
      client_id: null,
      business_name: 'Biznes Idempotent',
      visit_date: '2026-09-20',
      shenime: 'Telefono klientin',
    }

    const extraction: VisitAIExtraction = {
      hasReminder: true,
      actionType: 'call',
      description: 'Telefono klientin',
      dueDate: '2026-09-21',
      dueTime: '10:00',
      priority: 'medium',
      rawTrigger: 'telefono',
      summary: 'Kujtese',
    }

    // First execution -> inserts reminder
    const firstRes = await persistActionableReminder(input, extraction, adminSb as any)
    assert.equal(firstRes.alreadyExists, false)
    assert.equal(firstRes.id, deterministicReminderId(input.visit_id))
    assert.equal(db.reminders.length, 1)

    // Second execution -> catches duplicate key and returns alreadyExists: true
    const secondRes = await persistActionableReminder(input, extraction, adminSb as any)
    assert.equal(secondRes.alreadyExists, true)
    assert.equal(secondRes.id, deterministicReminderId(input.visit_id))
    assert.equal(db.reminders.length, 1, 'No duplicate row must be added')
  })

  // 12. Chat context is owner-scoped
  it('12. Chat context is owner-scoped (User B cannot see User A data in CRM chat)', async () => {
    const db = new SimulatedRlsDatabase()

    // Populate User A data
    db.clients.push({
      id: 'c-a-1',
      owner_user_id: USER_A,
      business_name: 'Klinika Stomatologjike A',
      status: 'Customer/Purchase',
      business_type: null,
      zone: 'Z1',
      address: 'Tirane',
      lat: null,
      lng: null,
      phone: null,
      contact_person: null,
      general_notes: null,
      next_action: 'Merr pagesen',
      next_followup: '2026-09-20',
      decline_reason: null,
      order_value: null,
      source: null,
      maps_url: null,
      created_at: '2026-09-20T08:00:00Z',
      updated_at: null,
    })
    db.visits.push({
      id: 'v-a-1',
      owner_user_id: USER_A,
      client_id: 'c-a-1',
      business_name: 'Klinika Stomatologjike A',
      visit_date: '2026-09-20',
      statusi: 'Customer/Purchase',
      shenime: 'Pagesa u mor',
      location_url: null,
      created_at: '2026-09-20T09:00:00Z',
      updated_at: null,
    })
    db.reminders.push({
      id: 'rem-a-1',
      owner_user_id: USER_A,
      client_id: 'c-a-1',
      visit_id: 'v-a-1',
      business_name: 'Klinika Stomatologjike A',
      action_type: 'call',
      description: 'Sekret A kujtese',
      priority: 'high',
      due_date: '2026-09-20',
      due_time: '12:00',
      is_dismissed: false,
    })

    // Populate User B data
    db.clients.push({
      id: 'c-b-1',
      owner_user_id: USER_B,
      business_name: 'Restorant Tradicional B',
      status: 'prospect',
      business_type: null,
      zone: 'Z3',
      address: 'Durres',
      lat: null,
      lng: null,
      phone: null,
      contact_person: null,
      general_notes: null,
      next_action: 'Prezanto menune',
      next_followup: '2026-09-20',
      decline_reason: null,
      order_value: null,
      source: null,
      maps_url: null,
      created_at: '2026-09-20T08:00:00Z',
      updated_at: null,
    })
    db.visits.push({
      id: 'v-b-1',
      owner_user_id: USER_B,
      client_id: 'c-b-1',
      business_name: 'Restorant Tradicional B',
      visit_date: '2026-09-20',
      statusi: 'prospect',
      shenime: 'Diskutuam per menune',
      location_url: null,
      created_at: '2026-09-20T09:00:00Z',
      updated_at: null,
    })
    db.reminders.push({
      id: 'rem-b-1',
      owner_user_id: USER_B,
      client_id: 'c-b-1',
      visit_id: 'v-b-1',
      business_name: 'Restorant Tradicional B',
      action_type: 'meeting',
      description: 'Takim per menune',
      priority: 'medium',
      due_date: '2026-09-20',
      due_time: '16:00',
      is_dismissed: false,
    })

    // Query chat context as User B
    const clientForUserB = db.createClient(USER_B)
    const contextResult = await buildCompactCRMContext(
      clientForUserB as any,
      'çfarë detyrash kam sot?',
      '2026-09-20',
      USER_B
    )

    const text = contextResult.text
    // User B data must be present
    assert.ok(text.includes('Restorant Tradicional B'), 'User B context must include User B client')
    assert.ok(text.includes('Takim per menune'), 'User B context must include User B reminder')

    // User A data must NOT be present
    assert.equal(text.includes('Klinika Stomatologjike A'), false, 'User B context must NOT leak User A client')
    assert.equal(text.includes('Sekret A kujtese'), false, 'User B context must NOT leak User A reminder')
    assert.equal(text.includes('Total Clients: 2'), false, 'User B count must NOT aggregate User A clients')
    assert.ok(text.includes('Total Clients: 1'), 'User B client count must strictly equal 1')
  })

  // 13. Daily digest query is owner-scoped
  it('13. Daily digest query is owner-scoped', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-20'

    // Visits and reminders for User A
    db.visits.push({
      id: 'v-a-digest',
      owner_user_id: USER_A,
      visit_date: today,
      business_name: 'Biznes A Digest',
      shenime: 'Shenim A',
      client_id: null,
      location_url: null,
      statusi: null,
      created_at: '2026-09-20T10:00:00Z',
      updated_at: null,
    })
    db.reminders.push({
      id: 'rem-a-digest',
      owner_user_id: USER_A,
      visit_id: 'v-a-digest',
      business_name: 'Biznes A Digest',
      action_type: 'call',
      description: 'Kujtese User A',
      priority: 'high',
      due_date: today,
      due_time: '10:00',
      is_dismissed: false,
    })

    // Visits and reminders for User B
    db.visits.push({
      id: 'v-b-digest',
      owner_user_id: USER_B,
      visit_date: today,
      business_name: 'Biznes B Digest',
      shenime: 'Shenim B',
      client_id: null,
      location_url: null,
      statusi: null,
      created_at: '2026-09-20T10:00:00Z',
      updated_at: null,
    })
    db.reminders.push({
      id: 'rem-b-digest',
      owner_user_id: USER_B,
      visit_id: 'v-b-digest',
      business_name: 'Biznes B Digest',
      action_type: 'meeting',
      description: 'Kujtese User B',
      priority: 'high',
      due_date: today,
      due_time: '11:00',
      is_dismissed: false,
    })

    // Simulate Daily Digest query executed by admin client strictly scoped to USER_A
    const adminSb = db.createClient(null)

    const { data: visitsA } = await adminSb
      .from('visits')
      .select('id, visit_date, business_name, shenime')
      .eq('visit_date', today)
      .eq('owner_user_id', USER_A)

    assert.ok(visitsA)
    assert.equal(visitsA.length, 1)
    assert.equal(visitsA[0].id, 'v-a-digest')

    const visitIds = (visitsA as any[]).map((v: any) => v.id)
    const { data: remindersA } = await adminSb
      .from('ai_reminders')
      .select('id, business_name, action_type, description, due_date, due_time, priority')
      .in('visit_id', visitIds)
      .eq('owner_user_id', USER_A)
      .eq('is_dismissed', false)

    assert.ok(remindersA)
    assert.equal(remindersA.length, 1)
    assert.equal(remindersA[0].id, 'rem-a-digest')
    assert.equal(remindersA[0].description, 'Kujtese User A')
  })


  // 14. Test A: Visit exists on 2026-09-22, today is 2026-09-21. Question about 2026-09-22 includes that visit in CRM context.
  it('14. Test A: Visit on future date (2026-09-22) is retrieved when asked about that date', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    db.visits.push({
      id: 'v-a-future',
      owner_user_id: USER_A,
      client_id: null,
      business_name: 'Bar Restorant Oase',
      visit_date: '2026-09-22',
      statusi: 'takim',
      shenime: 'Takim per furnizim me vere',
      location_url: null,
      created_at: '2026-09-21T10:00:00Z',
      updated_at: null,
    })

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'çfarë vizitash kam më 22 shtator?',
      today,
      USER_A
    )

    const text = contextResult.text
    assert.ok(text.includes('Bar Restorant Oase'), 'Future visit must be present in context for specific date query')
    assert.ok(text.includes('2026-09-22'), 'Target date must appear in context')
    assert.ok(text.includes('Takim per furnizim me vere'), 'Visit notes must be present')
  })

  // 15. Test B: Question "çfarë vizitash kam të regjistruara?" when visits exist on other dates must NOT produce an empty-CRM context.
  it('15. Test B: General visit inventory question does not produce empty-CRM context when visits exist on other dates', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    db.visits.push({
      id: 'v-a-past-1',
      owner_user_id: USER_A,
      client_id: null,
      business_name: 'Pastiçeri Rinia',
      visit_date: '2026-09-18',
      statusi: 'vizitë',
      shenime: 'Porosi e rregullt',
      location_url: null,
      created_at: '2026-09-18T10:00:00Z',
      updated_at: null,
    })
    db.visits.push({
      id: 'v-a-past-2',
      owner_user_id: USER_A,
      client_id: null,
      business_name: 'Hotel Plaza',
      visit_date: '2026-09-19',
      statusi: 'interes',
      shenime: 'Prezantim mostrash',
      location_url: null,
      created_at: '2026-09-19T11:00:00Z',
      updated_at: null,
    })

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'çfarë vizitash kam të regjistruara?',
      today,
      USER_A
    )

    const text = contextResult.text
    assert.equal(text.includes('nuk keni asnjë vizitë të regjistruar në CRM'), false, 'Must not claim CRM has no visits')
    assert.ok(text.includes('Total Registered Visits in CRM: 2'), 'Total visit count must reflect 2 visits')
    assert.ok(text.includes('Pastiçeri Rinia'), 'Must list recent visit Pastiçeri Rinia')
    assert.ok(text.includes('Hotel Plaza'), 'Must list recent visit Hotel Plaza')
  })

  // 16. Test C: Specific-date query with no rows correctly reports zero for THAT DATE only.
  it('16. Test C: Specific-date query with no rows reports zero for that date only, not entire CRM', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    db.visits.push({
      id: 'v-a-exist',
      owner_user_id: USER_A,
      client_id: null,
      business_name: 'Kafe Del Mar',
      visit_date: '2026-09-20',
      statusi: 'vizitë',
      shenime: 'Kafe e mire',
      location_url: null,
      created_at: '2026-09-20T10:00:00Z',
      updated_at: null,
    })

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'çfarë vizitash kam më 25 shtator?',
      today,
      USER_A
    )

    const text = contextResult.text
    assert.ok(text.includes('asnjë vizitë e regjistruar për datën 2026-09-25'), 'Must report 0 visits for 2026-09-25')
    assert.ok(text.includes('Në të gjithë CRM ekzistojnë 1 vizita në data të tjera'), 'Must inform that other visits exist in CRM')
    assert.ok(text.includes('Total Registered Visits in CRM: 1'), 'Authoritative total must be 1')
  })

  // 17. Test D: Total visit count is authoritative.
  it('17. Test D: Total visit count is authoritative in context', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    for (let i = 1; i <= 7; i++) {
      db.visits.push({
        id: `v-a-count-${i}`,
        owner_user_id: USER_A,
        client_id: null,
        business_name: `Biznes Sample ${i}`,
        visit_date: `2026-09-${10 + i}`,
        statusi: 'vizitë',
        shenime: `Shenim ${i}`,
        location_url: null,
        created_at: '2026-09-' + (10 + i) + 'T10:00:00Z',
        updated_at: null,
      })
    }

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'sa vizita kam gjithsej?',
      today,
      USER_A
    )

    assert.equal(contextResult.totalVisitsCount, 7)
    assert.ok(contextResult.text.includes('Total Registered Visits in CRM: 7'), 'Must show exact total 7')
    assert.equal(contextResult.intent?.kind, 'count')
  })

  // 18. Test E: Date-range query returns only rows inside the range.
  it('18. Test E: Date-range query returns only rows inside the specified range', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    db.visits.push(
      {
        id: 'v-before',
        owner_user_id: USER_A,
        client_id: null,
        business_name: 'Biznes Para Rangut',
        visit_date: '2026-09-10',
        statusi: 'vizitë',
        shenime: 'para',
        location_url: null,
        created_at: '2026-09-10T10:00:00Z',
        updated_at: null,
      },
      {
        id: 'v-in-1',
        owner_user_id: USER_A,
        client_id: null,
        business_name: 'Biznes Brenda Rangut 1',
        visit_date: '2026-09-16',
        statusi: 'vizitë',
        shenime: 'brenda 1',
        location_url: null,
        created_at: '2026-09-16T10:00:00Z',
        updated_at: null,
      },
      {
        id: 'v-in-2',
        owner_user_id: USER_A,
        client_id: null,
        business_name: 'Biznes Brenda Rangut 2',
        visit_date: '2026-09-19',
        statusi: 'vizitë',
        shenime: 'brenda 2',
        location_url: null,
        created_at: '2026-09-19T10:00:00Z',
        updated_at: null,
      },
      {
        id: 'v-after',
        owner_user_id: USER_A,
        client_id: null,
        business_name: 'Biznes Pas Rangut',
        visit_date: '2026-09-25',
        statusi: 'vizitë',
        shenime: 'pas',
        location_url: null,
        created_at: '2026-09-25T10:00:00Z',
        updated_at: null,
      }
    )

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'vizitat nga 15 deri më 20 shtator',
      today,
      USER_A
    )

    const text = contextResult.text
    assert.ok(text.includes('Biznes Brenda Rangut 1'), 'Must include row from 2026-09-16')
    assert.ok(text.includes('Biznes Brenda Rangut 2'), 'Must include row from 2026-09-19')
    assert.equal(text.includes('Biznes Para Rangut'), false, 'Must NOT include row before range')
    assert.equal(text.includes('Biznes Pas Rangut'), false, 'Must NOT include row after range')
  })

  // 19. Test F: User B cannot retrieve User A visits through any new query mode.
  it('19. Test F: User B cannot retrieve User A visits through any new query mode (date, range, inventory, count)', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    db.visits.push({
      id: 'v-a-secret',
      owner_user_id: USER_A,
      client_id: null,
      business_name: 'Ekskluzive User A',
      visit_date: '2026-09-22',
      statusi: 'sekret',
      shenime: 'Te dhena sekrete',
      location_url: null,
      created_at: '2026-09-21T10:00:00Z',
      updated_at: null,
    })

    const clientForUserB = db.createClient(USER_B)

    // Mode 1: specific date
    const resDate = await buildCompactCRMContext(clientForUserB as any, 'çfarë vizitash kam më 22 shtator?', today, USER_B)
    assert.equal(resDate.text.includes('Ekskluzive User A'), false, 'User B must not see User A visit via specific_date')
    assert.equal(resDate.totalVisitsCount, 0)

    // Mode 2: inventory
    const resInv = await buildCompactCRMContext(clientForUserB as any, 'çfarë vizitash kam të regjistruara?', today, USER_B)
    assert.equal(resInv.text.includes('Ekskluzive User A'), false, 'User B must not see User A visit via inventory')
    assert.equal(resInv.totalVisitsCount, 0)

    // Mode 3: count
    const resCount = await buildCompactCRMContext(clientForUserB as any, 'sa vizita kam gjithsej?', today, USER_B)
    assert.equal(resCount.text.includes('Ekskluzive User A'), false, 'User B must not see User A visit via count')
    assert.equal(resCount.totalVisitsCount, 0)

    // Mode 4: range
    const resRange = await buildCompactCRMContext(clientForUserB as any, 'vizitat nga 15 deri më 25 shtator', today, USER_B)
    assert.equal(resRange.text.includes('Ekskluzive User A'), false, 'User B must not see User A visit via date_range')
    assert.equal(resRange.totalVisitsCount, 0)

    // Mode 5: month
    const resMonth = await buildCompactCRMContext(clientForUserB as any, 'vizitat këtë muaj', today, USER_B)
    assert.equal(resMonth.text.includes('Ekskluzive User A'), false, 'User B must not see User A visit via month')
    assert.equal(resMonth.totalVisitsCount, 0)
  })

  // 20. Test G: Follow-up "po në 22?" can resolve using recent conversation context.
  it('20. Test G: Follow-up "po në 22?" resolves using conversation history', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    db.visits.push({
      id: 'v-a-22',
      owner_user_id: USER_A,
      client_id: null,
      business_name: 'Tirana Business Hub',
      visit_date: '2026-09-22',
      statusi: 'takim',
      shenime: 'Prezantim final',
      location_url: null,
      created_at: '2026-09-21T10:00:00Z',
      updated_at: null,
    })

    const conversationHistory: any[] = [
      { role: 'user', content: 'çfarë vizitash kam këtë muaj?' },
      { role: 'assistant', content: 'Këtë muaj keni disa vizita të planifikuara...' },
    ]

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'po në 22?',
      today,
      USER_A,
      conversationHistory
    )

    assert.equal(contextResult.intent?.kind, 'specific_date')
    assert.equal(contextResult.intent?.targetDate, '2026-09-22')
    assert.ok(contextResult.text.includes('Tirana Business Hub'), 'Must find visit on 22nd using history context')
    assert.ok(contextResult.text.includes('2026-09-22'), 'Date 2026-09-22 must be in context')
  })

  // 21. Test H: Existing client-specific visit retrieval remains functional.
  it('21. Test H: Existing client-specific visit retrieval remains functional', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    db.clients.push({
      id: 'c-oase',
      owner_user_id: USER_A,
      business_name: 'Restorant Oase',
      status: 'active',
      business_type: 'Restorant',
      zone: 'Blloku',
      address: 'Rruga Brigada VIII',
      lat: null,
      lng: null,
      phone: null,
      contact_person: null,
      general_notes: null,
      next_action: 'Marrja e pageses',
      next_followup: '2026-09-22',
      decline_reason: null,
      order_value: null,
      source: null,
      maps_url: null,
      created_at: '2026-09-10T08:00:00Z',
      updated_at: null,
    })

    db.visits.push({
      id: 'v-oase-1',
      owner_user_id: USER_A,
      client_id: 'c-oase',
      business_name: 'Restorant Oase',
      visit_date: '2026-09-14',
      statusi: 'vizitë',
      shenime: 'U la porosia e veres',
      location_url: null,
      created_at: '2026-09-14T09:00:00Z',
      updated_at: null,
    })

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'çfarë vizitash kam bërë te Oase?',
      today,
      USER_A
    )

    const text = contextResult.text
    assert.equal(contextResult.matchedClientName, 'Restorant Oase')
    assert.ok(text.includes('=== SPECIFIC CLIENT DETAILS FOR "Restorant Oase" ==='), 'Client header must be present')
    assert.ok(text.includes('U la porosia e veres'), 'Past visit notes for specific client must be present')
  })

  // 22. Test I: When two different months exist in history, newest month wins and older messages do not overwrite it
  it('22. Test I: When multiple months exist in history, the newest month wins', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    // Add visits on 2026-08-22 and 2026-09-22
    db.visits.push(
      {
        id: 'v-aug-22',
        owner_user_id: USER_A,
        client_id: null,
        business_name: 'Biznes Gusht 22',
        visit_date: '2026-08-22',
        statusi: 'vizitë',
        shenime: 'Vizite e vjeter ne gusht',
        location_url: null,
        created_at: '2026-08-22T10:00:00Z',
        updated_at: null,
      },
      {
        id: 'v-sep-22',
        owner_user_id: USER_A,
        client_id: null,
        business_name: 'Biznes Shtator 22',
        visit_date: '2026-09-22',
        statusi: 'vizitë',
        shenime: 'Vizite me e re ne shtator',
        location_url: null,
        created_at: '2026-09-21T10:00:00Z',
        updated_at: null,
      }
    )

    const conversationHistory: any[] = [
      { role: 'user', content: 'çfarë vizitash pata në gusht?' },
      { role: 'assistant', content: 'Në gusht keni pasur vizitën te Biznes Gusht 22.' },
      { role: 'user', content: 'çfarë vizitash kam në shtator?' },
      { role: 'assistant', content: 'Në shtator keni disa vizita të planifikuara.' },
    ]

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'po në 22?',
      today,
      USER_A,
      conversationHistory
    )

    // Newest month (shtator = 9) must win over older month (gusht = 8)
    assert.equal(contextResult.intent?.kind, 'specific_date')
    assert.equal(contextResult.intent?.targetDate, '2026-09-22', 'Newest month (September) must win over August')
    assert.ok(contextResult.text.includes('Biznes Shtator 22'), 'Context must include September 22 visit')
    assert.equal(contextResult.text.includes('Biznes Gusht 22'), false, 'Context must NOT include August 22 visit')
  })

  // 23. Test J: Resolves explicit year from conversation history when present
  it('23. Test J: Resolves explicit year from conversation history (e.g. vizitat e dhjetorit 2025 -> po në 22? -> 2025-12-22)', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    db.visits.push({
      id: 'v-2025-12-22',
      owner_user_id: USER_A,
      client_id: null,
      business_name: 'Viti Kaluar Biznes 2025',
      visit_date: '2025-12-22',
      statusi: 'takim',
      shenime: 'Mbyllje e vitit 2025',
      location_url: null,
      created_at: '2025-12-22T10:00:00Z',
      updated_at: null,
    })

    const conversationHistory: any[] = [
      { role: 'user', content: 'vizitat e dhjetorit 2025' },
      { role: 'assistant', content: 'Në dhjetor 2025 keni pasur vizita mbyllëse të vitit.' },
    ]

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'po në 22?',
      today,
      USER_A,
      conversationHistory
    )

    // Year 2025 and month 12 must be resolved from conversation history
    assert.equal(contextResult.intent?.kind, 'specific_date')
    assert.equal(contextResult.intent?.targetDate, '2025-12-22', 'Target date must resolve to 2025-12-22, not current year')
    assert.ok(contextResult.text.includes('Viti Kaluar Biznes 2025'), 'Context must include visit from 2025-12-22')
  })

  // 24. Regression Test A: historical month query (dhjetor 2025) resolves as month range
  it('24. Regression Test A: historical month query (dhjetor 2025) resolves as month range', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    db.visits.push(
      {
        id: 'v-dec-2025',
        owner_user_id: USER_A,
        client_id: null,
        business_name: 'Biznes Dhjetor 2025',
        visit_date: '2025-12-15',
        statusi: 'takim',
        shenime: 'Takim fundviti 2025',
        location_url: null,
        created_at: '2025-12-15T10:00:00Z',
        updated_at: null,
      },
      {
        id: 'v-sep-2026',
        owner_user_id: USER_A,
        client_id: null,
        business_name: 'Biznes Shtator 2026',
        visit_date: '2026-09-15',
        statusi: 'vizitë',
        shenime: 'Vizite shtatori',
        location_url: null,
        created_at: '2026-09-15T10:00:00Z',
        updated_at: null,
      }
    )

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'vizitat e dhjetorit 2025',
      today,
      USER_A
    )

    assert.equal(contextResult.intent?.kind, 'month')
    assert.equal(contextResult.intent?.from, '2025-12-01')
    assert.equal(contextResult.intent?.to, '2025-12-31')
    assert.ok(contextResult.text.includes('Biznes Dhjetor 2025'))
    assert.equal(contextResult.text.includes('Biznes Shtator 2026'), false)
  })

  // 25. Regression Test B: current-year named month query (shtator) resolves as month range
  it('25. Regression Test B: current-year named month query (shtator) resolves as month range', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    db.visits.push(
      {
        id: 'v-sep-2026',
        owner_user_id: USER_A,
        client_id: null,
        business_name: 'Biznes Brenda Shtatorit',
        visit_date: '2026-09-18',
        statusi: 'vizitë',
        shenime: 'Brenda shtatorit',
        location_url: null,
        created_at: '2026-09-18T10:00:00Z',
        updated_at: null,
      },
      {
        id: 'v-aug-2026',
        owner_user_id: USER_A,
        client_id: null,
        business_name: 'Biznes Brenda Gushtit',
        visit_date: '2026-08-18',
        statusi: 'vizitë',
        shenime: 'Brenda gushtit',
        location_url: null,
        created_at: '2026-08-18T10:00:00Z',
        updated_at: null,
      }
    )

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'vizitat e shtatorit',
      today,
      USER_A
    )

    assert.equal(contextResult.intent?.kind, 'month')
    assert.equal(contextResult.intent?.from, '2026-09-01')
    assert.equal(contextResult.intent?.to, '2026-09-30')
    assert.ok(contextResult.text.includes('Biznes Brenda Shtatorit'))
    assert.equal(contextResult.text.includes('Biznes Brenda Gushtit'), false)
  })

  // 26. Regression Test C: numeric date 22/09 resolves as specific_date
  it('26. Regression Test C: numeric date 22/09 resolves as specific_date', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    db.visits.push({
      id: 'v-22-09',
      owner_user_id: USER_A,
      client_id: null,
      business_name: 'Biznes Numerik 22/09',
      visit_date: '2026-09-22',
      statusi: 'vizitë',
      shenime: 'Vizite me date numerike',
      location_url: null,
      created_at: '2026-09-21T10:00:00Z',
      updated_at: null,
    })

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'çfarë vizitash kam më 22/09?',
      today,
      USER_A
    )

    assert.equal(contextResult.intent?.kind, 'specific_date')
    assert.equal(contextResult.intent?.targetDate, '2026-09-22')
    assert.ok(contextResult.text.includes('Biznes Numerik 22/09'))
  })

  // 27. Regression Test D: numeric date 22/09/2026 resolves as specific_date
  it('27. Regression Test D: numeric date 22/09/2026 resolves as specific_date', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    db.visits.push({
      id: 'v-22-09-2026',
      owner_user_id: USER_A,
      client_id: null,
      business_name: 'Biznes Numerik 22/09/2026',
      visit_date: '2026-09-22',
      statusi: 'takim',
      shenime: 'Vizite me date te plote',
      location_url: null,
      created_at: '2026-09-21T10:00:00Z',
      updated_at: null,
    })

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'vizitat më 22/09/2026',
      today,
      USER_A
    )

    assert.equal(contextResult.intent?.kind, 'specific_date')
    assert.equal(contextResult.intent?.targetDate, '2026-09-22')
    assert.ok(contextResult.text.includes('Biznes Numerik 22/09/2026'))
  })

  // 28. Regression Test E: month and year from unrelated history turns never get combined
  it('28. Regression Test E: month and year from unrelated history turns never get combined (dhjetor 2025 + shtator -> po në 22? -> 2026-09-22)', async () => {
    const db = new SimulatedRlsDatabase()
    const today = '2026-09-21'

    db.visits.push(
      {
        id: 'v-sep-2026-22',
        owner_user_id: USER_A,
        client_id: null,
        business_name: 'Biznes Shtator 2026',
        visit_date: '2026-09-22',
        statusi: 'vizitë',
        shenime: 'Shtator 2026 i sakte',
        location_url: null,
        created_at: '2026-09-21T10:00:00Z',
        updated_at: null,
      },
      {
        id: 'v-sep-2025-22',
        owner_user_id: USER_A,
        client_id: null,
        business_name: 'Biznes Shtator 2025 Gabim',
        visit_date: '2025-09-22',
        statusi: 'vizitë',
        shenime: 'Nuk duhet te shfaqet kurre',
        location_url: null,
        created_at: '2025-09-21T10:00:00Z',
        updated_at: null,
      }
    )

    const conversationHistory: any[] = [
      { role: 'user', content: 'vizitat e dhjetorit 2025' },
      { role: 'assistant', content: 'Në dhjetor 2025 keni pasur vizita...' },
      { role: 'user', content: 'vizitat në shtator' },
      { role: 'assistant', content: 'Në shtator keni planifikuar disa vizita...' },
    ]

    const clientForUserA = db.createClient(USER_A)
    const contextResult = await buildCompactCRMContext(
      clientForUserA as any,
      'po në 22?',
      today,
      USER_A,
      conversationHistory
    )

    // Must resolve to 2026-09-22, NOT 2025-09-22
    assert.equal(contextResult.intent?.kind, 'specific_date')
    assert.equal(contextResult.intent?.targetDate, '2026-09-22', 'Must resolve to 2026-09-22, never combining 2025 with September')
    assert.ok(contextResult.text.includes('Biznes Shtator 2026'))
    assert.equal(contextResult.text.includes('Biznes Shtator 2025 Gabim'), false)
  })
})
