import { NextRequest, NextResponse } from 'next/server'
import { getAdminClient } from '@/lib/supabase/server'

// Called by Vercel Cron every evening at 20:00 Albania time (18:00 UTC)
// Also callable manually: POST /api/daily-digest with Authorization: Bearer CRON_SECRET

export const runtime = 'nodejs'
export const maxDuration = 60

type PersistedReminder = {
  id: string
  business_name: string
  action_type: 'call' | 'meeting' | 'deliver' | 'follow_up'
  description: string
  due_date: string | null
  due_time: string | null
  priority: 'high' | 'medium' | 'low'
}

async function sendTelegram(message: string): Promise<void> {
  const token = process.env.TELEGRAM_BOT_TOKEN
  const chatId = process.env.TELEGRAM_CHAT_ID
  if (!token || !chatId) {
    console.error('[telegram] Missing BOT_TOKEN or CHAT_ID')
    return
  }
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML',
    }),
  })
  if (!res.ok) {
    const err = await res.text()
    console.error('[telegram] Send failed:', err)
  }
}

function formatDue(dueDate: string | null, dueTime: string | null): string | null {
  if (dueDate && dueTime) return `${dueDate} · ${dueTime}`
  if (dueDate) return dueDate
  if (dueTime) return dueTime
  return null
}

function formatReminder(r: PersistedReminder, index: number): string {
  const icons: Record<string, string> = {
    call: '📞',
    meeting: '🤝',
    deliver: '📦',
    follow_up: '🔄',
  }
  const priorityMark: Record<string, string> = {
    high: '🔴',
    medium: '🟡',
    low: '🟢',
  }

  const icon = icons[r.action_type] || '🔄'
  const mark = priorityMark[r.priority] || '🟡'

  const lines = [
    `${index}. ${icon} <b>${r.business_name}</b> ${mark}`,
    `   ${r.description}`,
  ]
  const due = formatDue(r.due_date, r.due_time)
  if (due) lines.push(`   📅 Afati: ${due}`)
  return lines.join('\n')
}

export async function POST(req: NextRequest) {
  // Auth check
  const auth = req.headers.get('authorization') ?? ''
  const secret = (process.env.CRON_SECRET ?? '').trim()
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const today = new Date().toISOString().slice(0, 10)
  // Private V1 Constraint: Digest is strictly scoped to the verified primary owner
  const targetOwnerId = (process.env.DAILY_DIGEST_OWNER_ID || 'a1026b88-6a25-4548-a055-cf12ea436bf8').trim()

  let sb: ReturnType<typeof getAdminClient>
  try {
    sb = getAdminClient()
  } catch (err: any) {
    console.error('[daily-digest] Failed to initialize Supabase admin client:', err.message)
    return NextResponse.json({ error: 'Supabase configuration error' }, { status: 500 })
  }

  // 1. Fetch today's visits for visit count strictly scoped to target owner
  const { data: visits, error: visitsError } = await sb
    .from('visits')
    .select('id, visit_date, business_name, shenime')
    .eq('visit_date', today)
    .eq('owner_user_id', targetOwnerId)

  if (visitsError) {
    console.error('[daily-digest] Supabase error fetching visits:', visitsError.message)
    return NextResponse.json({ error: visitsError.message }, { status: 500 })
  }

  if (!visits || visits.length === 0) {
    await sendTelegram(`📋 <b>MV CRM — ${today}</b>\n\nAsnjë vizitë e regjistruar sot.`)
    return NextResponse.json({ ok: true, visits: 0, reminders: 0 })
  }

  // 2. Query persisted ai_reminders for today's visits (single source of truth) scoped to target owner
  const visitIds = visits.map(v => v.id)
  const { data: remindersData, error: remindersError } = await sb
    .from('ai_reminders')
    .select('id, business_name, action_type, description, due_date, due_time, priority')
    .in('visit_id', visitIds)
    .eq('owner_user_id', targetOwnerId)
    .eq('is_dismissed', false)

  if (remindersError) {
    console.error('[daily-digest] Supabase error fetching reminders:', remindersError.message)
    return NextResponse.json({ error: remindersError.message }, { status: 500 })
  }

  const reminders = (remindersData ?? []) as PersistedReminder[]

  if (reminders.length === 0) {
    const visitsWithNotes = visits.filter(v => v.shenime && v.shenime.trim())
    const message = visitsWithNotes.length === 0
      ? `📋 <b>MV CRM — ${today}</b>\n\n${visits.length} vizita të regjistruara, por asnjë me shënime.`
      : `📋 <b>MV CRM — ${today}</b>\n\n✅ ${visits.length} vizita të analizuara. Asnjë veprim i kërkuar.`
    await sendTelegram(message)
    return NextResponse.json({ ok: true, visits: visits.length, reminders: 0 })
  }

  const high = reminders.filter(r => r.priority === 'high')
  const medium = reminders.filter(r => r.priority === 'medium')
  const low = reminders.filter(r => r.priority === 'low')

  const sorted = [...high, ...medium, ...low]

  const header = `📋 <b>MV CRM — Digest ${today}</b>\n${visits.length} vizita · ${reminders.length} veprime\n`
  const body = sorted.map((r, i) => formatReminder(r, i + 1)).join('\n\n')
  const footer = `\n\n<i>Gjeneruar automatikisht nga MV CRM AI</i>`

  const fullMessage = header + '\n' + body + footer

  // Telegram max message length is 4096 chars — split if needed
  if (fullMessage.length <= 4096) {
    await sendTelegram(fullMessage)
  } else {
    await sendTelegram(header + '\n' + sorted.slice(0, 10).map((r, i) => formatReminder(r, i + 1)).join('\n\n') + footer)
    if (sorted.length > 10) {
      const rest = sorted.slice(10)
      await sendTelegram(
        `📋 <b>Vazhdon... (${rest.length} veprime të tjera)</b>\n\n` +
        rest.map((r, i) => formatReminder(r, i + 11)).join('\n\n')
      )
    }
  }

  return NextResponse.json({ ok: true, visits: visits.length, reminders: reminders.length })
}

// Allow GET for quick health check
export async function GET(req: NextRequest) {
  const auth = req.headers.get('authorization') ?? ''
  const secret = (process.env.CRON_SECRET ?? '').trim()
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ ok: true, message: 'Daily digest endpoint is alive' })
}
