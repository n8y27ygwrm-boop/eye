import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { parseSurfaceCommand, canonicalSurfaceCommand } from './surface'
import { ActionError, databaseError } from './errors'
import type { ActionCommand, ActionService, CanonicalCommand, MutationResult, OperationalAction, ActionEvent } from './types'

const DateSchema = z.iso.date().nullable()
const TimeSchema = z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/).nullable()
const FieldsSchema = z.object({ description: z.string().trim().min(1), action_type: z.enum(['call', 'meeting', 'deliver', 'follow_up']), due_date: DateSchema, due_time: TimeSchema, priority: z.enum(['high', 'medium', 'low']) }).strict()
const NewFieldsSchema = FieldsSchema.extend({ origin: z.enum(['manual', 'ai']), source_visit_id: z.uuid().nullable(), source_excerpt: z.string().nullable(), creation_key: z.string().trim().min(1) })
const request = { requestId: z.uuid(), channel: z.enum(['client_detail', 'field_control', 'map', 'visit', 'ai_chat', 'api']) }
const target = { actionId: z.uuid(), expectedVersion: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }
export const CanonicalCommandSchema = z.discriminatedUnion('operation', [
  z.object({ ...request, operation: z.literal('create'), clientId: z.uuid(), fields: NewFieldsSchema }).strict(),
  z.object({ ...request, ...target, operation: z.enum(['edit', 'reschedule']), fields: FieldsSchema }).strict(),
  z.object({ ...request, ...target, operation: z.enum(['complete', 'cancel']), resolutionVisitId: z.uuid().nullable(), closureNote: z.string().nullable() }).strict(),
  z.object({ ...request, ...target, operation: z.literal('replace'), fields: NewFieldsSchema, closureNote: z.string().trim().min(1) }).strict(),
]).superRefine((command, ctx) => {
  if ('fields' in command && command.fields.due_time && !command.fields.due_date) ctx.addIssue({ code: 'custom', message: 'Time requires date' })
  if (command.operation === 'cancel' && !command.closureNote?.trim()) ctx.addIssue({ code: 'custom', message: 'Cancellation requires reason' })
})
const RowSchema = z.object({
  id: z.uuid(), owner_user_id: z.uuid(), client_id: z.uuid().nullable(), client_name_snapshot: z.string().min(1), description: z.string().min(1),
  action_type: z.enum(['call', 'meeting', 'deliver', 'follow_up']), due_date: DateSchema, due_time: TimeSchema, priority: z.enum(['high', 'medium', 'low']),
  state: z.enum(['open', 'completed', 'cancelled', 'replaced', 'legacy_closed']), origin: z.enum(['manual', 'ai', 'legacy']), version: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  source_visit_id: z.uuid().nullable(), source_excerpt: z.string().nullable(), resolution_visit_id: z.uuid().nullable(), replaces_action_id: z.uuid().nullable(),
  creation_key: z.string(), created_at: z.string(), updated_at: z.string(), closed_at: z.string().nullable(), closed_by: z.uuid().nullable(), closure_note: z.string().nullable(),
})

/** Construct only after auth.getUser verification; client uses the user's cookie/JWT, never admin credentials. */
export function createCanonicalActionService(sb: SupabaseClient, owner: string): ActionService {
  if (!owner) throw new ActionError('unauthenticated', 'Authentication required', 401)
  function row(value: unknown): OperationalAction {
    const parsed = RowSchema.safeParse(value)
    if (!parsed.success) throw new ActionError('database', 'Invalid or missing authoritative action result', 503)
    const data = parsed.data
    if (data.owner_user_id !== owner) throw new ActionError('forbidden', 'Owner mismatch', 403)
    if (data.state === 'legacy_closed' && (data.origin !== 'legacy' || data.closed_at !== null || data.closed_by !== null)) throw new ActionError('database', 'Invalid historical closure', 503)
    return { ...data, revision: String(data.version), allowed_operations: data.state === 'open' ? ['edit', 'reschedule', 'complete', 'cancel', 'replace'] : [] }
  }
  async function list(clientId?: string) {
    const rows: OperationalAction[] = []
    // PostgREST row cap must not silently truncate the operational queue.
    for (let offset = 0; ; offset += 500) {
      let query = sb.from('client_actions').select('*').eq('owner_user_id', owner).order('id').range(offset, offset + 499)
      query = clientId ? query.eq('client_id', clientId) : query.eq('state', 'open')
      const { data, error } = await query
      if (error) throw databaseError(error)
      if (!Array.isArray(data)) throw new ActionError('database', 'Missing action query result', 503)
      rows.push(...data.map(row))
      if (data.length < 500) return rows
    }
  }
  return {
    mode: 'CANONICAL', capabilities: { history: true, visitResolve: true, replace: true }, listOpen: () => list(), forClient: clientId => list(clientId),
    async byId(actionId) {
      const { data, error } = await sb.from('client_actions').select('*').eq('owner_user_id', owner).eq('id', actionId).maybeSingle()
      if (error) throw databaseError(error)
      return data === null ? null : row(data)
    },
    async history(actionId) {
      const events: ActionEvent[] = []
      for (let offset = 0; ; offset += 500) {
        const { data, error } = await sb.from('client_action_events').select('*').eq('owner_user_id', owner).eq('action_id', actionId).order('action_version').range(offset, offset + 499)
        if (error) throw databaseError(error)
        if (!Array.isArray(data)) throw new ActionError('database', 'Missing action history', 503)
        for (const event of data) {
          if (event.owner_user_id !== owner || event.action_id !== actionId) throw new ActionError('forbidden', 'History owner/target mismatch', 403)
          events.push(event as ActionEvent)
        }
        if (data.length < 500) return events
      }
    },
    async mutate(input: ActionCommand): Promise<MutationResult> {
      if (input.operation === 'surface') {
        const surface = parseSurfaceCommand(input)
        if (surface.intent === 'leave') return { unchanged: true }
        input = canonicalSurfaceCommand(surface)
      }
      const parsed = CanonicalCommandSchema.safeParse(input)
      if (!parsed.success) throw new ActionError('invalid', 'Invalid canonical action command', 400)
      const command: CanonicalCommand = parsed.data
      const operation = command.operation === 'reschedule' ? 'edit' : command.operation
      const args: Record<string, unknown> = { p_request_id: command.requestId, p_channel: command.channel }
      if ('actionId' in command) Object.assign(args, { p_action_id: command.actionId, p_expected_version: command.expectedVersion })
      if (command.operation === 'create') args.p_client_id = command.clientId
      if ('fields' in command) for (const [key, value] of Object.entries(command.fields)) args[`p_${key}`] = value
      if ('closureNote' in command) args.p_closure_note = command.closureNote
      if ('resolutionVisitId' in command) args.p_resolution_visit_id = command.resolutionVisitId
      const { data, error } = await sb.rpc(`eye_action_${operation}`, args)
      if (error) throw databaseError(error)
      if (command.operation === 'replace') {
        const replaced = row(data?.replaced), successor = row(data?.successor)
        if (replaced.id !== command.actionId || replaced.version !== command.expectedVersion + 1 || replaced.state !== 'replaced' || successor.replaces_action_id !== replaced.id || successor.client_id !== replaced.client_id || successor.state !== 'open') throw new ActionError('database', 'Replacement result mismatch', 503)
        return { replaced, successor }
      }
      const result = row(data)
      if ('actionId' in command && result.id !== command.actionId) throw new ActionError('database', 'Mutation target mismatch', 503)
      if ('expectedVersion' in command && result.version !== command.expectedVersion + 1) throw new ActionError('database', 'Mutation version mismatch', 503)
      const expectedState = command.operation === 'complete' ? 'completed' : command.operation === 'cancel' ? 'cancelled' : 'open'
      if (result.state !== expectedState) throw new ActionError('database', 'Mutation state mismatch', 503)
      if (command.operation === 'create' && result.client_id !== command.clientId) throw new ActionError('database', 'Created action client mismatch', 503)
      return result
    },
  }
}
