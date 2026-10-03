/** Deterministic provider stand-in; real chat route, resolver, receipts and execution remain active. */
export async function orchestrateCRMQuestion({ message }: { message: string; conversationHistory?: unknown; crmContext?: unknown }) {
  if (message.toLowerCase().includes('follow')) return { ok: true, providerUsed: 'offline-fixture', proposedActionRequest: { type: 'UPDATE_CLIENT_FOLLOWUP' as const, clientName: 'QA Text Date', dateSpec: { kind: 'relative_days' as const, days: message.toLowerCase().includes('change') ? 3 : 1 }, nextAction: message.toLowerCase().includes('change') ? 'Changed AI instruction' : 'Signed AI follow-up' } }
  return { ok: true, providerUsed: 'offline-fixture', reply: 'Offline QA response. No mutation was requested.' }
}
