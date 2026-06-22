# Tereni — Magazina Virtuale Field Sales CRM

CRM mobile-first për punën në terren në Tiranë. Backend: Supabase. Frontend: një file i vetëm HTML pa build step.

## Files

- `mv-crm.html` — frontend, hapet direkt në browser ose servohet si static
- `ingest.js` — Node script për të ngarkuar prospekte nga CSV në Supabase
- `bizneset_te_plota.csv` — lista e bizneseve nga PDF e terenit (~292 rresht)
- `package.json` — varësitë për `ingest.js`
- `.env.example` — formati i `.env` (kopjo në `.env` dhe plotëso çelësat)

## Frontend

`mv-crm.html` përdor:
- Supabase JS via CDN (anon key inline)
- Leaflet + OpenStreetMap (dark theme via CartoDB)
- Inter font nga Google Fonts

Hape lokalisht me një static server:

```sh
python3 -m http.server 8765
# pastaj hap http://localhost:8765/mv-crm.html
```

Ose hidhe drag-and-drop në Vercel / Netlify Drop për akses publik.

### Pamjet
- **Harta** — pinë me ngjyrë sipas statusit, vetëm bizneset me `lat+lng`
- **Lista** — të gjitha bizneset; ikona 📍 hap `maps_url`
- **Side panel** — detajet e plota me fusha të editueshme (status, telefon, kontakti, shënime, ndjekje, vlera)

### Statuset
- `prospect` (Prospekt) — gri
- `active` (Aktiv) — jeshil
- `inactive` (Joaktiv) — kuq
- `lead` (Lead) — blu
- `declined` (Refuzuar) — portokalli

Statuset e vjetra (`No contact`, `App downloaded`, etj.) shfaqen po ashtu për të dhënat ekzistuese.

## Ingest

```sh
npm install
cp .env.example .env
# plotëso .env me SUPABASE_URL dhe SUPABASE_SERVICE_KEY

node ingest.js --dry-run   # preview pa shkruar
node ingest.js             # shkruaj në Supabase
```

Logjika:
1. Lexon `bizneset_te_plota.csv`
2. Heq duplikatet (case-insensitive vs DB)
3. Heq rreshtat pa adresë
4. Insertion në batch të 100, çdo prospekt me `status='prospect'`, `zone='Z4'`, `source='field_pdf_import'`

## Skema e tabelës `clients`

```
id (uuid) | business_name | status | business_type | zone | address
lat | lng | phone | contact_person | general_notes | next_followup
decline_reason | order_value | source | maps_url | created_at | updated_at
```

## Workflow tipik

1. `node ingest.js` — ngarko bizneset e reja nga CSV
2. Hap `mv-crm.html` në telefon
3. Për çdo prospekt, kliko 📍 në kartë → hap Google Maps, gjej pinin e duhur
4. Kopjo `lat,lng` nga URL e Maps
5. Hap kartën në app → ngjit koordinatat në side panel → ruaj
6. Biznesi shfaqet automatikisht në hartë
