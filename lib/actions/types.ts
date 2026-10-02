export type ActionAuthority = 'LEGACY' | 'CANONICAL'
export type ActionState = 'open' | 'completed' | 'cancelled' | 'replaced' | 'legacy_closed'
export type ActionType = 'call' | 'meeting' | 'deliver' | 'follow_up'
export type ActionPriority = 'high' | 'medium' | 'low'
export type ActionChannel = 'client_detail' | 'field_control' | 'map' | 'visit' | 'ai_chat' | 'api'

/** DB names retained to avoid a second, lossy lifecycle representation. */
export interface OperationalAction {
  revision?: string
  allowed_operations?: ('edit' | 'reschedule' | 'complete' | 'cancel' | 'replace')[]
  id: string
  owner_user_id: string
  client_id: string | null
  client_name_snapshot: string
  description: string
  action_type: ActionType
  due_date: string | null
  due_time: string | null
  priority: ActionPriority
  state: ActionState
  origin: 'manual' | 'ai' | 'legacy'
  version: number | null // Legacy has no version; never fabricate one.
  source_visit_id: string | null
  source_excerpt: string | null
  resolution_visit_id: string | null
  replaces_action_id: string | null
  creation_key: string | null
  created_at: string | null
  updated_at: string | null
  closed_at: string | null
  closed_by: string | null
  closure_note: string | null
}
export interface ActionEvent {
  id: string; owner_user_id: string; action_id: string; action_version: number
  request_id: string; event_type: string; actor_user_id: string | null
  channel: string; related_visit_id: string | null; recorded_at: string
  request_body: unknown; result: unknown; before: unknown; after: unknown; legacy_source: unknown
}
export interface ActionFields {
  description: string; action_type: ActionType; due_date: string | null
  due_time: string | null; priority: ActionPriority
}
export interface NewActionFields extends ActionFields {
  origin: 'manual' | 'ai'; source_visit_id: string | null
  source_excerpt: string | null; creation_key: string
}
type Request = { requestId: string; channel: ActionChannel }
type Target = { actionId: string; expectedVersion: number }
export type CanonicalCommand = Request & (
  | { operation: 'create'; clientId: string; fields: NewActionFields }
  | (Target & { operation: 'edit' | 'reschedule'; fields: ActionFields })
  | (Target & { operation: 'complete' | 'cancel'; resolutionVisitId: string | null; closureNote: string | null })
  | (Target & { operation: 'replace'; fields: NewActionFields; closureNote: string })
)
/** Explicit legacy operations preserve existing semantics and concurrency evidence. */
export type LegacyCommand = {
  operation: 'legacy'; action: import('../ai/actions/types').PendingCRMAction
}
export interface ActionCapabilities { history: boolean; visitResolve: boolean; replace: boolean }
export type SurfaceCommand = {
  operation: 'surface'; intent: 'create' | 'edit' | 'reschedule' | 'complete' | 'cancel' | 'replace' | 'leave'
  requestId: string; channel: ActionChannel; clientId: string | null
  actionId?: string; expectedVersion?: number | null; expectedRevision?: string
  fields?: ActionFields; sourceVisitId?: string | null; reason?: string
}
export type ActionCommand = CanonicalCommand | LegacyCommand | SurfaceCommand
export type MutationResult = OperationalAction | { replaced: OperationalAction; successor: OperationalAction } | { removedActionId: string } | { unchanged: true }
export interface ActionService {
  readonly mode: ActionAuthority
  readonly capabilities?: ActionCapabilities
  listOpen(): Promise<OperationalAction[]>
  forClient(clientId: string): Promise<OperationalAction[]>
  byId(actionId: string): Promise<OperationalAction | null>
  history(actionId: string): Promise<ActionEvent[]>
  mutate(command: ActionCommand): Promise<MutationResult>
}
