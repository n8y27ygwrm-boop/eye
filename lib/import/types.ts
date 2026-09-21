export type ImportSourceType = "google_sheet" | "csv" | "xlsx"

export interface SourceFacts {
  business_name: string | null
  maps_url: string | null
  general_notes: string | null
  phone: string | null
  address: string | null
  zone: string | null
  business_type: string | null
}

export interface NormalizedRow {
  source_row_index: number
  business_name: string | null
  raw_business_name: string | null
  maps_url: string | null
  lat: number | null
  lng: number | null
  general_notes: string | null
  phone: string | null
  address: string | null
  zone: string | null
  business_type: string | null
}

export interface AIDerivedData {
  category: string | null
  zone: string | null
  followUpNeeded: boolean | null
  tags: string[]
  confidence: number
  reasoningCode: string | null
}

export type DuplicateMatchType = "exact_name" | "exact_phone" | "exact_url" | "same_coords"

export interface DuplicateMatch {
  isDuplicate: boolean
  matchType: DuplicateMatchType | null
  matchedClientName?: string
  matchedClientId?: string
  source: "current_batch" | "existing_client" | null
}

export type RowStatus =
  | "READY"
  | "READY_WITHOUT_ENRICHMENT"
  | "POSSIBLE_DUPLICATE"
  | "NEEDS_REVIEW"
  | "INVALID"
  | "EXCLUDED"

export interface ImportPreviewRow {
  id: string
  source_row_index: number
  sourceFacts: SourceFacts
  normalized: NormalizedRow
  aiDerived: AIDerivedData | null
  duplicate: DuplicateMatch
  missingName: boolean
  status: RowStatus
  include: boolean
  duplicateResolution: "skip" | "import_new"
  editedBusinessName?: string
}

export interface ImportPreviewSummary {
  totalRows: number
  readyCount: number
  readyWithoutEnrichmentCount: number
  duplicateCount: number
  needsReviewCount: number
  invalidCount: number
  excludedCount: number
}

export interface ClientImportCommitItem {
  business_name: string
  maps_url?: string | null
  lat?: number | null
  lng?: number | null
  general_notes?: string | null
  phone?: string | null
  address?: string | null
  zone?: string | null
  business_type?: string | null
  status?: string | null
  duplicateResolution?: "skip" | "import_new"
}

export interface ImportCommitPayload {
  rows: ClientImportCommitItem[]
}

export interface ImportCommitResult {
  imported: number
  skipped: number
  failed: number
  errors: string[]
}
