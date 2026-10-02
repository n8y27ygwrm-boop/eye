import type { NormalizedRow, DuplicateMatch } from "./types"
import type { Client } from "../types"
import { normalize } from "../types"

function normalizeDigits(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/[^0-9]/g, "")
  return digits.length >= 6 ? digits : null
}

function normalizeUrlForMatch(url: string | null | undefined): string | null {
  if (!url) return null
  try {
    const p = new URL(url)
    return (p.origin + p.pathname + p.search).toLowerCase()
  } catch {
    return url.trim().toLowerCase()
  }
}

function areCoordsClose(
  lat1: number | null,
  lng1: number | null,
  lat2: number | null,
  lng2: number | null
): boolean {
  if (lat1 == null || lng1 == null || lat2 == null || lng2 == null) return false
  // ~15 meters tolerance (~0.00015 deg lat/lng)
  return Math.abs(lat1 - lat2) < 0.00015 && Math.abs(lng1 - lng2) < 0.00015
}

/**
 * Detects duplicates for all normalized rows in an import.
 * Checks both:
 * 1. Against other rows earlier in the same import batch.
 * 2. Against existing clients belonging strictly to the authenticated user.
 */
export function detectDuplicates(
  rows: NormalizedRow[],
  existingUserClients: Client[]
): DuplicateMatch[] {
  const results: DuplicateMatch[] = []

  // Pre-index existing user clients for fast matching
  const existingByName = new Map<string, Client>()
  const existingByPhone = new Map<string, Client>()
  const existingByUrl = new Map<string, Client>()

  for (const c of existingUserClients) {
    const normName = normalize(c.business_name)
    if (normName && !existingByName.has(normName)) {
      existingByName.set(normName, c)
    }

    const digits = normalizeDigits(c.phone)
    if (digits && !existingByPhone.has(digits)) {
      existingByPhone.set(digits, c)
    }

    const normUrl = normalizeUrlForMatch(c.maps_url)
    if (normUrl && !existingByUrl.has(normUrl)) {
      existingByUrl.set(normUrl, c)
    }
  }

  // Batch index for detecting duplicates within the file itself
  const batchByName = new Map<string, { index: number; name: string }>()
  const batchByPhone = new Map<string, { index: number; name: string }>()
  const batchByUrl = new Map<string, { index: number; name: string }>()
  const batchWithCoords: { index: number; name: string; lat: number; lng: number }[] = []

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]
    const normName = normalize(row.business_name)
    const digits = normalizeDigits(row.phone)
    const normUrl = normalizeUrlForMatch(row.maps_url)

    let match: DuplicateMatch = {
      isDuplicate: false,
      matchType: null,
      source: null,
    }

    // 1. Check against current import batch (earlier rows)
    if (normName && batchByName.has(normName)) {
      const prior = batchByName.get(normName)!
      match = {
        isDuplicate: true,
        matchType: "exact_name",
        matchedClientName: prior.name,
        source: "current_batch",
      }
    } else if (digits && batchByPhone.has(digits)) {
      const prior = batchByPhone.get(digits)!
      match = {
        isDuplicate: true,
        matchType: "exact_phone",
        matchedClientName: prior.name,
        source: "current_batch",
      }
    } else if (normUrl && batchByUrl.has(normUrl)) {
      const prior = batchByUrl.get(normUrl)!
      match = {
        isDuplicate: true,
        matchType: "exact_url",
        matchedClientName: prior.name,
        source: "current_batch",
      }
    } else if (row.lat != null && row.lng != null) {
      const priorCoord = batchWithCoords.find(b => areCoordsClose(row.lat, row.lng, b.lat, b.lng))
      if (priorCoord) {
        match = {
          isDuplicate: true,
          matchType: "same_coords",
          matchedClientName: priorCoord.name,
          source: "current_batch",
        }
      }
    }

    // 2. Check against existing clients of current user (if not already matched in batch)
    if (!match.isDuplicate) {
      if (normName && existingByName.has(normName)) {
        const client = existingByName.get(normName)!
        match = {
          isDuplicate: true,
          matchType: "exact_name",
          matchedClientName: client.business_name,
          matchedClientId: client.id,
          source: "existing_client",
        }
      } else if (digits && existingByPhone.has(digits)) {
        const client = existingByPhone.get(digits)!
        match = {
          isDuplicate: true,
          matchType: "exact_phone",
          matchedClientName: client.business_name,
          matchedClientId: client.id,
          source: "existing_client",
        }
      } else if (normUrl && existingByUrl.has(normUrl)) {
        const client = existingByUrl.get(normUrl)!
        match = {
          isDuplicate: true,
          matchType: "exact_url",
          matchedClientName: client.business_name,
          matchedClientId: client.id,
          source: "existing_client",
        }
      } else if (row.lat != null && row.lng != null) {
        const clientCoord = existingUserClients.find(c => areCoordsClose(row.lat, row.lng, c.lat, c.lng))
        if (clientCoord) {
          match = {
            isDuplicate: true,
            matchType: "same_coords",
            matchedClientName: clientCoord.business_name,
            matchedClientId: clientCoord.id,
            source: "existing_client",
          }
        }
      }
    }

    results.push(match)

    // Add current row to batch indices for future rows in batch
    const displayName = row.business_name || `Rreshti ${i + 1}`
    if (normName && !batchByName.has(normName)) {
      batchByName.set(normName, { index: i, name: displayName })
    }
    if (digits && !batchByPhone.has(digits)) {
      batchByPhone.set(digits, { index: i, name: displayName })
    }
    if (normUrl && !batchByUrl.has(normUrl)) {
      batchByUrl.set(normUrl, { index: i, name: displayName })
    }
    if (row.lat != null && row.lng != null) {
      batchWithCoords.push({ index: i, name: displayName, lat: row.lat, lng: row.lng })
    }
  }

  return results
}
