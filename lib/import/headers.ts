/**
 * Header alias normalization for EYE Import Inbox.
 * Maps variable spreadsheet headers (English & Albanian) to canonical field keys.
 */

export type CanonicalFieldKey =
  | "business_name"
  | "maps_url"
  | "general_notes"
  | "phone"
  | "address"
  | "zone"
  | "business_type"

function simplifyHeader(h: string): string {
  return h
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // strip diacritics (ë -> e, etc)
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

const HEADER_ALIASES: Record<CanonicalFieldKey, string[]> = {
  business_name: [
    "name",
    "business",
    "business name",
    "businessname",
    "client",
    "client name",
    "clientname",
    "company",
    "company name",
    "emri",
    "emri biznesit",
    "emri i biznesit",
    "emribiznesit",
    "biznesi",
    "emri klientit",
    "kompania",
    "subjekti",
  ],
  maps_url: [
    "location",
    "location url",
    "location link",
    "maps",
    "google maps",
    "google maps link",
    "google maps search link",
    "map link",
    "maps url",
    "link",
    "linku",
    "vendndodhja",
    "vendndodhje",
    "url",
    "harta",
    "linku i hartes",
  ],
  general_notes: [
    "note",
    "notes",
    "comment",
    "comments",
    "shenime",
    "shenime te pergjithshme",
    "shenim",
    "pershkrim",
    "pershkrimi",
    "info",
    "informacion",
    "detaje",
  ],
  phone: [
    "phone",
    "phone number",
    "phonenumber",
    "telephone",
    "telefoni",
    "tel",
    "nr tel",
    "numri",
    "numri telefonit",
    "mobile",
    "celular",
  ],
  address: [
    "address",
    "adresa",
    "adresa pershkrim",
    "rruga",
    "vendbanimi",
  ],
  zone: [
    "zone",
    "zona",
    "lagja",
  ],
  business_type: [
    "category",
    "kategoria",
    "lloji",
    "tipi",
    "business type",
    "tipi i biznesit",
    "lloji i biznesit",
  ],
}

/**
 * Returns canonical field key if the header matches any known alias, or null.
 */
export function identifyHeaderField(header: string): CanonicalFieldKey | null {
  if (!header || typeof header !== "string") return null
  const cleaned = simplifyHeader(header)
  if (!cleaned) return null

  for (const [canonicalKey, aliases] of Object.entries(HEADER_ALIASES)) {
    for (const alias of aliases) {
      if (cleaned === alias) {
        return canonicalKey as CanonicalFieldKey
      }
    }
  }

  return null
}

/**
 * Creates a map from raw column headers to canonical field keys.
 */
export function buildHeaderMapping(rawHeaders: string[]): Record<string, CanonicalFieldKey> {
  const mapping: Record<string, CanonicalFieldKey> = {}
  const claimedFields = new Set<CanonicalFieldKey>()

  for (const rawHeader of rawHeaders) {
    const field = identifyHeaderField(rawHeader)
    if (field && !claimedFields.has(field)) {
      mapping[rawHeader] = field
      claimedFields.add(field)
    }
  }

  return mapping
}
