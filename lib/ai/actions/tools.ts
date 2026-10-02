
import { z } from 'zod'
import { STATUS_DEFS } from '../../types'
import type { CRMActionProposalRequest } from './types'

const FOLLOWUP_TOOL = 'propose_update_client_followup'
const DISMISS_TOOL = 'propose_dismiss_reminder'
const STATUS_TOOL = 'propose_update_client_status'

export const CRM_ACTION_TOOLS = [
  {
    type: 'function',
    function: {
      name: FOLLOWUP_TOOL,
      description: 'Propose changing a client next follow-up. This does NOT execute the change. Use it when the user asks to set/reschedule a follow-up.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          client_name: { type: 'string', description: 'Business/client name from the CRM context.' },
          date_kind: { type: 'string', enum: ['relative_days', 'explicit_date', 'next_weekday'] },
          relative_days: { type: 'integer', minimum: 0, maximum: 365 },
          explicit_date: { type: 'string', description: 'YYYY-MM-DD' },
          weekday: { type: 'integer', minimum: 0, maximum: 6, description: 'Sunday=0 ... Saturday=6' },
          next_action: { type: 'string', description: 'Only when user explicitly asks to change it.' },
        },
        required: ['client_name', 'date_kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: DISMISS_TOOL,
      description: 'Propose marking one active AI reminder as completed/dismissed. This does NOT execute the change.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: { business_name: { type: 'string' } },
        required: ['business_name'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: STATUS_TOOL,
      description: 'Propose changing a client lifecycle status. This does NOT execute the change.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          client_name: { type: 'string' },
          status: { type: 'string', enum: STATUS_DEFS.map(status => status.key) },
        },
        required: ['client_name', 'status'],
      },
    },
  },
] as const

const FollowupArgs = z.object({
  client_name: z.string().min(1).max(160),
  date_kind: z.enum(['relative_days', 'explicit_date', 'next_weekday']),
  relative_days: z.number().int().min(0).max(365).optional(),
  explicit_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  weekday: z.number().int().min(0).max(6).optional(),
  next_action: z.string().max(200).nullable().optional(),
}).superRefine((value, ctx) => {
  if (value.date_kind === 'relative_days' && value.relative_days === undefined) ctx.addIssue({ code: 'custom', message: 'relative_days is required' })
  if (value.date_kind === 'explicit_date' && !value.explicit_date) ctx.addIssue({ code: 'custom', message: 'explicit_date is required' })
  if (value.date_kind === 'next_weekday' && value.weekday === undefined) ctx.addIssue({ code: 'custom', message: 'weekday is required' })
})

const DismissArgs = z.object({ business_name: z.string().min(1).max(160) })
const StatusArgs = z.object({ client_name: z.string().min(1).max(160), status: z.string().min(1).max(80) })

export function parseCRMActionToolCall(toolCall: any): CRMActionProposalRequest | null {
  const name = toolCall?.function?.name
  const rawArgs = toolCall?.function?.arguments
  if (typeof name !== 'string' || typeof rawArgs !== 'string') return null

  let parsedArgs: unknown
  try { parsedArgs = JSON.parse(rawArgs) } catch { return null }

  if (name === FOLLOWUP_TOOL) {
    const parsed = FollowupArgs.safeParse(parsedArgs)
    if (!parsed.success) return null
    const value = parsed.data
    const dateSpec = value.date_kind === 'relative_days'
      ? { kind: 'relative_days' as const, days: value.relative_days! }
      : value.date_kind === 'explicit_date'
        ? { kind: 'explicit_date' as const, date: value.explicit_date! }
        : { kind: 'next_weekday' as const, weekday: value.weekday! }
    return {
      type: 'UPDATE_CLIENT_FOLLOWUP', clientName: value.client_name, dateSpec,
      ...(value.next_action !== undefined ? { nextAction: value.next_action } : {}),
    }
  }

  if (name === DISMISS_TOOL) {
    const parsed = DismissArgs.safeParse(parsedArgs)
    return parsed.success ? { type: 'DISMISS_REMINDER', businessName: parsed.data.business_name } : null
  }

  if (name === STATUS_TOOL) {
    const parsed = StatusArgs.safeParse(parsedArgs)
    return parsed.success ? { type: 'UPDATE_CLIENT_STATUS', clientName: parsed.data.client_name, status: parsed.data.status } : null
  }

  return null
}
