import { ActionError } from '../actions/errors'
import type { ActionAuthority } from '../actions/types'

export function resolveActionAuthority(value: string | undefined): ActionAuthority {
  if (value === undefined) return 'LEGACY'
  if (value === 'LEGACY' || value === 'CANONICAL') return value
  throw new ActionError('configuration', 'Invalid EYE_ACTION_AUTHORITY', 503)
}
/** Resolve once per authenticated request, exclusively on the server. */
export function getActionAuthority(): ActionAuthority {
  if (typeof window !== 'undefined') throw new ActionError('configuration', 'Authority is server controlled')
  return resolveActionAuthority(process.env.EYE_ACTION_AUTHORITY)
}
