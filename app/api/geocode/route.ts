import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

const TIRANA_BOUNDS = { minLat: 41.28, maxLat: 41.38, minLng: 19.75, maxLng: 19.95 }

function adminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_KEY
  if (!url || !key) throw new Error('NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_KEY not set')
  return createClient(url, key, { auth: { persistSession: false } })
}

function inTirana(lat: number, lng: number) {
  return lat >= TIRANA_BOUNDS.minLat && lat <= TIRANA_BOUNDS.maxLat
      && lng >= TIRANA_BOUNDS.minLng && lng <= TIRANA_BOUNDS.maxLng
}

async function geocodeOne(query: string, apiKey: string) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = await res.json() as { status: string; results: any[]; error_message?: string }
  if (json.status === 'OK' && json.results.length > 0) {
    const r = json.results[0]
    return { lat: r.geometry.location.lat as number, lng: r.geometry.location.lng as number }
  }
  if (json.status === 'ZERO_RESULTS') return null
  throw new Error(`Geocoder status=${json.status}${json.error_message ? ' — ' + json.error_message : ''}`)
}

export async function POST(req: NextRequest) {
  const googleKey = process.env.GOOGLE_MAPS_API_KEY
  if (!googleKey) return NextResponse.json({ error: 'GOOGLE_MAPS_API_KEY not set' }, { status: 500 })

  let sb: ReturnType<typeof adminClient>
  try { sb = adminClient() } catch (e: any) {
    return NextResponse.json({ error: e.message }, { status: 500 })
  }

  const body = await req.json().catch(() => ({})) as { limit?: number; dryRun?: boolean }
  const limit = body.limit ?? null
  const dryRun = body.dryRun ?? false

  // Fetch clients without coordinates
  const candidates: { id: string; business_name: string; address: string | null }[] = []
  let from = 0
  while (true) {
    const { data, error } = await sb!
      .from('clients')
      .select('id, business_name, address')
      .is('lat', null)
      .order('business_name')
      .range(from, from + 999)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    candidates.push(...data)
    if (data.length < 1000) break
    from += 1000
  }

  const queue = limit ? candidates.slice(0, limit) : candidates
  const results: { id: string; name: string; status: string; lat?: number; lng?: number }[] = []

  for (const c of queue) {
    const query = [c.business_name, c.address, 'Tiranë Albania'].filter(Boolean).join(' ')
    try {
      const geo = await geocodeOne(query, googleKey)
      if (!geo) {
        results.push({ id: c.id, name: c.business_name, status: 'not_found' })
      } else if (!inTirana(geo.lat, geo.lng)) {
        results.push({ id: c.id, name: c.business_name, status: 'out_of_bounds', lat: geo.lat, lng: geo.lng })
      } else if (!dryRun) {
        const { error } = await sb!.from('clients')
          .update({ lat: geo.lat, lng: geo.lng, updated_at: new Date().toISOString() })
          .eq('id', c.id)
        results.push({ id: c.id, name: c.business_name, status: error ? 'error' : 'ok', lat: geo.lat, lng: geo.lng })
      } else {
        results.push({ id: c.id, name: c.business_name, status: 'dry_run', lat: geo.lat, lng: geo.lng })
      }
    } catch (e: any) {
      results.push({ id: c.id, name: c.business_name, status: 'error' })
      if (/OVER_QUERY_LIMIT|REQUEST_DENIED/.test(e.message)) break
    }
    // 100ms rate limit between requests
    await new Promise(r => setTimeout(r, 100))
  }

  const counts = results.reduce(
    (acc, r) => { acc[r.status] = (acc[r.status] ?? 0) + 1; return acc },
    {} as Record<string, number>
  )
  return NextResponse.json({ total: queue.length, counts, results })
}
