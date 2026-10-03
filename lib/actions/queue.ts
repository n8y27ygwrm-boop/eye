import { SCHEDULING_TIME_ZONE } from '../config/scheduling'
import type { OperationalAction } from './types'
export function schedulingDate(now = new Date(), timeZone = SCHEDULING_TIME_ZONE): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now)
  const get = (type: string) => parts.find(p => p.type === type)!.value
  return `${get('year')}-${get('month')}-${get('day')}`
}
export function groupOpenActions(actions: OperationalAction[], now = new Date(), timeZone = SCHEDULING_TIME_ZONE) {
  const today = schedulingDate(now, timeZone)
  const groups: Record<'overdue' | 'today' | 'upcoming' | 'unscheduled', OperationalAction[]> = { overdue: [], today: [], upcoming: [], unscheduled: [] }
  for (const action of actions) {
    if (action.state !== 'open') continue
    const group = !action.due_date ? 'unscheduled' : action.due_date < today ? 'overdue' : action.due_date === today ? 'today' : 'upcoming'
    groups[group].push(action)
  }
  for (const rows of Object.values(groups)) rows.sort((a, b) => (a.due_date ?? '').localeCompare(b.due_date ?? '') || (a.due_time ?? '').localeCompare(b.due_time ?? '') || a.id.localeCompare(b.id))
  return groups
}
