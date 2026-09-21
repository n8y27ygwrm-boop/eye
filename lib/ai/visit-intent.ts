import type { ChatMessage } from './types'
import { addDaysISO } from '../followup'

export type VisitQueryKind =
  | 'today'
  | 'specific_date'
  | 'date_range'
  | 'week'
  | 'month'
  | 'recent'
  | 'count'
  | 'client_specific'
  | 'none'

export type VisitQueryIntent = {
  kind: VisitQueryKind
  targetDate?: string // YYYY-MM-DD
  from?: string // YYYY-MM-DD
  to?: string // YYYY-MM-DD
  isCountOnly?: boolean
  rawExpression?: string
}

export const MONTH_NAME_MAP: Record<string, number> = {
  // Albanian base, inflected, and abbreviations
  janar: 1, janarit: 1, jan: 1,
  shkurt: 2, shkurtit: 2, shk: 2,
  mars: 3, marsit: 3, mar: 3,
  prill: 4, prillit: 4, pri: 4,
  maj: 5, majit: 5,
  qershor: 6, qershorit: 6, qer: 6,
  korrik: 7, korrikut: 7, kor: 7,
  gusht: 8, gushtit: 8, gus: 8,
  shtator: 9, shtatorit: 9, sht: 9,
  tetor: 10, tetorit: 10, tet: 10,
  nentor: 11, nentorit: 11, nen: 11,
  dhjetor: 12, dhjetorit: 12, dhj: 12,
  // English months and abbreviations
  january: 1,
  february: 2, feb: 2,
  march: 3,
  april: 4, apr: 4,
  may: 5,
  june: 6, jun: 6,
  july: 7, jul: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  october: 10, oct: 10,
  november: 11, nov: 11,
  december: 12, dec: 12,
}

export function cleanText(str: string | null | undefined): string {
  return (str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ç/g, 'c')
    .trim()
}

export function getWeekRange(referenceDate: string): { from: string; to: string } {
  const [y, m, d] = referenceDate.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1, d))
  const dayOfWeek = dt.getUTCDay() // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const diffToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek
  const monday = addDaysISO(referenceDate, diffToMon)
  const sunday = addDaysISO(monday, 6)
  return { from: monday, to: sunday }
}

export function getMonthRange(
  referenceDate: string,
  targetMonth?: number,
  targetYear?: number
): { from: string; to: string } {
  const [y, m] = referenceDate.split('-').map(Number)
  const year = targetYear || y
  const month = targetMonth || m
  const from = `${year}-${String(month).padStart(2, '0')}-01`
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`
  return { from, to }
}

export interface HistoryTemporalContext {
  month?: number
  year?: number
  sourceTurnIndex: number
}

export function resolveHistoryTemporalContext(
  conversationHistory: ChatMessage[],
  defaultYear: number
): HistoryTemporalContext | null {
  const sortedMonthKeys = Object.keys(MONTH_NAME_MAP).sort((a, b) => b.length - a.length)

  // Scan newest to oldest so the most recent temporal anchor wins
  for (let i = conversationHistory.length - 1; i >= 0; i--) {
    const hText = cleanText(conversationHistory[i].content)

    // Check for ISO date in this turn
    const isoMatch = hText.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/)
    if (isoMatch) {
      return {
        year: parseInt(isoMatch[1], 10),
        month: parseInt(isoMatch[2], 10),
        sourceTurnIndex: i,
      }
    }

    // Check for named month in this turn
    let foundMonth: number | null = null
    for (const mName of sortedMonthKeys) {
      const regex = new RegExp(`\\b${mName}\\b`, 'i')
      if (regex.test(hText)) {
        foundMonth = MONTH_NAME_MAP[mName]
        break
      }
    }

    // Check for explicit 4-digit year in THIS turn
    const yearMatch = hText.match(/\b(20\d{2})\b/)
    const foundYear = yearMatch ? parseInt(yearMatch[1], 10) : undefined

    if (foundMonth !== null) {
      // Coherent temporal anchor found in this turn.
      // When the newest relevant month has no explicit year in this turn,
      // use defaultYear rather than borrowing a year from an older unrelated turn.
      return {
        month: foundMonth,
        year: foundYear ?? defaultYear,
        sourceTurnIndex: i,
      }
    } else if (foundYear !== undefined) {
      return {
        year: foundYear,
        sourceTurnIndex: i,
      }
    }
  }

  return null
}

export function resolveVisitQueryIntent({
  message,
  conversationHistory = [],
  today = '2026-09-21',
}: {
  message: string
  conversationHistory?: ChatMessage[]
  today?: string
}): VisitQueryIntent {
  const text = cleanText(message)
  const [currentYear, currentMonth] = today.split('-').map(Number)

  // 1. Resolve conversation history temporal context as one coherent anchor
  const historyTemporal = resolveHistoryTemporalContext(conversationHistory, currentYear)
  const historyHasVisits = conversationHistory.some(m => {
    const t = cleanText(m.content)
    return t.includes('vizit') || t.includes('visit')
  })

  const resolvedMonth = historyTemporal?.month ?? currentMonth
  const resolvedYear = historyTemporal?.year ?? currentYear
  const isVisitTopic = text.includes('vizit') || text.includes('visit') || historyHasVisits

  // 2. Explicit count question
  const isCount =
    /\bsa\s+vizit[a-z]*/i.test(text) ||
    /\bnumr[a-z]*\s+i\s+vizit[a-z]*/i.test(text) ||
    /\bhow\s+many\s+visits\b/i.test(text)

  // 3. Relative dates: today, yesterday, tomorrow, pardje
  if (/\bsot\b/i.test(text) || /\btoday\b/i.test(text) || /\be\s+sotme\b/i.test(text)) {
    return { kind: 'today', targetDate: today, isCountOnly: isCount }
  }

  if (/\bdje\b/i.test(text) || /\byesterday\b/i.test(text) || /\be\s+djeshme\b/i.test(text)) {
    return { kind: 'specific_date', targetDate: addDaysISO(today, -1), isCountOnly: isCount, rawExpression: 'dje' }
  }

  if (/\bpardje\b/i.test(text)) {
    return { kind: 'specific_date', targetDate: addDaysISO(today, -2), isCountOnly: isCount, rawExpression: 'pardje' }
  }

  if (/\bneser\b/i.test(text) || /\btomorrow\b/i.test(text)) {
    return { kind: 'specific_date', targetDate: addDaysISO(today, 1), isCountOnly: isCount, rawExpression: 'nesër' }
  }

  // 4. Current week
  if (/\b(?:kete|kesaj)\s+jave\b/i.test(text) || /\bthis\s+week\b/i.test(text)) {
    const { from, to } = getWeekRange(today)
    return { kind: 'week', from, to, isCountOnly: isCount }
  }

  // 5. Current month keywords
  if (/\b(?:kete|ketij)\s+muaj[i]?\b/i.test(text) || /\bthiss+month\b/i.test(text)) {
    const { from, to } = getMonthRange(today)
    return { kind: 'month', from, to, isCountOnly: isCount }
  }

  // 6. Date Range: "nga 15 deri me 20", "nga 15 deri ne 20", "nga 15 deri 20"
  const rangeMatch = text.match(
    /(?:nga|prej)\s+(\d{1,2})(?:\s+([a-z]+))?\s+(?:deri\s+(?:me|ne)?|deri|-)\s*(\d{1,2})(?:\s+([a-z]+))?(?:\s+(\d{4}))?/i
  )
  if (rangeMatch) {
    const d1 = parseInt(rangeMatch[1], 10)
    const m1Name = rangeMatch[2]?.toLowerCase()
    const d2 = parseInt(rangeMatch[3], 10)
    const m2Name = rangeMatch[4]?.toLowerCase()
    const yr = rangeMatch[5] ? parseInt(rangeMatch[5], 10) : resolvedYear

    const m1 = m1Name && MONTH_NAME_MAP[m1Name] ? MONTH_NAME_MAP[m1Name] : resolvedMonth
    const m2 =
      m2Name && MONTH_NAME_MAP[m2Name]
        ? MONTH_NAME_MAP[m2Name]
        : m1Name && MONTH_NAME_MAP[m1Name]
        ? m1
        : resolvedMonth

    const from = `${yr}-${String(m1).padStart(2, '0')}-${String(d1).padStart(2, '0')}`
    const to = `${yr}-${String(m2).padStart(2, '0')}-${String(d2).padStart(2, '0')}`
    return { kind: 'date_range', from, to, isCountOnly: isCount }
  }

  // 7. Full ISO date: "2026-09-22"
  const isoMatch = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
  if (isoMatch) {
    return { kind: 'specific_date', targetDate: isoMatch[0], isCountOnly: isCount }
  }

  // 8. Full numeric date: "22/09/2026", "22.09.2026", "22-09-2026"
  const fullNumericMatch = text.match(/\b(\d{1,2})[\/\.-](\d{1,2})[\/\.-](20\d{2})\b/)
  if (fullNumericMatch) {
    const d = parseInt(fullNumericMatch[1], 10)
    const m = parseInt(fullNumericMatch[2], 10)
    const y = parseInt(fullNumericMatch[3], 10)
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      const targetDate = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      return { kind: 'specific_date', targetDate, isCountOnly: isCount, rawExpression: fullNumericMatch[0] }
    }
  }

  // 9. Short numeric date: "22/09", "22.09" (day/month)
  const shortNumericMatch = text.match(/\b(\d{1,2})[\/\.](\d{1,2})\b/)
  if (shortNumericMatch) {
    const d = parseInt(shortNumericMatch[1], 10)
    const m = parseInt(shortNumericMatch[2], 10)
    if (d >= 1 && d <= 31 && m >= 1 && m <= 12) {
      const targetDate = `${resolvedYear}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
      return { kind: 'specific_date', targetDate, isCountOnly: isCount, rawExpression: shortNumericMatch[0] }
    }
  }

  // 10. Specific date with named month and day: "22 shtator", "me 22 shtator 2025", "22 sht"
  const sortedMonthKeys = Object.keys(MONTH_NAME_MAP).sort((a, b) => b.length - a.length)
  const namedDateMatch = text.match(/\b(\d{1,2})\s+([a-z]+)(?:\s+(\d{4}))?\b/i)
  if (namedDateMatch) {
    const day = parseInt(namedDateMatch[1], 10)
    const mName = namedDateMatch[2]?.toLowerCase()
    const yr = namedDateMatch[3] ? parseInt(namedDateMatch[3], 10) : resolvedYear
    if (mName && MONTH_NAME_MAP[mName] && day >= 1 && day <= 31) {
      const targetDate = `${yr}-${String(MONTH_NAME_MAP[mName]).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      return { kind: 'specific_date', targetDate, isCountOnly: isCount, rawExpression: namedDateMatch[0] }
    }
  }

  // 11. Explicit named month queries (without day):
  // "vizitat e dhjetorit 2025", "vizitat në dhjetor 2025", "vizitat e shtatorit", "visits in December 2025", "shtator 2025"
  for (const mName of sortedMonthKeys) {
    const regex = new RegExp(`\\b${mName}\\b`, 'i')
    if (regex.test(text)) {
      const msgYearMatch = text.match(/\b(20\d{2})\b/)
      const targetYear = msgYearMatch ? parseInt(msgYearMatch[1], 10) : resolvedYear
      const targetMonth = MONTH_NAME_MAP[mName]
      const { from, to } = getMonthRange(today, targetMonth, targetYear)
      return { kind: 'month', from, to, isCountOnly: isCount, rawExpression: mName }
    }
  }

  // 12. Conversational follow-up: "po ne 22?", "po me 22?", "po 22?", "ne 19?", "ne daten 22"
  const followUpMatch =
    text.match(/(?:po\s+)?(?:ne|me|daten?)\s*(\d{1,2})\b/i) ||
    text.match(/\bpo\s+(\d{1,2})\b/i)
  if (followUpMatch && isVisitTopic) {
    const day = parseInt(followUpMatch[1], 10)
    if (day >= 1 && day <= 31) {
      const targetDate = `${resolvedYear}-${String(resolvedMonth).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      return { kind: 'specific_date', targetDate, isCountOnly: isCount, rawExpression: followUpMatch[0] }
    }
  }

  // 13. Count-only query without specific date
  if (isCount) {
    return { kind: 'count', isCountOnly: true }
  }

  // 14. General visit inventory
  if (
    /\b(?:cfare|cilat|listo|trego|shfaq|historik[u]?)\s+.*vizit[a-z]*/i.test(text) ||
    /\bvizit[a-z]*\s+te\s+regjistruara\b/i.test(text) ||
    /\bvizit[a-z]*\s+e\s+fundit\b/i.test(text) ||
    /\bte\s+gjitha\s+vizit[a-z]*/i.test(text)
  ) {
    return { kind: 'recent' }
  }

  // 15. Any other general mention of visits
  if (text.includes('vizit') || text.includes('visit')) {
    return { kind: 'recent' }
  }

  return { kind: 'none' }
}
