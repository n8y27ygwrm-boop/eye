import type { SupabaseClient, RealtimeChannel } from '@supabase/supabase-js'
import type { ActionAuthority } from './types'

const registrations = new WeakMap<SupabaseClient, () => void>()
let registrationId = 0

/** Notifications invalidate the authoritative HTTP store; they never become another row store. */
export function subscribeActionInvalidation(
  sb: SupabaseClient,
  owner: string,
  readAuthority: () => Promise<{ mode: ActionAuthority }>,
  refresh: () => Promise<void>,
) {
  registrations.get(sb)?.()
  let active = true
  let timer: ReturnType<typeof setTimeout> | null = null
  let channel: RealtimeChannel | null = null
  const stop = () => {
    if (!active) return
    active = false
    if (timer) clearTimeout(timer)
    if (channel) void sb.removeChannel(channel)
    if (registrations.get(sb) === stop) registrations.delete(sb)
  }
  registrations.set(sb, stop)
  const invalidate = () => {
    if (!active) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      if (active) void refresh()
    }, 80)
  }
  void (async () => {
    try {
      // The authenticated server chooses authority; never guess or fall back on registration failure.
      const { mode } = await readAuthority()
      if (!active) return
      if (mode !== 'CANONICAL' && mode !== 'LEGACY') throw new Error('Invalid action authority')
      const tables = mode === 'CANONICAL'
        ? ['client_actions', 'client_action_events']
        : ['clients', 'ai_reminders', 'client_actions', 'client_action_events']
      // Supabase reuses same-topic channels, including ones still being removed.
      channel = sb.channel(`operational-actions-${owner}-${++registrationId}`)
      for (const table of tables) {
        channel.on('postgres_changes', { event: '*', schema: 'public', table, filter: `owner_user_id=eq.${owner}` }, invalidate)
      }
      const failed = (status: string) => {
        if (active) console.error(`Operational realtime ${mode}: ${status}; authenticated HTTP reads remain authoritative.`)
      }
      channel.on('system', {}, payload => {
        if (payload.status === 'error') failed('server registration failed')
      })
      channel.subscribe(status => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') failed(status)
      })
    } catch {
      if (active) console.error('Operational realtime registration failed; authenticated HTTP reads remain authoritative.')
    }
  })()
  return stop
}
