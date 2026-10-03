
import type { ChatMessage } from './types'

export const MAX_CURRENT_MESSAGE_CHARS = 2000
export const MAX_HISTORY_MESSAGES = 15
export const MAX_HISTORY_INBOUND_MESSAGES = 100
export const MAX_HISTORY_INBOUND_CHARS = 20000
export const MAX_HISTORY_CONTENT_CHARS = 4000

export function boundConversationHistory(messages: ChatMessage[]): ChatMessage[] {
  return messages
    .slice(-MAX_HISTORY_MESSAGES)
    .map(message => ({
      role: message.role,
      content: message.content.slice(0, MAX_HISTORY_CONTENT_CHARS),
    }))
    .filter(message => message.content.length > 0)
}
