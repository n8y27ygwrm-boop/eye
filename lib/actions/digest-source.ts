import type { SupabaseClient } from '@supabase/supabase-js'
import { getActionAuthority } from '../config/action-authority'
import { assertDigestAvailable } from './background-policy'
import { ActionError } from './errors'

/** Source selection uses server authority. Preserve today's-visit digest selection. */
export async function readDigestActions(owner: string, visitIds: string[], legacyClient: SupabaseClient) {
  if (getActionAuthority() === 'LEGACY') {
    const { data, error } = await legacyClient.from('ai_reminders').select('id, business_name, action_type, description, due_date, due_time, priority').in('visit_id', visitIds).eq('owner_user_id', owner).eq('is_dismissed', false)
    if (error) throw new ActionError('database', 'Digest source read failed', 503)
    return data ?? []
  }
  assertDigestAvailable()
  return [] // Exhaustive guard: canonical digest is explicitly unavailable.
}
