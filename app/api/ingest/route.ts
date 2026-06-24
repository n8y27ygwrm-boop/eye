import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { parse } from 'csv-parse/sync'

const BATCH_SIZE = 100

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY not set')
  return createClient(url, key, { auth: { persistSession: false } })
}

export async function POST(req: NextRequest) {
  let sb: ReturnType<typeof adminClient>
  try { sb = adminClient() } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }

  // Parse multipart form — expect a field named "csv"
  const form = await req.formData()
  const file = form.get('csv')
  if (!file || typeof file === 'string') {
    return NextResponse.json({ error: 'POST a multipart file field named "csv"' }, { status: 400 })
  }

  const csvText = await (file as File).text()
  let rows: Record<string, string>[]
  try {
    rows = parse(csvText, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true,
    })
  } catch (e: any) {
    return NextResponse.json({ error: `CSV parse error: ${e.message}` }, { status: 400 })
  }

  // Fetch existing names for deduplication
  const existingNames = new Set<string>()
  let from = 0
  while (true) {
    const { data, error } = await sb!.from('clients').select('business_name').range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    data.forEach((r: { business_name: string }) =>
      existingNames.add((r.business_name ?? '').trim().toLowerCase()))
    if (data.length < 1000) break
    from += 1000
  }

  const toInsert: Record<string, unknown>[] = []
  let dupSkipped = 0, noAddrSkipped = 0, noNameSkipped = 0

  for (const row of rows) {
    const name = (row['Emri Biznesit'] ?? '').trim()
    const address = (row['Adresa Pershkrim'] ?? '').trim()
    const mapsUrl = (row['Google Maps Search Link'] ?? '').trim()

    if (!name) { noNameSkipped++; continue }
    if (!address) { noAddrSkipped++; continue }
    const lc = name.toLowerCase()
    if (existingNames.has(lc)) { dupSkipped++; continue }

    const payload: Record<string, unknown> = { business_name: name, address, status: 'prospect', zone: 'Z4', source: 'field_pdf_import' }
    if (mapsUrl) payload.maps_url = mapsUrl
    toInsert.push(payload)
    existingNames.add(lc)
  }

  let inserted = 0
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const { error } = await sb!.from('clients').insert(toInsert.slice(i, i + BATCH_SIZE))
    if (error) return NextResponse.json({ error: error.message, inserted }, { status: 500 })
    inserted += Math.min(BATCH_SIZE, toInsert.length - i)
  }

  return NextResponse.json({
    parsed: rows.length, inserted, dupSkipped, noAddrSkipped, noNameSkipped,
  })
}
