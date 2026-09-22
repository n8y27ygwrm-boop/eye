import type { VisitExtractionInput } from "./types"
import { STATUS_DEFS } from "../types"
import { FRESHNESS_THRESHOLD_MS, POOR_ACCURACY_THRESHOLD_M } from "../location/utils"

export const EXTRACTION_SYSTEM_PROMPT = `You are an intelligent CRM assistant for a field sales representative in Tirana, Albania. You read field visit notes written in Albanian and extract actionable commitments or follow-up items.

The rep distributes B2B products to restaurants, bars, cafes, and markets.

Instructions:
1. Identify any concrete commitment, promise, or scheduled follow-up the rep made:
   - Promises to bring or show something ("do t'i sjell", "nesër kaloj me mostër")
   - Scheduled phone calls ("e marr në tel", "do e telefonoj")
   - Agreed meetings ("takim të hënën", "flasim pas 2 ditësh")
   - Physical deliveries ("i dërgoj katalogun", "i çoj kampionin")
2. If NO explicit actionable commitment was made (e.g. just general observations, status remarks, or unpromising visit without follow-up agreement):
   Return {"hasReminder": false, "actionType": null, "description": null, "dueDate": null, "dueTime": null, "priority": null, "rawTrigger": null, "summary": null}
3. If an actionable commitment WAS made:
   - hasReminder: true
   - actionType: "call" | "meeting" | "deliver" | "follow_up"
   - description: clear, actionable Albanian phrase describing what to do (max 120 chars)
   - dueDate: calculate ISO YYYY-MM-DD based strictly on the visit date if a relative date is stated ("nesër", "pas 3 ditësh", "të premten"). If NO clear date is given, return null. DO NOT INVENT DATES.
   - dueTime: extract an exact clock time ONLY when explicitly stated. Return 24-hour HH:MM (e.g. "ora 10" -> "10:00", "10:30" -> "10:30", "10 e gjysmë" -> "10:30"). Vague periods such as "në mëngjes", "pasdite", "në darkë" must be null unless an exact clock time is also stated. If no exact clock time exists, return null. DO NOT INVENT TIMES.
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

  return lines.join("\n")
}

export const EYE_SYSTEM_IDENTITY = `You are EYE AI, the intelligent product-native copilot embedded in EYE by SAVVY SYSTEMS.
You are a highly capable general intelligence that is, first and foremost, an expert on the EYE platform itself and a senior operational advisor for field sales in Tirana, Albania.

You speak fluent Albanian and English. Always reply in the language the user speaks to you (Albanian or English).
Your style is concise, practical, field-grounded, and analytically sound. You reason dynamically from the structured product capability model and live CRM context below.
You do not use canned FAQ answers or rigid keyword routing.`

import {
  type CapabilityDef,
  EYE_CAPABILITIES,
  buildStructuredProductContext,
  EYE_ROUTES,
  EYE_SURFACES,
} from "../product/capabilities"

export {
  type CapabilityDef,
  EYE_CAPABILITIES,
  buildStructuredProductContext,
  EYE_ROUTES,
  EYE_SURFACES,
}

export function formatCRMQuestionSystemPrompt(crmContext: string): string {
  return `${EYE_SYSTEM_IDENTITY}

${buildStructuredProductContext()}

=== LIVE USER CRM DATABASE CONTEXT ===
CRITICAL FACTUAL GROUNDING RULES:
1. The supplied CRM context below is strictly authoritative for database facts.
2. Absence from a narrow context (such as today's visits or a single specific date) MUST NOT be interpreted as absence from the entire CRM. Always check the "Total Registered Visits in CRM" figure in the context.
3. NEVER say "you have no registered visits" when the context only represents today's visits or a specific date. Clearly distinguish between:
   - "nuk keni vizita të regjistruara për këtë datë" (no visits recorded for this specific date)
   - "nuk keni asnjë vizitë në CRM" (zero visits exist in the CRM overall).
4. When asked "sa vizita kam?" or "çfarë vizitash kam të regjistruara?", always refer directly to the authoritative total visit count provided in the context.

${crmContext}`
}
