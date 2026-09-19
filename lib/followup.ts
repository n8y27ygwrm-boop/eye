import { todayISO, SQ_MONTHS } from './types'

export type FollowupState = 'NONE' | 'OVERDUE' | 'DUE_TODAY' | 'UPCOMING'
export type FollowupFilter = 'all' | 'overdue' | 'today' | 'upcoming'

export type FollowupStateInfo = {
  state: FollowupState
  label: string
  badgeText: string
  cls: string
  color: string
}

export const SQ_SHORT_MONTHS = ['Jan', 'Shk', 'Mar', 'Pri', 'Maj', 'Qer', 'Kor', 'Gus', 'Sht', 'Tet', 'Nën', 'Dhj']

export const FOLLOWUP_STATE_DEFS: Record<FollowupState, FollowupStateInfo> = {
  NONE: {
    state: 'NONE',
    label: 'Pa ndjekje',
    badgeText: '',
    cls: 'fu-none',
    color: '#6B7280',
  },
  OVERDUE: {
    state: 'OVERDUE',
    label: 'Me vonesë',
    badgeText: 'OVERDUE',
    cls: 'fu-overdue',
    color: '#EF4444',
  },
  DUE_TODAY: {
    state: 'DUE_TODAY',
    label: 'Sot',
    badgeText: 'DUE TODAY',
    cls: 'fu-today',
    color: '#3B82F6',
  },
  UPCOMING: {
    state: 'UPCOMING',
    label: 'Në vijim',
    badgeText: 'UPCOMING',
    cls: 'fu-upcoming',
    color: '#10B981',
  },
}

/**
 * Normalizes a date string to strictly YYYY-MM-DD.
 * Returns null if invalid or missing.
 */
export function normalizeDateOnly(dateStr: string | null | undefined): string | null {
  if (!dateStr) return null
  const s = dateStr.trim().slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  return s
}

/**
 * Pure date-only comparison:
 * - date < today -> OVERDUE
 * - date === today -> DUE_TODAY
 * - date > today -> UPCOMING
 * - null / invalid -> NONE
 */
export function getFollowupState(
  nextFollowup: string | null | undefined,
  referenceToday: string = todayISO()
): FollowupState {
  const d = normalizeDateOnly(nextFollowup)
  if (!d) return 'NONE'
  const today = normalizeDateOnly(referenceToday) || todayISO()
  if (d < today) return 'OVERDUE'
  if (d === today) return 'DUE_TODAY'
  return 'UPCOMING'
}

export function getFollowupInfo(
  nextFollowup: string | null | undefined,
  referenceToday: string = todayISO()
): FollowupStateInfo {
  const st = getFollowupState(nextFollowup, referenceToday)
  return FOLLOWUP_STATE_DEFS[st]
}

/**
 * Formats a date string safely without timezone shifts.
 * Examples: '19 Shtator 2026', '19 Sht'
 */
export function formatFollowupDate(
  dateStr: string | null | undefined,
  options?: { short?: boolean; withYear?: boolean }
): string {
  const d = normalizeDateOnly(dateStr)
  if (!d) return ''
  const [yearStr, monthStr, dayStr] = d.split('-')
  const day = parseInt(dayStr, 10)
  const monthIdx = parseInt(monthStr, 10) - 1
  if (monthIdx < 0 || monthIdx > 11) return d

  const monthName = options?.short ? SQ_SHORT_MONTHS[monthIdx] : SQ_MONTHS[monthIdx]
  if (options?.withYear) {
    return `${day} ${monthName} ${yearStr}`
  }
  return `${day} ${monthName}`
}

/**
 * Generates restrained badge text for client list cards.
 * Priority: OVERDUE, DUE TODAY, UPCOMING, NONE
 * Examples: OVERDUE, TODAY, 23 SHT
 */
export function formatCardFollowupLabel(
  nextFollowup: string | null | undefined,
  referenceToday: string = todayISO()
): { label: string; state: FollowupState; cls: string } | null {
  const state = getFollowupState(nextFollowup, referenceToday)
  if (state === 'NONE') return null

  const shortDate = formatFollowupDate(nextFollowup, { short: true })

  switch (state) {
    case 'OVERDUE':
      return { label: 'OVERDUE', state, cls: 'fu-overdue' }
    case 'DUE_TODAY':
      return { label: 'TODAY', state, cls: 'fu-today' }
    case 'UPCOMING':
      return { label: shortDate.toUpperCase(), state, cls: 'fu-upcoming' }
    default:
      return null
  }
}

/**
 * Adds days to an ISO YYYY-MM-DD date using local date arithmetic.
 */
export function addDaysISO(baseDateISO: string = todayISO(), days: number = 0): string {
  const norm = normalizeDateOnly(baseDateISO) || todayISO()
  const [y, m, d] = norm.split('-').map(Number)
  const dateObj = new Date(y, m - 1, d + days)
  const ry = dateObj.getFullYear()
  const rm = String(dateObj.getMonth() + 1).padStart(2, '0')
  const rd = String(dateObj.getDate()).padStart(2, '0')
  return `${ry}-${rm}-${rd}`
}
