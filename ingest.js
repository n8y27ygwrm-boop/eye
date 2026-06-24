/**
 * ingest.js - Bulk import field-PDF businesses into Supabase clients table.
 *
 * Setup:
 *   npm install @supabase/supabase-js dotenv csv-parse
 *
 * Create a .env file in the same directory:
 *   SUPABASE_URL=https://your-project.supabase.co
 *   SUPABASE_SERVICE_KEY=<your service role key>
 *
 * Run:
 *   node ingest.js                          # reads ./bizneset_te_plota.csv
 *   node ingest.js path/to/other.csv        # explicit path
 *   node ingest.js --dry-run                # preview without inserting
 */

require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const { readFileSync, existsSync } = require('fs');
const { parse } = require('csv-parse/sync');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const CSV_PATH = args.find(a => !a.startsWith('--')) || 'bizneset_te_plota.csv';
const BATCH_SIZE = 100;

function fail(msg) { console.error(`\nERROR: ${msg}`); process.exit(1); }
function pad(s, n) { return String(s).padStart(n, ' '); }

async function main() {
  if (!process.env.SUPABASE_URL) fail('SUPABASE_URL missing from .env');
  if (!process.env.SUPABASE_SERVICE_KEY) fail('SUPABASE_SERVICE_KEY missing from .env');
  if (!existsSync(CSV_PATH)) fail(`CSV file not found: ${CSV_PATH}`);

  const sb = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );

  console.log(`Reading ${CSV_PATH} ...`);
  const csvText = readFileSync(CSV_PATH, 'utf-8');
  const rows = parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
    relax_column_count: true,
  });
  console.log(`  Parsed ${rows.length} rows.\n`);

  console.log('Fetching existing business_name values from Supabase ...');
  // Page through all rows in case there are >1000
  const existingNames = new Set();
  let from = 0;
  while (true) {
    const { data, error } = await sb
      .from('clients')
      .select('business_name')
      .range(from, from + 999);
    if (error) fail(`Failed to fetch existing clients: ${error.message}`);
    data.forEach(r => existingNames.add((r.business_name || '').trim().toLowerCase()));
    if (data.length < 1000) break;
    from += 1000;
  }
  console.log(`  ${existingNames.size} unique names already in clients.\n`);

  const toInsert = [];
  let dupSkipped = 0;
  let noAddrSkipped = 0;
  let noNameSkipped = 0;

  for (const row of rows) {
    const name = (row['Emri Biznesit'] || '').trim();
    const address = (row['Adresa Pershkrim'] || '').trim();
    const mapsUrl = (row['Google Maps Search Link'] || '').trim();

    if (!name) { noNameSkipped++; continue; }
    if (!address) { noAddrSkipped++; continue; }

    const lc = name.toLowerCase();
    if (existingNames.has(lc)) { dupSkipped++; continue; }

    const payload = {
      business_name: name,
      address,
      status: 'prospect',
      zone: 'Z4',
      source: 'field_pdf_import',
    };
    if (mapsUrl) payload.maps_url = mapsUrl;

    toInsert.push(payload);
    existingNames.add(lc); // prevent duplicates inside the CSV itself
  }

  console.log(`Plan: ${toInsert.length} new records to insert.`);
  console.log(`  Skip (duplicate name): ${dupSkipped}`);
  console.log(`  Skip (no address):     ${noAddrSkipped}`);
  console.log(`  Skip (no name):        ${noNameSkipped}\n`);

  if (DRY_RUN) {
    console.log('(--dry-run) Showing first 5 payloads, then exiting:');
    toInsert.slice(0, 5).forEach((p, i) => console.log(`  [${i + 1}]`, p));
    return;
  }

  let inserted = 0;
  for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
    const batch = toInsert.slice(i, i + BATCH_SIZE);
    const { error } = await sb.from('clients').insert(batch);
    if (error) {
      console.error(`\nBatch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${error.message}`);
      console.error('First payload in failing batch:', JSON.stringify(batch[0]));
      fail('Aborting on insert error');
    }
    inserted += batch.length;
    process.stdout.write(`  Inserted ${inserted}/${toInsert.length}\r`);
  }
  if (toInsert.length > 0) process.stdout.write('\n');

  console.log('\n=== Summary ===');
  console.log(`  CSV rows parsed:        ${pad(rows.length, 5)}`);
  console.log(`  Inserted:               ${pad(inserted, 5)}`);
  console.log(`  Skipped (duplicate):    ${pad(dupSkipped, 5)}`);
  console.log(`  Skipped (no address):   ${pad(noAddrSkipped, 5)}`);
  console.log(`  Skipped (no name):      ${pad(noNameSkipped, 5)}`);
}

main().catch(e => { console.error('Unexpected error:', e); process.exit(1); });
