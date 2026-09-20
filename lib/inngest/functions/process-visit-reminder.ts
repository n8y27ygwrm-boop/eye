import { NonRetriableError } from 'inngest'
import { inngest } from '../client'
import { getAdminClient } from '@/lib/supabase/server'
import { orchestrateVisitExtraction } from '@/lib/ai/orchestrator'
import { deterministicReminderId } from '@/lib/ai/idempotency'
import type { VisitExtractionInput, AIProvider, VisitAIExtraction } from '@/lib/ai/types'
import type { ProviderErrorCategory } from '@/lib/ai/errors'

export type AuthoritativeRecordResult = {
  hasNotes: boolean
  input?: VisitExtractionInput
}

export type ExtractionStepResult = {
  hasReminder: boolean
  alreadyExists?: boolean
  extraction?: VisitAIExtraction
  provider?: string
}

export type PersistStepResult = {
  id: string
  alreadyExists: boolean
}

export const WORKFLOW_RETRYABLE_CATEGORIES: ReadonlySet<ProviderErrorCategory> = new Set([
  'rate_limit',
  'timeout',
  'network',
  'server_error',
  'structured_output',
])

export function isWorkflowRetryableCategory(category?: ProviderErrorCategory): boolean {
  if (!category) return false
  return WORKFLOW_RETRYABLE_CATEGORIES.has(category)
}

/**
 * Step 1: Load authoritative visit and client record from database.
 */
export async function loadAuthoritativeRecord(
  visitId: string,
  sb = getAdminClient()
): Promise<AuthoritativeRecordResult> {
  const { data: visit, error: visitError } = await sb
    .from('visits')
    .select('id, visit_date, business_name, shenime, client_id')
    .eq('id', visitId.trim())
    .maybeSingle()

  if (visitError || !visit) {
    throw new NonRetriableError(`Visit ${visitId} not found or inaccessible`)
  }

  // Data minimization: if notes are empty or whitespace, exit early
  if (!visit.shenime || !visit.shenime.trim()) {
    return { hasNotes: false }
  }

  let clientStatus: string | null = null
  let businessType: string | null = null
  let zone: string | null = null

  if (visit.client_id) {
    const { data: client } = await sb
      .from('clients')
      .select('status, business_type, zone')
      .eq('id', visit.client_id)
      .maybeSingle()

    if (client) {
      clientStatus = client.status
      businessType = client.business_type
      zone = client.zone
    }
  }

  return {
    hasNotes: true,
    input: {
      visit_id: visit.id,
      client_id: visit.client_id,
      business_name: visit.business_name,
      visit_date: visit.visit_date,
      shenime: visit.shenime,
      client_status: clientStatus,
      business_type: businessType,
      zone,
    },
  }
}

/**
 * Step 2: Orchestrate AI extraction with pre-check idempotency and error classification.
 */
export async function runReminderExtraction(
  input: VisitExtractionInput,
  sb = getAdminClient(),
  providers?: AIProvider[]
): Promise<ExtractionStepResult> {
  const deterministicId = deterministicReminderId(input.visit_id)

  // Pre-check for existing reminder (covers both deterministic and legacy IDs)
  const { data: existing } = await sb
    .from('ai_reminders')
    .select('id, business_name, action_type, description')
    .or(`id.eq.${deterministicId},visit_id.eq.${input.visit_id}`)
    .maybeSingle()

  if (existing) {
    return { hasReminder: true, alreadyExists: true }
  }

  const result = await orchestrateVisitExtraction(input, providers)

  if (!result.ok) {
    if (isWorkflowRetryableCategory(result.failureCategory)) {
      throw new Error('Transient AI processing failure')
    }
    throw new NonRetriableError('Permanent AI processing failure')
  }

  if (!result.extraction || !result.extraction.hasReminder || !result.extraction.description) {
    return {
      hasReminder: false,
      provider: result.providerUsed,
    }
  }

  return {
    hasReminder: true,
    extraction: result.extraction,
    provider: result.providerUsed,
  }
}

/**
 * Step 3: Persist reminder with deterministic UUID and race-condition idempotency.
 */
export async function persistActionableReminder(
  input: VisitExtractionInput,
  extraction: VisitAIExtraction,
  sb = getAdminClient()
): Promise<PersistStepResult> {
  const deterministicId = deterministicReminderId(input.visit_id)

  const { data: inserted, error: insertError } = await sb
    .from('ai_reminders')
    .insert({
      id: deterministicId,
      client_id: input.client_id,
      visit_id: input.visit_id,
      business_name: input.business_name,
      action_type: extraction.actionType ?? 'follow_up',
      description: extraction.description,
      due_date: extraction.dueDate,
      priority: extraction.priority ?? 'medium',
      raw_trigger: extraction.rawTrigger,
      is_dismissed: false,
    })
    .select('id')
    .single()

  if (insertError) {
    // Postgres 23505 unique primary key conflict -> idempotent success
    if (insertError.code === '23505' || insertError.message?.includes('duplicate key')) {
      return { id: deterministicId, alreadyExists: true }
    }
    throw new Error(`Failed to persist reminder: ${insertError.message}`)
  }

  return { id: inserted.id, alreadyExists: false }
}

/**
 * Canonical Inngest Durable Function for visit reminder processing.
 */
export const processVisitReminder = inngest.createFunction(
  {
    id: 'process-visit-reminder',
    retries: 2,
    triggers: [{ event: 'eye/visit.saved' }],
  },
  async ({ event, step }) => {
    const { visitId } = event.data

    if (!visitId || typeof visitId !== 'string' || !visitId.trim()) {
      throw new NonRetriableError('Missing or invalid visitId in event payload')
    }

    // Step 1: load-authoritative-record
    const record = await step.run('load-authoritative-record', async () => {
      return loadAuthoritativeRecord(visitId)
    })

    if (!record.hasNotes || !record.input) {
      return { ok: true, hasReminder: false, reason: 'blank_notes' }
    }

    // Step 2: extract-reminder
    const extractionResult = await step.run('extract-reminder', async () => {
      return runReminderExtraction(record.input!)
    })

    if (!extractionResult.hasReminder || !extractionResult.extraction) {
      return {
        ok: true,
        hasReminder: extractionResult.hasReminder,
        alreadyExists: extractionResult.alreadyExists ?? false,
        provider: extractionResult.provider,
      }
    }

    // Step 3: persist-reminder
    const persistenceResult = await step.run('persist-reminder', async () => {
      return persistActionableReminder(record.input!, extractionResult.extraction!)
    })

    return {
      ok: true,
      hasReminder: true,
      reminderId: persistenceResult.id,
      alreadyExists: persistenceResult.alreadyExists,
    }
  }
)
