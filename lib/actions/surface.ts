import { z } from 'zod'
import { ActionError } from './errors'
import type { CanonicalCommand, SurfaceCommand, OperationalAction } from './types'

export const SurfaceCommandSchema = z.object({
  operation: z.literal('surface'), intent: z.enum(['create', 'edit', 'reschedule', 'complete', 'cancel', 'replace', 'leave']),
  requestId: z.uuid(), channel: z.enum(['client_detail', 'field_control', 'map', 'visit', 'api']), clientId: z.uuid().nullable(),
  actionId: z.string().min(1).optional(), expectedVersion: z.number().int().positive().nullable().optional(), expectedRevision: z.string().min(1).optional(),
  fields: z.object({ description: z.string().trim().min(1), action_type: z.enum(['call', 'meeting', 'deliver', 'follow_up']), due_date: z.iso.date().nullable(), due_time: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d(?:\.\d{1,6})?)?$/).nullable(), priority: z.enum(['high', 'medium', 'low']) }).strict().optional(),
  sourceVisitId: z.uuid().nullable().optional(), reason: z.string().optional(),
}).strict().superRefine((c, ctx) => {
  if (c.intent === 'create' && !c.clientId) ctx.addIssue({ code: 'custom', message: 'Client required' })
  if (['create','edit','reschedule','replace'].includes(c.intent) && !c.fields) ctx.addIssue({ code: 'custom', message: 'Fields required' })
  if (!['create','leave'].includes(c.intent) && !c.actionId) ctx.addIssue({ code: 'custom', message: 'Target required' })
  if (c.fields?.due_time && !c.fields.due_date) ctx.addIssue({ code: 'custom', message: 'Time requires date' })
})
export function parseSurfaceCommand(value: unknown): SurfaceCommand {
  const parsed = SurfaceCommandSchema.safeParse(value)
  if (!parsed.success) throw new ActionError('invalid', 'Invalid action change', 400)
  return parsed.data
}
export function canonicalSurfaceCommand(c: SurfaceCommand): CanonicalCommand {
  const request = { requestId: c.requestId, channel: c.channel }
  const newFields = () => ({ ...c.fields!, origin: 'manual' as const, source_visit_id: c.sourceVisitId ?? null, source_excerpt: null, creation_key: `surface:${c.requestId}` })
  if (c.intent === 'create') return { ...request, operation: 'create', clientId: c.clientId!, fields: newFields() }
  if (!c.actionId || !c.expectedVersion) throw new ActionError('conflict', 'Current action version required', 409)
  const target = { actionId: c.actionId, expectedVersion: c.expectedVersion }
  if (c.intent === 'replace') return { ...request, ...target, operation: 'replace', fields: newFields(), closureNote: c.reason ?? '' }
  if (c.intent === 'complete' || c.intent === 'cancel') return { ...request, ...target, operation: c.intent, resolutionVisitId: c.sourceVisitId ?? null, closureNote: c.reason ?? null }
  if (c.intent === 'edit' || c.intent === 'reschedule') return { ...request, ...target, operation: c.intent, fields: c.fields! }
  throw new ActionError('invalid', 'Invalid action intent', 400)
}

/** Only skip a validated edit of the same current canonical action/version. */
export function isUnchangedCanonicalEdit(command: SurfaceCommand, target: OperationalAction | undefined): boolean {
  if (!target || target.version == null || target.state !== 'open' || !['edit', 'reschedule'].includes(command.intent)) return false
  const parsed = SurfaceCommandSchema.safeParse(command)
  if (!parsed.success) return false
  const c = parsed.data
  if (c.actionId !== target.id || c.clientId !== target.client_id || c.expectedVersion !== target.version || !c.fields) return false
  const time = (value: string | null) => {
    if (value == null) return null
    const [hours, minutes, seconds = '0'] = value.split(':')
    return `${hours}:${minutes}:${Number(seconds)}`
  }
  return c.fields.description === target.description && c.fields.action_type === target.action_type
    && c.fields.due_date === target.due_date && time(c.fields.due_time) === time(target.due_time)
    && c.fields.priority === target.priority
}
