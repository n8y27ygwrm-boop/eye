import type { AIProvider, VisitExtractionInput, VisitAIExtraction, CRMQuestionInput, CRMAnswerOutput } from '../types'
import { EXTRACTION_SYSTEM_PROMPT, formatVisitExtractionUserPrompt, formatCRMQuestionSystemPrompt } from '../prompts'
import { REMINDER_STRICT_JSON_SCHEMA, validateAndNormalizeExtraction } from '../schema'
import { classifyError } from '../errors'

const GROQ_ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions'
const DEFAULT_MODEL = 'openai/gpt-oss-20b'
const TIMEOUT_MS = 8000

export class GroqProvider implements AIProvider {
  readonly name = 'groq' as const
  private apiKey?: string
  private model: string

  constructor(options?: { apiKey?: string; model?: string }) {
    this.apiKey = options?.apiKey ?? process.env.GROQ_API_KEY
    this.model = options?.model ?? process.env.GROQ_MODEL ?? DEFAULT_MODEL
  }

  async extractVisitReminder(input: VisitExtractionInput): Promise<VisitAIExtraction> {
    if (!this.apiKey) {
      throw classifyError(new Error('GROQ_API_KEY is not configured'), this.name)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const userPrompt = formatVisitExtractionUserPrompt(input)
      const res = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
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
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err: any = new Error(`Groq HTTP ${res.status}: ${res.statusText}`)
        err.status = res.status
        throw classifyError(err, this.name)
      }

      const json = await res.json()
      const content = json?.choices?.[0]?.message?.content
      if (!content) {
        throw classifyError(new Error('Groq returned empty content'), this.name)
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
      throw classifyError(new Error('GROQ_API_KEY is not configured'), this.name)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const messages = [
        {
          role: 'system',
          content: formatCRMQuestionSystemPrompt(input.crmContext),
        },
        ...input.conversationHistory.map(m => ({
          role: m.role,
          content: m.content,
        })),
        { role: 'user', content: input.message },
      ]

      const res = await fetch(GROQ_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages,
          temperature: 0.7,
          max_tokens: 1024,
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err: any = new Error(`Groq HTTP ${res.status}: ${res.statusText}`)
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

  async classifyImportBatch(promptContent: string, systemPrompt: string): Promise<string | null> {
    if (!this.apiKey) {
      throw classifyError(new Error("GROQ_API_KEY is not configured"), this.name)
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

    try {
      const res = await fetch(GROQ_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: promptContent },
          ],
          temperature: 0.1,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err: any = new Error(`Groq HTTP ${res.status}: ${res.statusText}`)
        err.status = res.status
        throw classifyError(err, this.name)
      }

      const json = await res.json()
      return json?.choices?.[0]?.message?.content ?? null
    } catch (err) {
      throw classifyError(err, this.name)
    } finally {
      clearTimeout(timer)
    }
  }

}
