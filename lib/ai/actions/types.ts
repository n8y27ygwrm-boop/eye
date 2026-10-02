
export type CRMActionDateSpec =
  | { kind: 'relative_days'; days: number }
  | { kind: 'explicit_date'; date: string }
  | { kind: 'next_weekday'; weekday: number }

export type CRMActionProposalRequest =
  | {
      type: 'UPDATE_CLIENT_FOLLOWUP'
      clientName: string
      dateSpec: CRMActionDateSpec
      nextAction?: string | null
    }
  | {
      type: 'DISMISS_REMINDER'
      businessName: string
    }
  | {
      type: 'UPDATE_CLIENT_STATUS'
      clientName: string
      status: string
    }

type PendingBase = {
  confirmationToken?: string
  id: string
  targetId: string
  targetName: string
  confirmationText: string
}

export type PendingCRMAction =
  | (PendingBase & {
      type: 'UPDATE_CLIENT_FOLLOWUP'
      payload: { next_followup: string; next_action?: string | null }
      expected: { next_followup: string | null; next_action: string | null }
    })
  | (PendingBase & {
      type: 'DISMISS_REMINDER'
      payload: { is_dismissed: true }
      expected: { is_dismissed: false }
    })
  | (PendingBase & {
      type: 'UPDATE_CLIENT_STATUS'
      payload: { status: string }
      expected: { status: string | null }
    })
