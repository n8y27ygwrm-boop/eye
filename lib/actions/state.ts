import { ActionError } from './errors'
import { groupOpenActions } from './queue'
import { isUnchangedCanonicalEdit } from './surface'
import type { ActionCommand, ActionService, OperationalAction, ActionEvent, ActionCapabilities, MutationResult } from './types'

export type ActionLoadState =
  | { status: 'idle' | 'loading' }
  | { status: 'loaded'; actions: OperationalAction[] }
  | { status: 'authentication_error' | 'query_error'; error: ActionError }

/** One subscribed store per AppProvider; every surface observes the same authoritative refresh. */
export class ActionStateStore {
  private value: ActionLoadState = { status: 'idle' }
  private listeners = new Set<() => void>()
  private generation = 0
  private accountEpoch = 0
  private cacheGeneration = 0
  private histories = new Map<string, ActionEvent[]>()
  private clientRecords = new Map<string, OperationalAction[]>()
  private pendingCompletions = new Set<string>()
  private readonly service: Pick<ActionService, 'listOpen' | 'forClient' | 'history' | 'mutate' | 'capabilities'>
  constructor(service: Pick<ActionService, 'listOpen' | 'forClient' | 'history' | 'mutate' | 'capabilities'>) { this.service = service }
  get capabilities(): ActionCapabilities | undefined { return this.service.capabilities }
  clientSnapshot = (id: string) => this.clientRecords.get(id)
  historySnapshot = (id: string) => this.histories.get(id)
  snapshot = () => this.value
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private publish(value: ActionLoadState) { this.value = value; this.listeners.forEach(listener => listener()) }
  reset(reason?: 'unauthenticated') { this.cacheGeneration++; this.accountEpoch++; this.generation++; this.histories.clear(); this.clientRecords.clear(); this.publish(reason === 'unauthenticated' ? { status: 'authentication_error', error: new ActionError('unauthenticated', 'Authentication required', 401) } : { status: 'idle' }) }
  async load(showLoading = true) {
    this.cacheGeneration++
    this.histories.clear()
    this.clientRecords.clear()
    const generation = ++this.generation
    if (showLoading || this.value.status !== 'loaded') this.publish({ status: 'loading' })
    try {
      const actions = await this.service.listOpen()
      if (generation === this.generation) this.publish({ status: 'loaded', actions })
    } catch (cause) {
      const error = cause instanceof ActionError ? cause : new ActionError('database', 'Action query failed', 503)
      if (generation === this.generation) this.publish({ status: error.code === 'unauthenticated' ? 'authentication_error' : 'query_error', error })
    }
  }
  refresh = () => this.load(false)
  async mutate(command: ActionCommand) {
    const completionId = command.operation === 'surface' && command.intent === 'complete' ? command.actionId : undefined
    if (completionId && this.pendingCompletions.has(completionId)) return { unchanged: true } as const
    if (completionId) this.pendingCompletions.add(completionId)
    try {
      return await this.performMutation(command)
    } finally {
      if (completionId) this.pendingCompletions.delete(completionId)
    }
  }
  private async performMutation(command: ActionCommand) {
    const epoch = this.accountEpoch
    let target = command.operation === 'surface' && this.value.status === 'loaded'
      ? this.value.actions.find(action => action.id === command.actionId) : undefined
    if (!target && command.operation === 'surface' && ['edit', 'reschedule'].includes(command.intent) && command.expectedVersion != null && command.clientId) {
      target = (await this.service.forClient(command.clientId)).find(action => action.id === command.actionId)
      if (epoch !== this.accountEpoch) throw new ActionError('unauthenticated', 'Account changed while reading', 401)
    }
    const unchanged = command.operation === 'surface' && isUnchangedCanonicalEdit(command, target)
    let result: MutationResult
    try { result = unchanged ? { unchanged: true } : await this.service.mutate(command) }
    catch (cause) {
      if (epoch === this.accountEpoch && cause instanceof ActionError && cause.code === 'conflict') void this.refresh()
      throw cause
    }
    if (epoch !== this.accountEpoch) throw new ActionError('unauthenticated', 'Account changed while saving', 401)
    if ('unchanged' in result) return result
    if (this.value.status === 'loaded') {
      const changed = 'replaced' in result ? [result.replaced, result.successor] : 'removedActionId' in result ? [] : [result]
      const changedIds = new Set('removedActionId' in result ? [result.removedActionId] : changed.map(action => action.id))
      const actions = this.value.actions.filter(action => !changedIds.has(action.id))
      actions.push(...changed.filter(action => action.state === 'open'))
      this.publish({ status: 'loaded', actions })
    }
    // The RPC response is authoritative. A slow follow-up read must not keep the editor saving.
    void this.refresh()
    return result
  }
  forClient = async (id: string) => {
    const epoch = this.accountEpoch
    const cacheGeneration = this.cacheGeneration
    const records = await this.service.forClient(id)
    if (epoch !== this.accountEpoch) throw new ActionError('unauthenticated', 'Account changed while reading', 401)
    if (cacheGeneration !== this.cacheGeneration) throw new ActionError('conflict', 'Actions changed while loading client records', 409)
    this.clientRecords.set(id, records)
    this.publish({ ...this.value })
    return records
  }
  groups(now = new Date()) {
    return this.value.status === 'loaded' ? groupOpenActions(this.value.actions, now) : null
  }
  async history(id: string) {
    const epoch = this.accountEpoch
    const cacheGeneration = this.cacheGeneration
    const events = await this.service.history(id)
    if (epoch !== this.accountEpoch) throw new ActionError('unauthenticated', 'Account changed while reading history', 401)
    if (cacheGeneration !== this.cacheGeneration) throw new ActionError('conflict', 'Actions changed while loading history', 409)
    this.histories.set(id, events)
    this.publish({ ...this.value })
    return events
  }
}
