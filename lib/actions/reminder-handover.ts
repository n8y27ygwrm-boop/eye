import type { SupabaseClient } from '@supabase/supabase-js'
import type { VisitAIExtraction, VisitExtractionInput } from '../ai/types'
import { ActionError } from './errors'
import { getActionAuthority } from '../config/action-authority'
import { assertOperationalWritesEnabled } from '../config/write-maintenance'
import { backgroundReminderOutcome } from './background-policy'

export function assertJobAuthority(expected: 'LEGACY' | 'CANONICAL') {
  assertOperationalWritesEnabled()
  if (getActionAuthority() !== expected) throw new ActionError('configuration', 'Authority changed during job; preserve and replay event', 503)
}

/** Retired unattended canonical writer. Kept fail-closed for stale internal callers. */
export async function persistCanonicalReminder(input: VisitExtractionInput, _extraction: VisitAIExtraction, _sb?: SupabaseClient) {
  assertJobAuthority('CANONICAL')
  return backgroundReminderOutcome({ visitId: input.visit_id, ownerUserId: input.owner_user_id })!
}
