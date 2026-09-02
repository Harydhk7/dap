# AmbuMap — Ambulance baseline

Visualization of ambulance positions across Haryana with State / District / Day / Time-period filters.

This is the **ambulance-only baseline** for the AmbuMap project. Hospital ingestion,
level classification (L1 / L2 / L3 from TPL audit), 50&nbsp;km routing, and the
injury-aware DIRECT vs STABILIZE-THEN-TRANSFER recommendation engine are
**features to build on top of this baseline**.

## Stack

- **Frontend:** React 18 + Vite + react-leaflet + Leaflet + OSM tiles
- **Backend:** Flask + SQLAlchemy + GeoAlchemy2
- **Database:** PostgreSQL 15 + PostGIS

## Quick start

```bash
# 1. Postgres (PostGIS extension is required)
docker-compose up -d postgres

# 2. Backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Optional: fetch a Haryana districts GeoJSON for the boundary overlay
curl -L -o data/haryana_districts.geojson \
  https://raw.githubusercontent.com/datameet/maps/master/States/Haryana/Haryana_District.geojson

python seed.py     # creates schema, loads 142 ambulances + district outlines
python app.py      # Flask on :5001

# 3. Frontend (new terminal)
cd frontend
npm install
npm run dev        # Vite on :5173
```

Open http://localhost:5173 — you should see 142 red dots scattered across Haryana,
filter dropdowns on the left, and live filter counts.

## Docker quick start

Run the full stack with Docker Compose:

```bash
docker compose up --build
```

Then open:

- Frontend: http://localhost:3000
- Backend: http://localhost:5001/api/health
- Postgres: localhost:5432

The backend container seeds the database on startup, so the first boot may take a
little longer than a normal restart.

## API endpoints

| Method | Endpoint | Purpose |
|---|---|---|
| GET  | `/api/health`              | health check |
| GET  | `/api/filters/options`     | distinct values for state / district / day / time dropdowns |
| GET  | `/api/districts?state=Haryana` | GeoJSON of district polygons |
| GET  | `/api/ambulances?state=&district=&day=&time_period=` | filtered list (GeoJSON FeatureCollection) |
| GET  | `/api/ambulances/<id>`     | single ambulance |
| POST | `/api/upload/ambulances`   | multipart `.xlsx` upload |

## Excel format (ambulance dataset)

Required columns, exact spelling:

```
Uniqueid | Day | Timeperiod | Country | State | District | City | Postal Code | Latitude | Longitude | Address
```

The sample file `backend/data/ambulances_haryana.xlsx` (142 rows across 20 Haryana districts)
is preloaded by `seed.py`.

## What to build next (suggested order)

1. **Hospital ingestion**
   - New `hospitals` table with PostGIS geography column
   - `parse_hospitals()` in `services/excel_parser.py`
   - `POST /api/upload/hospitals`, `GET /api/hospitals`, `GET /api/hospitals/<id>`

2. **Level classification**
   - Lookup: `MCH`, `SSH`, `PRIVATE` → L1 (Tertiary)
   - `DCH`, `SDH`, `CHC` → L2 (Secondary)
   - `PHC`, `UPHC`, `UHC` → L3 (Primary)
   - Display TPL preparedness score per the matching level

3. **Hospital icons by level on the map**
   - L1: red shield + cross
   - L2: amber square + cross
   - L3: blue circle + cross

4. **Routing within 50&nbsp;km**
   - PostGIS `ST_DWithin` to filter hospitals near a selected ambulance
   - OSRM `/route/v1/driving` for road distance + path geometry
   - Compute travel time as `distance / 60 km/h` (project spec, not OSRM's own duration)
   - Render polylines on the map

5. **Smart recommendation engine**
   - Per-injury required level + safe time window:
     - TBI / Polytrauma / Spinal / Burns / Cardiac / Pediatric → L1, 10-min window
     - Thoracic / Abdominal → L2, 20-min window
     - Orthopedic → L2-L3, 30-min window
     - Minor → L3, 45-min window
   - Composite scoring: `TPL × (1 - travel_time / max_time)`
   - DIRECT route if best-required-level is reachable within window
   - CHAIN route (stabilize-then-transfer) if not — find a faster lower-tier hospital
     for stabilization, then plan transfer to the required-level hospital

The full reference implementation (with all of the above) is available separately as
`ambumap-haryana.zip` and deployed at https://ambumap-haryana.vercel.app for reference.

## Project structure

```
ambumap-ambulance-only/
├── backend/
│   ├── app.py                  # Flask app + ambulance API routes
│   ├── seed.py                 # DB schema + initial data load
│   ├── requirements.txt
│   ├── services/
│   │   └── excel_parser.py     # parse_ambulances()
│   ├── data/
│   │   └── ambulances_haryana.xlsx
│   ├── Procfile                # for Render / Heroku-style deploys
│   └── render.yaml             # Render Blueprint
├── frontend/
│   ├── src/
│   │   ├── App.jsx
│   │   ├── main.jsx
│   │   ├── styles.css
│   │   ├── api/client.js
│   │   └── components/
│   │       ├── MapView.jsx
│   │       ├── Sidebar.jsx
│   │       └── UploadModal.jsx
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── docker-compose.yml
├── .env.example
└── README.md
```

## Deployment

See `DEPLOYMENT.md` for the Render (backend + Postgres) + Vercel (frontend) recipe.
The same deploy flow works for this ambulance-only baseline.

## License

Internal — IIT Madras Dual Degree Project.
