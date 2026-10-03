import type { SupabaseClient } from '@supabase/supabase-js'
import type { createActionRuntime } from '../../actions/runtime'
import type { CanonicalCommand, OperationalAction } from '../../actions/types'
import { ActionError, databaseError } from '../../actions/errors'
import { createSupabaseCRMActionStore, executePendingCRMAction, resolveProposedCRMAction } from './server'
import type { CRMActionProposalRequest, PendingCRMAction } from './types'
import { issueConfirmation, verifyConfirmation } from './receipt'
import { formatFollowupDate } from '../../followup'

type Runtime = Awaited<ReturnType<typeof createActionRuntime>>
export async function prepareAIAction(runtime: Runtime, sb: SupabaseClient, request: CRMActionProposalRequest, today: string) {
  const legacyStore = createSupabaseCRMActionStore(sb)
  if (runtime.mode === 'LEGACY' || request.type === 'UPDATE_CLIENT_STATUS') {
    const result = await resolveProposedCRMAction(legacyStore, runtime.owner, request, today)
    return result.ok ? { ...result, action: issueConfirmation(runtime.owner, runtime.mode, result.action, null) } : result
  }
  const actions = await runtime.service.listOpen()
  // Client identity/status is CRM data, not legacy operational action state.
  const identityStore = {
    ...legacyStore,
    async listClients(owner: string) {
      const rows: { id: string; business_name: string; status: string | null; next_action: null; next_followup: null }[] = []
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await sb.from('clients').select('id,business_name,status').eq('owner_user_id', owner).order('id').range(offset, offset + 499)
        if (error) throw databaseError(error)
        if (!Array.isArray(data)) throw new ActionError('database', 'Missing clients', 503)
        rows.push(...data.map(row => ({ ...row, next_action: null, next_followup: null })))
        if (data.length < 500) return { data: rows, error: null }
      }
    },
    async listActiveReminders() {
      return { data: actions.map(a => ({ id: a.id, business_name: a.client_name_snapshot, description: a.description, is_dismissed: false })), error: null }
    },
  }
  const planned = await resolveProposedCRMAction(identityStore, runtime.owner, request, today)
  if (!planned.ok) return planned
  const action = planned.action
  let command: CanonicalCommand
  if (action.type === 'DISMISS_REMINDER') {
    const current = actions.find(a => a.id === action.targetId)!
    command = { operation: 'cancel', actionId: current.id, expectedVersion: current.version!, requestId: action.id, channel: 'ai_chat', resolutionVisitId: null, closureNote: 'Dismissal explicitly confirmed in AI chat' }
  } else if (action.type === 'UPDATE_CLIENT_FOLLOWUP') {
    if ('next_action' in action.payload && !action.payload.next_action?.trim()) return { ok: false as const, reply: 'Veprimi kanonik kërkon një përshkrim. Specifiko përshkrimin e ri.' }
    const matches = actions.filter(a => a.client_id === action.targetId)
    if (matches.length > 1) return { ok: false as const, reply: 'Ka disa veprime aktive. Specifiko veprimin që dëshiron të ndryshosh.' }
    const current: OperationalAction | undefined = matches[0]
    const fields = { description: action.payload.next_action?.trim() || current?.description || 'Follow-up — details not recorded', action_type: current?.action_type ?? 'follow_up' as const, due_date: action.payload.next_followup, due_time: current?.due_time ?? null, priority: current?.priority ?? 'medium' as const }
    command = current
      ? { operation: 'edit', actionId: current.id, expectedVersion: current.version!, requestId: action.id, channel: 'ai_chat', fields }
      : { operation: 'create', clientId: action.targetId, requestId: action.id, channel: 'ai_chat', fields: { ...fields, origin: 'ai', source_visit_id: null, source_excerpt: null, creation_key: `ai:${action.id}` } }
  } else throw new ActionError('invalid', 'Unexpected proposal', 400)
  return { ok: true as const, action: issueConfirmation(runtime.owner, runtime.mode, action, command) }
}

export async function confirmAIAction(runtime: Runtime, sb: SupabaseClient, action: PendingCRMAction) {
  const receipt = verifyConfirmation(runtime.owner, runtime.mode, action)
  if (action.type === 'UPDATE_CLIENT_STATUS') return executePendingCRMAction(createSupabaseCRMActionStore(sb), runtime.owner, receipt.action)
  const result = await runtime.service.mutate(runtime.mode === 'CANONICAL'
    ? receipt.command ?? (() => { throw new ActionError('forbidden', 'Missing canonical proposal command', 403) })()
    : { operation: 'legacy', action: receipt.action })
  return { ok: true, code: 'updated', status: 200, reply: action.type === 'DISMISS_REMINDER'
    ? `U krye — veprimi për ${action.targetName} u hoq nga lista aktive.`
    : `U përditësua — ${action.targetName} · follow-up ${'next_followup' in action.payload ? formatFollowupDate(action.payload.next_followup, { withYear: true }) : ''}.`, result }
}
