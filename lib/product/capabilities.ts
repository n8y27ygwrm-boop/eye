import { STATUS_DEFS } from '../types'
import { FRESHNESS_THRESHOLD_MS, POOR_ACCURACY_THRESHOLD_M } from '../location/utils'

export const EYE_ROUTES = {
  CLIENTS: '/list',
  MAP: '/map',
  ROUTE: '/route',
  LOGIN: '/login',
} as const

export const EYE_SURFACES = {
  CLIENTS: 'Clients',
  MAP: 'Map',
  ROUTE: 'Route / Visits',
  FIELD_CONTROL: 'Field Control',
  AI_ASSISTANT: 'AI Assistant',
  IMPORT_INBOX: 'Import Inbox',
  LOCATION: 'Location Foundation',
} as const

export interface CapabilityDef {
  surface: string
  route?: string
  capability: string
  action: string
  constraints: string
  status: 'CURRENT' | 'PLANNED_FUTURE'
}

/**
 * EYE Product Capability Model
 * Authoritative single source-of-truth derived directly from application routes,
 * components, contracts, and lifecycle status definitions.
 */
export const EYE_CAPABILITIES: readonly CapabilityDef[] = [
  {
    surface: EYE_SURFACES.CLIENTS,
    route: EYE_ROUTES.CLIENTS,
    capability: 'Account directory & multi-field search',
    action: 'Filter by dynamic zones (from active records), status (from STATUS_DEFS), follow-up; view client detail slide-over; launch Import Data modal',
    constraints: 'All records bound strictly to authenticated user session (owner_user_id)',
    status: 'CURRENT',
  },
  {
    surface: EYE_SURFACES.MAP,
    route: EYE_ROUTES.MAP,
    capability: 'Interactive spatial canvas (Leaflet)',
    action: 'Plot client locations; view agent GPS marker; click client marker for quick visit action; center on user via Locate Me button',
    constraints: 'Only clients with verified lat/lng coordinates appear on map',
    status: 'CURRENT',
  },
  {
    surface: EYE_SURFACES.ROUTE,
    route: EYE_ROUTES.ROUTE,
    capability: 'Daily chronological visit journal',
    action: 'Browse daily visits by date; open VisitModal to log new visit or edit existing; attach GPS snapshot',
    constraints: 'Visits organized per-day; rep manually logs each visit',
    status: 'CURRENT',
  },
  {
    surface: EYE_SURFACES.FIELD_CONTROL,
    route: 'dock / sheet',
    capability: 'Persistent surface switcher & command center',
    action: 'Navigate between Clients, Map, Route, and Next Actions with zero context loss',
    constraints: 'Desktop persistent dock, mobile 3-state bottom sheet (peek, half, full)',
    status: 'CURRENT',
  },
  {
    surface: EYE_SURFACES.AI_ASSISTANT,
    route: 'ambient FAB / panel',
    capability: 'Field operational reasoning & CRM query',
    action: 'Answer CRM questions, recall visits, reason on workflows; automatic visit reminder extraction via Inngest durable pipeline',
    constraints: 'Read-only access to user CRM context; grounding strictly authoritative for database facts; no direct DB writes',
    status: 'CURRENT',
  },
  {
    surface: EYE_SURFACES.IMPORT_INBOX,
    route: `${EYE_ROUTES.CLIENTS} (Import Data button)`,
    capability: 'Multi-format file & sheet ingestion',
    action: 'Parse Google Sheets (view-only public URL), CSV, and XLSX; preview in-memory; detect duplicates; toggle skip vs import_new; commit verified rows',
    constraints: 'Pure two-step in-memory preview before commit; missing names block row until user edits; missing location stays null (never invented); source facts preserved 100%; AI metadata separated',
    status: 'CURRENT',
  },
  {
    surface: EYE_SURFACES.LOCATION,
    route: 'app-wide (foreground)',
    capability: 'Device GPS positioning',
    action: 'Display live agent marker on map; attach GPS snapshot to visit when enabled',
    constraints: `Foreground only while EYE is open; NO 24/7 background tracking; NO continuous DB logging; visit snapshot attached only if age <= ${FRESHNESS_THRESHOLD_MS / 1000}s and accuracy <= ${POOR_ACCURACY_THRESHOLD_M}m (or explicit user confirmation)`,
    status: 'CURRENT',
  },
  {
    surface: 'Multi-Stop Route Optimization',
    route: 'none',
    capability: 'Automated Traveling Salesperson route algorithm',
    action: 'Automated turn-by-turn multi-stop route sequencing',
    constraints: 'NOT CURRENTLY SUPPORTED. Reps plan routes manually using zone filters and map markers.',
    status: 'PLANNED_FUTURE',
  },
  {
    surface: 'Multi-Agent Team Dispatch',
    route: 'none',
    capability: 'Manager oversight & team territory assignment',
    action: 'Dispatching jobs across multiple sales reps from a manager dashboard',
    constraints: 'NOT CURRENTLY SUPPORTED. EYE accounts and visits are strictly single-tenant isolated per user.',
    status: 'PLANNED_FUTURE',
  },
  {
    surface: 'Offline PWA Background Sync',
    route: 'none',
    capability: 'Service worker database cache & offline queue',
    action: 'Operating full CRM offline with automatic background sync upon reconnection',
    constraints: 'NOT CURRENTLY SUPPORTED. EYE requires an active network connection.',
    status: 'PLANNED_FUTURE',
  },
  {
    surface: 'Integrated VoIP Call Recording',
    route: 'none',
    capability: 'In-app telephony & call recording',
    action: 'Dialing clients directly through browser with audio recording',
    constraints: 'NOT CURRENTLY SUPPORTED. Phone calls trigger the native device tel: protocol.',
    status: 'PLANNED_FUTURE',
  },
  {
    surface: 'Bidirectional Live Google Sheets Sync',
    route: 'none',
    capability: 'Two-way real-time spreadsheet synchronization',
    action: 'Live 2-way sync reflecting edits in Google Sheets back and forth',
    constraints: 'NOT CURRENTLY SUPPORTED. Import Inbox is snapshot ingestion only.',
    status: 'PLANNED_FUTURE',
  },
]

/**
 * Builds compact structured EYE capability context derived from real code constants.
 */
export function buildStructuredProductContext(): string {
  const currentCapabilities = EYE_CAPABILITIES.filter(c => c.status === 'CURRENT')
    .map(c => `[SURFACE: ${c.surface}]${c.route ? ` (Route: ${c.route})` : ''}
  Capability: ${c.capability}
  Action: ${c.action}
  Constraints: ${c.constraints}`)
    .join('\n\n')

  const futureCapabilities = EYE_CAPABILITIES.filter(c => c.status === 'PLANNED_FUTURE')
    .map(c => `- ${c.capability} (${c.surface}): ${c.constraints}`)
    .join('\n')

  const statusTaxonomy = STATUS_DEFS.map(s => `${s.key} (${s.label})`).join(', ')

  return `=== EYE STRUCTURED PRODUCT CAPABILITIES (DERIVED FROM APPLICATION SOURCE) ===
IDENTITY: EYE by SAVVY SYSTEMS — field operations and field sales workspace centered on clients, places, visits, follow-ups, and next actions.

CURRENT SURFACES & CAPABILITIES:
${currentCapabilities}

CLIENT DATA MODEL (Source of Truth: lib/types.ts):
- Attributes: business_name (required), phone, address, zone, business_type, maps_url, lat, lng, general_notes, status, next_action, next_followup, owner_user_id
- Status Taxonomy (from STATUS_DEFS): ${statusTaxonomy}
- Follow-up Filter States: all (Të gjitha ndjekjet), overdue (Me vonesë), today (Sot), upcoming (Në vijim)
- Zones: Dynamically derived from the user's active client records (no hardcoded list)

IMPORT INBOX CONTRACTS:
- Supported Formats: Google Sheets (view-only public URL), CSV, XLSX
- Pipeline: Pure in-memory preview -> explicit user commit. Zero DB writes during preview.
- Data Integrity: Source facts preserved 100%; AI metadata distinctly separated.
- Missing Data Rules: Missing names NEVER invented (row flagged 'Needs Review' until user edits). Missing locations stay null (coordinates NEVER hallucinated).
- Duplicates: Detected against user's existing records (by exact name, phone, maps URL, or coordinates). User toggles 'skip' or 'import_new'.

LOCATION CONTRACTS:
- Boundaries: Foreground only while tab is active. NO 24/7 background tracking. NO continuous DB coordinate logging.
- Freshness: <= ${FRESHNESS_THRESHOLD_MS / 1000}s. Accuracy warning: > ${POOR_ACCURACY_THRESHOLD_M}m. GPS snapshot attached to visit only on explicit save.

NOT CURRENTLY SUPPORTED (PLANNED / FUTURE CONCEPTS ONLY):
${futureCapabilities}

CRITICAL REASONING & CAPABILITY BOUNDARY RULES:
1. Reason dynamically using the capability model, live CRM context, and conversation history. Do NOT use canned FAQ answers.
2. When asked about product design (e.g. why Import is in Clients), reason from the architecture: Import creates client records, which then feed Map, Visits, Field Control, and CRM context.
3. NEVER claim a planned or future feature currently exists in EYE. If a user asks about a non-supported capability, explain current alternatives (e.g. manual zone routing instead of automated TSP route optimization) and clearly label any future enhancements as product suggestions.
4. Live CRM facts provided below are strictly authoritative for user data facts.`
}
