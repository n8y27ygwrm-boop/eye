import { z } from 'zod'
import type { VisitAIExtraction, ActionType, ReminderPriority } from './types'

export const REMINDER_STRICT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    hasReminder: {
      type: 'boolean',
      description: 'True if an actionable commitment, scheduled call, meeting, delivery, or explicit follow-up was mentioned',
    },
    actionType: {
      type: ['string', 'null'],
      enum: ['call', 'meeting', 'deliver', 'follow_up', null],
      description: 'Category of action to take',
    },
    description: {
      type: ['string', 'null'],
      description: 'Clear actionable Albanian description of what to do (max 120 chars)',
    },
    dueDate: {
      type: ['string', 'null'],
      description: 'ISO date YYYY-MM-DD if explicit or relative date was mentioned, otherwise null',
    },
    dueTime: {
      type: ['string', 'null'],
      description: '24-hour clock time HH:MM (00:00 through 23:59) if an exact time was explicitly stated, otherwise null',
    },
    priority: {
      type: ['string', 'null'],
      enum: ['high', 'medium', 'low', null],
      description: 'Priority level based on urgency and customer tier',
    },
    rawTrigger: {
      type: ['string', 'null'],
      description: 'Exact excerpt from the visit notes that triggered this reminder',
    },
    summary: {
      type: ['string', 'null'],
      description: 'Short 1-line summary of visit context (max 100 chars)',
    },
  },
  required: [
    'hasReminder',
    'actionType',
    'description',
    'dueDate',
    'dueTime',
    'priority',
    'rawTrigger',
    'summary',
  ],
  additionalProperties: false,
} as const

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/
const timeRegex = /^([01]\d|2[0-3]):[0-5]\d$/

export const RawExtractionSchema = z.object({
  hasReminder: z.boolean(),
  actionType: z.enum(['call', 'meeting', 'deliver', 'follow_up']).nullish(),
  description: z.string().nullish(),
  dueDate: z.string().nullish(),
  dueTime: z.string().nullish(),
  priority: z.enum(['high', 'medium', 'low']).nullish(),
  rawTrigger: z.string().nullish(),
  summary: z.string().nullish(),
})

export function validateAndNormalizeExtraction(raw: unknown): VisitAIExtraction {
  let parsedJson = raw
  if (typeof raw === 'string') {
    const cleaned = raw.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim()
    try {
      parsedJson = JSON.parse(cleaned)
    } catch (e: any) {
      throw new Error(`Failed to parse JSON string: ${e.message}`)
    }
  }

  if (Array.isArray(parsedJson)) {
    if (parsedJson.length === 0) {
      return {
        hasReminder: false,
        actionType: null,
        description: null,
        dueDate: null,
        dueTime: null,
        priority: null,
        rawTrigger: null,
        summary: null,
      }
    }
    parsedJson = parsedJson[0]
  }

  const parsed = RawExtractionSchema.parse(parsedJson)

  if (!parsed.hasReminder) {
    return {
      hasReminder: false,
      actionType: null,
      description: null,
      dueDate: null,
      dueTime: null,
      priority: null,
      rawTrigger: null,
      summary: null,
    }
  }

  // Sanitize dueDate: must be valid ISO date YYYY-MM-DD
  let validDueDate: string | null = null
  if (parsed.dueDate && isoDateRegex.test(parsed.dueDate.trim())) {
    const dt = new Date(parsed.dueDate.trim())
    if (!isNaN(dt.getTime())) {
      validDueDate = parsed.dueDate.trim()
    }
  }

  // Sanitize dueTime: must be valid 24-hour HH:MM (00:00 through 23:59)
  let validDueTime: string | null = null
  if (typeof parsed.dueTime === 'string') {
    const trimmedTime = parsed.dueTime.trim()
    if (timeRegex.test(trimmedTime)) {
      validDueTime = trimmedTime
    }
  }

  const cleanDescription = (parsed.description ?? parsed.summary ?? '').trim()
  if (!cleanDescription) {
    return {
      hasReminder: false,
      actionType: null,
      description: null,
      dueDate: null,
      dueTime: null,
      priority: null,
      rawTrigger: null,
      summary: null,
    }
  }

  return {
    hasReminder: true,
    actionType: (parsed.actionType as ActionType) ?? 'follow_up',
    description: cleanDescription.slice(0, 200),
    dueDate: validDueDate,
    dueTime: validDueTime,
    priority: (parsed.priority as ReminderPriority) ?? 'medium',
    rawTrigger: parsed.rawTrigger ? parsed.rawTrigger.trim().slice(0, 300) : null,
    summary: parsed.summary ? parsed.summary.trim().slice(0, 200) : null,
  }
}
