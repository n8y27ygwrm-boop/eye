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

        const builder = {
          select: (fields?: string) => builder,
          order: () => builder,
          range: (from: number, to: number) => {
            rangeFilter = [from, to]
            return builder
          },
          eq: (col: string, val: any) => {
            filters[col] = val
            return builder
          },
          in: (col: string, vals: any[]) => {
            filters[col + '__in'] = vals
            return builder
          },
          or: (clause: string) => builder,
          limit: () => builder,

          then: async (resolve: any) => {
            const rows = await executeSelect()
            resolve({ data: rows, error: null })
          },

          maybeSingle: async () => {
            const rows = await executeSelect()
            return { data: rows[0] || null, error: null }
          },
          single: async () => {
            const rows = await executeSelect()
            if (rows.length === 0) return { data: null, error: new Error('Row not found') }
            return { data: rows[0], error: null }
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
            } else {
              visible = visible.filter(r => r[k] === v)
            }
          }

          if (rangeFilter) {
            visible = visible.slice(rangeFilter[0], rangeFilter[1] + 1)
          }

          return visible
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

    const visitIds = visitsA.map(v => v.id)
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

})
