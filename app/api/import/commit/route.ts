import { NextRequest, NextResponse } from "next/server"
import { requireAuthenticatedUser } from "@/lib/supabase/server"
import { validateCommitRow, type ValidatedCommitRow } from "@/lib/import/validation"
import { detectDuplicates } from "@/lib/import/dedupe"
import type { ImportCommitResult, NormalizedRow } from "@/lib/import/types"
import type { Client } from "@/lib/types"

const BATCH_SIZE = 100

export async function POST(req: NextRequest) {
  // 1. Strict Server-Side Authentication
  const { user, supabase, error: authError } = await requireAuthenticatedUser()
  if (authError || !user) {
    return NextResponse.json(
      { error: "I paautorizuar (Unauthorized). Ju lutem kyçuni për të kryer importimin." },
      { status: 401 }
    )
  }

  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Payload JSON i pavlefshëm." }, { status: 400 })
  }

  const rawRows = body?.rows
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    return NextResponse.json({ error: "Nuk u dërguan rreshta për importim." }, { status: 400 })
  }

  if (rawRows.length > 500) {
    return NextResponse.json({ error: "Numri maksimal i rreshtave për importim është 500." }, { status: 400 })
  }

  const candidateRows: ValidatedCommitRow[] = []
  const errors: string[] = []
  let skipped = 0
  let failed = 0

  // 2. Server-side validation of individual row format
  // STRICT: owner_user_id is set to user.id and never taken from raw input!
  for (let i = 0; i < rawRows.length; i++) {
    const raw = rawRows[i]
    if (raw?.skip === true || raw?.duplicateResolution === "skip") {
      skipped++
      continue
    }

    const res = validateCommitRow(raw, user.id)
    if (!res.valid) {
      failed++
      errors.push(`Rreshti ${i + 1}: ${res.error}`)
    } else {
      candidateRows.push(res.row)
    }
  }

  if (candidateRows.length === 0) {
    return NextResponse.json<ImportCommitResult>({
      imported: 0,
      skipped,
      failed,
      errors,
    })
  }

  // 3. REVALIDATE DUPLICATES AT COMMIT BOUNDARY (Current DB state + Batch)
  // Query existing clients strictly scoped to current authenticated user
  const { data: userClients, error: fetchErr } = await supabase
    .from("clients")
    .select("id, owner_user_id, business_name, phone, maps_url, lat, lng")
    .eq("owner_user_id", user.id)

  if (fetchErr) {
    return NextResponse.json(
      { error: `Dështoi kontrolli i duplikatave: ${fetchErr.message}` },
      { status: 500 }
    )
  }

  const existingClients = (userClients || []) as Client[]

  // Convert candidates to NormalizedRow shape for dedupe engine
  const normalizedCandidates: NormalizedRow[] = candidateRows.map((r, idx) => ({
    source_row_index: idx,
    business_name: r.business_name,
    raw_business_name: r.business_name,
    maps_url: r.maps_url,
    lat: r.lat,
    lng: r.lng,
    general_notes: r.general_notes,
    phone: r.phone,
    address: r.address,
    zone: r.zone,
    business_type: r.business_type,
  }))

  const duplicateMatches = detectDuplicates(normalizedCandidates, existingClients)

  const finalInsertBatch: Omit<ValidatedCommitRow, "duplicateResolution">[] = []

  for (let i = 0; i < candidateRows.length; i++) {
    const row = candidateRows[i]
    const match = duplicateMatches[i]

    if (match.isDuplicate) {
      // If a duplicate is detected, only allow insertion if user explicitly resolved as "import_new"
      if (row.duplicateResolution === "import_new") {
        const { duplicateResolution: _res, ...cleanRow } = row
        finalInsertBatch.push(cleanRow)
      } else {
        // Safe default: skip duplicate
        skipped++
      }
    } else {
      const { duplicateResolution: _res, ...cleanRow } = row
      finalInsertBatch.push(cleanRow)
    }
  }

  if (finalInsertBatch.length === 0) {
    return NextResponse.json<ImportCommitResult>({
      imported: 0,
      skipped,
      failed,
      errors,
    })
  }

  // 4. Batch insert clean validated clients
  let imported = 0
  for (let i = 0; i < finalInsertBatch.length; i += BATCH_SIZE) {
    const batch = finalInsertBatch.slice(i, i + BATCH_SIZE)
    const { error: insertErr } = await supabase.from("clients").insert(batch)

    if (insertErr) {
      failed += batch.length
      errors.push(`Dështoi ruajtja e grupit ${Math.floor(i / BATCH_SIZE) + 1}: ${insertErr.message}`)
    } else {
      imported += batch.length
    }
  }

  return NextResponse.json<ImportCommitResult>({
    imported,
    skipped,
    failed,
    errors,
  })
}
