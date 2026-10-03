
import { NextRequest, NextResponse } from 'next/server'
import { requireAuthenticatedUser } from '@/lib/supabase/server'
import { PendingCRMActionSchema } from '@/lib/ai/actions/server'

import { createActionRuntime } from '@/lib/actions/runtime'
import { confirmAIAction } from '@/lib/ai/actions/runtime'
import { ActionError } from '@/lib/actions/errors'
import { confirmationReadiness } from '@/lib/actions/readiness'
import { assertOperationalWritesEnabled } from '@/lib/config/write-maintenance'

export const runtime = 'nodejs'
export const maxDuration = 15

export async function GET() {
  const { user, supabase, error } = await requireAuthenticatedUser()
  if (error || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const { mode, owner } = await createActionRuntime(supabase)
    return NextResponse.json(confirmationReadiness(owner, mode), { headers: { 'Cache-Control': 'private, no-store' } })
  } catch {
    return NextResponse.json({ code: 'configuration', error: 'Signing configuration unavailable' }, { status: 503 })
  }
}

export async function POST(req: NextRequest) {
  const { user, supabase: sb, error: authError } = await requireAuthenticatedUser()
  if (authError || !user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const rawBody = await req.json().catch(() => null)
  const parsed = PendingCRMActionSchema.safeParse(rawBody?.action)
  if (!parsed.success) {
    console.warn('[chat-action] validation_failed', parsed.error.issues.map(issue => ({ path: issue.path.join('.'), code: issue.code })))
    return NextResponse.json({ ok: false, code: 'invalid_action', error: 'Veprimi i propozuar nuk është i vlefshëm.' }, { status: 400 })
  }

  try {
    assertOperationalWritesEnabled()
    const actionRuntime = await createActionRuntime(sb)
    const result = await confirmAIAction(actionRuntime, sb, parsed.data)
    return NextResponse.json({ ok: result.ok, code: result.code, ...(result.ok ? { reply: result.reply } : { error: result.reply }) }, { status: result.status })
  } catch (cause) {
    const error = cause instanceof ActionError ? cause : new ActionError('database', 'Ndryshimi dështoi. Provo përsëri.', 503)
    return NextResponse.json({ ok: false, code: error.code, error: error.message }, { status: error.status })
  }
}
