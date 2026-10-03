import type { SupabaseClient } from '@supabase/supabase-js'
import { createCanonicalActionService } from './canonical'
import { createActionRuntime } from './runtime'
import { issueConfirmation, verifyConfirmation } from '../ai/actions/receipt'

/** Explicit authenticated read probe; never selects a mutation authority. */
export async function readCanonicalReadiness(sb: SupabaseClient, clientId?: string) {
  const runtime = await createActionRuntime(sb)
  const reader = createCanonicalActionService(sb, runtime.owner)
  const data = clientId ? await reader.forClient(clientId) : await reader.listOpen()
  return { mode: runtime.mode, source: 'CANONICAL', readOnly: true, data }
}

/** Self-test only: signed payload never leaves the server and no command is dispatched. */
export function confirmationReadiness(owner: string, mode: 'LEGACY' | 'CANONICAL') {
  const action = { id: '00000000-0000-4000-8000-000000000001', type: 'UPDATE_CLIENT_FOLLOWUP' as const,
    targetId: '00000000-0000-4000-8000-000000000002', targetName: 'Signing readiness',
    payload: { next_followup: '2026-09-27' }, expected: { next_followup: null, next_action: null }, confirmationText: 'Signing readiness' }
  const signed = issueConfirmation(owner, mode, action, null)
  verifyConfirmation(owner, mode, signed)
  for (const proposal of [action, { ...signed, confirmationToken: 'invalid.receipt' }]) {
    let rejected = false
    try { verifyConfirmation(owner, mode, proposal) } catch (error: any) { if (error.status === 403) rejected = true; else throw error }
    if (!rejected) throw new Error('Signing verification did not reject an invalid receipt')
  }
  return { mode, initialized: true, serverOnly: true, readOnly: true, missingReceiptRejected: true, invalidReceiptRejected: true }
}
