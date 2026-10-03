import type { Client } from './types'

export type NearbyClient = { client: Client; distanceMeters: number }

export type NearbyDecision = {
  businessName: string
  candidateIds: string[]
}

export type NearbyDecisionState = {
  candidates: NearbyClient[]
  pending: NearbyDecision | null
  approved: NearbyDecision | null
}

export const emptyNearbyDecisionState: NearbyDecisionState = {
  candidates: [],
  pending: null,
  approved: null,
}

export function makeNearbyDecision(businessName: string, candidates: NearbyClient[]): NearbyDecision {
  return {
    businessName: businessName.trim(),
    candidateIds: candidates.map(({ client }) => client.id).sort(),
  }
}

export function matchesNearbyDecision(decision: NearbyDecision | null | undefined, businessName: string, candidates: NearbyClient[]): boolean {
  if (!decision || decision.businessName !== businessName.trim()) return false
  const currentIds = candidates.map(({ client }) => client.id).sort()
  return decision.candidateIds.length === currentIds.length
    && decision.candidateIds.every((id, index) => id === currentIds[index])
}

export function nearbyDecisionReducer(state: NearbyDecisionState, action:
  | { type: 'required'; businessName: string; candidates: NearbyClient[] }
  | { type: 'approve' }
  | { type: 'reset' }
): NearbyDecisionState {
  if (action.type === 'reset') return emptyNearbyDecisionState
  if (action.type === 'required') return {
    candidates: action.candidates,
    pending: makeNearbyDecision(action.businessName, action.candidates),
    approved: null,
  }
  return state.pending ? { candidates: [], pending: null, approved: state.pending } : state
}
