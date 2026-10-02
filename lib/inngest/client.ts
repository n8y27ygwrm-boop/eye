import { Inngest } from 'inngest'

export type VisitSavedEventPayload = {
  visitId: string
  ownerUserId: string
}

export type EyeEvents = {
  'eye/visit.saved': {
    data: VisitSavedEventPayload
  }
}

export const inngest = new Inngest({
  id: 'eye',
  isDev: process.env.INNGEST_DEV === '1' || process.env.NODE_ENV === 'development',
})
