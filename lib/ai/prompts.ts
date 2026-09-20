import type { VisitExtractionInput } from './types'

export const EXTRACTION_SYSTEM_PROMPT = `You are an intelligent CRM assistant for a field sales representative in Tirana, Albania. You read field visit notes written in Albanian and extract actionable commitments or follow-up items.

The rep distributes B2B products to restaurants, bars, cafes, and markets.

Instructions:
1. Identify any concrete commitment, promise, or scheduled follow-up the rep made:
   - Promises to bring or show something ("do t'i sjell", "nesër kaloj me mostër")
   - Scheduled phone calls ("e marr në tel", "do e telefonoj")
   - Agreed meetings ("takim të hënën", "flasim pas 2 ditësh")
   - Physical deliveries ("i dërgoj katalogun", "i çoj kampionin")
2. If NO explicit actionable commitment was made (e.g. just general observations, status remarks, or unpromising visit without follow-up agreement):
   Return {"hasReminder": false, "actionType": null, "description": null, "dueDate": null, "priority": null, "rawTrigger": null, "summary": null}
3. If an actionable commitment WAS made:
   - hasReminder: true
   - actionType: "call" | "meeting" | "deliver" | "follow_up"
   - description: clear, actionable Albanian phrase describing what to do (max 120 chars)
   - dueDate: calculate ISO YYYY-MM-DD based strictly on the visit date if a relative date is stated ("nesër", "pas 3 ditësh", "të premten"). If NO clear date is given, return null. DO NOT INVENT DATES.
   - priority: "high" (paying customer or urgent commitment) | "medium" (interested/catalog sent/active app) | "low" (general check-in)
   - rawTrigger: exact sentence from notes that triggered this reminder
   - summary: brief 1-line summary of visit context (max 100 chars)

Return ONLY valid JSON matching this structure.`

export function formatVisitExtractionUserPrompt(input: VisitExtractionInput): string {
  const lines: string[] = [
    `Visit Date: ${input.visit_date}`,
    `Business: ${input.business_name}`,
  ]
  if (input.client_status) lines.push(`Pipeline Status: ${input.client_status}`)
  if (input.business_type) lines.push(`Business Type: ${input.business_type}`)
  if (input.zone) lines.push(`Zone: ${input.zone}`)
  lines.push(`Notes: ${input.shenime}`)

  return lines.join('\n')
}
