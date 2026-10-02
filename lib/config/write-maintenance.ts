import { ActionError } from '../actions/errors'

/** Server control only. DB fences are still required for old deployments and direct clients. */
export function assertOperationalWritesEnabled() {
  const value = process.env.EYE_ACTION_MAINTENANCE ?? 'OFF'
  if (value !== 'OFF' && value !== 'ON') throw new ActionError('configuration', 'Invalid maintenance configuration', 503)
  if (value === 'ON') throw new ActionError('configuration', 'Operational writes are temporarily paused', 503)
}
