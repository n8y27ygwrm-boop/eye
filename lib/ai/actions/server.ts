
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { SupabaseClient } from '@supabase/supabase-js'
import { normalize, STATUS_DEFS } from '../../types'
import { formatFollowupDate } from '../../followup'
import type { CRMActionDateSpec, CRMActionProposalRequest, PendingCRMAction } from './types'

export type ActionClientRecord = {
  id: string
  business_name: string
  status: string | null
  next_action: string | null
  next_followup: string | null
}

export type ActionReminderRecord = {
  id: string
  business_name: string
  description: string
  is_dismissed: boolean
}

type StoreResult<T> = { data: T | null; error: string | null }

export interface CRMActionStore {
  listClients(ownerUserId: string): Promise<StoreResult<ActionClientRecord[]>>
  listActiveReminders(ownerUserId: string): Promise<StoreResult<ActionReminderRecord[]>>
  getClient(ownerUserId: string, id: string): Promise<StoreResult<ActionClientRecord>>
  getReminder(ownerUserId: string, id: string): Promise<StoreResult<ActionReminderRecord>>
  updateClientFollowup(ownerUserId: string, id: string, expected: { next_followup: string | null; next_action: string | null }, patch: { next_followup: string | null; next_action?: string | null }): Promise<StoreResult<ActionClientRecord>>
  updateClientStatus(ownerUserId: string, id: string, expectedStatus: string | null, status: string): Promise<StoreResult<ActionClientRecord>>
  dismissReminder(ownerUserId: string, id: string, expected?: Record<string, unknown>): Promise<StoreResult<ActionReminderRecord>>
}

export function createSupabaseCRMActionStore(sb: SupabaseClient): CRMActionStore {
  return {
    async listClients(ownerUserId) {
      const { data, error } = await sb.from('clients').select('id, business_name, status, next_action, next_followup').eq('owner_user_id', ownerUserId)
      return { data: data as ActionClientRecord[] | null, error: error?.message ?? null }
    },
    async listActiveReminders(ownerUserId) {
      const { data, error } = await sb.from('ai_reminders').select('id, business_name, description, is_dismissed').eq('owner_user_id', ownerUserId).eq('is_dismissed', false)
      return { data: data as ActionReminderRecord[] | null, error: error?.message ?? null }
    },
    async getClient(ownerUserId, id) {
      const { data, error } = await sb.from('clients').select('id, business_name, status, next_action, next_followup').eq('id', id).eq('owner_user_id', ownerUserId).maybeSingle()
      return { data: data as ActionClientRecord | null, error: error?.message ?? null }
    },
    async getReminder(ownerUserId, id) {
      const { data, error } = await sb.from('ai_reminders').select('id, business_name, description, is_dismissed').eq('id', id).eq('owner_user_id', ownerUserId).maybeSingle()
      return { data: data as ActionReminderRecord | null, error: error?.message ?? null }
    },
    async updateClientFollowup(ownerUserId, id, expected, patch) {
      let query = sb.from('clients').update({
        next_followup: patch.next_followup,
        ...('next_action' in patch ? { next_action: patch.next_action } : {}),
        updated_at: new Date().toISOString(),
      }).eq('id', id).eq('owner_user_id', ownerUserId)
      query = expected.next_followup === null ? query.is('next_followup', null) : query.eq('next_followup', expected.next_followup)
      if ('next_action' in patch) query = expected.next_action === null ? query.is('next_action', null) : query.eq('next_action', expected.next_action)
      const { data, error } = await query.select('id, business_name, status, next_action, next_followup').maybeSingle()
      return { data: data as ActionClientRecord | null, error: error?.message ?? null }
    },
    async updateClientStatus(ownerUserId, id, expectedStatus, status) {
      let query = sb.from('clients').update({ status, updated_at: new Date().toISOString() }).eq('id', id).eq('owner_user_id', ownerUserId)
      query = expectedStatus === null ? query.is('status', null) : query.eq('status', expectedStatus)
      const { data, error } = await query.select('id, business_name, status, next_action, next_followup').maybeSingle()
      return { data: data as ActionClientRecord | null, error: error?.message ?? null }
    },
    async dismissReminder(ownerUserId, id, expected) {
      let query = sb.from('ai_reminders').update({ is_dismissed: true }).eq('id', id).eq('owner_user_id', ownerUserId).eq('is_dismissed', false)
      if (expected) for (const field of ['description', 'due_date', 'due_time', 'client_id', 'visit_id', 'action_type', 'priority']) {
        const value = expected[field] ?? null
        query = value === null ? query.is(field, null) : query.eq(field, value)
      }
      const { data, error } = await query.select('id, business_name, description, is_dismissed').maybeSingle()
      return { data: data as ActionReminderRecord | null, error: error?.message ?? null }
    },
  }
}

function addDays(baseDateISO: string, days: number): string {
  const [year, month, day] = baseDateISO.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCDate(date.getUTCDate() + days)
  return [date.getUTCFullYear(), String(date.getUTCMonth() + 1).padStart(2, '0'), String(date.getUTCDate()).padStart(2, '0')].join('-')
}

export function resolveActionDate(today: string, spec: CRMActionDateSpec): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) return null
  if (spec.kind === 'explicit_date') return /^\d{4}-\d{2}-\d{2}$/.test(spec.date) ? spec.date : null
  if (spec.kind === 'relative_days') return Number.isInteger(spec.days) && spec.days >= 0 && spec.days <= 365 ? addDays(today, spec.days) : null
  if (!Number.isInteger(spec.weekday) || spec.weekday < 0 || spec.weekday > 6) return null
  const [year, month, day] = today.split('-').map(Number)
  const currentWeekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay()
  let delta = (spec.weekday - currentWeekday + 7) % 7
  if (delta === 0) delta = 7
  return addDays(today, delta)
}

function resolveUniqueByName<T extends { business_name: string }>(rows: T[], requestedName: string): { kind: 'one'; row: T } | { kind: 'none' } | { kind: 'many'; rows: T[] } {
  const target = normalize(requestedName)
  if (target.length < 2) return { kind: 'none' }
  const exact = rows.filter(row => normalize(row.business_name) === target)
  if (exact.length === 1) return { kind: 'one', row: exact[0] }
  if (exact.length > 1) return { kind: 'many', rows: exact }
  const partial = rows.filter(row => {
    const name = normalize(row.business_name)
    return name.includes(target) || target.includes(name)
  })
  if (partial.length === 1) return { kind: 'one', row: partial[0] }
  if (partial.length > 1) return { kind: 'many', rows: partial }
  return { kind: 'none' }
}

function ambiguityReply(rows: { business_name: string }[]): string {
  const names = [...new Set(rows.map(row => row.business_name))].slice(0, 5)
  return `Nuk mund ta zgjedh në mënyrë të sigurt. Gjeta disa përputhje: ${names.join(', ')}. Cilin ke parasysh?`
}

export type ResolveActionResult = { ok: true; action: PendingCRMAction } | { ok: false; reply: string }

export async function resolveProposedCRMAction(store: CRMActionStore, ownerUserId: string, request: CRMActionProposalRequest, today: string): Promise<ResolveActionResult> {
  if (request.type === 'UPDATE_CLIENT_FOLLOWUP') {
    const listed = await store.listClients(ownerUserId)
    if (listed.error || !listed.data) return { ok: false, reply: 'Nuk munda të lexoj klientët për ta përgatitur ndryshimin.' }
    const resolved = resolveUniqueByName(listed.data, request.clientName)
    if (resolved.kind === 'none') return { ok: false, reply: `Nuk gjeta një klient të vetëm që përputhet me "${request.clientName}".` }
    if (resolved.kind === 'many') return { ok: false, reply: ambiguityReply(resolved.rows) }
    const nextFollowup = resolveActionDate(today, request.dateSpec)
    if (!nextFollowup) return { ok: false, reply: 'Data e kërkuar nuk mund të përcaktohet në mënyrë të sigurt.' }
    const row = resolved.row
    const formatted = formatFollowupDate(nextFollowup, { withYear: true })
    const confirmationText = request.nextAction !== undefined
      ? `Ta vendos follow-up-in e ${row.business_name} për ${formatted} dhe veprimin "${request.nextAction || '—'}"?`
      : `Ta vendos follow-up-in e ${row.business_name} për ${formatted}?`
    return { ok: true, action: {
      id: randomUUID(), type: 'UPDATE_CLIENT_FOLLOWUP', targetId: row.id, targetName: row.business_name,
      payload: { next_followup: nextFollowup, ...(request.nextAction !== undefined ? { next_action: request.nextAction } : {}) },
      expected: { next_followup: row.next_followup, next_action: row.next_action }, confirmationText,
    } }
  }

  if (request.type === 'DISMISS_REMINDER') {
    const listed = await store.listActiveReminders(ownerUserId)
    if (listed.error || !listed.data) return { ok: false, reply: 'Nuk munda të lexoj veprimet aktive për ta përgatitur ndryshimin.' }
    const resolved = resolveUniqueByName(listed.data, request.businessName)
    if (resolved.kind === 'none') return { ok: false, reply: `Nuk gjeta një veprim aktiv të vetëm për "${request.businessName}".` }
    if (resolved.kind === 'many') return { ok: false, reply: ambiguityReply(resolved.rows) }
    const row = resolved.row
    return { ok: true, action: {
      id: randomUUID(), type: 'DISMISS_REMINDER', targetId: row.id, targetName: row.business_name,
      payload: { is_dismissed: true }, expected: { is_dismissed: false },
      confirmationText: `Ta shënoj si të kryer veprimin për ${row.business_name}: "${row.description}"?`,
    } }
  }

  const allowedStatus = STATUS_DEFS.find(status => status.key === request.status)
  if (!allowedStatus) return { ok: false, reply: 'Statusi i kërkuar nuk është një status i vlefshëm i EYE.' }
  const listed = await store.listClients(ownerUserId)
  if (listed.error || !listed.data) return { ok: false, reply: 'Nuk munda të lexoj klientët për ta përgatitur ndryshimin.' }
  const resolved = resolveUniqueByName(listed.data, request.clientName)
  if (resolved.kind === 'none') return { ok: false, reply: `Nuk gjeta një klient të vetëm që përputhet me "${request.clientName}".` }
  if (resolved.kind === 'many') return { ok: false, reply: ambiguityReply(resolved.rows) }
  const row = resolved.row
  return { ok: true, action: {
    id: randomUUID(), type: 'UPDATE_CLIENT_STATUS', targetId: row.id, targetName: row.business_name,
    payload: { status: allowedStatus.key }, expected: { status: row.status },
    confirmationText: `Ta ndryshoj statusin e ${row.business_name} në "${allowedStatus.label}"?`,
  } }
}

const BasePendingFields = {
  confirmationToken: z.string().max(30000).optional(),
  id: z.string().min(1).max(100),
  targetId: z.string().min(1).max(120),
  targetName: z.string().min(1).max(200),
  confirmationText: z.string().min(1).max(500),
}

export const PendingCRMActionSchema = z.discriminatedUnion('type', [
  z.object({ ...BasePendingFields, type: z.literal('UPDATE_CLIENT_FOLLOWUP'), payload: z.object({ next_followup: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), next_action: z.string().max(200).nullable().optional() }).strict(), expected: z.object({ next_followup: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(), next_action: z.string().max(500).nullable() }).strict() }).strict(),
  z.object({ ...BasePendingFields, type: z.literal('DISMISS_REMINDER'), payload: z.object({ is_dismissed: z.literal(true) }).strict(), expected: z.object({ is_dismissed: z.literal(false) }).strict() }).strict(),
  z.object({ ...BasePendingFields, type: z.literal('UPDATE_CLIENT_STATUS'), payload: z.object({ status: z.string().min(1).max(80) }).strict(), expected: z.object({ status: z.string().max(80).nullable() }).strict() }).strict(),
])

export type CRMActionExecutionResult = { ok: boolean; status: number; code: string; reply: string }

export async function executePendingCRMAction(store: CRMActionStore, ownerUserId: string, action: PendingCRMAction): Promise<CRMActionExecutionResult> {
  if (action.type === 'UPDATE_CLIENT_FOLLOWUP') {
    const current = await store.getClient(ownerUserId, action.targetId)
    if (current.error) return { ok: false, status: 500, code: 'read_failed', reply: 'Ndryshimi dështoi gjatë verifikimit.' }
    if (!current.data) return { ok: false, status: 404, code: 'not_found', reply: 'Klienti nuk u gjet ose nuk i përket kësaj llogarie.' }
    const sameFollowup = current.data.next_followup === action.payload.next_followup
    const sameAction = !('next_action' in action.payload) || current.data.next_action === action.payload.next_action
    if (sameFollowup && sameAction) return { ok: false, status: 409, code: 'already_applied', reply: 'Ky ndryshim është aplikuar tashmë.' }
    if (current.data.next_followup !== action.expected.next_followup || ('next_action' in action.payload && current.data.next_action !== action.expected.next_action)) return { ok: false, status: 409, code: 'stale', reply: 'Të dhënat kanë ndryshuar ndërkohë. Propozoje veprimin përsëri.' }
    const updated = await store.updateClientFollowup(ownerUserId, action.targetId, action.expected, action.payload)
    if (updated.error) return { ok: false, status: 500, code: 'write_failed', reply: 'Nuk u ruajt ndryshimi. Provo përsëri.' }
    if (!updated.data) return { ok: false, status: 409, code: 'stale', reply: 'Ndryshimi nuk u aplikua sepse rekordi ndryshoi ndërkohë.' }
    const verified = updated.data.next_followup === action.payload.next_followup && (!('next_action' in action.payload) || updated.data.next_action === action.payload.next_action)
    if (!verified) return { ok: false, status: 500, code: 'verify_failed', reply: 'Ruajtja nuk mund të verifikohej.' }
    return { ok: true, status: 200, code: 'updated', reply: `U përditësua — ${updated.data.business_name} · follow-up ${formatFollowupDate(updated.data.next_followup, { withYear: true })}.` }
  }

  if (action.type === 'DISMISS_REMINDER') {
    const current = await store.getReminder(ownerUserId, action.targetId)
    if (current.error) return { ok: false, status: 500, code: 'read_failed', reply: 'Veprimi dështoi gjatë verifikimit.' }
    if (!current.data) return { ok: false, status: 404, code: 'not_found', reply: 'Veprimi nuk u gjet ose nuk i përket kësaj llogarie.' }
    if (current.data.is_dismissed) return { ok: false, status: 409, code: 'already_applied', reply: 'Ky veprim është shënuar tashmë si i kryer.' }
    const updated = await store.dismissReminder(ownerUserId, action.targetId)
    if (updated.error) return { ok: false, status: 500, code: 'write_failed', reply: 'Nuk u ruajt ndryshimi. Provo përsëri.' }
    if (!updated.data || !updated.data.is_dismissed) return { ok: false, status: 409, code: 'stale', reply: 'Veprimi nuk u shënua si i kryer.' }
    return { ok: true, status: 200, code: 'dismissed', reply: `U krye — veprimi për ${updated.data.business_name} u hoq nga lista aktive.` }
  }

  const allowedStatus = STATUS_DEFS.find(status => status.key === action.payload.status)
  if (!allowedStatus) return { ok: false, status: 400, code: 'invalid_status', reply: 'Statusi nuk është i vlefshëm.' }
  const current = await store.getClient(ownerUserId, action.targetId)
  if (current.error) return { ok: false, status: 500, code: 'read_failed', reply: 'Ndryshimi dështoi gjatë verifikimit.' }
  if (!current.data) return { ok: false, status: 404, code: 'not_found', reply: 'Klienti nuk u gjet ose nuk i përket kësaj llogarie.' }
  if (current.data.status === action.payload.status) return { ok: false, status: 409, code: 'already_applied', reply: 'Ky status është vendosur tashmë.' }
  if (current.data.status !== action.expected.status) return { ok: false, status: 409, code: 'stale', reply: 'Statusi ka ndryshuar ndërkohë. Propozoje veprimin përsëri.' }
  const updated = await store.updateClientStatus(ownerUserId, action.targetId, action.expected.status, action.payload.status)
  if (updated.error) return { ok: false, status: 500, code: 'write_failed', reply: 'Nuk u ruajt statusi. Provo përsëri.' }
  if (!updated.data || updated.data.status !== action.payload.status) return { ok: false, status: 500, code: 'verify_failed', reply: 'Ruajtja e statusit nuk mund të verifikohej.' }
  return { ok: true, status: 200, code: 'updated', reply: `U përditësua — ${updated.data.business_name} · statusi "${allowedStatus.label}".` }
}
