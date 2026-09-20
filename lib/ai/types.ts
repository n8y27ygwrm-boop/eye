import type { ProviderErrorCategory } from './errors'

export type ActionType = 'call' | 'meeting' | 'deliver' | 'follow_up'
export type ReminderPriority = 'high' | 'medium' | 'low'

export type VisitExtractionInput = {
  visit_id: string
  owner_user_id?: string
  client_id: string | null
  business_name: string
  visit_date: string
  shenime: string
  client_status?: string | null
  business_type?: string | null
  zone?: string | null
}

export type VisitAIExtraction = {
  hasReminder: boolean
  actionType: ActionType | null
  description: string | null
  dueDate: string | null
  dueTime: string | null
  priority: ReminderPriority | null
  rawTrigger: string | null
  summary: string | null
}

export type ChatMessage = {
  role: 'user' | 'assistant'
  content: string
}

export type CRMQuestionInput = {
  message: string
  conversationHistory: ChatMessage[]
  crmContext: string
}

export type CRMAnswerOutput = {
  reply: string
}

export interface AIProvider {
  readonly name: 'groq' | 'openrouter' | 'gemini'
  extractVisitReminder(input: VisitExtractionInput): Promise<VisitAIExtraction>
  answerCRMQuestion(input: CRMQuestionInput): Promise<CRMAnswerOutput>
}

export type ExtractionExecutionResult = {
  ok: boolean
  extraction?: VisitAIExtraction
  providerUsed?: 'groq' | 'openrouter' | 'gemini'
  fallbacksUsed: number
  error?: string
  failureCategory?: ProviderErrorCategory
}

export type ChatExecutionResult = {
  ok: boolean
  reply?: string
  providerUsed?: 'groq' | 'openrouter' | 'gemini'
  fallbacksUsed: number
  error?: string
}
