/**
 * geocode.js — Geocode clients without coordinates using Google Maps Geocoding API.
 *
 * Setup:
 *   npm install   (uses @supabase/supabase-js + dotenv from package.json)
 *
 * .env requires:
 *   SUPABASE_URL=https://...supabase.co
 *   SUPABASE_SERVICE_KEY=<service_role_key>
 *   GOOGLE_MAPS_API_KEY=<your Google Maps API key with Geocoding enabled>
 *
 * Run:
 *   node geocode.js                  # geocode all clients where lat IS NULL
 *   node geocode.js --dry-run        # preview without writing to Supabase
 *   node geocode.js --limit 20       # process only the first N candidates
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const TIRANA_BOUNDS = { minLat: 41.28, maxLat: 41.38, minLng: 19.75, maxLng: 19.95 };
const RATE_LIMIT_MS = 100;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitIdx = args.indexOf('--limit');
const LIMIT = limitIdx >= 0 ? parseInt(args[limitIdx + 1], 10) : null;

function fail(msg) { console.error(`\nERROR: ${msg}`); process.exit(1); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function inTirana(lat, lng) {
  return lat >= TIRANA_BOUNDS.minLat && lat <= TIRANA_BOUNDS.maxLat
      && lng >= TIRANA_BOUNDS.minLng && lng <= TIRANA_BOUNDS.maxLng;
}

async function geocodeOne(query, apiKey) {
  const url = `https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(query)}&key=${apiKey}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = await res.json();
  if (json.status === 'OK' && json.results.length > 0) {
    const r = json.results[0];
    return {
      lat: r.geometry.location.lat,
      lng: r.geometry.location.lng,
      formatted: r.formatted_address,
    };
  }
  if (json.status === 'ZERO_RESULTS') return null;
  // OVER_QUERY_LIMIT, REQUEST_DENIED, INVALID_REQUEST, UNKNOWN_ERROR
  throw new Error(`Geocoder status=${json.status}${json.error_message ? ' — ' + json.error_message : ''}`);
}

async function main() {
  if (!process.env.SUPABASE_URL) fail('SUPABASE_URL missing from .env');
  if (!process.env.SUPABASE_SERVICE_KEY) fail('SUPABASE_SERVICE_KEY missing from .env');
  if (!process.env.GOOGLE_MAPS_API_KEY) fail('GOOGLE_MAPS_API_KEY missing from .env');

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  console.log('Fetching clients without coordinates ...');
  const candidates = [];
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('clients')
      .select('id, business_name, address, zone, lat, lng')
      .is('lat', null)
      .order('business_name')
      .range(from, from + 999);
    if (error) fail(`Failed to fetch: ${error.message}`);
    candidates.push(...data);
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  ${candidates.length} clients need geocoding.\n`);

  const queue = LIMIT ? candidates.slice(0, LIMIT) : candidates;
  if (LIMIT) console.log(`(--limit ${LIMIT}) Processing first ${queue.length} only.\n`);
  if (DRY_RUN) console.log('(--dry-run) No writes to Supabase.\n');

  let geocoded = 0, outOfBounds = 0, notFound = 0, errors = 0;
  const warnings = [];

  for (let i = 0; i < queue.length; i++) {
    const c = queue[i];
    const parts = [c.business_name, c.address, 'Tiranë Albania'].filter(Boolean);
    const query = parts.join(' ');
    const tag = `[${i + 1}/${queue.length}] ${c.business_name}`;

    try {
      const result = await geocodeOne(query, process.env.GOOGLE_MAPS_API_KEY);
      if (!result) {
        notFound++;
        warnings.push(`${tag} — ZERO_RESULTS`);
        process.stdout.write(`  ${tag}: not found\n`);
      } else if (!inTirana(result.lat, result.lng)) {
        outOfBounds++;
        warnings.push(`${tag} — outside Tirana (${result.lat.toFixed(4)}, ${result.lng.toFixed(4)}) — ${result.formatted}`);
        process.stdout.write(`  ${tag}: outside bounds (${result.lat.toFixed(4)}, ${result.lng.toFixed(4)})\n`);
      } else {
        if (!DRY_RUN) {
          const { error } = await sb
            .from('clients')
            .update({ lat: result.lat, lng: result.lng, updated_at: new Date().toISOString() })
            .eq('id', c.id);
          if (error) {
            errors++;
            warnings.push(`${tag} — UPDATE failed: ${error.message}`);
            process.stdout.write(`  ${tag}: UPDATE failed — ${error.message}\n`);
          } else {
            geocoded++;
            process.stdout.write(`  ${tag}: ${result.lat.toFixed(5)}, ${result.lng.toFixed(5)}\n`);
          }
        } else {
          geocoded++;
          process.stdout.write(`  ${tag}: ${result.lat.toFixed(5)}, ${result.lng.toFixed(5)} (dry-run)\n`);
        }
      }
    } catch (e) {
      errors++;
      warnings.push(`${tag} — ${e.message}`);
      process.stdout.write(`  ${tag}: ERROR — ${e.message}\n`);
      // If we hit OVER_QUERY_LIMIT or REQUEST_DENIED, abort early — keep retrying is wasteful
      if (/OVER_QUERY_LIMIT|REQUEST_DENIED|INVALID_REQUEST/.test(e.message)) {
        console.error('\nFatal API error — aborting.');
        break;
      }
    }

    if (i < queue.length - 1) await sleep(RATE_LIMIT_MS);
  }

  console.log('\n=== Summary ===');
  console.log(`  Candidates processed:  ${queue.length}`);
  console.log(`  Geocoded:              ${geocoded}${DRY_RUN ? ' (dry-run, not written)' : ''}`);
  console.log(`  Outside Tirana bbox:   ${outOfBounds}`);
  console.log(`  Not found:             ${notFound}`);
  console.log(`  Errors:                ${errors}`);

  if (warnings.length > 0) {
    console.log('\n=== Warnings / Skipped ===');
    warnings.forEach(w => console.log(`  ${w}`));
  }
}

main().catch(e => { console.error('Unexpected error:', e); process.exit(1); });
