export type ActionErrorCode = 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'request_conflict' | 'invalid' | 'database' | 'unsupported' | 'configuration'
export class ActionError extends Error {
  readonly code: ActionErrorCode
  readonly status: number
  constructor(code: ActionErrorCode, message: string, status = 500) {
    super(message); this.name = 'ActionError'; this.code = code; this.status = status
  }
}
export function databaseError(error: { code?: string; message?: string }): ActionError {
  const codes: Record<string, [ActionErrorCode, number]> = {
    '40001': ['conflict', 409], '23505': ['request_conflict', 409],
    '42501': ['forbidden', 403], 'PGRST301': ['unauthenticated', 401],
    '22023': ['invalid', 400], '22P02': ['invalid', 400], '22007': ['invalid', 400],
    '22008': ['invalid', 400], '23502': ['invalid', 400], '23514': ['invalid', 400], '23503': ['invalid', 400],
  }
  const [code, status] = codes[error.code ?? ''] ?? ['database', 503]
  return new ActionError(code, code === 'database' ? 'Action database request failed' : `Action request rejected: ${code}`, status)
}
