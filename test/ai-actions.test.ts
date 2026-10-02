
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MAX_CURRENT_MESSAGE_CHARS, MAX_HISTORY_CONTENT_CHARS, MAX_HISTORY_MESSAGES, boundConversationHistory } from '../lib/ai/history'
import { classifyConfirmationMessage } from '../lib/ai/confirmation'
import { executePendingCRMAction, resolveActionDate, resolveProposedCRMAction, type ActionClientRecord, type ActionReminderRecord, type CRMActionStore } from '../lib/ai/actions/server'
import type { PendingCRMAction } from '../lib/ai/actions/types'

type OwnedClient = ActionClientRecord & { owner: string }
type OwnedReminder = ActionReminderRecord & { owner: string }

function createMemoryStore() {
  const clients: OwnedClient[] = [
    { id: 'client-a', owner: 'owner-a', business_name: 'Oase Restaurant', status: 'prospect', next_action: null, next_followup: null },
    { id: 'client-b', owner: 'owner-b', business_name: 'Other Owner Client', status: 'prospect', next_action: null, next_followup: null },
    { id: 'client-bar-1', owner: 'owner-a', business_name: 'Bar Alpha', status: 'prospect', next_action: null, next_followup: null },
    { id: 'client-bar-2', owner: 'owner-a', business_name: 'Bar Beta', status: 'prospect', next_action: null, next_followup: null },
  ]
  const reminders: OwnedReminder[] = [
    { id: 'rem-a', owner: 'owner-a', business_name: 'Oase Restaurant', description: 'Telefono klientin', is_dismissed: false },
    { id: 'rem-b', owner: 'owner-b', business_name: 'Other Owner Client', description: 'Private reminder', is_dismissed: false },
  ]
  let writes = 0
  let failWrites = false
  const store: CRMActionStore = {
    async listClients(owner) { return { data: clients.filter(c => c.owner === owner), error: null } },
    async listActiveReminders(owner) { return { data: reminders.filter(r => r.owner === owner && !r.is_dismissed), error: null } },
    async getClient(owner, id) { return { data: clients.find(c => c.owner === owner && c.id === id) ?? null, error: null } },
    async getReminder(owner, id) { return { data: reminders.find(r => r.owner === owner && r.id === id) ?? null, error: null } },
    async updateClientFollowup(owner, id, expected, patch) {
      if (failWrites) return { data: null, error: 'forced write failure' }
      const row = clients.find(c => c.owner === owner && c.id === id)
      if (!row || row.next_followup !== expected.next_followup || ('next_action' in patch && row.next_action !== expected.next_action)) return { data: null, error: null }
      writes++; row.next_followup = patch.next_followup; if ('next_action' in patch) row.next_action = patch.next_action ?? null
      return { data: row, error: null }
    },
    async updateClientStatus(owner, id, expectedStatus, status) {
      if (failWrites) return { data: null, error: 'forced write failure' }
      const row = clients.find(c => c.owner === owner && c.id === id)
      if (!row || row.status !== expectedStatus) return { data: null, error: null }
      writes++; row.status = status; return { data: row, error: null }
    },
    async dismissReminder(owner, id) {
      if (failWrites) return { data: null, error: 'forced write failure' }
      const row = reminders.find(r => r.owner === owner && r.id === id && !r.is_dismissed)
      if (!row) return { data: null, error: null }
      writes++; row.is_dismissed = true; return { data: row, error: null }
    },
  }
  return { store, clients, reminders, getWrites: () => writes, setFailWrites: (v: boolean) => { failWrites = v } }
}

describe('EYE AI actions and conversation safety', () => {
  it('long assistant history cannot poison the next turn', () => {
    const history = Array.from({ length: 25 }, (_, i) => ({ role: i % 2 === 0 ? ('user' as const) : ('assistant' as const), content: i === 23 ? 'A'.repeat(9000) : `message-${i}` }))
    const bounded = boundConversationHistory(history)
    assert.equal(bounded.length, MAX_HISTORY_MESSAGES)
    assert.equal(bounded.at(-2)?.content.length, MAX_HISTORY_CONTENT_CHARS)
    assert.equal(MAX_CURRENT_MESSAGE_CHARS, 2000)
  })

  it('confirmation requires explicit short yes/no', () => {
    assert.equal(classifyConfirmationMessage('po'), 'confirm')
    assert.equal(classifyConfirmationMessage('Bëje'), 'confirm')
    assert.equal(classifyConfirmationMessage('jo'), 'cancel')
    assert.equal(classifyConfirmationMessage('jo pas dy javësh'), 'none')
  })

  it('relative date is deterministic', () => assert.equal(resolveActionDate('2026-09-22', { kind: 'relative_days', days: 7 }), '2026-09-29'))

  it('proposal performs zero writes until execution', async () => {
    const m = createMemoryStore()
    const p = await resolveProposedCRMAction(m.store, 'owner-a', { type: 'UPDATE_CLIENT_FOLLOWUP', clientName: 'Oase', dateSpec: { kind: 'relative_days', days: 7 } }, '2026-09-22')
    assert.equal(p.ok, true); assert.equal(m.getWrites(), 0)
    if (p.ok) {
      assert.equal(p.action.type, 'UPDATE_CLIENT_FOLLOWUP')
      if (p.action.type === 'UPDATE_CLIENT_FOLLOWUP') {
        assert.equal(p.action.payload.next_followup, '2026-09-29')
      }
    }
  })

  it('ambiguous client and invalid status do not mutate', async () => {
    const m = createMemoryStore()
    const ambiguous = await resolveProposedCRMAction(m.store, 'owner-a', { type: 'UPDATE_CLIENT_STATUS', clientName: 'Bar', status: 'Customer/Purchase' }, '2026-09-22')
    assert.equal(ambiguous.ok, false)
    const invalid = await resolveProposedCRMAction(m.store, 'owner-a', { type: 'UPDATE_CLIENT_STATUS', clientName: 'Oase', status: 'invented-status' }, '2026-09-22')
    assert.equal(invalid.ok, false); assert.equal(m.getWrites(), 0)
  })

  it('confirmed follow-up persists once and repeated confirmation is rejected', async () => {
    const m = createMemoryStore()
    const p = await resolveProposedCRMAction(m.store, 'owner-a', { type: 'UPDATE_CLIENT_FOLLOWUP', clientName: 'Oase', dateSpec: { kind: 'relative_days', days: 7 } }, '2026-09-22')
    assert.equal(p.ok, true); if (!p.ok) return
    const first = await executePendingCRMAction(m.store, 'owner-a', p.action)
    assert.equal(first.ok, true); assert.equal(m.getWrites(), 1); assert.equal(m.clients.find(c => c.id === 'client-a')?.next_followup, '2026-09-29')
    const second = await executePendingCRMAction(m.store, 'owner-a', p.action)
    assert.equal(second.ok, false); assert.equal(second.code, 'already_applied'); assert.equal(m.getWrites(), 1)
  })

  it('cross-owner client and reminder mutations are rejected', async () => {
    const m = createMemoryStore()
    const clientAction: PendingCRMAction = { id: 'x', type: 'UPDATE_CLIENT_STATUS', targetId: 'client-b', targetName: 'Other', payload: { status: 'Customer/Purchase' }, expected: { status: 'prospect' }, confirmationText: 'x' }
    const reminderAction: PendingCRMAction = { id: 'y', type: 'DISMISS_REMINDER', targetId: 'rem-b', targetName: 'Other', payload: { is_dismissed: true }, expected: { is_dismissed: false }, confirmationText: 'y' }
    assert.equal((await executePendingCRMAction(m.store, 'owner-a', clientAction)).code, 'not_found')
    assert.equal((await executePendingCRMAction(m.store, 'owner-a', reminderAction)).code, 'not_found')
    assert.equal(m.getWrites(), 0)
  })

  it('reminder dismissal persists and leaves active inventory', async () => {
    const m = createMemoryStore()
    const p = await resolveProposedCRMAction(m.store, 'owner-a', { type: 'DISMISS_REMINDER', businessName: 'Oase' }, '2026-09-22')
    assert.equal(p.ok, true); if (!p.ok) return
    const result = await executePendingCRMAction(m.store, 'owner-a', p.action)
    assert.equal(result.ok, true); assert.equal(m.reminders.find(r => r.id === 'rem-a')?.is_dismissed, true)
    assert.equal((await m.store.listActiveReminders('owner-a')).data?.length, 0)
  })

  it('write failure never reports success', async () => {
    const m = createMemoryStore()
    const p = await resolveProposedCRMAction(m.store, 'owner-a', { type: 'UPDATE_CLIENT_STATUS', clientName: 'Oase', status: 'Customer/Purchase' }, '2026-09-22')
    assert.equal(p.ok, true); if (!p.ok) return
    m.setFailWrites(true)
    const result = await executePendingCRMAction(m.store, 'owner-a', p.action)
    assert.equal(result.ok, false); assert.equal(result.code, 'write_failed'); assert.equal(m.getWrites(), 0)
  })
})
