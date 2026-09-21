import { NextRequest, NextResponse } from "next/server"
import { requireAuthenticatedUser } from "@/lib/supabase/server"
import { parseCsvContent } from "@/lib/import/parse-csv"
import { parseXlsxContent } from "@/lib/import/parse-xlsx"
import { fetchPublicGoogleSheetCsv, isAllowedGoogleSheetsUrl } from "@/lib/import/google-sheet"
import { buildHeaderMapping } from "@/lib/import/headers"
import { normalizeRawRecord } from "@/lib/import/normalize"
import { detectDuplicates } from "@/lib/import/dedupe"
import { classifyImportRows } from "@/lib/import/ai-classify"
import { determineRowStatus } from "@/lib/import/validation"
import type { ImportPreviewRow, ImportPreviewSummary, SourceFacts, NormalizedRow } from "@/lib/import/types"
import type { Client } from "@/lib/types"

export async function POST(req: NextRequest) {
  // 1. Strict Server-Side Authentication
  const { user, supabase, error: authError } = await requireAuthenticatedUser()
  if (authError || !user) {
    return NextResponse.json({ error: "I paautorizuar (Unauthorized). Ju lutem kyçuni për të importuar të dhëna." }, { status: 401 })
  }

  const contentType = req.headers.get("content-type") || ""

  let headers: string[] = []
  let records: Record<string, string>[] = []

  try {
    if (contentType.includes("application/json")) {
      const body = await req.json()
      const { type, url } = body

      if (type !== "google_sheet" || !url) {
        return NextResponse.json({ error: "Kërkesa duhet të përmbajë një Google Sheets URL të vlefshme." }, { status: 400 })
      }

      if (!isAllowedGoogleSheetsUrl(url)) {
        return NextResponse.json({
          error: "URL-ja e dhënë nuk është e lejuar. Lejohen vetëm dokumente publike nga docs.google.com/spreadsheets.",
        }, { status: 400 })
      }

      const csvContent = await fetchPublicGoogleSheetCsv(url)
      const parsed = parseCsvContent(csvContent)
      headers = parsed.headers
      records = parsed.records
    } else if (contentType.includes("multipart/form-data")) {
      const formData = await req.formData()
      const file = formData.get("file") as File | null

      if (!file) {
        return NextResponse.json({ error: "Nuk u ngarkua asnjë skedar." }, { status: 400 })
      }

      const filename = file.name || "upload"
      const lowerName = filename.toLowerCase()
      const arrayBuffer = await file.arrayBuffer()
      const buffer = Buffer.from(arrayBuffer)

      if (lowerName.endsWith(".csv")) {
        const parsed = parseCsvContent(buffer)
        headers = parsed.headers
        records = parsed.records
      } else if (lowerName.endsWith(".xlsx")) {
        const parsed = await parseXlsxContent(buffer, filename)
        headers = parsed.headers
        records = parsed.records
      } else if (lowerName.endsWith(".xlsm") || lowerName.endsWith(".xls")) {
        return NextResponse.json({
          error: "Skedari nuk lejohet (.xlsm ose .xls). Ju lutem ruajeni si .xlsx ose .csv para ngarkimit.",
        }, { status: 400 })
      } else {
        return NextResponse.json({
          error: "Format skedari i panjohur. Mbështeten vetëm skedarë .csv dhe .xlsx.",
        }, { status: 400 })
      }
    } else {
      return NextResponse.json({ error: "Content-Type i pambështetur." }, { status: 400 })
    }
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Gabim gjatë leximit të skedarit." }, { status: 400 })
  }

  if (records.length === 0) {
    return NextResponse.json({ error: "Nuk u gjetën të dhëna për importim." }, { status: 400 })
  }

  // 2. Fetch existing clients scoped STRICTLY to the authenticated user for deduplication
  const { data: userClients, error: fetchErr } = await supabase
    .from("clients")
    .select("id, owner_user_id, business_name, phone, maps_url, lat, lng, zone, business_type, general_notes, address, status, contact_person, next_action, next_followup, decline_reason, order_value, source, created_at, updated_at")
    .eq("owner_user_id", user.id)

  if (fetchErr) {
    return NextResponse.json({ error: `Dështoi leximi i klientëve ekzistues: ${fetchErr.message}` }, { status: 500 })
  }

  const existingClients = (userClients || []) as Client[]

  // 3. Build Header Mapping & Normalize Records
  const headerMap = buildHeaderMapping(headers)
  const normalizedList: { sourceFacts: SourceFacts; normalized: NormalizedRow }[] = []

  for (let i = 0; i < records.length; i++) {
    const norm = normalizeRawRecord(records[i], headerMap, i)
    normalizedList.push(norm)
  }

  const normalizedRows = normalizedList.map(n => n.normalized)

  // 4. Duplicate Detection (Current Batch + Authenticated User Clients ONLY)
  const duplicates = detectDuplicates(normalizedRows, existingClients)

  // 5. AI Classification (Batched, Safe Fallback)
  const aiResults = await classifyImportRows(normalizedRows)

  // 6. Build Preview Rows
  const previewRows: ImportPreviewRow[] = []

  let readyCount = 0
  let readyWithoutEnrichmentCount = 0
  let duplicateCount = 0
  let needsReviewCount = 0
  let invalidCount = 0
  let excludedCount = 0

  for (let i = 0; i < normalizedList.length; i++) {
    const { sourceFacts, normalized } = normalizedList[i]
    const duplicate = duplicates[i]
    const aiDerived = aiResults[i]

    const { status, missingName } = determineRowStatus(normalized, duplicate, aiDerived)

    // Default include policy: include if ready or duplicate (user decides resolution), exclude if missing name
    const include = !missingName && status !== "INVALID"

    if (missingName) {
      needsReviewCount++
    } else if (duplicate.isDuplicate) {
      duplicateCount++
    } else if (status === "READY_WITHOUT_ENRICHMENT") {
      readyWithoutEnrichmentCount++
      readyCount++
    } else if (status === "READY") {
      readyCount++
    }

    previewRows.push({
      id: `row-${i}`,
      source_row_index: i,
      sourceFacts,
      normalized,
      aiDerived,
      duplicate,
      missingName,
      status,
      include,
      duplicateResolution: duplicate.isDuplicate ? "skip" : "import_new",
    })
  }

  const summary: ImportPreviewSummary = {
    totalRows: previewRows.length,
    readyCount,
    readyWithoutEnrichmentCount,
    duplicateCount,
    needsReviewCount,
    invalidCount,
    excludedCount,
  }

  return NextResponse.json({
    success: true,
    summary,
    rows: previewRows,
  })
}
