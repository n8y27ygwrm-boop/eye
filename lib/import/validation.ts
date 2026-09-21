import type { NormalizedRow, DuplicateMatch, AIDerivedData, RowStatus, ClientImportCommitItem } from "./types"
import { STATUS_DEFS, type Client } from "../types"

const ALLOWED_STATUS_MAP = new Map(STATUS_DEFS.map(s => [s.key.toLowerCase(), s.key]))

export function sanitizeStatus(rawStatus: unknown): string {
  if (typeof rawStatus !== "string" || !rawStatus.trim()) {
    return "prospect"
  }
  const matched = ALLOWED_STATUS_MAP.get(rawStatus.trim().toLowerCase())
  return matched || "prospect"
}

/**
 * Determines the initial preview state for a normalized row.
 */
export function determineRowStatus(
  normalized: NormalizedRow,
  duplicate: DuplicateMatch,
  aiDerived: AIDerivedData | null
): { status: RowStatus; missingName: boolean } {
  const missingName = !normalized.business_name || normalized.business_name.trim().length === 0

  if (missingName) {
    return { status: "NEEDS_REVIEW", missingName: true }
  }

  if (duplicate.isDuplicate) {
    return { status: "POSSIBLE_DUPLICATE", missingName: false }
  }

  if (!aiDerived) {
    return { status: "READY_WITHOUT_ENRICHMENT", missingName: false }
  }

  return { status: "READY", missingName: false }
}

export interface ValidatedCommitRow {
  business_name: string
  owner_user_id: string
  maps_url: string | null
  lat: number | null
  lng: number | null
  general_notes: string | null
  phone: string | null
  address: string | null
  zone: string | null
  business_type: string | null
  status: string
  source: string
  duplicateResolution?: "skip" | "import_new"
}

/**
 * Server-side commit validator.
 * Re-validates row, restricts status to project allowed set,
 * and strictly assigns owner_user_id from the authenticated session.
 */
export function validateCommitRow(
  rawItem: unknown,
  authenticatedOwnerUserId: string
): { valid: true; row: ValidatedCommitRow } | { valid: false; error: string } {
  if (!rawItem || typeof rawItem !== "object") {
    return { valid: false, error: "Invalid row format (must be object)." }
  }

  const item = rawItem as Partial<ClientImportCommitItem>

  // 1. Business Name is mandatory
  const rawName = typeof item.business_name === "string" ? item.business_name.trim() : ""
  if (!rawName) {
    return { valid: false, error: "Emri i biznesit mungon (është i detyrueshëm)." }
  }
  if (rawName.length > 255) {
    return { valid: false, error: "Emri i biznesit tejkalon limitin prej 255 karaktereve." }
  }

  // 2. Validate coordinates if provided
  let lat: number | null = null
  let lng: number | null = null
  if (typeof item.lat === "number" && !isNaN(item.lat) && typeof item.lng === "number" && !isNaN(item.lng)) {
    if (item.lat >= -90 && item.lat <= 90 && item.lng >= -180 && item.lng <= 180) {
      lat = item.lat
      lng = item.lng
    }
  }

  // 3. String bounds & sanitization
  const cleanStr = (val: unknown, maxLen: number): string | null => {
    if (typeof val !== "string") return null
    const trimmed = val.trim()
    return trimmed.length > 0 ? trimmed.slice(0, maxLen) : null
  }

  const maps_url = cleanStr(item.maps_url, 1000)
  const general_notes = cleanStr(item.general_notes, 4000)
  const phone = cleanStr(item.phone, 100)
  const address = cleanStr(item.address, 500)
  const zone = cleanStr(item.zone, 50)
  const business_type = cleanStr(item.business_type, 100)
  const status = sanitizeStatus(item.status)

  const duplicateResolution =
    item.duplicateResolution === "import_new" || item.duplicateResolution === "skip"
      ? item.duplicateResolution
      : undefined

  return {
    valid: true,
    row: {
      business_name: rawName,
      owner_user_id: authenticatedOwnerUserId,
      maps_url,
      lat,
      lng,
      general_notes,
      phone,
      address,
      zone,
      business_type,
      status,
      source: "import_inbox",
      duplicateResolution,
    },
  }
}

/**
 * Resolves final commit fields between Source Facts and AI Derived metadata.
 * STRICT POLICY: Source facts ALWAYS win over AI.
 * AI may fill the field ONLY when source field is null/blank.
 */
export function resolveCommittedFields(
  sourceFacts: { zone?: string | null; business_type?: string | null },
  aiDerived?: { zone?: string | null; category?: string | null } | null
): { zone: string | null; business_type: string | null } {
  const sourceZone = (typeof sourceFacts.zone === "string" && sourceFacts.zone.trim().length > 0)
    ? sourceFacts.zone.trim()
    : null

  const sourceBusinessType = (typeof sourceFacts.business_type === "string" && sourceFacts.business_type.trim().length > 0)
    ? sourceFacts.business_type.trim()
    : null

  return {
    zone: sourceZone ?? (aiDerived?.zone ? aiDerived.zone.trim() : null),
    business_type: sourceBusinessType ?? (aiDerived?.category ? aiDerived.category.trim() : null),
  }
}
