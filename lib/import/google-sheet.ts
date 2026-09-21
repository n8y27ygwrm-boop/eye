/**
 * Google Sheets ingestion & security module for EYE Import Inbox.
 * Validates public Google Sheets URLs, guards against SSRF,
 * and fetches public CSV export using bounded manual redirect validation.
 */

export const MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024 // 5 MB
export const FETCH_TIMEOUT_MS = 10_000 // 10 seconds
export const MAX_REDIRECT_HOPS = 3 // Maximum allowed redirect hops

// Strict regex matching valid Google Sheets URLs
const GOOGLE_SHEETS_URL_REGEX = /^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9-_]+)(?:\/.*)?$/

/**
 * Checks if a URL is a valid Google Sheets URL and parses sheetId and optional gid.
 */
export function parseGoogleSheetsUrl(rawUrl: string): { sheetId: string; gid: string | null } | null {
  if (!rawUrl || typeof rawUrl !== "string") return null
  const trimmed = rawUrl.trim()

  try {
    const parsed = new URL(trimmed)

    // Strict protocol & host check
    if (parsed.protocol !== "https:" || parsed.hostname !== "docs.google.com") {
      return null
    }

    const match = trimmed.match(GOOGLE_SHEETS_URL_REGEX)
    if (!match || !match[1]) {
      return null
    }

    const sheetId = match[1]

    // Extract gid if present in query or hash
    let gid: string | null = null
    const gidParam = parsed.searchParams.get("gid")
    if (gidParam && /^\d+$/.test(gidParam)) {
      gid = gidParam
    } else if (parsed.hash) {
      const hashMatch = parsed.hash.match(/gid=(\d+)/)
      if (hashMatch) {
        gid = hashMatch[1]
      }
    }

    return { sheetId, gid }
  } catch {
    return null
  }
}

/**
 * Validates that an arbitrary URL is strictly an approved Google Sheets URL.
 * Rejects localhost, private IPs, arbitrary schemes, etc.
 */
export function isAllowedGoogleSheetsUrl(rawUrl: string): boolean {
  if (!rawUrl || typeof rawUrl !== "string") return false
  const trimmed = rawUrl.trim()

  // Fast rejection of hazardous schemes/hosts
  if (
    trimmed.startsWith("http://") ||
    trimmed.startsWith("file:") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("javascript:") ||
    /localhost|127\.0\.0\.1|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2[0-9]|3[0-1])\.|169\.254\./i.test(trimmed)
  ) {
    return false
  }

  return parseGoogleSheetsUrl(trimmed) !== null
}

/**
 * Converts a valid public Google Sheets URL to its direct CSV export endpoint.
 */
export function buildGoogleSheetsCsvExportUrl(sheetId: string, gid: string | null): string {
  const base = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv`
  return gid ? `${base}&gid=${encodeURIComponent(gid)}` : base
}

/**
 * SSRF GUARD: Validates redirect targets BEFORE issuing requests.
 * Enforces:
 * - HTTPS only
 * - No user/password credentials
 * - Standard HTTPS port (443 or none)
 * - No IP addresses (IPv4 or IPv6)
 * - Strictly approved Google domains (docs.google.com, spreadsheets.google.com,
 *   *.google.com, *.googleusercontent.com)
 * Rejects: evil.com, evilgoogle.com, docs.google.com.evil.com, localhost, private IPs.
 */
export function isAllowedGoogleRedirectTarget(targetUrl: string): boolean {
  if (!targetUrl || typeof targetUrl !== "string") return false
  try {
    const parsed = new URL(targetUrl)

    // 1. Must be HTTPS
    if (parsed.protocol !== "https:") {
      return false
    }

    // 2. Must not contain credentials
    if (parsed.username || parsed.password) {
      return false
    }

    // 3. Port must be empty or 443
    if (parsed.port && parsed.port !== "443") {
      return false
    }

    const host = parsed.hostname.toLowerCase()

    // 4. Disallow IP addresses (IPv4 or IPv6)
    if (/^[\d.]+$|^\[.*\]$/.test(host)) {
      return false
    }

    // 5. Disallow localhost or single-label hosts
    if (host === "localhost" || !host.includes(".")) {
      return false
    }

    // 6. Strict approved Google domains
    const isExactGoogle =
      host === "docs.google.com" ||
      host === "spreadsheets.google.com" ||
      host === "drive.google.com" ||
      host === "google.com"

    const isGoogleSubdomain =
      host.endsWith(".docs.google.com") ||
      host.endsWith(".spreadsheets.google.com") ||
      host.endsWith(".google.com")

    const isGoogleUserContent =
      host === "googleusercontent.com" ||
      host.endsWith(".googleusercontent.com")

    if (!isExactGoogle && !isGoogleSubdomain && !isGoogleUserContent) {
      return false
    }

    return true
  } catch {
    return false
  }
}

/**
 * Safely fetches a public Google Sheet as CSV with:
 * - Bounded manual redirect strategy (redirect: "manual", max 3 hops)
 * - Strict SSRF validation on each Location BEFORE following
 * - Timeout bound (10s)
 * - Response size bound (5 MB)
 */
export async function fetchPublicGoogleSheetCsv(rawUrl: string): Promise<string> {
  const parsed = parseGoogleSheetsUrl(rawUrl)
  if (!parsed) {
    throw new Error("Linku i dhënë nuk është një link i vlefshëm i Google Sheets (https://docs.google.com/spreadsheets/d/...).")
  }

  const exportUrl = buildGoogleSheetsCsvExportUrl(parsed.sheetId, parsed.gid)

  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS)

  let currentUrl = exportUrl
  let hops = 0

  try {
    while (true) {
      const res = await fetch(currentUrl, {
        method: "GET",
        signal: controller.signal,
        headers: {
          "User-Agent": "EYE-CRM/1.0",
          "Accept": "text/csv, text/plain, */*",
        },
        redirect: "manual",
      })

      // Check for redirects (301, 302, 303, 307, 308)
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        hops++
        if (hops > MAX_REDIRECT_HOPS) {
          throw new Error(`Google Sheet kërkesa tejkaloi limitin e lejuar të ridrejtimeve (maksimumi ${MAX_REDIRECT_HOPS}).`)
        }

        const location = res.headers.get("location")
        if (!location) {
          throw new Error(`Google Sheet ridrejtoi me status ${res.status} por pa header Location.`)
        }

        let nextUrl: string
        try {
          nextUrl = new URL(location, currentUrl).toString()
        } catch {
          throw new Error(`Header Location i pavlefshëm gjatë ridrejtimit: ${location}`)
        }

        // PRE-REQUEST SSRF GUARD: Validate destination BEFORE making the request!
        if (!isAllowedGoogleRedirectTarget(nextUrl)) {
          throw new Error(`Ridrejtimi te hosti i paautorizuar (${nextUrl}) u bllokua nga mbrojtja e sigurisë.`)
        }

        currentUrl = nextUrl
        continue
      }

      if (!res.ok) {
        if (res.status === 404) {
          throw new Error("Dokumenti Google Sheets nuk u gjet (404). Kontrolloni linkun.")
        }
        if (res.status === 401 || res.status === 403) {
          throw new Error("Google Sheet nuk është publik. Ju lutem aktivizoni lejen \"Anyone with the link can view\".")
        }
        throw new Error(`Shkarkimi i Google Sheet dështoi me status ${res.status}.`)
      }

      // Check content-type: Google Sheets returns HTML login page if private
      const contentType = (res.headers.get("content-type") || "").toLowerCase()
      if (contentType.includes("text/html")) {
        const checkUrl = new URL(currentUrl)
        if (checkUrl.pathname.includes("/signin") || checkUrl.pathname.includes("/ServiceLogin")) {
          throw new Error("Google Sheet kërkon hyrje me llogari (nuk është publik). Ju lutem bëjeni publik para importimit.")
        }
      }

      // Check content-length header if provided
      const contentLength = res.headers.get("content-length")
      if (contentLength && parseInt(contentLength, 10) > MAX_DOWNLOAD_BYTES) {
        throw new Error("Google Sheet tejkalon madhësinë maksimale të lejuar prej 5 MB.")
      }

      // Stream download with byte counter to enforce MAX_DOWNLOAD_BYTES
      const reader = res.body?.getReader()
      if (!reader) {
        const text = await res.text()
        if (Buffer.byteLength(text, "utf8") > MAX_DOWNLOAD_BYTES) {
          throw new Error("Google Sheet tejkalon madhësinë maksimale prej 5 MB.")
        }
        if (text.trim().startsWith("<!DOCTYPE html") || text.trim().startsWith("<html")) {
          throw new Error("Google Sheet nuk është publik ose kërkon autorizim. Sigurohuni që linku është publik.")
        }
        return text
      }

      const chunks: Uint8Array[] = []
      let totalBytes = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          totalBytes += value.length
          if (totalBytes > MAX_DOWNLOAD_BYTES) {
            controller.abort()
            throw new Error("Google Sheet tejkalon madhësinë maksimale të lejuar prej 5 MB.")
          }
          chunks.push(value)
        }
      }

      const buffer = Buffer.concat(chunks)
      const text = buffer.toString("utf8")

      // If result looks like an HTML error/login page despite status 200
      if (text.trim().startsWith("<!DOCTYPE html") || text.trim().startsWith("<html")) {
        throw new Error("Google Sheet nuk është publik ose kërkon autorizim. Sigurohuni që linku është publik.")
      }

      return text
    }
  } catch (err: any) {
    if (err.name === "AbortError") {
      throw new Error("Kërkesa për shkarkimin e Google Sheet zgjati shumë (timeout pas 10 sekondash).")
    }
    throw err
  } finally {
    clearTimeout(timeoutId)
  }
}
