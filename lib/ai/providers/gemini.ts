import type { AIProvider, VisitExtractionInput, VisitAIExtraction, CRMQuestionInput, CRMAnswerOutput } from '../types'
import { EXTRACTION_SYSTEM_PROMPT, formatVisitExtractionUserPrompt } from '../prompts'
import { validateAndNormalizeExtraction } from '../schema'
import { classifyError } from '../errors'

export const GEMINI_STRICT_SCHEMA = {
  type: 'OBJECT',
  properties: {
    hasReminder: { type: 'BOOLEAN' },
    actionType: { type: 'STRING', enum: ['call', 'meeting', 'deliver', 'follow_up'], nullable: true },
    description: { type: 'STRING', nullable: true },
    dueDate: { type: 'STRING', nullable: true },
    dueTime: { type: 'STRING', nullable: true },
    priority: { type: 'STRING', enum: ['high', 'medium', 'low'], nullable: true },
    rawTrigger: { type: 'STRING', nullable: true },
    summary: { type: 'STRING', nullable: true },
  },
  required: [
    'hasReminder',
    'actionType',
    'description',
    'dueDate',
    'dueTime',
    'priority',
    'rawTrigger',
    'summary',
  ],
} as const

const DEFAULT_GEMINI_MODEL = 'gemini-flash-latest'
const TIMEOUT_MS = 8000

export class GeminiProvider implements AIProvider {
  readonly name = 'gemini' as const
  private apiKey?: string
  private model: string

  constructor(options?: { apiKey?: string; model?: string }) {
    this.apiKey = options?.apiKey ?? process.env.GEMINI_API_KEY
    this.model = options?.model ?? process.env.GEMINI_MODEL ?? DEFAULT_GEMINI_MODEL
  }

  private getEndpointUrl(): string {
    return `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey!)}`
  }

  async extractVisitReminder(input: VisitExtractionInput): Promise<VisitAIExtraction> {
    if (!this.apiKey) {
      throw classifyError(new Error('GEMINI_API_KEY is not configured'), this.name)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const userPrompt = formatVisitExtractionUserPrompt(input)
      const res = await fetch(this.getEndpointUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: EXTRACTION_SYSTEM_PROMPT }] },
          contents: [{ parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.1,
            responseMimeType: 'application/json',
            responseSchema: GEMINI_STRICT_SCHEMA,
          },
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err: any = new Error(`Gemini HTTP ${res.status}: ${res.statusText}`)
        err.status = res.status
        throw classifyError(err, this.name)
      }

      const json = await res.json()
      const rawText = json?.candidates?.[0]?.content?.parts?.[0]?.text
      if (!rawText) {
        throw classifyError(new Error('Gemini returned empty candidate content'), this.name)
      }

      return validateAndNormalizeExtraction(rawText)
    } catch (err) {
      throw classifyError(err, this.name)
    } finally {
      clearTimeout(timer)
    }
  }

  async answerCRMQuestion(input: CRMQuestionInput): Promise<CRMAnswerOutput> {
    if (!this.apiKey) {
      throw classifyError(new Error('GEMINI_API_KEY is not configured'), this.name)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const systemPrompt = `You are an intelligent assistant for a field sales representative in Tirana, Albania. You have access to their CRM data. You speak Albanian and English — respond in whichever language the user writes in. You know about their ~300 business clients across 17 zones of Tirana, their sales pipeline, active follow-ups, and visit logs. Be concise, practical, and helpful.\n\n${input.crmContext}`

      const contents = [
        ...input.conversationHistory.map(m => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        { role: 'user', parts: [{ text: input.message }] },
      ]

      const res = await fetch(this.getEndpointUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: systemPrompt }] },
          contents,
          generationConfig: { temperature: 0.7, maxOutputTokens: 1024 },
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err: any = new Error(`Gemini HTTP ${res.status}: ${res.statusText}`)
        err.status = res.status
        throw classifyError(err, this.name)
      }

      const json = await res.json()
      const reply = json?.candidates?.[0]?.content?.parts?.[0]?.text ?? 'Nuk munda të gjeneroj përgjigje.'
      return { reply }
    } catch (err) {
      throw classifyError(err, this.name)
    } finally {
      clearTimeout(timer)
    }
  }
}
