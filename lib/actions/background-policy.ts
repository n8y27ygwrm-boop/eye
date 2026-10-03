import { getActionAuthority } from '../config/action-authority'
import { ActionError } from './errors'

/** V1: canonical operational writes require explicit authenticated interaction. */
export function backgroundReminderOutcome(evidence: { eventId?: string; visitId?: string; ownerUserId?: string } = {}) {
  if (getActionAuthority() === 'LEGACY') return null
  return { ok: true, queued: false, hasReminder: false, persisted: false,
    reason: 'canonical_interactive_only', outcome: 'no_background_write', evidence }
}

export function assertDigestAvailable() {
  if (getActionAuthority() === 'CANONICAL') throw new ActionError('configuration',
    'Canonical digest unavailable: owner-scoped background reading needs a separate runtime design', 503)
}
