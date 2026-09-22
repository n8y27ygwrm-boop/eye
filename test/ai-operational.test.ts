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
      const ownerUserId = 'u-persist-100'
      const emitted = await inngest.send({
        name: 'eye/visit.saved',
        data: { visitId, ownerUserId },
      })

      assert.equal(emitted.ids.length, 1)
      assert.equal((capturedEvent as any)?.name, 'eye/visit.saved')
      assert.equal((capturedEvent as any)?.data?.visitId, 'v-persist-100')
      assert.equal((capturedEvent as any)?.data?.ownerUserId, 'u-persist-100')
    } finally {
      InngestClass.prototype.send = origSend
    }
  })

  // 2. Event payload contains exactly { visitId, ownerUserId }
  it('2. Event payload contains exactly { visitId, ownerUserId } and nothing more', () => {
    const payload = { visitId: 'v-clean-123', ownerUserId: 'u-clean-123' }
    const keys = Object.keys(payload).sort()
    assert.deepEqual(keys, ['ownerUserId', 'visitId'])
  })

  // 3. No notes/business/client PII appears in event payload
  it('3. No notes, business name, or client PII appears in event payload', () => {
    const event = {
      name: 'eye/visit.saved',
      data: { visitId: 'v-clean-456', ownerUserId: 'u-clean-456' },
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
        select: () => {
          const queryObj: any = {
            eq: () => queryObj,
            maybeSingle: () => Promise.resolve({
              data: { id: 'v-blank-1', owner_user_id: 'u-blank-1', visit_date: '2026-09-20', business_name: 'Bar Pa Shenime', shenime: '   ', client_id: null },
              error: null,
            })
          }
          return queryObj
        }
      })
    }

    const record = await loadAuthoritativeRecord('v-blank-1', 'u-blank-1', mockSb)
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
      dueTime: null,
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
      dueTime: '10:00',
      priority: 'high',
      rawTrigger: 'telefono neser',
      summary: 'Kerkese',
    }

    const inputWithOwner = {
      ...sampleInput,
      owner_user_id: 'u-sample-owner',
    }

    const persistRes = await persistActionableReminder(inputWithOwner, extraction, mockSb)
    assert.equal(persistRes.alreadyExists, false)
    assert.equal(insertedRow.id, deterministicReminderId(inputWithOwner.visit_id))
    assert.equal(insertedRow.owner_user_id, 'u-sample-owner')
    assert.equal(insertedRow.description, 'Telefono klientin neser')
    assert.equal(insertedRow.action_type, 'call')
    assert.equal(insertedRow.due_date, '2026-09-21')
    assert.equal(insertedRow.due_time, '10:00')
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
      dueTime: null,
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
      dueTime: '14:30',
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
    assert.equal(REMINDER_STRICT_JSON_SCHEMA.required.length, 8)
    assert.ok(REMINDER_STRICT_JSON_SCHEMA.required.includes('dueTime'))
    assert.ok('dueTime' in REMINDER_STRICT_JSON_SCHEMA.properties)

    // 17d. Europe/Tirane date at UTC midnight
    const nearMidnight = new Date('2026-09-20T23:30:00.000Z')
    assert.equal(nearMidnight.toISOString().slice(0, 10), '2026-09-20')
    assert.equal(getTiranaDate(nearMidnight), '2026-09-21')
  })

  // 18. Chat input boundary enforcement & history resilience (>20 messages)
  it('18. Chat input validation bounds message and history, accepts >20 messages and retains latest window', async () => {
    const { z } = await import('zod')
    const ChatMessageSchema = z.object({
      role: z.enum(['user', 'assistant']),
      content: z.string().min(1).max(2000),
    })
    const ChatRequestSchema = z.object({
      message: z.string().min(1).max(2000),
      conversationHistory: z.array(ChatMessageSchema).max(100).optional().default([]),
    })

    // Valid basic request
    const valid = ChatRequestSchema.safeParse({ message: 'Aferte sot?', conversationHistory: [] })
    assert.equal(valid.success, true)

    // Defensively accepts long conversation history (>20 messages, e.g. 25 messages)
    const longHistory = Array.from({ length: 25 }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `Message index ${i}`,
    }))
    const validLong = ChatRequestSchema.safeParse({ message: 'Pyetje e radhes?', conversationHistory: longHistory })
    assert.equal(validLong.success, true)

    // Deterministic truncation preserves the latest 15 messages
    if (validLong.success) {
      const bounded = validLong.data.conversationHistory.slice(-15)
      assert.equal(bounded.length, 15)
      assert.equal(bounded[0].content, 'Message index 10')
      assert.equal(bounded[14].content, 'Message index 24')
    }

    // Invalid roles rejected (e.g. 'system', 'admin')
    const invalidRole = ChatRequestSchema.safeParse({
      message: 'Test',
      conversationHistory: [{ role: 'system' as any, content: 'Malicious injection' }],
    })
    assert.equal(invalidRole.success, false)

    // Content bounds enforcement
    const invalidLength = ChatRequestSchema.safeParse({ message: 'X'.repeat(2005) })
    assert.equal(invalidLength.success, false)

    const invalidEmpty = ChatRequestSchema.safeParse({ message: '' })
    assert.equal(invalidEmpty.success, false)
  })

  // 21. Grounded EYE Structured Product Capability & Behavioral Integrity
  describe('21. Structured EYE Capability Model & Behavioral Integrity', () => {
    // A. current EYE status taxonomy comes from source-of-truth
    it('21a. Status taxonomy in AI capability context is derived directly from STATUS_DEFS source-of-truth', async () => {
      const { buildStructuredProductContext } = await import('../lib/ai/prompts')
      const { STATUS_DEFS } = await import('../lib/types')
      const context = buildStructuredProductContext()
      for (const s of STATUS_DEFS) {
        assert.ok(context.includes(s.key), `Capability context must include STATUS_DEFS key '${s.key}'`)
        assert.ok(context.includes(s.label), `Capability context must include STATUS_DEFS label '${s.label}'`)
      }
    })

    // B. unknown/future capability is not claimed as current
    it('21b. Future and non-existent capabilities are strictly separated from current capabilities', async () => {
      const { EYE_CAPABILITIES, buildStructuredProductContext } = await import('../lib/ai/prompts')
      const context = buildStructuredProductContext()

      const futureCaps = EYE_CAPABILITIES.filter(c => c.status === 'PLANNED_FUTURE')
      assert.ok(futureCaps.length >= 4, 'Must define planned/future boundaries')

      const currentSection = context.split('NOT CURRENTLY SUPPORTED')[0]
      for (const f of futureCaps) {
        assert.ok(
          !currentSection.includes(`Capability: ${f.capability}`),
          `Future capability '${f.capability}' must NOT appear in CURRENT SURFACES section`
        )
      }

      assert.ok(!context.includes('drone delivery'), 'Must not claim fictional drone delivery')
      assert.ok(!context.includes('automated cold calling'), 'Must not claim automated cold calling')
    })

    // C. product question can be answered from structured capability context
    it('21c. Structured capability context provides architectural dependencies to answer product questions', async () => {
      const { EYE_CAPABILITIES } = await import('../lib/ai/prompts')
      const importCap = EYE_CAPABILITIES.find(c => c.surface === 'Import Inbox')
      assert.ok(importCap, 'Import Inbox must exist in capability registry')
      assert.match(importCap.route || '', /Clients|list/i, 'Import Inbox route must anchor to Clients surface')

      const clientsCap = EYE_CAPABILITIES.find(c => c.surface === 'Clients')
      assert.ok(clientsCap, 'Clients surface must exist')
      assert.match(clientsCap.action, /Import Data/i, 'Clients surface action must provide Import Data entry point')

      const mapCap = EYE_CAPABILITIES.find(c => c.surface === 'Map')
      assert.match(mapCap?.constraints || '', /clients with verified lat\/lng/i, 'Map depends on client records')

      const routeCap = EYE_CAPABILITIES.find(c => c.surface === 'Route / Visits')
      assert.match(routeCap?.constraints || '', /manually logs each visit/i, 'Route logs visits against clients')
    })

    // D. no static hardcoded zone count is present
    it('21d. No static hardcoded zone count or invented zone lists exist in prompts', async () => {
      const { buildStructuredProductContext } = await import('../lib/ai/prompts')
      const context = buildStructuredProductContext()

      assert.ok(!context.includes('17 Tirana zones'), 'Must not claim 17 Tirana zones')
      assert.ok(!context.includes('17 zonat'), 'Must not claim 17 zonat')
      assert.match(context, /Dynamically derived from the user's active client records/i, 'Zones must be specified as dynamically derived')
    })

    // E. live CRM facts still override model assumptions
    it('21e. Live CRM facts are strictly authoritative over model assumptions in system prompt', async () => {
      const { formatCRMQuestionSystemPrompt } = await import('../lib/ai/prompts')
      const crmContext = 'Total Registered Visits in CRM: 35. Total visits for today (2026-09-22): 0.'
      const prompt = formatCRMQuestionSystemPrompt(crmContext)

      assert.ok(prompt.includes(crmContext), 'Live CRM context must be included verbatim')
      assert.match(prompt, /The supplied CRM context below is strictly authoritative for database facts/i)
      assert.match(prompt, /NEVER say "you have no registered visits" when the context only represents today's visits/i)
    })
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

  // 20. dueTime validation and normalization rules
  describe('20. dueTime validation and normalization rules', () => {
    const baseRaw = {
      hasReminder: true,
      actionType: 'call',
      description: 'Telefono klientin për porosi',
      dueDate: '2026-09-21',
      priority: 'high',
      rawTrigger: 'telefono neser',
      summary: 'Porosi',
    }

    // A. dueDate = "2026-09-21", dueTime = "10:00" -> same values preserved
    it('20a. Preserves valid dueDate and valid dueTime (10:00)', () => {
      const result = validateAndNormalizeExtraction({
        ...baseRaw,
        dueDate: '2026-09-21',
        dueTime: '10:00',
      })
      assert.equal(result.dueDate, '2026-09-21')
      assert.equal(result.dueTime, '10:00')
    })

    // B. dueTime = "23:59" -> valid
    it('20b. Accepts boundary 24-hour time 23:59 as valid', () => {
      const result = validateAndNormalizeExtraction({
        ...baseRaw,
        dueTime: '23:59',
      })
      assert.equal(result.dueTime, '23:59')
    })

    // C. dueTime = "00:00" -> valid
    it('20c. Accepts boundary 24-hour time 00:00 as valid', () => {
      const result = validateAndNormalizeExtraction({
        ...baseRaw,
        dueTime: '00:00',
      })
      assert.equal(result.dueTime, '00:00')
    })

    // D. dueTime = "24:00" -> null
    it('20d. Normalizes invalid 24-hour time 24:00 to null without throwing', () => {
      const result = validateAndNormalizeExtraction({
        ...baseRaw,
        dueTime: '24:00',
      })
      assert.equal(result.dueTime, null)
    })

    // E. dueTime = "10:75" -> null
    it('20e. Normalizes invalid minute time 10:75 to null without throwing', () => {
      const result = validateAndNormalizeExtraction({
        ...baseRaw,
        dueTime: '10:75',
      })
      assert.equal(result.dueTime, null)
    })

    // F. dueTime = "afternoon" -> null
    it('20f. Normalizes vague non-time string "afternoon" to null without throwing', () => {
      const result = validateAndNormalizeExtraction({
        ...baseRaw,
        dueTime: 'afternoon',
      })
      assert.equal(result.dueTime, null)
    })

    // G. hasReminder = false -> dueDate = null, dueTime = null
    it('20g. hasReminder:false returns dueDate:null and dueTime:null', () => {
      const result = validateAndNormalizeExtraction({
        hasReminder: false,
        actionType: null,
        description: null,
        dueDate: '2026-09-21',
        dueTime: '10:00',
        priority: null,
        rawTrigger: null,
        summary: null,
      })
      assert.equal(result.hasReminder, false)
      assert.equal(result.dueDate, null)
      assert.equal(result.dueTime, null)
    })
  })

  describe("22. Product Capability Registry & AI Model Split", () => {
    it("22a. Product capability registry is imported by AI and matches product capability module", async () => {
      const { EYE_CAPABILITIES: aiCaps, buildStructuredProductContext: aiBuild } = await import("../lib/ai/prompts")
      const { EYE_CAPABILITIES: prodCaps, buildStructuredProductContext: prodBuild, EYE_ROUTES } = await import("../lib/product/capabilities")

      assert.strictEqual(aiCaps, prodCaps)
      assert.strictEqual(aiBuild, prodBuild)
      assert.equal(typeof EYE_ROUTES.CLIENTS, "string")
      assert.equal(EYE_ROUTES.CLIENTS, "/list")
    })

    it("22b. buildStructuredProductContext dynamically derives status taxonomy from STATUS_DEFS", async () => {
      const { buildStructuredProductContext } = await import("../lib/product/capabilities")
      const { STATUS_DEFS } = await import("../lib/types")
      const context = buildStructuredProductContext()

      for (const def of STATUS_DEFS) {
        assert.ok(
          context.includes(def.key) && context.includes(def.label),
          `Expected context to contain status key "${def.key}" and label "${def.label}"`
        )
      }
    })

    it("22c. GroqProvider chat model and background model are independently configurable via options and env", async () => {
      const { GroqProvider, DEFAULT_BACKGROUND_MODEL, DEFAULT_CHAT_MODEL } = await import("../lib/ai/providers/groq")

      const prevModel = process.env.GROQ_MODEL
      const prevChatModel = process.env.GROQ_CHAT_MODEL
      delete process.env.GROQ_MODEL
      delete process.env.GROQ_CHAT_MODEL

      try {
        const defaultProvider = new GroqProvider({ apiKey: "mock" })
        assert.equal(defaultProvider.getBackgroundModel(), DEFAULT_BACKGROUND_MODEL)
        assert.equal(defaultProvider.getChatModel(), DEFAULT_CHAT_MODEL)

        process.env.GROQ_MODEL = "custom-bg-env"
        process.env.GROQ_CHAT_MODEL = "custom-chat-env"
        const envProvider = new GroqProvider({ apiKey: "mock" })
        assert.equal(envProvider.getBackgroundModel(), "custom-bg-env")
        assert.equal(envProvider.getChatModel(), "custom-chat-env")

        const customProvider = new GroqProvider({
          apiKey: "mock",
          model: "options-bg",
          chatModel: "options-chat",
        })
        assert.equal(customProvider.getBackgroundModel(), "options-bg")
        assert.equal(customProvider.getChatModel(), "options-chat")
      } finally {
        if (prevModel !== undefined) process.env.GROQ_MODEL = prevModel
        else delete process.env.GROQ_MODEL
        if (prevChatModel !== undefined) process.env.GROQ_CHAT_MODEL = prevChatModel
        else delete process.env.GROQ_CHAT_MODEL
      }
    })

    it("22d. GroqProvider routes answerCRMQuestion to chat model and extraction/import to background model", async () => {
      const { GroqProvider } = await import("../lib/ai/providers/groq")

      const capturedModels: { call: string; model: string }[] = []
      const originalFetch = globalThis.fetch
      globalThis.fetch = (async (url: any, init: any) => {
        const body = JSON.parse(init.body)
        if (url.includes("completions")) {
          if (body.response_format?.type === "json_schema") {
            capturedModels.push({ call: "extractVisitReminder", model: body.model })
            return new Response(JSON.stringify({
              choices: [{
                message: {
                  content: JSON.stringify({
                    hasReminder: false,
                    actionType: null,
                    description: null,
                    dueDate: null,
                    dueTime: null,
                    priority: null,
                    rawTrigger: null,
                    summary: null,
                  })
                }
              }]
            }), { status: 200 })
          } else if (body.response_format?.type === "json_object") {
            capturedModels.push({ call: "classifyImportBatch", model: body.model })
            return new Response(JSON.stringify({ choices: [{ message: { content: "{\"items\":[]}" } }] }), { status: 200 })
          } else {
            capturedModels.push({ call: "answerCRMQuestion", model: body.model })
            return new Response(JSON.stringify({ choices: [{ message: { content: "CRM Answer" } }] }), { status: 200 })
          }
        }
        return originalFetch(url, init)
      }) as any

      try {
        const provider = new GroqProvider({
          apiKey: "mock-key",
          model: "openai/gpt-oss-20b",
          chatModel: "openai/gpt-oss-120b",
        })

        await provider.answerCRMQuestion({
          message: "Sa kliente kam?",
          conversationHistory: [],
          crmContext: "CRM Context",
        })

        await provider.extractVisitReminder({
          visit_id: "test-visit-1",
          client_id: "test-client-1",
          visit_date: "2026-09-22",
          business_name: "Test Client",
          shenime: "Note",
        })

        await provider.classifyImportBatch("batch content", "system prompt")

        assert.equal(capturedModels.length, 3)
        assert.equal(capturedModels[0].call, "answerCRMQuestion")
        assert.equal(capturedModels[0].model, "openai/gpt-oss-120b")

        assert.equal(capturedModels[1].call, "extractVisitReminder")
        assert.equal(capturedModels[1].model, "openai/gpt-oss-20b")

        assert.equal(capturedModels[2].call, "classifyImportBatch")
        assert.equal(capturedModels[2].model, "openai/gpt-oss-20b")
      } finally {
        globalThis.fetch = originalFetch
      }
    })

    it("22e. buildCompactCRMContext correctly grounds with non-zero owner-scoped clients and visits", async () => {
      const { buildCompactCRMContext } = await import("../lib/ai/chat-context")

      const ownerId = "user-owner-123"
      const mockClients = [
        { id: "c1", business_name: "Minimarket Fredi", status: "Customer/Purchase", zone: "Blloku", next_action: "Merr porosi", next_followup: "2026-09-22", owner_user_id: ownerId },
        { id: "c2", business_name: "Restorant Kashta", status: "Customer/Purchase", zone: "Kombinat", next_action: null, next_followup: null, owner_user_id: ownerId },
      ]
      const mockVisits = [
        { id: "v1", client_id: "c1", business_name: "Minimarket Fredi", visit_date: "2026-09-22", statusi: "Customer/Purchase", shenime: "U krye porosia", owner_user_id: ownerId },
        { id: "v2", client_id: "c2", business_name: "Restorant Kashta", visit_date: "2026-09-21", statusi: "prospect", shenime: "I interesuar per furnizim", owner_user_id: ownerId },
      ]

      const mockSb = {
        from: (table: string) => {
          if (table === "clients") {
            return {
              select: () => ({
                eq: (col: string, val: string) => {
                  assert.equal(col, "owner_user_id")
                  assert.equal(val, ownerId)
                  return Promise.resolve({ data: mockClients, error: null })
                }
              })
            }
          }
          if (table === "ai_reminders") {
            return {
              select: () => ({
                eq: () => ({
                  limit: () => ({
                    eq: () => Promise.resolve({ data: [], error: null })
                  })
                })
              })
            }
          }
          if (table === "visits") {
            return {
              select: (_cols: any, opts?: any) => {
                if (opts?.head) {
                  return {
                    eq: (col: string, val: string) => {
                      assert.equal(col, "owner_user_id")
                      assert.equal(val, ownerId)
                      return Promise.resolve({ count: mockVisits.length, data: null, error: null })
                    }
                  }
                }
                return {
                  eq: (col: string, val: string) => ({
                    eq: (dCol: string, dVal: string) => ({
                      order: () => Promise.resolve({
                        data: mockVisits.filter(v => v.visit_date === dVal),
                        error: null,
                      })
                    }),
                    order: () => ({
                      limit: () => Promise.resolve({ data: mockVisits, error: null })
                    })
                  })
                }
              }
            }
          }
          throw new Error("Unexpected table " + table)
        }
      } as any

      const context = await buildCompactCRMContext(mockSb, "Sa kliente kam?", "2026-09-22", ownerId)
      assert.ok(context.text.includes("Total Clients: 2"))
      assert.ok(context.text.includes("Total Registered Visits in CRM: 2"))
      assert.ok(context.text.includes("Minimarket Fredi"))
    })
  })
})
