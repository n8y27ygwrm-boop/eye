import { NextRequest, NextResponse } from 'next/server'
import { requireAuthenticatedUser } from '@/lib/supabase/server'
import { inngest } from '@/lib/inngest/client'

export const runtime = 'nodejs'
export const maxDuration = 15

export async function POST(req: NextRequest) {
  const { user, supabase: sb, error: authError } = await requireAuthenticatedUser()
  if (authError || !user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const body = await req.json().catch(() => ({}))
    const visitId = body?.visit_id

    if (!visitId || typeof visitId !== 'string' || !visitId.trim()) {
      return NextResponse.json({ error: 'Missing or invalid visit_id' }, { status: 400 })
    }

    // Verify visit exists through authenticated user RLS session
    const { data: visit, error: visitError } = await sb
      .from('visits')
      .select('id')
      .eq('id', visitId.trim())
      .maybeSingle()

    if (visitError || !visit) {
      return NextResponse.json({ error: 'Visit not found or inaccessible' }, { status: 404 })
    }

    // Emit canonical minimal event to Inngest with authenticated owner identity (strictly server-side)
    await inngest.send({
      name: 'eye/visit.saved',
      data: {
        visitId: visit.id,
        ownerUserId: user.id,
      },
    })

    return NextResponse.json({ ok: true, queued: true })
  } catch (err: any) {
    console.error('[reminders/enqueue] Error enqueuing event')
    return NextResponse.json({ ok: false, error: 'Could not enqueue reminder processing' }, { status: 500 })
  }
}
