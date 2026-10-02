import type { SupabaseClient } from '@supabase/supabase-js'
import { getActionAuthority } from '../config/action-authority'
import { createCanonicalActionService } from './canonical'
import { createLegacyActionService } from './legacy'
import { ActionError } from './errors'
import type { ActionAuthority, ActionService } from './types'
import { assertOperationalWritesEnabled } from '../config/write-maintenance'

/** Lazy selection guarantees a request cannot invoke both storage implementations. */
export function selectActionService(mode: ActionAuthority, factories: Record<ActionAuthority, () => ActionService>): ActionService {
  if (mode !== 'LEGACY' && mode !== 'CANONICAL') throw new ActionError('configuration', 'Invalid action authority', 503)
  return factories[mode]()
}
export async function createActionRuntime(sb: SupabaseClient) {
  if (typeof window !== 'undefined') throw new ActionError('configuration', 'Action runtime is server only')
  const mode = getActionAuthority()
  const { data, error } = await sb.auth.getUser()
  if (error || !data.user) throw new ActionError('unauthenticated', 'Authentication required', 401)
  const owner = data.user.id
  const service = selectActionService(mode, {
    LEGACY: () => createLegacyActionService(sb, owner),
    CANONICAL: () => createCanonicalActionService(sb, owner),
  })
  const mutate = service.mutate.bind(service)
  service.mutate = command => { assertOperationalWritesEnabled(); return mutate(command) }
  return { mode, owner, service }
}
