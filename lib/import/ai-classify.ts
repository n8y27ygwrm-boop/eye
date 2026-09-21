import { z } from "zod"
import { GroqProvider } from "@/lib/ai/providers/groq"
import type { NormalizedRow, AIDerivedData } from "./types"

const CHUNK_SIZE = 10

const RowClassificationItemSchema = z.object({
  rowIndex: z.number(),
  category: z.string().nullish(),
  zone: z.string().nullish(),
  followUpNeeded: z.boolean().nullish(),
  tags: z.array(z.string()).nullish(),
  confidence: z.number().min(0).max(1).nullish(),
  reasoningCode: z.string().nullish(),
})

const BatchClassificationResponseSchema = z.object({
  items: z.array(RowClassificationItemSchema),
})

const SYSTEM_PROMPT = `You are EYE AI Classifier for a sales CRM in Tirana, Albania.
Analyze rows containing business name, notes, and address/location to derive useful CRM metadata.

Strict rules:
1. NEVER invent phone numbers, websites, addresses, exact coordinates, or business names.
2. Return null for category, zone, or followUpNeeded when uncertain or when evidence is insufficient.
3. Category should be a clean 1-2 word business sector in Albanian or English (e.g., "Restorant", "Farmaci", "Klinikë", "Supermarket", "Hotel", "Kafene", "Dyqan", "Ndërtim", "Auto servis", "Bujqësi").
4. Zone must strictly be one of "Z1", "Z2", "Z3", "Z4", "Z5" if clearly referenced, otherwise null.
5. followUpNeeded: true if notes mention a promise, appointment, catalog request, interested, or deadline.
6. tags: array of 0-3 short lowercase keywords (e.g., ["urgent", "catalog", "decision-maker"]).
7. confidence: float between 0.0 and 1.0.
8. reasoningCode: very brief code like "name_keyword", "note_intent", "uncertain", or null. Do NOT write sentences.

Output strictly valid JSON with shape: { "items": [ { "rowIndex": 0, "category": "...", "zone": null, "followUpNeeded": true, "tags": [], "confidence": 0.85, "reasoningCode": "..." } ] }`

/**
 * Categorizes a chunk of rows reusing the existing GroqProvider instance.
 * Fails safely: returns an empty map on error without throwing.
 */
async function classifyChunk(
  chunk: { index: number; row: NormalizedRow }[],
  provider: GroqProvider
): Promise<Map<number, AIDerivedData>> {
  const resultMap = new Map<number, AIDerivedData>()

  const promptRows = chunk.map(c => ({
    rowIndex: c.index,
    businessName: c.row.business_name,
    note: c.row.general_notes,
    address: c.row.address,
  }))

  try {
    const rawContent = await provider.classifyImportBatch(
      `Classify these ${promptRows.length} rows:\n` + JSON.stringify(promptRows),
      SYSTEM_PROMPT
    )

    if (!rawContent) return resultMap

    const parsedJson = JSON.parse(rawContent)
    const validated = BatchClassificationResponseSchema.parse(parsedJson)

    for (const item of validated.items) {
      resultMap.set(item.rowIndex, {
        category: item.category ? item.category.trim() : null,
        zone: item.zone && /^[Zz][1-5]$/.test(item.zone.trim()) ? item.zone.trim().toUpperCase() : null,
        followUpNeeded: item.followUpNeeded ?? null,
        tags: Array.isArray(item.tags) ? item.tags.slice(0, 3).map(t => String(t).trim().toLowerCase()) : [],
        confidence: typeof item.confidence === "number" ? Math.max(0, Math.min(1, item.confidence)) : 0.7,
        reasoningCode: item.reasoningCode ? item.reasoningCode.trim().slice(0, 30) : null,
      })
    }
  } catch (err: any) {
    console.warn(`[AI Classify] Batch classification error via GroqProvider: ${err.message}`)
  }

  return resultMap
}

/**
 * Batched AI categorization for normalized import rows.
 * Reuses the existing GroqProvider.
 * If Groq is unavailable, fails gracefully returning null for each row without aborting the import.
 */
export async function classifyImportRows(rows: NormalizedRow[]): Promise<(AIDerivedData | null)[]> {
  // If no API key configured, return null for all rows safely
  if (!process.env.GROQ_API_KEY) {
    return rows.map(() => null)
  }

  let provider: GroqProvider
  try {
    provider = new GroqProvider()
  } catch {
    return rows.map(() => null)
  }

  // Filter only rows that have meaningful input (business name or notes)
  const candidates: { index: number; row: NormalizedRow }[] = []
  for (let i = 0; i < rows.length; i++) {
    if (rows[i].business_name || rows[i].general_notes) {
      candidates.push({ index: i, row: rows[i] })
    }
  }

  const results: (AIDerivedData | null)[] = new Array(rows.length).fill(null)

  // Chunk candidates into batches of CHUNK_SIZE
  for (let i = 0; i < candidates.length; i += CHUNK_SIZE) {
    const chunk = candidates.slice(i, i + CHUNK_SIZE)
    const chunkResults = await classifyChunk(chunk, provider)
    for (const [idx, data] of chunkResults.entries()) {
      results[idx] = data
    }
  }

  return results
}
