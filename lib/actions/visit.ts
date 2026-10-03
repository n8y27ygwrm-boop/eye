import { ActionError } from './errors'
import type { ActionService, SurfaceCommand } from './types'
export type VisitActionPlan = { intent: 'leave' } | { intent: 'create' | 'resolve' | 'replace'; command: SurfaceCommand }
export function validateVisitActionPlan(plan: VisitActionPlan, capabilities: { visitResolve: boolean; replace: boolean } | undefined) {
  if (plan.intent === 'leave') return
  if (!capabilities) throw new ActionError('database', 'Action capabilities have not loaded', 503)
  if ((plan.intent === 'resolve' && !capabilities.visitResolve) || (plan.intent === 'replace' && !capabilities.replace)) throw new ActionError('unsupported', 'This visit action is unavailable', 422)
  const expected = plan.intent === 'resolve' ? 'complete' : plan.intent
  if (plan.command.intent !== expected || plan.command.channel !== 'visit') throw new ActionError('invalid', 'Visit action plan mismatch', 400)
}
export async function applyVisitActionPlan(service: Pick<ActionService, 'mutate'>, plan: VisitActionPlan, visitId: string, clientId: string) {
  if (plan.intent === 'leave') return { unchanged: true as const }
  if (plan.command.clientId !== clientId) throw new ActionError('invalid', 'Visit action client mismatch', 400)
  return service.mutate({ ...plan.command, sourceVisitId: visitId })
}
