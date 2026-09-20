import type { AIProvider, VisitExtractionInput, VisitAIExtraction, CRMQuestionInput, CRMAnswerOutput } from '../types'
import { EXTRACTION_SYSTEM_PROMPT, formatVisitExtractionUserPrompt } from '../prompts'
import { REMINDER_STRICT_JSON_SCHEMA, validateAndNormalizeExtraction } from '../schema'
import { classifyError } from '../errors'

const OPENROUTER_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_MODEL = 'openrouter/free'
const TIMEOUT_MS = 8000

export const OPENROUTER_PRIVACY_CONFIG = {
  require_parameters: true,
  zdr: true,
  data_collection: 'deny',
} as const

export class OpenRouterProvider implements AIProvider {
  readonly name = 'openrouter' as const
  private apiKey?: string
  private model: string

  constructor(options?: { apiKey?: string; model?: string }) {
    this.apiKey = options?.apiKey ?? process.env.OPENROUTER_API_KEY
    this.model = options?.model ?? process.env.OPENROUTER_MODEL ?? DEFAULT_MODEL
  }

  async extractVisitReminder(input: VisitExtractionInput): Promise<VisitAIExtraction> {
    if (!this.apiKey) {
      throw classifyError(new Error('OPENROUTER_API_KEY is not configured'), this.name)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const userPrompt = formatVisitExtractionUserPrompt(input)
      const res = await fetch(OPENROUTER_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://eye-seven-omega.vercel.app',
          'X-Title': 'Eye CRM',
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
            { role: 'user', content: userPrompt },
          ],
          temperature: 0.1,
          response_format: {
            type: 'json_schema',
            json_schema: {
              name: 'visit_reminder_extraction',
              strict: true,
              schema: REMINDER_STRICT_JSON_SCHEMA,
            },
          },
          provider: OPENROUTER_PRIVACY_CONFIG,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err: any = new Error(`OpenRouter HTTP ${res.status}: ${res.statusText}`)
        err.status = res.status
        throw classifyError(err, this.name)
      }

      const json = await res.json()
      const content = json?.choices?.[0]?.message?.content
      if (!content) {
        throw classifyError(new Error('OpenRouter returned empty content'), this.name)
      }

      return validateAndNormalizeExtraction(content)
    } catch (err) {
      throw classifyError(err, this.name)
    } finally {
      clearTimeout(timer)
    }
  }

  async answerCRMQuestion(input: CRMQuestionInput): Promise<CRMAnswerOutput> {
    if (!this.apiKey) {
      throw classifyError(new Error('OPENROUTER_API_KEY is not configured'), this.name)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const messages = [
        {
          role: 'system',
          content: `You are an intelligent assistant for a field sales representative in Tirana, Albania. You have access to their CRM data. You speak Albanian and English — respond in whichever language the user writes in. You know about their ~300 business clients across 17 zones of Tirana, their sales pipeline, active follow-ups, and visit logs. Be concise, practical, and helpful.\n\n${input.crmContext}`,
        },
        ...input.conversationHistory.map(m => ({
          role: m.role,
          content: m.content,
        })),
        { role: 'user', content: input.message },
      ]

      const res = await fetch(OPENROUTER_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
          'HTTP-Referer': 'https://eye-seven-omega.vercel.app',
          'X-Title': 'Eye CRM',
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.7,
          max_tokens: 1024,
          provider: OPENROUTER_PRIVACY_CONFIG,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err: any = new Error(`OpenRouter HTTP ${res.status}: ${res.statusText}`)
        err.status = res.status
        throw classifyError(err, this.name)
      }

      const json = await res.json()
      const reply = json?.choices?.[0]?.message?.content ?? 'Nuk munda të gjeneroj përgjigje.'
      return { reply }
    } catch (err) {
      throw classifyError(err, this.name)
    } finally {
      clearTimeout(timer)
    }
  }
}
