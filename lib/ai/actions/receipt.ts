import { createHmac, timingSafeEqual } from 'node:crypto'
import type { PendingCRMAction } from './types'
import type { ActionAuthority, CanonicalCommand } from '../../actions/types'
import { ActionError } from '../../actions/errors'

type Receipt = { owner: string; mode: ActionAuthority; action: PendingCRMAction; command: CanonicalCommand | null; expires: number }
function key(secret = process.env.EYE_AI_CONFIRMATION_SECRET) {
  if (typeof window !== 'undefined' || !secret || secret.length < 32) throw new ActionError('configuration', 'EYE_AI_CONFIRMATION_SECRET must contain at least 32 characters', 503)
  return secret
}
export function exactJSON(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(exactJSON).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${exactJSON(v)}`).join(',')}}`
  return JSON.stringify(value)
}
function unsigned(action: PendingCRMAction) {
  const { confirmationToken: _token, ...payload } = action
  return payload as PendingCRMAction
}
/** Stateless signed receipt works across workers/restarts with the same server secret. */
export function issueConfirmation(owner: string, mode: ActionAuthority, action: PendingCRMAction, command: CanonicalCommand | null, secret?: string, now = Date.now()): PendingCRMAction {
  if (command && (command.requestId !== action.id || command.channel !== 'ai_chat')) throw new ActionError('invalid', 'Proposal request binding mismatch', 400)
  const receipt: Receipt = { owner, mode, action: unsigned(action), command, expires: now + 15 * 60_000 }
  const body = Buffer.from(exactJSON(receipt)).toString('base64url')
  const signature = createHmac('sha256', key(secret)).update(body).digest('base64url')
  return { ...action, confirmationToken: `${body}.${signature}` }
}
export function verifyConfirmation(owner: string, mode: ActionAuthority, action: PendingCRMAction, secret?: string, now = Date.now()): Receipt {
  const reject = () => new ActionError('forbidden', 'Confirmation does not match an issued proposal', 403)
  const token = action.confirmationToken
  if (!token || token.length > 30_000) throw reject()
  const [body, signature, extra] = token.split('.')
  if (!body || !signature || extra) throw reject()
  const expected = createHmac('sha256', key(secret)).update(body).digest()
  const received = Buffer.from(signature, 'base64url')
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw reject()
  let receipt: Receipt
  try { receipt = JSON.parse(Buffer.from(body, 'base64url').toString()) } catch { throw reject() }
  if (receipt.owner !== owner || receipt.mode !== mode || !Number.isFinite(receipt.expires) || receipt.expires <= now || exactJSON(receipt.action) !== exactJSON(unsigned(action))) throw reject()
  if (receipt.command && (receipt.command.requestId !== receipt.action.id || receipt.command.channel !== 'ai_chat')) throw reject()
  return receipt
}
