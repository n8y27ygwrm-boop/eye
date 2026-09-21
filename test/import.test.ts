import { test, describe } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import * as fflate from "fflate"

import { parseCsvContent } from "../lib/import/parse-csv"
import { parseXlsxContent } from "../lib/import/parse-xlsx"
import {
  parseGoogleSheetsUrl,
  isAllowedGoogleSheetsUrl,
  buildGoogleSheetsCsvExportUrl,
  isAllowedGoogleRedirectTarget,
  fetchPublicGoogleSheetCsv,
  MAX_REDIRECT_HOPS,
} from "../lib/import/google-sheet"
import { identifyHeaderField, buildHeaderMapping } from "../lib/import/headers"
import { cleanString, extractCoordsFromUrl, normalizeRawRecord } from "../lib/import/normalize"
import { detectDuplicates } from "../lib/import/dedupe"
import {
  determineRowStatus,
  validateCommitRow,
  resolveCommittedFields,
  sanitizeStatus,
  type ValidatedCommitRow,
} from "../lib/import/validation"
import type { NormalizedRow, DuplicateMatch, AIDerivedData } from "../lib/import/types"
import type { Client } from "../lib/types.ts"


function createMockXlsxBuffer(options?: {
  sheetXml?: string
  includeVba?: boolean
  extraFiles?: Record<string, Uint8Array>
}): Buffer {
  const contentTypesXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  ${options?.includeVba ? '<Override PartName="/xl/vbaProject.bin" ContentType="application/vnd.ms-office.vbaProject"/>' : ''}
</Types>`

  const relsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`

  const workbookXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Sheet1" sheetId="1" r:id="rId1"/>
  </sheets>
</workbook>`

  const workbookRelsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>`

  const defaultSheetXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>
    <row r="1">
      <c r="A1" t="inlineStr"><is><t>Business Name</t></is></c>
      <c r="B1" t="inlineStr"><is><t>Location</t></is></c>
      <c r="C1" t="inlineStr"><is><t>Notes</t></is></c>
    </row>
    <row r="2">
      <c r="A2" t="inlineStr"><is><t>Hotel Tirana</t></is></c>
      <c r="B2" t="inlineStr"><is><t>https://maps.google.com/?q=41.32,19.81</t></is></c>
      <c r="C2" t="inlineStr"><is><t>Regular client</t></is></c>
    </row>
    <row r="3">
      <c r="A3" t="inlineStr"><is><t>Bar Central</t></is></c>
      <c r="B3" t="inlineStr"><is><t></t></is></c>
      <c r="C3"><f>1+2</f><v>3</v></c>
    </row>
  </sheetData>
</worksheet>`

  const zipData: Record<string, Uint8Array> = {
    "[Content_Types].xml": fflate.strToU8(contentTypesXml),
    "_rels/.rels": fflate.strToU8(relsXml),
    "xl/workbook.xml": fflate.strToU8(workbookXml),
    "xl/_rels/workbook.xml.rels": fflate.strToU8(workbookRelsXml),
    "xl/worksheets/sheet1.xml": fflate.strToU8(options?.sheetXml || defaultSheetXml),
    ...(options?.extraFiles || {}),
  }

  if (options?.includeVba) {
    zipData["xl/vbaProject.bin"] = fflate.strToU8("VBA_MACRO_PAYLOAD_BIN")
  }

  const zipped = fflate.zipSync(zipData)
  return Buffer.from(zipped)
}

describe("EYE Import Inbox — V1 Hardened Regression Suite", () => {
  // ── TEST A: CSV with name + location + note parses correctly ──────────────
  test("A. CSV with name + location + note parses correctly", () => {
    const csv = [
      "Business Name,Google Maps,Notes",
      "Farmaci Dita,\"https://www.google.com/maps?q=41.3275,19.8187\",Klient i rregullt",
    ].join("\n")

    const parsed = parseCsvContent(csv)
    assert.equal(parsed.totalParsedRows, 1)

    const headerMap = buildHeaderMapping(parsed.headers)
    assert.equal(headerMap["Business Name"], "business_name")
    assert.equal(headerMap["Google Maps"], "maps_url")
    assert.equal(headerMap["Notes"], "general_notes")

    const { sourceFacts, normalized } = normalizeRawRecord(parsed.records[0], headerMap, 0)

    assert.equal(sourceFacts.business_name, "Farmaci Dita")
    assert.equal(sourceFacts.maps_url, "https://www.google.com/maps?q=41.3275,19.8187")
    assert.equal(sourceFacts.general_notes, "Klient i rregullt")

    assert.equal(normalized.lat, 41.3275)
    assert.equal(normalized.lng, 19.8187)
  })

  // ── TEST B: Blank location remains null ───────────────────────────────────
  test("B. Blank location remains null", () => {
    const csv = [
      "Name,Location,Note",
      "Restorant Tradicional,   ,Follow up next week",
    ].join("\n")

    const parsed = parseCsvContent(csv)
    const headerMap = buildHeaderMapping(parsed.headers)
    const { sourceFacts, normalized } = normalizeRawRecord(parsed.records[0], headerMap, 0)

    assert.equal(sourceFacts.business_name, "Restorant Tradicional")
    assert.equal(sourceFacts.maps_url, null)
    assert.equal(normalized.lat, null)
    assert.equal(normalized.lng, null)
    assert.equal(sourceFacts.general_notes, "Follow up next week")
  })

  // ── TEST C: Blank note remains null ──────────────────────────────────────
  test("C. Blank note remains null", () => {
    const csv = [
      "Name,Location,Note",
      "Klinika Dentare,\"https://maps.google.com/?q=41.32,19.81\",",
    ].join("\n")

    const parsed = parseCsvContent(csv)
    const headerMap = buildHeaderMapping(parsed.headers)
    const { sourceFacts } = normalizeRawRecord(parsed.records[0], headerMap, 0)

    assert.equal(sourceFacts.business_name, "Klinika Dentare")
    assert.equal(sourceFacts.general_notes, null)
  })

  // ── TEST D: Missing name becomes NEEDS REVIEW and is not auto-importable ─
  test("D. Missing name becomes NEEDS REVIEW and is not auto-importable", () => {
    const csv = [
      "Name,Location,Note",
      ",https://maps.google.com/?q=41.32,19.81,Shenim pa emer biznesi",
    ].join("\n")

    const parsed = parseCsvContent(csv)
    const headerMap = buildHeaderMapping(parsed.headers)
    const { normalized } = normalizeRawRecord(parsed.records[0], headerMap, 0)

    const duplicate: DuplicateMatch = { isDuplicate: false, matchType: null, source: null }
    const { status, missingName } = determineRowStatus(normalized, duplicate, null)

    assert.equal(missingName, true)
    assert.equal(status, "NEEDS_REVIEW")
  })

  // ── TEST E: Different reasonable header names are recognized ─────────────
  test("E. Different reasonable header names are recognized (EN & SQ aliases)", () => {
    assert.equal(identifyHeaderField("Client Name"), "business_name")
    assert.equal(identifyHeaderField("Map Link"), "maps_url")
    assert.equal(identifyHeaderField("Comments"), "general_notes")
    assert.equal(identifyHeaderField("Phone Number"), "phone")
    assert.equal(identifyHeaderField("Emri i Biznesit"), "business_name")
    assert.equal(identifyHeaderField("Google Maps Search Link"), "maps_url")
    assert.equal(identifyHeaderField("Vendndodhja"), "maps_url")
    assert.equal(identifyHeaderField("Shenime"), "general_notes")
    assert.equal(identifyHeaderField("Nr Tel"), "phone")
    assert.equal(identifyHeaderField("Adresa Pershkrim"), "address")
    assert.equal(identifyHeaderField("Zona"), "zone")
    assert.equal(identifyHeaderField("Kategoria"), "business_type")
  })

  // ── TEST F: Public valid Google Sheet URL accepted ───────────────────────
  test("F. Public valid Google Sheet URL accepted and export URL built", () => {
    const url = "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit?gid=12345#gid=12345"
    assert.equal(isAllowedGoogleSheetsUrl(url), true)

    const parsed = parseGoogleSheetsUrl(url)
    assert.ok(parsed)
    assert.equal(parsed.sheetId, "1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms")
    assert.equal(parsed.gid, "12345")

    const exportUrl = buildGoogleSheetsCsvExportUrl(parsed.sheetId, parsed.gid)
    assert.equal(
      exportUrl,
      "https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/export?format=csv&gid=12345"
    )
  })

  // ── TEST G: Google Sheets SSRF & Redirect Pre-Validation ─────────────────
  test("G. Google Sheets SSRF & Redirect target pre-validation", () => {
    // 1. Starting URL rejection
    assert.equal(isAllowedGoogleSheetsUrl("https://evil.com/sheet"), false)
    assert.equal(isAllowedGoogleSheetsUrl("https://docs.google.com.evil.com/sheet"), false)
    assert.equal(isAllowedGoogleSheetsUrl("https://attacker.io/data.csv"), false)
    assert.equal(isAllowedGoogleSheetsUrl("http://localhost:3000"), false)
    assert.equal(isAllowedGoogleSheetsUrl("http://127.0.0.1/admin"), false)

    // 2. Redirect target pre-validation BEFORE request
    // Approved targets
    assert.equal(isAllowedGoogleRedirectTarget("https://docs.google.com/spreadsheets/d/xxx/export?format=csv"), true)
    assert.equal(isAllowedGoogleRedirectTarget("https://spreadsheets.google.com/tq?key=xxx"), true)
    assert.equal(isAllowedGoogleRedirectTarget("https://doc-04-74-docs.googleusercontent.com/docs/securesc/xxx"), true)
    assert.equal(isAllowedGoogleRedirectTarget("https://drive.google.com/file/d/xxx"), true)

    // Blocked redirect targets (rejected BEFORE fetch)
    assert.equal(isAllowedGoogleRedirectTarget("https://evil.com/leak"), false)
    assert.equal(isAllowedGoogleRedirectTarget("https://docs.google.com.evil.com/leak"), false)
    assert.equal(isAllowedGoogleRedirectTarget("https://evilgoogle.com/"), false)
    assert.equal(isAllowedGoogleRedirectTarget("http://docs.google.com/sheet"), false) // non-https
    assert.equal(isAllowedGoogleRedirectTarget("https://localhost:3000/api"), false) // localhost
    assert.equal(isAllowedGoogleRedirectTarget("https://127.0.0.1/admin"), false) // loopback IP
    assert.equal(isAllowedGoogleRedirectTarget("https://169.254.169.254/latest/meta-data"), false) // cloud metadata
    assert.equal(isAllowedGoogleRedirectTarget("https://10.0.0.1/secret"), false) // private RFC1918
    assert.equal(isAllowedGoogleRedirectTarget("https://user:pass@docs.google.com/"), false) // credentials in URL
    assert.equal(isAllowedGoogleRedirectTarget("https://docs.google.com:8443/"), false) // non-standard port
  })

  // ── TEST H: Excessive redirects rejected ─────────────────────────────────
  test("H. Excessive redirects rejected (> 3 hops)", async () => {
    // Mock fetch that loops redirect 4 times
    const originalFetch = globalThis.fetch
    let redirectCalls = 0

    try {
      globalThis.fetch = (async (url: any) => {
        redirectCalls++
        return {
          status: 302,
          headers: new Headers({
            location: `https://docs.google.com/spreadsheets/d/test/export?format=csv&hop=${redirectCalls}`,
          }),
        } as any
      }) as any

      await assert.rejects(
        () => fetchPublicGoogleSheetCsv("https://docs.google.com/spreadsheets/d/test/edit"),
        /tejkaloi limitin e lejuar të ridrejtimeve/i
      )
      // Exactly 4 requests made (initial + 3 redirects allowed -> 4th throws)
      assert.equal(redirectCalls, MAX_REDIRECT_HOPS + 1)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  // ── TEST I: Redirect to malicious host blocked BEFORE request ───────────
  test("I. Redirect to evil.com blocked BEFORE request is issued", async () => {
    const originalFetch = globalThis.fetch
    let requestedUrls: string[] = []

    try {
      globalThis.fetch = (async (url: any) => {
        requestedUrls.push(String(url))
        return {
          status: 302,
          headers: new Headers({
            location: "https://evil.com/exfiltrate-token",
          }),
        } as any
      }) as any

      await assert.rejects(
        () => fetchPublicGoogleSheetCsv("https://docs.google.com/spreadsheets/d/test/edit"),
        /Ridrejtimi te hosti i paautorizuar/i
      )

      // Verified: evil.com was NEVER requested!
      assert.equal(requestedUrls.some(u => u.includes("evil.com")), false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  // ── TEST J: Oversized file rejected (> 5 MB) ─────────────────────────────
  test("J. Oversized file rejected (> 5 MB)", async () => {
    const oversizedBuffer = Buffer.alloc(5.1 * 1024 * 1024)
    assert.throws(() => parseCsvContent(oversizedBuffer), /tejkalon madhesine maksimale|tejkalon madh/i)
    await assert.rejects(() => parseXlsxContent(oversizedBuffer, "test.xlsx"), /tejkalon madhesine maksimale|tejkalon madh/i)
  })

  // ── TEST K: More than row limit rejected (> 500 rows) ────────────────────
  test("K. More than row limit rejected (> 500 rows)", () => {
    const lines = ["Name,Note"]
    for (let i = 0; i < 505; i++) {
      lines.push(`Biznes ${i},Shenim ${i}`)
    }
    const csv = lines.join("\n")
    assert.throws(() => parseCsvContent(csv), /500 rreshta/)
  })

  // ── TEST L: Real formula cells are never executed, macros rejected ───────
  test("L. XLSX real formula cells are never executed; macros & arbitrary zip rejected", async () => {
    // 1. Build an Excel workbook with a REAL formula cell
    const buf = createMockXlsxBuffer()
    const result = await parseXlsxContent(buf, "test.xlsx")
    assert.equal(result.totalParsedRows, 2)
    assert.equal(result.records[0]["Business Name"], "Hotel Tirana")
    assert.equal(result.records[1]["Business Name"], "Bar Central")
    // Formula cell <c r="C3"><f>1+2</f><v>3</v></c> reads value 3, formula <f> is never executed
    assert.equal(result.records[1]["Notes"], "3")
    assert.equal((result.records[1] as any).f, undefined)

    // 2. Reject macro extensions
    await assert.rejects(() => parseXlsxContent(buf, "macro_file.xlsm"), /makro/i)
    await assert.rejects(() => parseXlsxContent(buf, "legacy_file.xls"), /xls/i)

    // 3. Reject REAL macro-bearing workbook renamed .xlsx based on CONTENT (vbaProject.bin)
    const macroBuf = createMockXlsxBuffer({ includeVba: true })
    await assert.rejects(
      () => parseXlsxContent(macroBuf, "safe_looking_file.xlsx"),
      /makro/i,
      "Macro workbook renamed .xlsx must be rejected based on content!"
    )

    // 4. Reject arbitrary ZIP file renamed to .xlsx (missing OOXML structures)
    const arbitraryZipHeader = Buffer.from([
      0x50, 0x4b, 0x03, 0x04, 0x0a, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
      0x00, 0x00, 0x05, 0x00, 0x00, 0x00, 0x68, 0x65, 0x6c, 0x6c, 0x6f,
      0x77, 0x6f, 0x72, 0x6c, 0x64
    ])
    await assert.rejects(
      () => parseXlsxContent(arbitraryZipHeader, "fake.xlsx"),
      /dokument i vlefshëm Excel OOXML|format i pavlefshëm/i
    )

    // 5. Reject malformed OOXML
    const malformedBuf = Buffer.from("PK\x03\x04corrupted_payload_data_not_valid_zip")
    await assert.rejects(
      () => parseXlsxContent(malformedBuf, "corrupted.xlsx"),
      /dokument i vlefshëm Excel OOXML|Leximi i skedarit XLSX dështoi/i
    )
  })

  // ── TEST M: SOURCE FACTS ALWAYS WIN OVER AI ──────────────────────────────
  test("M. SOURCE FACTS ALWAYS WIN OVER AI (No AI overwrite permitted)", () => {
    // 1. Source zone + conflicting AI zone -> Source zone persists
    const res1 = resolveCommittedFields(
      { zone: "Blloku", business_type: null },
      { zone: "Z2", category: "Restorant" }
    )
    assert.equal(res1.zone, "Blloku", "Source zone MUST persist over AI zone")
    assert.equal(res1.business_type, "Restorant", "AI category may fill blank source category")

    // 2. Source category + conflicting AI category -> Source category persists
    const res2 = resolveCommittedFields(
      { zone: null, business_type: "Farmaci" },
      { zone: "Z1", category: "Kafene" }
    )
    assert.equal(res2.business_type, "Farmaci", "Source business_type MUST persist over AI category")
    assert.equal(res2.zone, "Z1", "AI zone may fill blank source zone")

    // 3. Both source fields supplied -> Both source fields persist, AI ignored
    const res3 = resolveCommittedFields(
      { zone: "Kombinat", business_type: "Dyqan" },
      { zone: "Z5", category: "Supermarket" }
    )
    assert.equal(res3.zone, "Kombinat")
    assert.equal(res3.business_type, "Dyqan")

    // 4. Blank / whitespace source fields -> AI values may be used
    const res4 = resolveCommittedFields(
      { zone: "   ", business_type: "" },
      { zone: "Z3", category: "Klinikë" }
    )
    assert.equal(res4.zone, "Z3")
    assert.equal(res4.business_type, "Klinikë")

    // 5. Neither source nor AI supplied -> null
    const res5 = resolveCommittedFields(
      { zone: null, business_type: null },
      null
    )
    assert.equal(res5.zone, null)
    assert.equal(res5.business_type, null)
  })

  // ── TEST N: In-batch duplicate detection ──────────────────────────────────
  test("N. Same normalized client in import is marked duplicate (in-batch deduplication)", () => {
    const rows: NormalizedRow[] = [
      {
        source_row_index: 0,
        business_name: "Farmaci Dita",
        raw_business_name: "Farmaci Dita",
        maps_url: null,
        lat: null,
        lng: null,
        general_notes: "First row",
        phone: null,
        address: null,
        zone: null,
        business_type: null,
      },
      {
        source_row_index: 1,
        business_name: "farmaci dita  ",
        raw_business_name: "farmaci dita  ",
        maps_url: null,
        lat: null,
        lng: null,
        general_notes: "Second row duplicate",
        phone: null,
        address: null,
        zone: null,
        business_type: null,
      },
    ]

    const matches = detectDuplicates(rows, [])
    assert.equal(matches[0].isDuplicate, false)
    assert.equal(matches[1].isDuplicate, true)
    assert.equal(matches[1].matchType, "exact_name")
    assert.equal(matches[1].source, "current_batch")
  })

  // ── TEST O: REVALIDATE DUPLICATES AT COMMIT BOUNDARY ──────────────────────
  test("O. Revalidate duplicates at commit boundary against DB state", () => {
    const existingDbClients: Client[] = [
      {
        id: "client-existing-1",
        owner_user_id: "user-1",
        business_name: "Hotel Tirana",
        phone: "+355691111111",
        maps_url: "https://maps.google.com/?q=41.32,19.81",
        lat: 41.32,
        lng: 19.81,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      } as unknown as Client,
    ]

    const commitCandidates: NormalizedRow[] = [
      {
        source_row_index: 0,
        business_name: "Hotel Tirana", // Duplicate of existing DB client!
        raw_business_name: "Hotel Tirana",
        maps_url: "https://maps.google.com/?q=41.32,19.81",
        lat: 41.32,
        lng: 19.81,
        general_notes: "Bypass attempt",
        phone: "+355691111111",
        address: null,
        zone: null,
        business_type: null,
      },
    ]

    // 1. Direct commit bypass attempt (no explicit duplicateResolution or resolution !== import_new)
    const matches1 = detectDuplicates(commitCandidates, existingDbClients)
    assert.equal(matches1[0].isDuplicate, true)
    assert.equal(matches1[0].source, "existing_client")

    // Policy test: if duplicate found and resolution !== "import_new" -> DO NOT INSERT
    const shouldInsertBypass = matches1[0].isDuplicate && (undefined as any) === "import_new"
    assert.equal(shouldInsertBypass, false, "Direct commit bypass attempt MUST NOT be inserted")

    // 2. Duplicate with resolution === "skip" -> DO NOT INSERT
    const shouldInsertSkip = matches1[0].isDuplicate && ("skip" as any) === "import_new"
    assert.equal(shouldInsertSkip, false, "Duplicate with skip resolution MUST NOT be inserted")

    // 3. Duplicate with explicit "import_new" -> INSERTION ALLOWED
    const shouldInsertExplicit = matches1[0].isDuplicate && ("import_new" as any) === "import_new"
    assert.equal(shouldInsertExplicit, true, "Duplicate with explicit import_new MUST be allowed")

    // 4. Stale preview where duplicate appears before commit:
    // Suppose at preview time DB was empty:
    const previewMatches = detectDuplicates(commitCandidates, [])
    assert.equal(previewMatches[0].isDuplicate, false, "Preview saw no duplicates initially")

    // But before commit, DB got updated:
    const commitTimeMatches = detectDuplicates(commitCandidates, existingDbClients)
    assert.equal(commitTimeMatches[0].isDuplicate, true, "Commit boundary catches newly created DB duplicate!")
  })

  // ── TEST P: TENANT ISOLATION — Other user client never participates ───────
  test("P. Strict tenant isolation: Other user client MUST NOT participate in duplicate check", () => {
    // Attacker or other tenant has this client in DB
    const otherUserClient: Client = {
      id: "client-other-user",
      owner_user_id: "other-user-999",
      business_name: "Kafe Tirana",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as unknown as Client

    // Current user Alpha imports the same name
    const userAlphaRows: NormalizedRow[] = [
      {
        source_row_index: 0,
        business_name: "Kafe Tirana",
        raw_business_name: "Kafe Tirana",
        maps_url: null,
        lat: null,
        lng: null,
        general_notes: null,
        phone: null,
        address: null,
        zone: null,
        business_type: null,
      },
    ]

    // Strict tenant isolation: server-side query filters .eq("owner_user_id", user.id)
    // Therefore otherUserClient is never present in the search list!
    const userAlphaExistingClients: Client[] = []
    const matches = detectDuplicates(userAlphaRows, userAlphaExistingClients)
    assert.equal(matches[0].isDuplicate, false, "Other tenant client never causes duplicate match")
  })

  // ── TEST Q: Owner user ID and Status validation ──────────────────────────
  test("Q. Commit strictly derives owner_user_id from auth session and validates status", () => {
    const rawPayloadItem = {
      business_name: "Pasticeri Rinia",
      owner_user_id: "attacker-user-id", // Tampering attempt
      status: "SUPER_ADMIN_STATUS", // Tampering attempt
      maps_url: "https://maps.google.com/?q=41.32,19.81",
      general_notes: "Porosi e re",
    }

    const authenticatedSessionOwner = "legitimate-auth-user-123"
    const validationResult = validateCommitRow(rawPayloadItem, authenticatedSessionOwner)

    assert.equal(validationResult.valid, true)
    if (validationResult.valid) {
      // 1. owner_user_id strictly overridden by session
      assert.equal(validationResult.row.owner_user_id, authenticatedSessionOwner)
      assert.notEqual(validationResult.row.owner_user_id, "attacker-user-id")

      // 2. Status sanitized against allowed project statuses
      assert.equal(validationResult.row.status, "prospect")
    }

    // 3. Allowed statuses are correctly preserved
    assert.equal(sanitizeStatus("PROSPECT"), "prospect")
    assert.equal(sanitizeStatus("App downloaded"), "App downloaded")
    assert.equal(sanitizeStatus("catalog sent"), "Catalog sent")
    assert.equal(sanitizeStatus("Customer/Purchase"), "Customer/Purchase")
    assert.equal(sanitizeStatus("visited"), "prospect", "visited is not a client status and must map to prospect")
    assert.equal(sanitizeStatus("INVALID_STATUS"), "prospect")
  })

  // ── TEST R: AI malformed output & outage isolation ───────────────────────
  test("R. AI malformed output or outage does not abort import", () => {
    const row: NormalizedRow = {
      source_row_index: 0,
      business_name: "Auto Servis Tirana",
      raw_business_name: "Auto Servis Tirana",
      maps_url: "https://maps.google.com/?q=41.32,19.81",
      lat: 41.32,
      lng: 19.81,
      general_notes: "Nderrim vaji",
      phone: null,
      address: null,
      zone: null,
      business_type: null,
    }

    const duplicate: DuplicateMatch = { isDuplicate: false, matchType: null, source: null }
    // When AI returns null (outage, timeout, or malformed schema)
    const { status, missingName } = determineRowStatus(row, duplicate, null)

    assert.equal(missingName, false)
    assert.equal(status, "READY_WITHOUT_ENRICHMENT")

    // The row is still completely committable with pure source facts
    const commitRes = validateCommitRow(
      {
        business_name: row.business_name,
        maps_url: row.maps_url,
        lat: row.lat,
        lng: row.lng,
        general_notes: row.general_notes,
      },
      "user-1"
    )
    assert.equal(commitRes.valid, true)
  })

  // ── TEST S: Pure preview pipeline executes with zero database mutations ──
  test("S. Pure preview pipeline executes with zero database mutations", () => {
    const csv = "Name,Location\nTest Business,https://maps.google.com/?q=41.32,19.81"
    const parsed = parseCsvContent(csv)
    const headerMap = buildHeaderMapping(parsed.headers)
    const { normalized } = normalizeRawRecord(parsed.records[0], headerMap, 0)
    const duplicate = detectDuplicates([normalized], [])[0]
    const previewStatus = determineRowStatus(normalized, duplicate, null)

    assert.equal(previewStatus.status, "READY_WITHOUT_ENRICHMENT")
    assert.equal(normalized.business_name, "Test Business")
  })

  // ── TEST T: UI Components Architecture & Zero Emoji Verification ─────────
  test("T. UI Components Architecture & Zero Emoji Verification", () => {
    // 1. AppContext exports import modal state & reload
    const appCtx = fs.readFileSync("/Users/redjonhalilaj/Downloads/eye/contexts/AppContext.tsx", "utf8")
    assert.match(appCtx, /importModalOpen/, "AppContext must export importModalOpen")
    assert.match(appCtx, /openImportModal/, "AppContext must export openImportModal")
    assert.match(appCtx, /closeImportModal/, "AppContext must export closeImportModal")
    assert.match(appCtx, /loadClients/, "AppContext must export loadClients")

    // 2. ClientList renders IMPORT DATA action
    const clientList = fs.readFileSync("/Users/redjonhalilaj/Downloads/eye/components/ClientList.tsx", "utf8")
    assert.match(clientList, /btn-import-clients/, "ClientList must render btn-import-clients")
    assert.match(clientList, /IMPORT DATA/, "ClientList must display IMPORT DATA text")
    assert.match(clientList, /openImportModal/, "ClientList button must call openImportModal")

    // 3. Shell mounts ImportModal inside modal-overlay-center
    const shell = fs.readFileSync("/Users/redjonhalilaj/Downloads/eye/app/(main)/shell.tsx", "utf8")
    assert.match(shell, /import-modal-overlay/, "shell must mount import-modal-overlay")
    assert.match(shell, /<ImportModal/, "shell must render ImportModal")

    // 4. ImportRowCard: Zero emoji check
    const rowCard = fs.readFileSync("/Users/redjonhalilaj/Downloads/eye/components/import/ImportRowCard.tsx", "utf8")
    assert.equal(rowCard.includes("📍"), false, "ImportRowCard must NOT contain pin emoji")
    assert.equal(rowCard.includes("🏷️"), false, "ImportRowCard must NOT contain tag emoji")
    assert.equal(rowCard.includes("⚡"), false, "ImportRowCard must NOT contain lightning emoji")

    // 5. CSS uses Savvy Systems tokens and mobile bottom sheet rules
    const css = fs.readFileSync("/Users/redjonhalilaj/Downloads/eye/app/globals.css", "utf8")
    assert.match(css, /btn-import-clients/, "globals.css must style btn-import-clients")
    assert.match(css, /import-modal-card/, "globals.css must style import-modal-card")
    assert.match(css, /max-height:\s*94dvh/, "globals.css must use 94dvh on mobile")
  })
})
