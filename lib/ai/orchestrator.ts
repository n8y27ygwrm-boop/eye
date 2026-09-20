import type {
  AIProvider,
  VisitExtractionInput,
  CRMQuestionInput,
  ExtractionExecutionResult,
  ChatExecutionResult,
} from './types'
import { GroqProvider } from './providers/groq'
import { OpenRouterProvider } from './providers/openrouter'
import { GeminiProvider } from './providers/gemini'
import { classifyError, isFallbackAllowed, ProviderError } from './errors'

export function getDefaultProviders(): AIProvider[] {
  return [
    new GroqProvider(),
    new OpenRouterProvider(),
    new GeminiProvider(),
  ]
}

function logSafe(entry: {
  operation: 'extract_reminder' | 'crm_chat'
  provider: string
  latencyMs: number
  status: 'success' | 'fallback' | 'failed'
  fallbackCount: number
  errorCategory?: string
}) {
  const msg = `[ai-orchestrator] op=${entry.operation} provider=${entry.provider} status=${entry.status} fallbacks=${entry.fallbackCount} latency=${entry.latencyMs}ms${entry.errorCategory ? ` category=${entry.errorCategory}` : ''}`
  if (entry.status === 'success') {
    // Clean info
  } else if (entry.status === 'fallback') {
    console.warn(msg)
  } else {
    console.error(msg)
  }
}

export async function orchestrateVisitExtraction(
  input: VisitExtractionInput,
  providers: AIProvider[] = getDefaultProviders()
): Promise<ExtractionExecutionResult> {
  // Data minimization: if notes are empty or blank, return hasReminder: false immediately without calling providers
  if (!input.shenime || !input.shenime.trim()) {
    return {
      ok: true,
      extraction: {
        hasReminder: false,
        actionType: null,
        description: null,
        dueDate: null,
        priority: null,
        rawTrigger: null,
        summary: null,
      },
      fallbacksUsed: 0,
    }
  }

  let fallbacksUsed = 0
  let lastError: ProviderError | null = null

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i]
    const startTime = Date.now()
    try {
      const extraction = await provider.extractVisitReminder(input)
      const latencyMs = Date.now() - startTime

      logSafe({
        operation: 'extract_reminder',
        provider: provider.name,
        latencyMs,
        status: 'success',
        fallbackCount: fallbacksUsed,
      })

      return {
        ok: true,
        extraction,
        providerUsed: provider.name,
        fallbacksUsed,
      }
    } catch (rawErr: any) {
      const latencyMs = Date.now() - startTime
      const classified = classifyError(rawErr, provider.name)
      lastError = classified

      const fallbackAllowed = isFallbackAllowed(classified.category)
      const isLast = i === providers.length - 1

      logSafe({
        operation: 'extract_reminder',
        provider: provider.name,
        latencyMs,
        status: !fallbackAllowed || isLast ? 'failed' : 'fallback',
        fallbackCount: fallbacksUsed,
        errorCategory: classified.category,
      })

      // If category is not eligible for fallback (e.g. bad_request / unknown), fail closed immediately
      if (!fallbackAllowed) {
        return {
          ok: false,
          fallbacksUsed,
          error: 'AI reminder could not be processed right now.',
          failureCategory: classified.category,
        }
      }

      if (!isLast) {
        fallbacksUsed++
      }
    }
  }

  return {
    ok: false,
    fallbacksUsed,
    error: 'AI reminder could not be processed right now.',
    failureCategory: lastError?.category ?? 'unknown',
  }
}

export async function orchestrateCRMQuestion(
  input: CRMQuestionInput,
  providers: AIProvider[] = getDefaultProviders()
): Promise<ChatExecutionResult> {
  let fallbacksUsed = 0
  let lastError: ProviderError | null = null

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i]
    const startTime = Date.now()
    try {
      const result = await provider.answerCRMQuestion(input)
      const latencyMs = Date.now() - startTime

      logSafe({
        operation: 'crm_chat',
        provider: provider.name,
        latencyMs,
        status: 'success',
        fallbackCount: fallbacksUsed,
      })

      return {
        ok: true,
        reply: result.reply,
        providerUsed: provider.name,
        fallbacksUsed,
      }
    } catch (rawErr: any) {
      const latencyMs = Date.now() - startTime
      const classified = classifyError(rawErr, provider.name)
      lastError = classified

      const fallbackAllowed = isFallbackAllowed(classified.category)
      const isLast = i === providers.length - 1

      logSafe({
        operation: 'crm_chat',
        provider: provider.name,
        latencyMs,
        status: !fallbackAllowed || isLast ? 'failed' : 'fallback',
        fallbackCount: fallbacksUsed,
        errorCategory: classified.category,
      })

      // If category is not eligible for fallback, fail closed immediately
      if (!fallbackAllowed) {
        return {
          ok: false,
          fallbacksUsed,
          error: 'Shërbimi AI për momentin nuk është i disponueshëm.',
        }
      }

      if (!isLast) {
        fallbacksUsed++
      }
    }
  }

  return {
    ok: false,
    fallbacksUsed,
    error: 'Shërbimi AI për momentin nuk është i disponueshëm.',
  }
}
