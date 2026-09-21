import type { SourceFacts, NormalizedRow } from "./types"
import type { CanonicalFieldKey } from "./headers"

/**
 * Trims and collapses multiple spaces. Returns null if blank or empty.
 * Never mutates meaningful punctuation.
 */
export function cleanString(val: unknown): string | null {
  if (val == null) return null
  const s = String(val).trim().replace(/\s+/g, " ")
  return s.length > 0 ? s : null
}

/**
 * Extracts coordinates deterministically from a Google Maps URL if present.
 * Never guesses coordinates. If coordinates are not found, returns lat: null, lng: null.
 */
export function extractCoordsFromUrl(url: string | null): { lat: number | null; lng: number | null } {
  if (!url || typeof url !== "string") {
    return { lat: null, lng: null }
  }

  // 1. Check for @lat,lng (e.g., https://www.google.com/maps/place/.../@41.327546,19.818721,17z)
  const atMatch = url.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/)
  if (atMatch) {
    const lat = parseFloat(atMatch[1])
    const lng = parseFloat(atMatch[2])
    if (isValidCoord(lat, lng)) {
      return { lat, lng }
    }
  }

  // 2. Check for ?q=lat,lng or &q=lat,lng (e.g. https://maps.google.com/?q=41.3275,19.8187)
  const qMatch = url.match(/[?&]q=(-?\d+\.\d+),(-?\d+\.\d+)/i)
  if (qMatch) {
    const lat = parseFloat(qMatch[1])
    const lng = parseFloat(qMatch[2])
    if (isValidCoord(lat, lng)) {
      return { lat, lng }
    }
  }

  // 3. Check for query=lat,lng
  const queryMatch = url.match(/[?&]query=(-?\d+\.\d+),(-?\d+\.\d+)/i)
  if (queryMatch) {
    const lat = parseFloat(queryMatch[1])
    const lng = parseFloat(queryMatch[2])
    if (isValidCoord(lat, lng)) {
      return { lat, lng }
    }
  }

  // 4. Check for destination=lat,lng
  const destMatch = url.match(/[?&]destination=(-?\d+\.\d+),(-?\d+\.\d+)/i)
  if (destMatch) {
    const lat = parseFloat(destMatch[1])
    const lng = parseFloat(destMatch[2])
    if (isValidCoord(lat, lng)) {
      return { lat, lng }
    }
  }

  // 5. Check for ll=lat,lng
  const llMatch = url.match(/[?&]ll=(-?\d+\.\d+),(-?\d+\.\d+)/i)
  if (llMatch) {
    const lat = parseFloat(llMatch[1])
    const lng = parseFloat(llMatch[2])
    if (isValidCoord(lat, lng)) {
      return { lat, lng }
    }
  }

  return { lat: null, lng: null }
}

function isValidCoord(lat: number, lng: number): boolean {
  return !isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
}

/**
 * Normalizes a raw input record into canonical SourceFacts and NormalizedRow.
 * Source facts strictly preserve original string representations.
 */
export function normalizeRawRecord(
  rawRecord: Record<string, unknown>,
  headerMap: Record<string, CanonicalFieldKey>,
  rowIndex: number
): { sourceFacts: SourceFacts; normalized: NormalizedRow } {
  const extracted: Partial<Record<CanonicalFieldKey, unknown>> = {}

  for (const [colName, val] of Object.entries(rawRecord)) {
    const canonicalKey = headerMap[colName]
    if (canonicalKey && extracted[canonicalKey] === undefined) {
      extracted[canonicalKey] = val
    }
  }

  const rawName = extracted.business_name != null ? String(extracted.business_name) : null
  const cleanedName = cleanString(rawName)

  const rawMapsUrl = cleanString(extracted.maps_url)
  const rawNotes = cleanString(extracted.general_notes)
  const rawPhone = cleanString(extracted.phone)
  const rawAddress = cleanString(extracted.address)
  const rawZone = cleanString(extracted.zone)
  const rawBusinessType = cleanString(extracted.business_type)

  const coords = extractCoordsFromUrl(rawMapsUrl)

  const sourceFacts: SourceFacts = {
    business_name: cleanedName,
    maps_url: rawMapsUrl,
    general_notes: rawNotes,
    phone: rawPhone,
    address: rawAddress,
    zone: rawZone,
    business_type: rawBusinessType,
  }

  const normalized: NormalizedRow = {
    source_row_index: rowIndex,
    business_name: cleanedName,
    raw_business_name: rawName,
    maps_url: rawMapsUrl,
    lat: coords.lat,
    lng: coords.lng,
    general_notes: rawNotes,
    phone: rawPhone,
    address: rawAddress,
    zone: rawZone,
    business_type: rawBusinessType,
  }

  return { sourceFacts, normalized }
}
