import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuthenticatedUser } from '@/lib/supabase/server'
import { buildCompactCRMContext } from '@/lib/ai/chat-context'
import { orchestrateCRMQuestion } from '@/lib/ai/orchestrator'
import { getTiranaDate } from '@/lib/types'

export const runtime = 'nodejs'
export const maxDuration = 30

const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(2000),
})

const ChatRequestSchema = z.object({
  message: z.string().min(1).max(2000),
  conversationHistory: z.array(ChatMessageSchema).max(100).optional().default([]),
})

export async function POST(req: NextRequest) {
  const { user, supabase: sb, error: authError } = await requireAuthenticatedUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const rawBody = await req.json().catch(() => null)
    const parseResult = ChatRequestSchema.safeParse(rawBody)

    if (!parseResult.success) {
      return NextResponse.json({ error: 'Mesazh ose format i pavlefshëm.' }, { status: 400 })
    }

    const { message, conversationHistory } = parseResult.data

    // Defensively take only the latest bounded history window (last 15 messages)
    const boundedHistory = conversationHistory.slice(-15)

    const today = getTiranaDate()
    const contextResult = await buildCompactCRMContext(sb, message, today, user.id, boundedHistory)

    const result = await orchestrateCRMQuestion({
      message: message.trim(),
      conversationHistory: boundedHistory,
      crmContext: contextResult.text,
    })

    if (!result.ok || !result.reply) {
      return NextResponse.json({
        reply: 'Shërbimi AI për momentin nuk është i disponueshëm. Ju lutem provoni përsëri pak më vonë.',
        provider: result.providerUsed,
      }, { status: 200 })
    }

    return NextResponse.json({
      reply: result.reply,
      provider: result.providerUsed,
    })
  } catch (e: any) {
    console.error('[chat] Handled error in route')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
