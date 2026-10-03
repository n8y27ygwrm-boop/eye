import { createHash } from 'node:crypto'
import { parseSurfaceCommand } from './surface'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createSupabaseCRMActionStore, executePendingCRMAction } from '../ai/actions/server'
import { ActionError, databaseError } from './errors'
import type { ActionService, OperationalAction } from './types'

export function mapLegacy(source: 'client' | 'reminder', row: Record<string, any>, owner: string): OperationalAction | null {
  if (row.owner_user_id !== owner) throw new ActionError('forbidden', 'Legacy owner mismatch', 403)
  if (source === 'client' && !row.next_action?.trim() && !row.next_followup) return null
  const evidence = source === 'client' ? [row.next_action ?? null, row.next_followup ?? null] : [row.description, row.due_date ?? null, row.due_time ?? null, row.is_dismissed, row.client_id ?? null, row.visit_id ?? null, row.action_type, row.priority]
  return {
    revision: createHash('sha256').update(JSON.stringify([owner, source, row.id, evidence])).digest('hex'),
    allowed_operations: source === 'client' ? ['edit', 'reschedule', 'complete'] : row.is_dismissed ? [] : ['complete'],
    id: `${source}:${row.id}`, owner_user_id: owner,
    client_id: source === 'client' ? row.id : row.client_id ?? null,
    client_name_snapshot: row.business_name,
    description: source === 'client' ? row.next_action?.trim() || 'Follow-up — details not recorded' : row.description,
    action_type: source === 'client' ? 'follow_up' : row.action_type,
    due_date: source === 'client' ? row.next_followup ?? null : row.due_date ?? null,
    due_time: source === 'client' ? null : row.due_time ?? null,
    priority: source === 'client' ? 'medium' : row.priority,
    state: source === 'reminder' && row.is_dismissed ? 'legacy_closed' : 'open', origin: 'legacy', version: null,
    source_visit_id: source === 'reminder' ? row.visit_id ?? null : null,
    source_excerpt: null, resolution_visit_id: null, replaces_action_id: null, creation_key: null,
    created_at: row.created_at ?? null, updated_at: row.updated_at ?? null,
    closed_at: null, closed_by: null, closure_note: null,
  }
}

export function createLegacyActionService(sb: SupabaseClient, owner: string): ActionService {
  if (!owner) throw new ActionError('unauthenticated', 'Authentication required', 401)
  async function all() {
    async function read(table: string) {
      const rows: Record<string, any>[] = []
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await sb.from(table).select('*').eq('owner_user_id', owner).order('id').range(offset, offset + 499)
        if (error) throw databaseError(error)
        if (!Array.isArray(data)) throw new ActionError('database', 'Missing legacy query result', 503)
        rows.push(...data)
        if (data.length < 500) return rows
      }
    }
    const [clients, reminders] = await Promise.all([read('clients'), read('ai_reminders')])
    return [...clients.map(r => mapLegacy('client', r, owner)), ...reminders.map(r => mapLegacy('reminder', r, owner))].filter((a): a is OperationalAction => a !== null)
  }
  const service: ActionService = {
    mode: 'LEGACY', capabilities: { history: false, visitResolve: false, replace: false },
    listOpen: async () => (await all()).filter(a => a.state === 'open'),
    forClient: async id => (await all()).filter(a => a.client_id === id),
    byId: async id => (await all()).find(a => a.id === id) ?? null,
    async history() { throw new ActionError('unsupported', 'Legacy storage has no action event history', 422) },
    async mutate(command) {
      if (command.operation === 'surface') {
        const c = parseSurfaceCommand(command)
        if (c.intent === 'leave') return { unchanged: true }
        if (c.intent === 'cancel' || c.intent === 'replace' || (c.channel === 'visit' && c.intent === 'complete')) throw new ActionError('unsupported', 'Legacy storage does not support this lifecycle operation', 422)
        const source = c.intent === 'create' ? 'client' : c.actionId?.startsWith('client:') ? 'client' : c.actionId?.startsWith('reminder:') ? 'reminder' : null
        if (!source) throw new ActionError('invalid', 'Invalid action target', 400)
        const targetId = c.intent === 'create' ? c.clientId! : c.actionId!.slice(c.actionId!.indexOf(':') + 1)
        const table = source === 'client' ? 'clients' : 'ai_reminders'
        const { data: current, error } = await sb.from(table).select('*').eq('id', targetId).eq('owner_user_id', owner).maybeSingle()
        if (error) throw databaseError(error)
        if (!current) throw new ActionError('not_found', 'Action target not found', 404)
        const before = mapLegacy(source, current, owner)
        if (c.intent === 'create' && before) throw new ActionError('conflict', 'An open follow-up already exists', 409)
        if (c.intent !== 'create' && (!before || before.state !== 'open' || before.revision !== c.expectedRevision)) throw new ActionError('conflict', 'Action changed; refresh before retrying', 409)
        if ((source === 'client' ? targetId : current.client_id ?? null) !== c.clientId) throw new ActionError('invalid', 'Action client mismatch', 400)
        const store = createSupabaseCRMActionStore(sb)
        if (source === 'reminder') {
          if (c.intent !== 'complete') throw new ActionError('unsupported', 'Legacy reminders only support dismissal', 422)
          const result = await store.dismissReminder(owner, targetId, current)
          if (result.error) throw new ActionError('database', result.error, 503)
          if (!result.data) throw new ActionError('conflict', 'Reminder was changed or dismissed', 409)
          return mapLegacy('reminder', { ...current, ...result.data }, owner)!
        }
        if (c.fields && (c.fields.due_time || c.fields.action_type !== 'follow_up' || c.fields.priority !== 'medium')) throw new ActionError('unsupported', 'Legacy client follow-ups cannot store time, type or priority changes', 422)
        const patch = c.intent === 'complete' ? { next_followup: null, next_action: null } : c.intent === 'reschedule' ? { next_followup: c.fields!.due_date, next_action: current.next_action ?? null } : { next_followup: c.fields!.due_date, next_action: c.fields!.description }
        const result = await store.updateClientFollowup(owner, targetId, { next_followup: current.next_followup ?? null, next_action: current.next_action ?? null }, patch)
        if (result.error) throw new ActionError('database', result.error, 503)
        if (!result.data) throw new ActionError('conflict', 'Follow-up changed before saving', 409)
        return c.intent === 'complete' ? { removedActionId: c.actionId! } : mapLegacy('client', { ...current, ...result.data }, owner)!
      }
      if (command.operation !== 'legacy' || command.action.type === 'UPDATE_CLIENT_STATUS') throw new ActionError('unsupported', 'Legacy supports follow-up changes and reminder dismissal only', 422)
      const result = await executePendingCRMAction(createSupabaseCRMActionStore(sb), owner, command.action)
      if (!result.ok) throw new ActionError(result.status === 409 ? 'conflict' : result.status === 404 ? 'not_found' : 'database', result.reply, result.status)
      const id = `${command.action.type === 'DISMISS_REMINDER' ? 'reminder' : 'client'}:${command.action.targetId}`
      const action = await service.byId(id)
      if (!action) throw new ActionError('database', 'Missing authoritative legacy write result', 503)
      return action
    },
  }
  return service
}
