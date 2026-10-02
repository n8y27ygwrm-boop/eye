import type { NormalizedRow, DuplicateMatch, AIDerivedData, RowStatus, ClientImportCommitItem, ImportPreviewRow } from "./types"
import { STATUS_DEFS, type Client } from "../types"

const ALLOWED_STATUS_MAP = new Map(STATUS_DEFS.flatMap(s => [
  [s.key.toLowerCase(), s.key],
  [s.label.toLowerCase(), s.key],
]))

export function sanitizeStatus(rawStatus: unknown): string | null {
  if (rawStatus == null || rawStatus === "") {
    return "prospect"
  }
  if (typeof rawStatus !== "string") return null
  if (!rawStatus.trim()) return "prospect"
  return ALLOWED_STATUS_MAP.get(rawStatus.trim().toLowerCase()) || null
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

  if (normalized.warnings?.length) {
    return { status: "INVALID", missingName: false }
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
  contact_person: string | null
  order_value: string | null
  decline_reason: string | null
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

  // 2. Coordinates are an exact pair. Reject invalid or incomplete values.
  const lat = item.lat ?? null
  const lng = item.lng ?? null
  if ((lat === null) !== (lng === null) ||
    (lat !== null && (typeof lat !== "number" || !Number.isFinite(lat) || lat < -90 || lat > 90)) ||
    (lng !== null && (typeof lng !== "number" || !Number.isFinite(lng) || lng < -180 || lng > 180))) {
    return { valid: false, error: "Koordinatat duhet të jenë çift i vlefshëm (latitude -90..90, longitude -180..180)." }
  }

  // 3. Preserve mapped fields. Never silently truncate source values.
  const cleanStr = (val: unknown, maxLen: number, label: string): string | null => {
    if (val == null) return null
    if (typeof val !== "string") throw new Error(`${label} duhet të jetë tekst.`)
    const trimmed = val.trim()
    if (trimmed.length > maxLen) throw new Error(`${label} tejkalon ${maxLen} karaktere.`)
    return trimmed.length > 0 ? trimmed : null
  }

  let maps_url: string | null, general_notes: string | null, phone: string | null
  let address: string | null, zone: string | null, business_type: string | null
  let contact_person: string | null, decline_reason: string | null, order_value: string | null
  try {
    maps_url = cleanStr(item.maps_url, 1000, "Maps URL")
    general_notes = cleanStr(item.general_notes, 4000, "Shënimet")
    phone = cleanStr(item.phone, 100, "Telefoni")
    address = cleanStr(item.address, 500, "Adresa")
    zone = cleanStr(item.zone, 50, "Zona")
    business_type = cleanStr(item.business_type, 100, "Kategoria")
    contact_person = cleanStr(item.contact_person, 255, "Personi i kontaktit")
    decline_reason = cleanStr(item.decline_reason, 4000, "Arsyeja e refuzimit")
    order_value = cleanStr(item.order_value, 100, "Vlera e porosisë")
  } catch (error) {
    return { valid: false, error: (error as Error).message }
  }
  if (order_value !== null && !/^[+-]?\d+(?:\.\d+)?$/.test(order_value)) {
    return { valid: false, error: "Vlera e porosisë duhet të jetë numër dhjetor i vlefshëm." }
  }
  const status = sanitizeStatus(item.status)
  if (status === null) {
    return { valid: false, error: `Status i panjohur: ${String(item.status)}.` }
  }

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
      contact_person,
      order_value,
      decline_reason,
      status,
      source: "import_inbox",
      duplicateResolution,
    },
  }
}

/** The exact item shown in preview is the item sent to commit. */
export function buildCommitItem(row: ImportPreviewRow): ClientImportCommitItem {
  return {
    business_name: (row.editedBusinessName ?? row.normalized.business_name ?? "").trim(),
    maps_url: row.sourceFacts.maps_url,
    lat: row.normalized.lat,
    lng: row.normalized.lng,
    general_notes: row.sourceFacts.general_notes,
    phone: row.sourceFacts.phone,
    address: row.sourceFacts.address,
    ...resolveCommittedFields(row.sourceFacts, row.aiDerived),
    contact_person: row.sourceFacts.contact_person ?? null,
    order_value: row.sourceFacts.order_value ?? null,
    decline_reason: row.sourceFacts.decline_reason ?? null,
    status: row.normalized.status ?? row.sourceFacts.status ?? "prospect",
    duplicateResolution: row.duplicateResolution,
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
