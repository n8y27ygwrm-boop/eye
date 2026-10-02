import { NextRequest, NextResponse } from 'next/server'
import { requireAuthenticatedUser } from '@/lib/supabase/server'
import { createActionRuntime } from '@/lib/actions/runtime'
import { ActionError } from '@/lib/actions/errors'
import { CanonicalCommandSchema } from '@/lib/actions/canonical'
import { verifyConfirmation } from '@/lib/ai/actions/receipt'
import { PendingCRMActionSchema } from '@/lib/ai/actions/server'
import { parseSurfaceCommand } from '@/lib/actions/surface'
import { readCanonicalReadiness } from '@/lib/actions/readiness'
import { assertOperationalWritesEnabled } from '@/lib/config/write-maintenance'
import { EYE_RELEASE_ID } from '@/lib/config/release'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
function failure(cause: unknown) {
  const error = cause instanceof ActionError ? cause : new ActionError('database', 'Action request failed', 503)
  return NextResponse.json({ code: error.code, error: error.message }, { status: error.status })
}
export async function GET(req: NextRequest) {
  const { user, supabase, error } = await requireAuthenticatedUser()
  if (error || !user) return failure(new ActionError('unauthenticated', 'Authentication required', 401))
  try {
    if (req.nextUrl.searchParams.get('read') === 'canonical-readiness') {
      return NextResponse.json({ ...await readCanonicalReadiness(supabase, req.nextUrl.searchParams.get('id') ?? undefined), release: EYE_RELEASE_ID }, { headers: { 'Cache-Control': 'private, no-store' } })
    }
    const { mode, owner, service } = await createActionRuntime(supabase)
    const read = req.nextUrl.searchParams.get('read') ?? 'open'
    const id = req.nextUrl.searchParams.get('id')
    if (['client', 'action', 'history'].includes(read) && !id) throw new ActionError('invalid', 'Target ID required', 400)
    const data = read === 'capability' ? { mode, capabilities: service.capabilities } : read === 'open' ? await service.listOpen() : read === 'client' ? await service.forClient(id!) : read === 'action' ? await service.byId(id!) : read === 'history' ? await service.history(id!) : (() => { throw new ActionError('invalid', 'Invalid action read', 400) })()
    return NextResponse.json({ mode, capabilities: service.capabilities, data, release: EYE_RELEASE_ID }, { headers: { 'Cache-Control': 'private, no-store' } })
  } catch (cause) { return failure(cause) }
}
export async function POST(req: NextRequest) {
  const { user, supabase, error } = await requireAuthenticatedUser()
  if (error || !user) return failure(new ActionError('unauthenticated', 'Authentication required', 401))
  try {
    assertOperationalWritesEnabled()
    const { mode, owner, service } = await createActionRuntime(supabase)
    const raw = await req.json()
    // The browser cannot select mode. Canonical and legacy payloads are disjoint.
    let command
    if (raw.command?.operation === 'surface') {
      command = parseSurfaceCommand(raw.command)
    } else if (mode === 'LEGACY') {
      if (raw.command?.operation !== 'legacy') throw new ActionError('unsupported', 'Canonical command unavailable in LEGACY mode', 422)
      const parsed = PendingCRMActionSchema.safeParse(raw.command.action)
      if (!parsed.success) throw new ActionError('invalid', 'Invalid legacy command', 400)
      const receipt = verifyConfirmation(owner, mode, parsed.data)
      command = { operation: 'legacy' as const, action: receipt.action }
    } else {
      const parsed = CanonicalCommandSchema.safeParse(raw.command)
      if (!parsed.success) throw new ActionError('invalid', 'Invalid canonical command', 400)
      command = parsed.data
      // AI provenance is restricted to the signed confirmation endpoint.
      if (command.channel === 'ai_chat' || ('fields' in command && 'origin' in command.fields && command.fields.origin === 'ai')) throw new ActionError('forbidden', 'AI commands require an issued confirmation', 403)
    }
    return NextResponse.json({ mode, data: await service.mutate(command) })
  } catch (cause) { return failure(cause) }
}
