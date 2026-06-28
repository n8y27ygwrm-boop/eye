import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const maxDuration = 30

type Message = { role: 'user' | 'assistant'; content: string }

function getSupabase() {
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function POST(req: NextRequest) {
  try {
  const body = await req.json()
  const message: string = body.message ?? ''
  const conversationHistory: Message[] = body.conversationHistory ?? []

  if (!message.trim()) {
    return NextResponse.json({ error: 'Empty message' }, { status: 400 })
  }

  const sb = getSupabase()
  const today = new Date().toISOString().slice(0, 10)

  const [clientsRes, visitsRes, remindersRes] = await Promise.all([
    sb.from('clients').select('status'),
    sb.from('visits').select('business_name, statusi, shenime').eq('visit_date', today),
    sb.from('ai_reminders').select('business_name, action_type, description, priority, due_date').eq('is_dismissed', false).limit(20),
  ])

  const statusCounts: Record<string, number> = {}
  for (const c of clientsRes.data ?? []) {
    const s = c.status ?? 'unknown'
    statusCounts[s] = (statusCounts[s] ?? 0) + 1
  }

  const visitsToday = visitsRes.data ?? []
  const reminders = remindersRes.data ?? []

  const lines: string[] = [
    `CRM data as of ${today}:`,
    '',
    `Total clients: ${(clientsRes.data ?? []).length}`,
    'By pipeline status:',
    ...Object.entries(statusCounts).map(([k, v]) => `  - ${k}: ${v}`),
    '',
    `Today's visits (${visitsToday.length}):`,
  ]

  if (visitsToday.length === 0) {
    lines.push('  (no visits logged today)')
  } else {
    for (const v of visitsToday) {
      const note = v.shenime ? ': ' + v.shenime.slice(0, 100) : ''
      lines.push(`  - ${v.business_name}${v.statusi ? ` [${v.statusi}]` : ''}${note}`)
    }
  }

  lines.push('', `Pending AI reminders (${reminders.length}):`)
  if (reminders.length === 0) {
    lines.push('  (none)')
  } else {
    for (const r of reminders) {
      const due = r.due_date ? ` — due ${r.due_date}` : ''
      lines.push(`  - [${r.priority ?? 'medium'}] ${r.business_name}: ${r.description}${due}`)
    }
  }

  const contextBlock = lines.join('\n')

  const systemPrompt = `You are an intelligent assistant for a field sales representative in Tirana, Albania. You have access to their CRM data. You speak Albanian and English — respond in whichever language the user writes in. You know about their ~300 business clients across 17 zones of Tirana, their sales pipeline, and their daily visit logs. Be concise, practical, and helpful.

${contextBlock}`

  const apiKey = process.env.GEMINI_API_KEY
  console.log('GEMINI_API_KEY exists:', !!apiKey)
  console.log('GEMINI_API_KEY first 10 chars:', apiKey?.substring(0, 10))
  if (!apiKey) {
    console.error('[chat] GEMINI_API_KEY not set')
    return NextResponse.json({ error: 'GEMINI_API_KEY not configured' }, { status: 500 })
  }

  const contents = [
    ...conversationHistory.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    })),
    { role: 'user', parts: [{ text: message }] },
  ]

  const geminiRes = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
      }),
    }
  )

  if (!geminiRes.ok) {
    const err = await geminiRes.text()
    console.error('[chat] Gemini error:', err.slice(0, 300))
    return NextResponse.json({ error: 'AI error' }, { status: 500 })
  }

  const json = await geminiRes.json()
  const reply: string = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'Nuk mund të gjeneroj përgjigje.'

  return NextResponse.json({ reply })
  } catch (e) {
    console.error('[chat] Unhandled error:', e)
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}
