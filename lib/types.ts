export type Client = {
  id: string
  business_name: string
  status: string | null
  business_type: string | null
  zone: string | null
  address: string | null
  lat: number | null
  lng: number | null
  phone: string | null
  contact_person: string | null
  general_notes: string | null
  next_followup: string | null
  decline_reason: string | null
  order_value: number | null
  source: string | null
  maps_url: string | null
  created_at: string
  updated_at: string | null
}

export type Visit = {
  id: string
  visit_date: string
  client_id: string | null
  business_name: string
  location_url: string | null
  statusi: string | null
  shenime: string | null
  created_at: string
  updated_at: string | null
}

export const STATUS_DEFS = [
  { key: 'prospect',          label: 'Prospekt',        color: '#9CA3AF', cls: 's-prospect' },
  { key: 'App downloaded',    label: 'App Shkarkuar',   color: '#22C55E', cls: 's-active'   },
  { key: 'Catalog sent',      label: 'Katalog Dërguar', color: '#3B82F6', cls: 's-lead'     },
  { key: 'Customer/Purchase', label: 'Klient/Blerje',   color: '#10B981', cls: 's-customer' },
  { key: 'No interest',       label: 'Pa Interes',      color: '#F59E0B', cls: 's-declined' },
  { key: 'No contact',        label: 'Pa Kontakt',      color: '#EF4444', cls: 's-inactive' },
] as const

export type StatusDef = typeof STATUS_DEFS[number]

const STATUS_MAP = Object.fromEntries(STATUS_DEFS.map(s => [s.key.toLowerCase(), s]))

export type StatusInfo = { key: string; label: string; color: string; cls: string }

export function statusInfo(s: string | null | undefined): StatusInfo {
  if (!s) return { key: 'unknown', label: '—', color: '#6B7280', cls: 's-unknown' }
  const norm = String(s).toLowerCase().trim()
  return STATUS_MAP[norm] ?? { key: s, label: s, color: '#6B7280', cls: 's-unknown' }
}

export function normalize(s: string | null | undefined): string {
  return (s ?? '').toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ').trim()
}

export const TIRANA_CENTER: [number, number] = [41.3275, 19.8187]
export const TIRANA_ZOOM = 14

export const SQ_MONTHS = ['Janar','Shkurt','Mars','Prill','Maj','Qershor','Korrik','Gusht','Shtator','Tetor','Nëntor','Dhjetor']
export const SQ_DAY_SHORT = ['Hë','Ma','Më','En','Pr','Sh','Di']
export const SQ_DAY_FULL  = ['E Diel','E Hënë','E Martë','E Mërkurë','E Enjte','E Premte','E Shtunë']

export function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}
export const todayISO = () => isoDate(new Date())

export function fmtAlbDate(d: Date | string): string {
  const dt = d instanceof Date ? d : new Date(d)
  return `${SQ_DAY_FULL[dt.getDay()]}, ${dt.getDate()} ${SQ_MONTHS[dt.getMonth()]} ${dt.getFullYear()}`
}
export function fmtDate(d: string | null | undefined): string {
  if (!d) return ''
  const dt = new Date(d)
  return isNaN(dt.getTime()) ? d : dt.toLocaleDateString('sq-AL', { day:'2-digit', month:'short', year:'numeric' })
}
export function fmtDateTime(d: string | null | undefined): string {
  if (!d) return ''
  const dt = new Date(d)
  return isNaN(dt.getTime()) ? d : dt.toLocaleString('sq-AL', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' })
}
export const nowISO = () => new Date().toISOString()
