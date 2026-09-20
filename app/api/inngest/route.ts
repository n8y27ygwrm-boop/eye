import { serve } from 'inngest/next'
import { inngest } from '@/lib/inngest/client'
import { processVisitReminder } from '@/lib/inngest/functions/process-visit-reminder'

export const { GET, POST, PUT } = serve({
  client: inngest,
  functions: [
    processVisitReminder,
  ],
})
