import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { analyzeVisitNotes, type VisitWithClient, type AIReminder } from '@/lib/gemini'

// Called by Vercel Cron every evening at 20:00 Albania time (18:00 UTC)
// Also callable manually: POST /api/daily-digest with Authorization: Bearer CRON_SECRET

export const runtime = 'nodejs'
export const maxDuration = 60

function getSupabase() {
  const url = process.env.SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY!
  return createClient(url, key, { auth: { persistSession: false } })
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

function formatReminder(r: AIReminder, index: number): string {
  const icons: Record<AIReminder['action_type'], string> = {
    call: '📞',
    meeting: '🤝',
    deliver: '📦',
    follow_up: '🔄',
  }
  const priorityMark: Record<AIReminder['priority'], string> = {
    high: '🔴',
    medium: '🟡',
    low: '🟢',
  }

  const lines = [
    `${index}. ${icons[r.action_type]} <b>${r.business_name}</b> ${priorityMark[r.priority]}`,
    `   ${r.description}`,
  ]
  if (r.due_date) lines.push(`   📅 Afati: ${r.due_date}`)
  return lines.join('\n')
}

export async function POST(req: NextRequest) {
  // Auth check
  const auth = req.headers.get('authorization') ?? ''
  const secret = process.env.CRON_SECRET ?? ''
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const today = new Date().toISOString().slice(0, 10)
  const sb = getSupabase()

  // Fetch today's visits joined with client data
  const { data: visits, error } = await sb
    .from('visits')
    .select(`
      id,
      visit_date,
      business_name,
      shenime,
      client_id,
      clients (
        id,
        business_name,
        business_type,
        zone,
        status
      )
    `)
    .eq('visit_date', today)

  if (error) {
    console.error('[daily-digest] Supabase error:', error.message)
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (!visits || visits.length === 0) {
    await sendTelegram(`📋 <b>MV CRM — ${today}</b>\n\nAsnjë vizitë e regjistruar sot.`)
    return NextResponse.json({ ok: true, visits: 0, reminders: 0 })
  }

  const visitsWithNotes = visits.filter(v => v.shenime && v.shenime.trim())

  if (visitsWithNotes.length === 0) {
    await sendTelegram(
      `📋 <b>MV CRM — ${today}</b>\n\n${visits.length} vizita të regjistruara, por asnjë me shënime.`
    )
    return NextResponse.json({ ok: true, visits: visits.length, reminders: 0 })
  }

  // Run Gemini analysis
  const reminders = await analyzeVisitNotes(visits as unknown as VisitWithClient[])

  // Build Telegram message
  if (reminders.length === 0) {
    await sendTelegram(
      `📋 <b>MV CRM — ${today}</b>\n\n✅ ${visits.length} vizita të analizuara. Asnjë veprim i kërkuar.`
    )
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
  const secret = process.env.CRON_SECRET ?? ''
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ ok: true, message: 'Daily digest endpoint is alive' })
}
