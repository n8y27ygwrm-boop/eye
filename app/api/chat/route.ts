
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireAuthenticatedUser } from '@/lib/supabase/server'
import { buildCompactCRMContext } from '@/lib/ai/chat-context'
import { orchestrateCRMQuestion } from '@/lib/ai/orchestrator'
import { getTiranaDate } from '@/lib/types'
import { MAX_CURRENT_MESSAGE_CHARS, MAX_HISTORY_INBOUND_CHARS, MAX_HISTORY_INBOUND_MESSAGES, boundConversationHistory } from '@/lib/ai/history'
import { createActionRuntime } from '@/lib/actions/runtime'
import { prepareAIAction } from '@/lib/ai/actions/runtime'

export const runtime = 'nodejs'
export const maxDuration = 30

const HistoryMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().min(1).max(MAX_HISTORY_INBOUND_CHARS),
}).strict()

const ChatRequestSchema = z.object({
  message: z.string().min(1).max(MAX_CURRENT_MESSAGE_CHARS),
  conversationHistory: z.array(HistoryMessageSchema).max(MAX_HISTORY_INBOUND_MESSAGES).optional().default([]),
}).strict()

export async function POST(req: NextRequest) {
  const { user, supabase: sb, error: authError } = await requireAuthenticatedUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  try {
    const rawBody = await req.json().catch(() => null)
    const parseResult = ChatRequestSchema.safeParse(rawBody)
    if (!parseResult.success) {
      console.warn('[chat] validation_failed', parseResult.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })))
      return NextResponse.json({ error: 'Mesazh ose format i pavlefshëm.' }, { status: 400 })
    }

    const { message, conversationHistory } = parseResult.data
    const boundedHistory = boundConversationHistory(conversationHistory)
    const actionRuntime = await createActionRuntime(sb)
    const today = getTiranaDate()
    const contextResult = await buildCompactCRMContext(sb, message, today, user.id, boundedHistory, actionRuntime.mode === 'CANONICAL' ? actionRuntime.service : undefined)
    const result = await orchestrateCRMQuestion({ message: message.trim(), conversationHistory: boundedHistory, crmContext: contextResult.text })

    if (result.ok && result.proposedActionRequest) {
      const planned = await prepareAIAction(actionRuntime, sb, result.proposedActionRequest, today)
      if (!planned.ok) return NextResponse.json({ reply: planned.reply, provider: result.providerUsed })
      return NextResponse.json({ reply: planned.action.confirmationText, pendingAction: planned.action, provider: result.providerUsed })
    }

    if (!result.ok || !result.reply) {
      return NextResponse.json({ reply: 'Shërbimi AI për momentin nuk është i disponueshëm. Ju lutem provoni përsëri pak më vonë.', provider: result.providerUsed })
    }
    return NextResponse.json({ reply: result.reply, provider: result.providerUsed })
  } catch {
    console.error('[chat] handled route failure')
    return NextResponse.json({ error: 'Internal Server Error' }, { status: 500 })
  }
}
