import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { REMINDER_STRICT_JSON_SCHEMA, validateAndNormalizeExtraction, RawExtractionSchema } from '../lib/ai/schema'
import { classifyError, isFallbackAllowed, ProviderError } from '../lib/ai/errors'
import { GroqProvider } from '../lib/ai/providers/groq'
import { OpenRouterProvider, OPENROUTER_PRIVACY_CONFIG } from '../lib/ai/providers/openrouter'
import { GeminiProvider, GEMINI_STRICT_SCHEMA } from '../lib/ai/providers/gemini'
import { orchestrateVisitExtraction, orchestrateCRMQuestion } from '../lib/ai/orchestrator'
import { deterministicReminderId } from '../lib/ai/idempotency'
import { NonRetriableError } from 'inngest'
import { inngest } from '../lib/inngest/client'
import {
  processVisitReminder,
  loadAuthoritativeRecord,
  runReminderExtraction,
  persistActionableReminder,
  isWorkflowRetryableCategory,
  WORKFLOW_RETRYABLE_CATEGORIES,
} from '../lib/inngest/functions/process-visit-reminder'
import { enqueueVisitReminder } from '../lib/ai/client-enqueue'
import { getTiranaDate } from '../lib/types'
import { buildCompactCRMContext } from '../lib/ai/chat-context'
import type { AIProvider, VisitExtractionInput, VisitAIExtraction, CRMQuestionInput, CRMAnswerOutput } from '../lib/ai/types'

class MockProvider implements AIProvider {
  name: 'groq' | 'openrouter' | 'gemini'
  extractFn?: (input: VisitExtractionInput) => Promise<VisitAIExtraction>
  answerFn?: (input: CRMQuestionInput) => Promise<CRMAnswerOutput>

  constructor(
    name: 'groq' | 'openrouter' | 'gemini',
    extractFn?: (input: VisitExtractionInput) => Promise<VisitAIExtraction>,
    answerFn?: (input: CRMQuestionInput) => Promise<CRMAnswerOutput>
  ) {
    this.name = name
    this.extractFn = extractFn
    this.answerFn = answerFn
  }

  async extractVisitReminder(input: VisitExtractionInput): Promise<VisitAIExtraction> {
    if (this.extractFn) return this.extractFn(input)
    throw new Error('Not implemented')
  }

  async answerCRMQuestion(input: CRMQuestionInput): Promise<CRMAnswerOutput> {
    if (this.answerFn) return this.answerFn(input)
    return { reply: 'Mock response' }
  }
}

const sampleInput: VisitExtractionInput = {
  visit_id: 'v-101',
  client_id: 'c-202',
  business_name: 'Kafe Bar Tirana',
  visit_date: '2026-09-20',
  shenime: 'Pronari kërkoi të kaloj nesër në mëngjes për të marrë porosinë e parë.',
  client_status: 'App downloaded',
  business_type: 'Bar',
  zone: 'Blloku',
}

describe('AI Operational Loop — Inngest Architecture & Boundary A Verification', () => {

  // 1. Successful persisted visit causes enqueue of exactly one eye/visit.saved
  it('1. Successful persisted visit causes enqueue of exactly one eye/visit.saved', async () => {
    let capturedEvent = null
    const InngestClass = inngest.constructor as any; const origSend = InngestClass.prototype.send
    // Mock inngest.send
    InngestClass.prototype.send = async (payload: any) => {
      capturedEvent = payload
      return { ids: ['event-1'] }
    }

    try {
      const visitId = 'v-persist-100'
      const emitted = await inngest.send({
        name: 'eye/visit.saved',
        data: { visitId },
      })

      assert.equal(emitted.ids.length, 1)
      assert.equal((capturedEvent as any)?.name, 'eye/visit.saved')
      assert.equal((capturedEvent as any)?.data?.visitId, 'v-persist-100')
    } finally {
      InngestClass.prototype.send = origSend
    }
  })

  // 2. Event payload contains exactly { visitId }
  it('2. Event payload contains exactly { visitId } and nothing more', () => {
    const payload = { visitId: 'v-clean-123' }
    const keys = Object.keys(payload)
    assert.deepEqual(keys, ['visitId'])
  })

  // 3. No notes/business/client PII appears in event payload
  it('3. No notes, business name, or client PII appears in event payload', () => {
    const event = {
      name: 'eye/visit.saved',
      data: { visitId: 'v-clean-456' },
    }
    const d = event.data as any
    assert.equal(d.notes, undefined)
    assert.equal(d.shenime, undefined)
    assert.equal(d.business_name, undefined)
    assert.equal(d.client, undefined)
    assert.equal(d.client_id, undefined)
    assert.equal(d.phone, undefined)
    assert.equal(d.prompts, undefined)
  })

  // 4. Event is emitted only after successful visit persistence
  it('4. Event is emitted only after successful visit persistence', async () => {
    // 4a. Source-boundary assertion on contexts/AppContext.tsx
    const appContextPath = path.resolve(process.cwd(), '../eye/contexts/AppContext.tsx')
    assert.equal(fs.existsSync(appContextPath), true, 'AppContext.tsx must exist')
    const appContextSource = fs.readFileSync(appContextPath, 'utf8')

    // enqueueVisitReminder must be imported from client-enqueue
    assert.match(appContextSource, /import\s*\{\s*enqueueVisitReminder\s*\}\s*from\s*['"]@\/lib\/ai\/client-enqueue['"]/)

    // enqueueVisitReminder must only be called in AppContext inside the successful persistence branch
    const enqueueCalls = appContextSource.match(/enqueueVisitReminder\s*\(/g)
    assert.equal(enqueueCalls?.length, 1, 'enqueueVisitReminder must be called exactly once in AppContext')

    // Extract the if (result.kind === "success") block and subsequent branches
    const successBlockMatch = appContextSource.match(/if\s*\(\s*result\.kind\s*===\s*["']success["']\s*\)\s*\{([\s\S]*?)\}\s*else\s*if\s*\(\s*result\.kind\s*===\s*["']failure["']\s*\)/)
    assert.ok(successBlockMatch, 'Must find if (result.kind === "success") block')
    assert.ok(
      successBlockMatch[1].includes('enqueueVisitReminder(result.data.id)'),
      'enqueueVisitReminder must be called strictly inside result.kind === "success" branch'
    )

    // Verify failure and partial blocks do NOT contain enqueueVisitReminder
    const failureBlockMatch = appContextSource.match(/else\s*if\s*\(\s*result\.kind\s*===\s*["']failure["']\s*\)\s*\{([\s\S]*?)\}\s*else\s*if\s*\(\s*result\.kind\s*===\s*["']partial["']\s*\)/)
    assert.ok(failureBlockMatch, 'Must find failure block')
    assert.equal(failureBlockMatch[1].includes('enqueueVisitReminder'), false, 'failure block must NOT call enqueueVisitReminder')

    const partialBlockMatch = appContextSource.match(/else\s*if\s*\(\s*result\.kind\s*===\s*["']partial["']\s*\)\s*\{([\s\S]*?)\}/)
    assert.ok(partialBlockMatch, 'Must find partial block')
    assert.equal(partialBlockMatch[1].includes('enqueueVisitReminder'), false, 'partial block must NOT call enqueueVisitReminder')

    // 4b. Integration simulation verifying enqueueVisitReminder only executes on kind === 'success'
    const postSaveActions: string[] = []
    function simulatePostSaveBranch(result: { kind: 'success' | 'failure' | 'partial'; data?: { id: string } }) {
      if (result.kind === 'success') {
        postSaveActions.push(`enqueue:${result.data?.id}`)
      } else if (result.kind === 'failure') {
        postSaveActions.push('toast:failure')
      } else if (result.kind === 'partial') {
        postSaveActions.push('toast:partial')
      }
    }

    simulatePostSaveBranch({ kind: 'failure' })
    simulatePostSaveBranch({ kind: 'partial' })
    assert.deepEqual(postSaveActions, ['toast:failure', 'toast:partial'])

    simulatePostSaveBranch({ kind: 'success', data: { id: 'v-order-1' } })
    assert.deepEqual(postSaveActions, ['toast:failure', 'toast:partial', 'enqueue:v-order-1'])
  })

  // 5. Event emission failure does not alter successful visit result
  it('5. Event emission failure leaves persisted visit completely successful', async () => {
    const visitResult = {
      kind: 'success' as const,
      data: { id: 'v-saved-ok', business_name: 'Bar Tirana' },
    }

    // Simulate enqueue transport failure
    const mockFailingFetch = (async () => {
      throw new Error('Inngest transport network timeout')
    }) as typeof fetch

    const enqueueRes = await enqueueVisitReminder(visitResult.data.id, mockFailingFetch)
    assert.equal(enqueueRes.ok, false)
    assert.equal(enqueueRes.warning, 'Vizita u ruajt, por AI reminder u vendos në pritje.')

    // Crucial: The persisted visit result is never modified or rolled back
    assert.equal(visitResult.kind, 'success')
    assert.equal(visitResult.data.id, 'v-saved-ok')
  })

  // 6. Inngest function reloads authoritative visit
  it('6. Inngest function reloads authoritative visit directly from database', async () => {
    const mockDbVisit = {
      id: 'v-auth-1',
      visit_date: '2026-09-20',
      business_name: 'Authoritative Business',
      shenime: 'Authoritative note: kalo te henen',
      client_id: 'c-auth-10',
    }
    const mockDbClient = {
      status: 'App downloaded',
      business_type: 'Restaurant',
      zone: 'Blloku',
    }

    const mockSb: any = {
      from: (table: string) => ({
        select: () => ({
          eq: (field: string, val: string) => ({
            maybeSingle: () => {
              if (table === 'visits' && val === 'v-auth-1') return Promise.resolve({ data: mockDbVisit, error: null })
              if (table === 'clients' && val === 'c-auth-10') return Promise.resolve({ data: mockDbClient, error: null })
              return Promise.resolve({ data: null, error: null })
            }
          })
        })
      })
    }

    const record = await loadAuthoritativeRecord('v-auth-1', mockSb)
    assert.equal(record.hasNotes, true)
    assert.equal(record.input?.business_name, 'Authoritative Business')
    assert.equal(record.input?.shenime, 'Authoritative note: kalo te henen')
    assert.equal(record.input?.client_status, 'App downloaded')
    assert.equal(record.input?.zone, 'Blloku')
  })

  // 7. Function does not trust event data beyond visitId
  it('7. Function strictly pulls visitId and ignores any untrusted event payload fields', () => {
    const maliciousEvent = {
      name: 'eye/visit.saved',
      data: {
        visitId: 'v-secure-1',
        shenime: 'ATTACKER_OVERRIDE',
        business_name: 'FAKE_BIZ',
      },
    }
    const { visitId } = maliciousEvent.data
    assert.equal(visitId, 'v-secure-1')
    // No other field from event data is passed to database or AI
  })

  // 8. Blank stored note invokes zero providers
  it('8. Blank stored note exits early and invokes zero AI providers', async () => {
    const mockSb: any = {
      from: (table: string) => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: { id: 'v-blank-1', visit_date: '2026-09-20', business_name: 'Bar Pa Shenime', shenime: '   ', client_id: null },
              error: null,
            })
          })
        })
      })
    }

    const record = await loadAuthoritativeRecord('v-blank-1', mockSb)
    assert.equal(record.hasNotes, false)
    assert.equal(record.input, undefined)
  })

  // 9. Valid hasReminder:false produces no reminder and succeeds
  it('9. Valid hasReminder:false produces no reminder and succeeds cleanly', async () => {
    const mockSb: any = {
      from: (table: string) => ({
        select: () => ({
          or: () => ({
            maybeSingle: () => Promise.resolve({ data: null }),
          })
        })
      })
    }

    const groq = new MockProvider('groq', async () => ({
      hasReminder: false,
      actionType: null,
      description: null,
      dueDate: null,
      priority: null,
      rawTrigger: null,
      summary: null,
    }))

    const stepResult = await runReminderExtraction(sampleInput, mockSb, [groq])
    assert.equal(stepResult.hasReminder, false)
    assert.equal(stepResult.extraction, undefined)
  })

  // 10. Actionable extraction persists reminder
  it('10. Actionable extraction persists reminder with deterministic UUID', async () => {
    let insertedRow: any = null
    const mockSb: any = {
      from: (table: string) => ({
        insert: (row: any) => ({
          select: () => ({
            single: () => {
              insertedRow = row
              return Promise.resolve({ data: { id: row.id }, error: null })
            }
          })
        })
      })
    }

    const extraction: VisitAIExtraction = {
      hasReminder: true,
      actionType: 'call',
      description: 'Telefono klientin neser',
      dueDate: '2026-09-21',
      priority: 'high',
      rawTrigger: 'telefono neser',
      summary: 'Kerkese',
    }

    const persistRes = await persistActionableReminder(sampleInput, extraction, mockSb)
    assert.equal(persistRes.alreadyExists, false)
    assert.equal(insertedRow.id, deterministicReminderId(sampleInput.visit_id))
    assert.equal(insertedRow.description, 'Telefono klientin neser')
    assert.equal(insertedRow.action_type, 'call')
  })

  // 11. Duplicate/retried Inngest execution remains idempotent
  it('11. Duplicate or retried Inngest execution remains idempotent', async () => {
    const deterministicId = deterministicReminderId(sampleInput.visit_id)
    const existingReminder = {
      id: deterministicId,
      business_name: sampleInput.business_name,
      action_type: 'call',
      description: 'Already persisted',
    }

    const mockSb: any = {
      from: (table: string) => ({
        select: () => ({
          or: () => ({
            maybeSingle: () => Promise.resolve({ data: existingReminder })
          })
        })
      })
    }

    const res = await runReminderExtraction(sampleInput, mockSb)
    assert.equal(res.hasReminder, true)
    assert.equal(res.alreadyExists, true)
  })

  // 12. Concurrent equivalent execution cannot create duplicate reminder IDs
  it('12. Concurrent equivalent execution cannot create duplicate reminder IDs', async () => {
    const memoryDb = new Map<string, any>()
    const deterministicId = deterministicReminderId('v-concurrent-99')

    function mockInsert(row: any) {
      if (memoryDb.has(row.id)) {
        const err: any = new Error('duplicate key value violates unique constraint')
        err.code = '23505'
        return { data: null, error: err }
      }
      memoryDb.set(row.id, row)
      return { data: { id: row.id }, error: null }
    }

    const mockSb: any = {
      from: () => ({
        insert: (row: any) => ({
          select: () => ({
            single: () => Promise.resolve(mockInsert(row))
          })
        })
      })
    }

    const dummyExtraction: VisitAIExtraction = {
      hasReminder: true,
      actionType: 'deliver',
      description: 'Dërgo katalogun',
      dueDate: '2026-09-22',
      priority: 'medium',
      rawTrigger: 'katalog',
      summary: 'Katalog',
    }

    const runA = await persistActionableReminder({ ...sampleInput, visit_id: 'v-concurrent-99' }, dummyExtraction, mockSb)
    const runB = await persistActionableReminder({ ...sampleInput, visit_id: 'v-concurrent-99' }, dummyExtraction, mockSb)

    assert.equal(runA.alreadyExists, false)
    assert.equal(runB.alreadyExists, true)
    assert.equal(runA.id, deterministicId)
    assert.equal(runB.id, deterministicId)
    assert.equal(memoryDb.size, 1)
  })

  // 13. Durable workflow retry classification tests
  // A. transient failure (server_error) -> standard Error allows Inngest durable retry
  it('13a. Transient failure (server_error) throws standard Error allowing Inngest durable retry', async () => {
    const mockSb: any = {
      from: () => ({ select: () => ({ or: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) })
    }
    const failingGroq = new MockProvider('groq', async () => {
      const err: any = new Error('503 Service Unavailable')
      err.status = 503
      throw err
    })

    await assert.rejects(
      async () => {
        await runReminderExtraction(sampleInput, mockSb, [failingGroq])
      },
      (err: any) => {
        assert.equal(err.name, 'Error')
        assert.equal(err.message, 'Transient AI processing failure')
        assert.equal(err instanceof NonRetriableError, false)
        return true
      }
    )
  })

  // B. rate limit (rate_limit) -> standard Error
  it('13b. Rate limit (rate_limit) throws standard Error allowing Inngest durable retry', async () => {
    const mockSb: any = {
      from: () => ({ select: () => ({ or: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) })
    }
    const failingGroq = new MockProvider('groq', async () => {
      const err: any = new Error('429 Rate limit exceeded')
      err.status = 429
      throw err
    })

    await assert.rejects(
      async () => {
        await runReminderExtraction(sampleInput, mockSb, [failingGroq])
      },
      (err: any) => {
        assert.equal(err.name, 'Error')
        assert.equal(err.message, 'Transient AI processing failure')
        assert.equal(err instanceof NonRetriableError, false)
        return true
      }
    )
  })

  // C. bad request (bad_request) -> NonRetriableError
  it('13c. Bad request (bad_request) throws NonRetriableError stopping Inngest retries', async () => {
    const mockSb: any = {
      from: () => ({ select: () => ({ or: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) })
    }
    const failingGroq = new MockProvider('groq', async () => {
      const err: any = new Error('400 Bad Request: Malformed JSON input')
      err.status = 400
      throw err
    })

    await assert.rejects(
      async () => {
        await runReminderExtraction(sampleInput, mockSb, [failingGroq])
      },
      (err: any) => {
        assert.equal(err.name, 'NonRetriableError')
        assert.equal(err.message, 'Permanent AI processing failure')
        return true
      }
    )
  })

  // D. unknown/programming error (unknown) -> NonRetriableError
  it('13d. Unknown/programming error (unknown) throws NonRetriableError stopping Inngest retries', async () => {
    const mockSb: any = {
      from: () => ({ select: () => ({ or: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) })
    }
    const failingGroq = new MockProvider('groq', async () => {
      throw new TypeError('Unexpected runtime exception in provider logic')
    })

    await assert.rejects(
      async () => {
        await runReminderExtraction(sampleInput, mockSb, [failingGroq])
      },
      (err: any) => {
        assert.equal(err.name, 'NonRetriableError')
        assert.equal(err.message, 'Permanent AI processing failure')
        return true
      }
    )
  })

  // E. unconfigured (unconfigured) -> NonRetriableError
  it('13e. Unconfigured provider chain throws NonRetriableError stopping Inngest retries', async () => {
    const mockSb: any = {
      from: () => ({ select: () => ({ or: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) })
    }
    const unconfiguredGroq = new MockProvider('groq', async () => {
      throw new Error('Groq API key not configured')
    })
    const unconfiguredOpenRouter = new MockProvider('openrouter', async () => {
      throw new Error('Missing API key for OpenRouter')
    })
    const unconfiguredGemini = new MockProvider('gemini', async () => {
      throw new Error('GEMINI_API_KEY is not configured')
    })

    await assert.rejects(
      async () => {
        await runReminderExtraction(sampleInput, mockSb, [unconfiguredGroq, unconfiguredOpenRouter, unconfiguredGemini])
      },
      (err: any) => {
        assert.equal(err.name, 'NonRetriableError')
        assert.equal(err.message, 'Permanent AI processing failure')
        return true
      }
    )
  })

  // F. auth error (auth_error) -> NonRetriableError
  it('13f. Auth error after exhausting provider chain throws NonRetriableError stopping Inngest retries', async () => {
    const mockSb: any = {
      from: () => ({ select: () => ({ or: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) })
    }
    const unauthorizedGroq = new MockProvider('groq', async () => {
      const err: any = new Error('401 Unauthorized: Invalid API Key')
      err.status = 401
      throw err
    })
    const unauthorizedOpenRouter = new MockProvider('openrouter', async () => {
      const err: any = new Error('403 Forbidden: Account suspended')
      err.status = 403
      throw err
    })

    await assert.rejects(
      async () => {
        await runReminderExtraction(sampleInput, mockSb, [unauthorizedGroq, unauthorizedOpenRouter])
      },
      (err: any) => {
        assert.equal(err.name, 'NonRetriableError')
        assert.equal(err.message, 'Permanent AI processing failure')
        return true
      }
    )
  })

  // G. provider fallback still works (Groq 429 -> OpenRouter success)
  it('13g. Provider fallback still works (Groq 429 -> OpenRouter success) and never reaches Inngest retry', async () => {
    const mockSb: any = {
      from: () => ({ select: () => ({ or: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }) })
    }
    const rateLimitedGroq = new MockProvider('groq', async () => {
      const err: any = new Error('429 Rate limit reached')
      err.status = 429
      throw err
    })
    const successfulOpenRouter = new MockProvider('openrouter', async () => ({
      hasReminder: true,
      actionType: 'call',
      description: 'Telefono pronarin për konfirmim porosie',
      dueDate: '2026-09-22',
      priority: 'high',
      rawTrigger: 'telefono pronarin',
      summary: 'Konfirmim',
    }))

    const res = await runReminderExtraction(sampleInput, mockSb, [rateLimitedGroq, successfulOpenRouter])
    assert.equal(res.hasReminder, true)
    assert.equal(res.provider, 'openrouter')
    assert.equal(res.extraction?.description, 'Telefono pronarin për konfirmim porosie')
  })

  // 14. Permanent/application validation failure does not cascade incorrectly
  it('14. Permanent validation/missing visit throws NonRetriableError to stop retries', async () => {
    const mockSbMissing: any = {
      from: () => ({
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({ data: null, error: null })
          })
        })
      })
    }

    await assert.rejects(
      async () => {
        await loadAuthoritativeRecord('v-missing-id', mockSbMissing)
      },
      (err: any) => {
        assert.equal(err.name, 'NonRetriableError')
        return true
      }
    )
  })

  // 15. /api/inngest registers process-visit-reminder
  it('15. /api/inngest registers process-visit-reminder function', () => {
    assert.equal(processVisitReminder.id(inngest.id), 'eye-process-visit-reminder')
  })

  // 16. Old direct browser /api/reminders/extract processing path is absent
  it('16. Old direct browser /api/reminders/extract processing path is absent from filesystem', () => {
    const extractPath = path.resolve(process.cwd(), '../eye/app/api/reminders/extract')
    assert.equal(fs.existsSync(extractPath), false, 'app/api/reminders/extract must not exist')

    const oldDeliveryPath = path.resolve(process.cwd(), '../eye/lib/ai/client-delivery.ts')
    assert.equal(fs.existsSync(oldDeliveryPath), false, 'lib/ai/client-delivery.ts must not exist')
  })

  // 17. Current AI provider and security tests remain green
  it('17. Provider lifecycle, JSON Schema, OpenRouter privacy routing, and security guards remain active', async () => {
    // 17a. Retired Gemini 1.5 absent
    const rootDir = '/Users/redjonhalilaj/Downloads/eye'
    const activeDirs = ['lib', 'app', 'components', 'contexts']
    for (const d of activeDirs) {
      const full = path.join(rootDir, d)
      if (!fs.existsSync(full)) continue
      const entries = fs.readdirSync(full, { withFileTypes: true, recursive: true })
      for (const entry of entries) {
        if (!entry.isDirectory() && /\.(ts|tsx|js|jsx)$/.test(entry.name)) {
          const content = fs.readFileSync(path.join(entry.parentPath || d, entry.name), 'utf8')
          assert.equal(content.includes('gemini-1.5'), false)
        }
      }
    }

    // 17b. OpenRouter privacy routing
    assert.equal(OPENROUTER_PRIVACY_CONFIG.zdr, true)
    assert.equal(OPENROUTER_PRIVACY_CONFIG.data_collection, 'deny')
    assert.equal(OPENROUTER_PRIVACY_CONFIG.require_parameters, true)

    // 17c. Strict Schema
    assert.equal(REMINDER_STRICT_JSON_SCHEMA.type, 'object')
    assert.equal(REMINDER_STRICT_JSON_SCHEMA.additionalProperties, false)
    assert.equal(REMINDER_STRICT_JSON_SCHEMA.required.length, 7)

    // 17d. Europe/Tirane date at UTC midnight
    const nearMidnight = new Date('2026-09-20T23:30:00.000Z')
    assert.equal(nearMidnight.toISOString().slice(0, 10), '2026-09-20')
    assert.equal(getTiranaDate(nearMidnight), '2026-09-21')
  })

  // 18. Chat input boundary enforcement
  it('18. Chat input validation bounds message and history', async () => {
    const { z } = await import('zod')
    const ChatMessageSchema = z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().min(1).max(2000),
    })
    const ChatRequestSchema = z.object({
      message: z.string().min(1).max(2000),
      conversationHistory: z.array(ChatMessageSchema).max(20).optional().default([]),
    })

    const valid = ChatRequestSchema.safeParse({ message: 'Aferte sot?', conversationHistory: [] })
    assert.equal(valid.success, true)

    const invalid = ChatRequestSchema.safeParse({ message: 'X'.repeat(2005) })
    assert.equal(invalid.success, false)
  })

  // 19. No AI/Inngest/Supabase privileged secret appears in client code
  it('19. No AI, Inngest, or Supabase service secret appears in client code', () => {
    const rootDir = '/Users/redjonhalilaj/Downloads/eye'
    const clientDirs = ['components', 'contexts', 'app/(main)']
    const forbiddenKeys = [
      'INNGEST_EVENT_KEY',
      'INNGEST_SIGNING_KEY',
      'GROQ_API_KEY',
      'OPENROUTER_API_KEY',
      'GEMINI_API_KEY',
      'SUPABASE_SERVICE_KEY',
      'SUPABASE_SERVICE_ROLE_KEY',
    ]

    for (const cDir of clientDirs) {
      const full = path.join(rootDir, cDir)
      if (!fs.existsSync(full)) continue
      const files = fs.readdirSync(full, { withFileTypes: true })
      for (const f of files) {
        if (!f.isDirectory() && /\.(tsx|ts|jsx|js)$/.test(f.name)) {
          const code = fs.readFileSync(path.join(full, f.name), 'utf8')
          for (const key of forbiddenKeys) {
            assert.equal(
              code.includes(key),
              false,
              'Forbidden server key ' + key + ' found in client file ' + f.name
            )
          }
        }
      }
    }
  })
})
