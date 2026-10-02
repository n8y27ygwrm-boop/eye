import { ActionError, type ActionErrorCode } from './errors'
import type { ActionCommand, ActionService, ActionAuthority, ActionCapabilities, MutationResult, OperationalAction, ActionEvent } from './types'

/** Client never imports authority config or opens a database connection. */
export function createActionHttpClient() {
  let capabilities: ActionCapabilities | undefined
  async function request<T>(query: string, command?: ActionCommand): Promise<T> {
    const response = await fetch(`/api/actions${query}`, { cache: 'no-store', ...(command ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command }) } : {}) })
    const body = await response.json()
    if (!response.ok) throw new ActionError(body.code as ActionErrorCode ?? 'database', body.error ?? 'Action request failed', response.status)
    capabilities = body.capabilities
    return body.data as T
  }
  return {
    get capabilities() { return capabilities },
    // Mode is supplied only by the server response; it is not a request input.
    capability: () => request<{ mode: ActionAuthority }>('?read=capability'),
    listOpen: () => request<OperationalAction[]>(''),
    forClient: (id: string) => request<OperationalAction[]>(`?read=client&id=${encodeURIComponent(id)}`),
    byId: (id: string) => request<OperationalAction | null>(`?read=action&id=${encodeURIComponent(id)}`),
    history: (id: string) => request<ActionEvent[]>(`?read=history&id=${encodeURIComponent(id)}`),
    mutate: (command: ActionCommand) => request<MutationResult>('', command),
  } satisfies Omit<ActionService, 'mode'> & { capability: () => Promise<{ mode: ActionAuthority }> }
}
