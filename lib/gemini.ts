export type VisitWithClient = {
  id: string
  visit_date: string
  business_name: string
  shenime: string | null
  client_id: string | null
  clients: {
    id: string
    business_name: string
    business_type: string
    zone: string
    status: string
  } | null
}

export type AIReminder = {
  client_id: string | null
  visit_id: string
  business_name: string
  action_type: 'call' | 'meeting' | 'deliver' | 'follow_up'
  description: string
  due_date: string | null
  priority: 'high' | 'medium' | 'low'
  raw_trigger: string
}

const GEMINI_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent'

export async function analyzeVisitNotes(
  visits: VisitWithClient[]
): Promise<AIReminder[]> {
  const active = visits.filter(v => v.shenime && v.shenime.trim().length > 0)
  if (active.length === 0) return []

  const visitsBlock = active
    .map(v => {
      const c = v.clients
      return [
        `Visit ID: ${v.id}`,
        `Date: ${v.visit_date}`,
        `Business: ${v.business_name}`,
        c ? `Type: ${c.business_type}` : '',
        c ? `Zone: ${c.zone}` : '',
        c ? `Pipeline status: ${c.status}` : '',
        `Notes: ${v.shenime}`,
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n---\n\n')

  const prompt = `You are an intelligent assistant for a field sales rep in Tirana, Albania. You read visit notes written in Albanian and extract actionable commitments and follow-up items.

The rep works for Magazina Virtuale, a B2B product distribution platform. Their job is to onboard bars, cafes, restaurants, markets, hotels and other HoReCa businesses onto the platform and convert them into paying customers.

Pipeline statuses (ordered by conversion stage):
- prospect: not yet contacted
- No contact: visited but couldn't reach decision maker
- App downloaded: business owner installed the app
- Catalog sent: product catalog was shared
- Customer/Purchase: active paying customer
- No interest: explicitly rejected

Today's visit notes:

${visitsBlock}

---

Instructions:
1. Read each visit's notes carefully. The notes are in Albanian.
2. Extract every actionable commitment, promise, or follow-up item the rep mentioned — things like:
   - Promises made to clients ("do t'i sjell", "do ta kontaktoj", "nesër kaloj")
   - Scheduled follow-ups ("takim të hënën", "e kontaktoj pas 2 ditësh")
   - Items to deliver physically ("i sjell katalogun", "i sjell kampionin")
   - Calls to make ("i bëj telefon", "e lajmëroj")
   - Meetings agreed upon ("dakordësuam takim")
3. For priority, consider:
   - HIGH: Customer/Purchase status, urgent language, specific near-term dates mentioned, explicit promises
   - MEDIUM: App downloaded or Catalog sent status, general follow-ups
   - LOW: prospect or No contact status, vague intentions
4. For due_date: extract any specific date or relative time ("nesër" = tomorrow from visit_date, "të hënën" = next Monday, "pas 2 ditësh" = 2 days after visit_date). Return ISO format YYYY-MM-DD. If no date mentioned, return null.
5. For action_type:
   - "call": phone calls to make
   - "meeting": in-person visits or meetings
   - "deliver": physically bringing something (catalog, sample, device)
   - "follow_up": general check-in or next contact without a specific action

Return ONLY a valid raw JSON array of objects. No markdown. No backticks. No explanation. No text before or after. If there are no action items, return an empty array: []

Each object must have exactly these fields:
{
  "client_id": string or null,
  "visit_id": string,
  "business_name": string,
  "action_type": "call" | "meeting" | "deliver" | "follow_up",
  "description": string (in Albanian, clear and actionable, max 120 chars),
  "due_date": string (YYYY-MM-DD) or null,
  "priority": "high" | "medium" | "low",
  "raw_trigger": string (exact sentence from the notes that triggered this)
}`

  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    console.error('[gemini] GEMINI_API_KEY is not set')
    return []
  }

  let raw: string | undefined
  try {
    const res = await fetch(`${GEMINI_URL}?key=${apiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: 'application/json',
        },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error(`[gemini] API error ${res.status}:`, err)
      return []
    }

    const json = await res.json()
    raw = json?.candidates?.[0]?.content?.parts?.[0]?.text

    if (!raw) {
      console.error('[gemini] Empty response from API:', JSON.stringify(json))
      return []
    }

    const reminders: AIReminder[] = JSON.parse(raw)

    // Attach visit_id and client_id from source data where missing
    return reminders.map(r => {
      const source = active.find(v => v.id === r.visit_id)
      return {
        ...r,
        visit_id: r.visit_id ?? source?.id ?? '',
        client_id: r.client_id ?? source?.client_id ?? null,
      }
    })
  } catch (e) {
    console.error('[gemini] Failed to parse response:', e)
    if (raw) console.error('[gemini] Raw text was:', raw.slice(0, 500))
    return []
  }
}
