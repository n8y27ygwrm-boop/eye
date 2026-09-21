import type { SupabaseClient } from '@supabase/supabase-js'
import { normalize, getTiranaDate } from '../types'
import { resolveVisitQueryIntent, type VisitQueryIntent } from './visit-intent'
import type { ChatMessage } from './types'

export type CompactCRMContext = {
  text: string
  matchedClientName?: string
  intent?: VisitQueryIntent
  totalVisitsCount?: number
}

const GENERIC_BIZ_WORDS = new Set([
  'bar', 'kafe', 'cafe', 'restorant', 'restaurant', 'hotel',
  'pasticeri', 'dyqan', 'market', 'klinika', 'auto', 'farmaci',
  'shpk', 'albania', 'tirana'
])

export function findMentionedClient<T extends { business_name: string }>(
  clients: T[],
  message: string
): T | null {
  const normMessage = normalize(message)
  if (!normMessage) return null

  // 1. Direct full name match (longest first)
  const sorted = [...clients].sort((a, b) => b.business_name.length - a.business_name.length)
  for (const c of sorted) {
    const normName = normalize(c.business_name)
    if (normName.length >= 3 && normMessage.includes(normName)) {
      return c
    }
  }

  // 2. Distinctive token match (e.g. "Oase" matches "Restorant Oase")
  for (const c of sorted) {
    const tokens = normalize(c.business_name)
      .split(/\s+/)
      .filter(t => t.length >= 3 && !GENERIC_BIZ_WORDS.has(t))

    for (const token of tokens) {
      const regex = new RegExp(`\\b${token}\\b`, 'i')
      if (regex.test(normMessage)) {
        return c
      }
    }
  }

  return null
}

export async function buildCompactCRMContext(
  sb: SupabaseClient,
  userMessage: string,
  today: string = getTiranaDate(),
  ownerUserId?: string,
  conversationHistory: ChatMessage[] = []
): Promise<CompactCRMContext> {
  // 1. Resolve visit query intent deterministically
  const intent = resolveVisitQueryIntent({
    message: userMessage,
    conversationHistory,
    today,
  })

  // 2. Fetch overview data: clients, reminders, and total authoritative visit count (strictly owner-scoped)
  let clientsQuery = sb.from('clients').select('id, business_name, status, zone, next_action, next_followup')
  let remindersQuery = sb.from('ai_reminders').select('business_name, action_type, description, priority, due_date, due_time').eq('is_dismissed', false).limit(15)
  let totalVisitsQuery = sb.from('visits').select('id', { count: 'exact', head: true })

  if (ownerUserId) {
    clientsQuery = clientsQuery.eq('owner_user_id', ownerUserId)
    remindersQuery = remindersQuery.eq('owner_user_id', ownerUserId)
    totalVisitsQuery = totalVisitsQuery.eq('owner_user_id', ownerUserId)
  }

  // Execute initial queries in parallel to identify clients and counts
  const [clientsRes, remindersRes, totalVisitsRes] = await Promise.all([
    clientsQuery,
    remindersQuery,
    totalVisitsQuery,
  ])

  const allClients = clientsRes.data ?? []
  const reminders = remindersRes.data ?? []
  const totalVisitsCount =
    typeof totalVisitsRes.count === 'number'
      ? totalVisitsRes.count
      : (totalVisitsRes.data?.length ?? 0)

  // 3. Targeted Entity Matching: Check if user mentions a specific client
  const matchedClient = findMentionedClient(allClients, userMessage)
  if (matchedClient && (intent.kind === 'none' || intent.kind === 'recent')) {
    intent.kind = 'client_specific'
  }

  // 4. Build the intent-aware visit retrieval query (strictly owner-scoped)
  let visitsQuery = sb.from('visits').select('business_name, statusi, shenime, visit_date')
  if (ownerUserId) {
    visitsQuery = visitsQuery.eq('owner_user_id', ownerUserId)
  }

  let visitSectionTitle = ''

  switch (intent.kind) {
    case 'today': {
      visitsQuery = visitsQuery.eq('visit_date', today).order('created_at', { ascending: false })
      visitSectionTitle = `Today's Visits (${today})`
      break
    }
    case 'specific_date': {
      const target = intent.targetDate || today
      visitsQuery = visitsQuery.eq('visit_date', target).order('created_at', { ascending: false })
      visitSectionTitle = `Visits on Date ${target}`
      break
    }
    case 'date_range': {
      visitsQuery = visitsQuery
        .gte('visit_date', intent.from!)
        .lte('visit_date', intent.to!)
        .order('visit_date', { ascending: true })
        .limit(20)
      visitSectionTitle = `Visits from ${intent.from} to ${intent.to}`
      break
    }
    case 'week': {
      visitsQuery = visitsQuery
        .gte('visit_date', intent.from!)
        .lte('visit_date', intent.to!)
        .order('visit_date', { ascending: true })
        .limit(20)
      visitSectionTitle = `This Week's Visits (${intent.from} to ${intent.to})`
      break
    }
    case 'month': {
      visitsQuery = visitsQuery
        .gte('visit_date', intent.from!)
        .lte('visit_date', intent.to!)
        .order('visit_date', { ascending: true })
        .limit(20)
      visitSectionTitle = `Visits for ${intent.from} to ${intent.to}`
      break
    }
    case 'count': {
      visitsQuery = visitsQuery
        .order('visit_date', { ascending: false })
        .limit(5)
      visitSectionTitle = 'Recent Sample Visits'
      break
    }
    case 'client_specific': {
      if (matchedClient) {
        visitsQuery = visitsQuery.eq('client_id', matchedClient.id).order('visit_date', { ascending: false }).limit(5)
        visitSectionTitle = `Visits for ${matchedClient.business_name}`
      } else {
        visitsQuery = visitsQuery.order('visit_date', { ascending: false }).limit(20)
        visitSectionTitle = 'Registered Visits Inventory (Latest)'
      }
      break
    }
    case 'recent': {
      visitsQuery = visitsQuery
        .order('visit_date', { ascending: false })
        .limit(20)
      visitSectionTitle = 'Registered Visits Inventory (Latest)'
      break
    }
    case 'none':
    default: {
      visitsQuery = visitsQuery.eq('visit_date', today).order('created_at', { ascending: false })
      visitSectionTitle = `Today's Visits (${today})`
      break
    }
  }

  // Execute visits query
  const visitsRes = await visitsQuery
  const retrievedVisits = visitsRes.data ?? []

  // Aggregate pipeline status distribution
  const statusCounts: Record<string, number> = {}
  for (const c of allClients) {
    const s = c.status ?? 'prospect'
    statusCounts[s] = (statusCounts[s] ?? 0) + 1
  }

  // Filter follow-up states
  const overdueClients = allClients.filter(c => c.next_followup && c.next_followup < today)
  const dueTodayClients = allClients.filter(c => c.next_followup && c.next_followup === today)
  const upcomingClients = allClients.filter(c => c.next_followup && c.next_followup > today).slice(0, 10)

  // 5. Client Specific History Block (if a client is matched)
  let clientSpecificHistoryBlock = ''
  if (matchedClient) {
    let clientVisitsQuery = sb
      .from('visits')
      .select('visit_date, statusi, shenime')
      .eq('client_id', matchedClient.id)

    if (ownerUserId) {
      clientVisitsQuery = clientVisitsQuery.eq('owner_user_id', ownerUserId)
    }

    const { data: clientVisits } = await clientVisitsQuery
      .order('visit_date', { ascending: false })
      .limit(5)

    const visitLines = (clientVisits ?? []).map(
      v => `    * ${v.visit_date} [${v.statusi ?? 'vizitë'}]: ${v.shenime || '(pa shënime)'}`
    )

    clientSpecificHistoryBlock = [
      '',
      `=== SPECIFIC CLIENT DETAILS FOR "${matchedClient.business_name}" ===`,
      `Pipeline Status: ${matchedClient.status ?? 'prospect'}`,
      `Zone: ${matchedClient.zone ?? 'N/A'}`,
      `Next Action: ${matchedClient.next_action || 'none'}`,
      `Next Follow-up Due: ${matchedClient.next_followup || 'none'}`,
      `Recent Visit Notes:`,
      visitLines.length > 0 ? visitLines.join('\n') : '    (asnjë vizitë e mëparshme)',
      '==================================================',
    ].join('\n')
  }

  // 6. Construct visits section lines
  let visitLines: string[] = []
  if (retrievedVisits.length > 0) {
    visitLines = retrievedVisits.map(
      v => `  - [${v.visit_date}] ${v.business_name}${v.statusi ? ` [${v.statusi}]` : ''}: ${v.shenime ? v.shenime.slice(0, 120) : '(pa shënime)'}`
    )
  } else {
    if (intent.kind === 'specific_date') {
      visitLines = [
        `  (asnjë vizitë e regjistruar për datën ${intent.targetDate}. Shënim: Në të gjithë CRM ekzistojnë ${totalVisitsCount} vizita në data të tjera.)`,
      ]
    } else if (intent.kind === 'today' || intent.kind === 'none') {
      visitLines = [
        `  (asnjë vizitë e regjistruar për sot. Shënim: Në të gjithë CRM ekzistojnë ${totalVisitsCount} vizita në data të tjera.)`,
      ]
    } else if (intent.kind === 'date_range' || intent.kind === 'week' || intent.kind === 'month') {
      visitLines = [
        `  (asnjë vizitë e regjistruar për këtë periudhë. Shënim: Në të gjithë CRM ekzistojnë ${totalVisitsCount} vizita në data të tjera.)`,
      ]
    } else {
      visitLines = [
        totalVisitsCount === 0
          ? '  (nuk keni asnjë vizitë të regjistruar në CRM)'
          : `  (nuk u gjetën vizita për këtë kërkesë. Gjithsej në CRM: ${totalVisitsCount} vizita.)`,
      ]
    }
  }

  // 7. Assemble compact context text
  const lines: string[] = [
    `CRM Overview as of ${today}:`,
    `Total Clients: ${allClients.length}`,
    `Total Registered Visits in CRM: ${totalVisitsCount}`,
    'Pipeline Breakdown:',
    ...Object.entries(statusCounts).map(([k, v]) => `  - ${k}: ${v}`),
    '',
    `Overdue Follow-ups (${overdueClients.length}):`,
    overdueClients.length > 0
      ? overdueClients.slice(0, 10).map(c => `  - ${c.business_name} (due ${c.next_followup}): ${c.next_action || 'Ndiq klientin'}`).join('\n')
      : '  (none)',
    '',
    `Due Today Follow-ups (${dueTodayClients.length}):`,
    dueTodayClients.length > 0
      ? dueTodayClients.map(c => `  - ${c.business_name}: ${c.next_action || 'Ndiq klientin'}`).join('\n')
      : '  (none)',
    '',
    `Upcoming Follow-ups (${upcomingClients.length}):`,
    upcomingClients.length > 0
      ? upcomingClients.map(c => `  - ${c.business_name} (due ${c.next_followup}): ${c.next_action || 'Ndiq klientin'}`).join('\n')
      : '  (none)',
    '',
    `${visitSectionTitle} (${retrievedVisits.length} found, total in CRM: ${totalVisitsCount}):`,
    ...visitLines,
    '',
    `Active AI Reminders (${reminders.length}):`,
    reminders.length > 0
      ? reminders.map(r => {
          let dueStr = ''
          if (r.due_date && r.due_time) {
            dueStr = ` (due ${r.due_date} ${r.due_time})`
          } else if (r.due_date) {
            dueStr = ` (due ${r.due_date})`
          } else if (r.due_time) {
            dueStr = ` (due ${r.due_time})`
          }
          return `  - [${r.priority ?? 'medium'}] ${r.business_name}: ${r.description}${dueStr}`
        }).join('\n')
      : '  (none)',
  ]

  if (clientSpecificHistoryBlock) {
    lines.push(clientSpecificHistoryBlock)
  }

  return {
    text: lines.join('\n'),
    matchedClientName: matchedClient?.business_name,
    intent,
    totalVisitsCount,
  }
}
