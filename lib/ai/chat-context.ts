import type { SupabaseClient } from '@supabase/supabase-js'
import { normalize, getTiranaDate } from '../types'

export type CompactCRMContext = {
  text: string
  matchedClientName?: string
}

export async function buildCompactCRMContext(
  sb: SupabaseClient,
  userMessage: string,
  today: string = getTiranaDate(),
  ownerUserId?: string
): Promise<CompactCRMContext> {
  const normMessage = normalize(userMessage)

  let clientsQuery = sb.from('clients').select('id, business_name, status, zone, next_action, next_followup')
  let visitsTodayQuery = sb.from('visits').select('business_name, statusi, shenime').eq('visit_date', today)
  let remindersQuery = sb.from('ai_reminders').select('business_name, action_type, description, priority, due_date, due_time').eq('is_dismissed', false).limit(15)

  if (ownerUserId) {
    clientsQuery = clientsQuery.eq('owner_user_id', ownerUserId)
    visitsTodayQuery = visitsTodayQuery.eq('owner_user_id', ownerUserId)
    remindersQuery = remindersQuery.eq('owner_user_id', ownerUserId)
  }

  // 1. Fetch lightweight overview data in parallel (strictly owner-scoped)
  const [clientsRes, visitsTodayRes, remindersRes] = await Promise.all([
    clientsQuery,
    visitsTodayQuery,
    remindersQuery,
  ])

  const allClients = clientsRes.data ?? []
  const visitsToday = visitsTodayRes.data ?? []
  const reminders = remindersRes.data ?? []

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

  // 2. Targeted Entity Matching: Check if user mentions a specific client
  let matchedClient: typeof allClients[0] | null = null
  for (const c of allClients) {
    const normName = normalize(c.business_name)
    if (normName.length >= 3 && normMessage.includes(normName)) {
      matchedClient = c
      break
    }
  }

  let clientSpecificHistoryBlock = ''
  if (matchedClient) {
    // Fetch last 3 visits for this specific client (owner-scoped)
    let clientVisitsQuery = sb
      .from('visits')
      .select('visit_date, statusi, shenime')
      .eq('client_id', matchedClient.id)

    if (ownerUserId) {
      clientVisitsQuery = clientVisitsQuery.eq('owner_user_id', ownerUserId)
    }

    const { data: clientVisits } = await clientVisitsQuery
      .order('visit_date', { ascending: false })
      .limit(3)

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

  // 3. Assemble compact text
  const lines: string[] = [
    `CRM Overview as of ${today}:`,
    `Total Clients: ${allClients.length}`,
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
    `Today's Visits (${visitsToday.length}):`,
    visitsToday.length > 0
      ? visitsToday.map(v => `  - ${v.business_name}${v.statusi ? ` [${v.statusi}]` : ''}${v.shenime ? `: ${v.shenime.slice(0, 100)}` : ''}`).join('\n')
      : '  (asnjë vizitë sot)',
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
  }
}
