import { groupOpenActions } from './queue'
import type { OperationalAction } from './types'
import { formatFollowupDate } from '../followup'
export function attentionBadge(group: string | null, dueDate: string | null | undefined) {
  return group === 'overdue' ? { label: 'ME VONESË', cls: 'fu-overdue' } : group === 'today' ? { label: 'SOT', cls: 'fu-today' } : group === 'upcoming' ? { label: formatFollowupDate(dueDate, { short: true }).toUpperCase(), cls: 'fu-upcoming' } : group === 'unscheduled' ? { label: 'PA AFAT', cls: 'fu-none' } : null
}
export function deriveClientAttention(actions: OperationalAction[], clientId: string, now = new Date()) {
  const open = actions.filter(a => a.state === 'open' && a.client_id === clientId)
  const groups = groupOpenActions(open, now)
  const nearest = [...groups.overdue, ...groups.today, ...groups.upcoming, ...groups.unscheduled][0] ?? null
  return { hasOpenAction: open.length > 0, open, nearest,
    overdue: groups.overdue.length > 0, today: groups.today.length > 0,
    upcoming: groups.upcoming.length > 0, unscheduled: groups.unscheduled.length > 0,
    group: groups.overdue.length ? 'overdue' : groups.today.length ? 'today' : groups.upcoming.length ? 'upcoming' : groups.unscheduled.length ? 'unscheduled' : null,
  }
}
