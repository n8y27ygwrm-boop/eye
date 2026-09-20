export type EnqueueResult = {
  ok: boolean
  warning?: string
}

/**
 * Enqueue visit reminder for durable background processing via Inngest.
 * - Visit persistence is already complete and primary.
 * - Sends only { visit_id: visitId }.
 * - Uses keepalive: true for reliable delivery on navigation.
 * - Bounded retry: exactly at most 1 retry for transport or 5xx.
 * - Failure surfaces non-blocking warning: 'Vizita u ruajt, por AI reminder u vendos në pritje.'
 */
export async function enqueueVisitReminder(
  visitId: string,
  customFetch: typeof fetch = fetch
): Promise<EnqueueResult> {
  const payload = JSON.stringify({ visit_id: visitId })

  const attempt = async () => {
    return customFetch('/api/reminders/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
    })
  }

  let res: Response | null = null
  let err: any = null

  try {
    res = await attempt()
  } catch (e) {
    err = e
  }

  // Bounded retry: at most once for transport failure or 5xx
  const is5xx = res !== null && res.status >= 500 && res.status <= 599
  if (err || is5xx) {
    try {
      err = null
      res = await attempt()
    } catch (e2) {
      err = e2
      res = null
    }
  }

  if (err || !res || !res.ok) {
    return {
      ok: false,
      warning: 'Vizita u ruajt, por AI reminder u vendos në pritje.',
    }
  }

  try {
    const json = await res.json()
    if (!json || !json.ok) {
      return {
        ok: false,
        warning: 'Vizita u ruajt, por AI reminder u vendos në pritje.',
      }
    }
    return { ok: true }
  } catch {
    return {
      ok: false,
      warning: 'Vizita u ruajt, por AI reminder u vendos në pritje.',
    }
  }
}
