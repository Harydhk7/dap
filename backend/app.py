"""
Flask application — AmbuMap (Ambulance-only baseline).

Endpoints:
    GET  /api/health
    GET  /api/filters/options   - distinct filter values (state, district, day, time_period)
    GET  /api/districts         - GeoJSON of districts (boundary overlay)
    GET  /api/ambulances        - filtered ambulance list as GeoJSON
    GET  /api/ambulances/<id>   - single ambulance
    POST /api/upload/ambulances - multipart .xlsx

NOTE FOR THE SOFTWARE TEAM:
This is the ambulance-only baseline. The full version also includes:
  - Hospital ingestion + level classification (L1 / L2 / L3 from TPL audit)
  - Smart routing: per-injury required level, safe-window decision,
    DIRECT vs STABILIZE-THEN-TRANSFER chain
  - OSRM driving routes with @60 km/h time estimates
You will be adding these on top of this baseline.
"""

import json
import os
import re
from io import BytesIO
from urllib.parse import urlsplit, urlunsplit

from dotenv import load_dotenv
from flask import Flask, jsonify, request, send_file
from flask_cors import CORS
from sqlalchemy import bindparam, create_engine, text
from sqlalchemy.orm import sessionmaker
from openpyxl import Workbook

from services.excel_parser import parse_ambulances, ExcelValidationError

load_dotenv()

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+psycopg2://ambumap:ambumap@localhost:5432/ambumap"
)
CORS_ORIGINS = [origin.strip() for origin in os.environ.get("CORS_ORIGINS", "*").split(",") if origin.strip()]
FLASK_PORT = int(os.environ.get("PORT") or os.environ.get("FLASK_PORT", 5001))


def _resolve_database_url(url):
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg2://", 1)

    parsed = urlsplit(url)
    if parsed.hostname == "db" and not os.path.exists("/.dockerenv"):
        netloc = parsed.netloc.replace("db", "localhost", 1)
        url = urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))

    return url

# Render injects DATABASE_URL with postgres:// prefix; SQLAlchemy needs postgresql+psycopg2://
DATABASE_URL = _resolve_database_url(DATABASE_URL)

engine = create_engine(DATABASE_URL, pool_pre_ping=True)
SessionLocal = sessionmaker(bind=engine)

app = Flask(__name__)
CORS(app, origins="*" if CORS_ORIGINS == ["*"] else CORS_ORIGINS)

def _normalise_level_code(required_level):
    return f"L{int(required_level)}"


def _injury_by_key(key):
    injuries = _load_patient_injuries()
    if not key:
        return injuries[0]
    for injury in injuries:
        if injury["key"] == key:
            return injury
    return injuries[0]


def _level_order(level_code):
    try:
        return int(str(level_code).replace("L", ""))
    except (TypeError, ValueError):
        return 99


def _format_minutes(distance_km):
    try:
        return round(float(distance_km), 1)
    except (TypeError, ValueError):
        return None


def _level_summary(feature):
    props = feature["properties"]
    level_code = props.get("level_code")
    if level_code == "L1":
        tpl_score = props.get("avg_tertiary")
        tpl_breakdown = {
            "equipment": props.get("e_tertiary"),
            "infrastructure": props.get("i_tertiary"),
            "beds": props.get("b_tertiary"),
            "services": props.get("s_tertiary"),
        }
    elif level_code == "L2":
        tpl_score = props.get("avg_secondary")
        tpl_breakdown = {
            "equipment": props.get("e_secondary"),
            "infrastructure": props.get("i_secondary"),
            "beds": props.get("b_secondary"),
            "services": props.get("s_secondary"),
        }
    else:
        tpl_score = props.get("avg_primary")
        tpl_breakdown = {
            "equipment": props.get("e_primary"),
            "infrastructure": props.get("i_primary"),
            "beds": props.get("b_primary"),
            "services": props.get("s_primary"),
        }

    road_km = props.get("distance_km")
    time_min = props.get("estimated_minutes")
    return {
        "hospital_id": props.get("hospital_id"),
        "name": props.get("hospital_name"),
        "district": props.get("district"),
        "hospital_type": props.get("hospital_type"),
        "level": int(str(level_code).replace("L", "")) if level_code else None,
        "level_code": level_code,
        "level_label": props.get("level_label"),
        "longitude": feature["geometry"]["coordinates"][0],
        "latitude": feature["geometry"]["coordinates"][1],
        "road_km": _distance_km(road_km),
        "time_min": _format_minutes(time_min if time_min is not None else road_km),
        "tpl_score": round(float(tpl_score or 0), 3),
        "tpl_breakdown": {key: round(float(value or 0), 3) for key, value in tpl_breakdown.items()},
        "composite_score": round(float(tpl_score or 0), 3),
        "distance_km": _distance_km(road_km),
    }


def _fetch_nearby_hospital_features(conn, latitude, longitude, radius_km):
    rows = conn.execute(text("""
        SELECT hospital_id, record_id, state, district, hospital_name, pincode,
               hospital_type, level_code, level_label, latitude, longitude,
               creation_date, date_submission,
               avg_primary, avg_secondary, avg_tertiary,
               e_primary, e_secondary, e_tertiary,
               i_primary, i_secondary, i_tertiary,
               b_primary, b_secondary, b_tertiary,
               s_primary, s_secondary, s_tertiary,
               ST_Distance(geom, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography) / 1000.0 AS distance_km
        FROM hospitals
        WHERE ST_DWithin(
            geom,
            ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography,
            :radius_meters
        )
        ORDER BY distance_km, hospital_name
    """), {
        "lon": longitude,
        "lat": latitude,
        "radius_meters": radius_km * 1000,
    }).fetchall()

    features = []
    for row in rows:
        feature = _hospital_to_feature(row._mapping)
        feature["properties"]["distance_km"] = _distance_km(row._mapping.get("distance_km"))
        feature["properties"]["estimated_minutes"] = _format_minutes(row._mapping.get("distance_km"))
        features.append(feature)
    return features


def _top_hospital_by_level(features):
    by_level = {}
    for feature in features:
      level_code = feature["properties"].get("level_code")
      if level_code not in ("L1", "L2", "L3"):
          continue
      current = by_level.get(level_code)
      if not current:
          by_level[level_code] = feature
          continue
      current_distance = current["properties"].get("distance_km") or 9999
      next_distance = feature["properties"].get("distance_km") or 9999
      if next_distance < current_distance:
          by_level[level_code] = feature
    return by_level


def _build_recommendation(features, injury):
    top_by_level = _top_hospital_by_level(features)
    required_level_code = _normalise_level_code(injury["required_level"])
    required_hospital = top_by_level.get(required_level_code)
    safe_window_min = injury["safe_window_min"]

    recommended_level_code = required_level_code
    decision = {
        "kind": "direct",
        "title": "DIRECT — WITHIN SAFE WINDOW",
        "message": "No suitable hospital could be evaluated for this injury.",
        "recommended_level_code": recommended_level_code,
    }

    if required_hospital:
        required_distance = required_hospital["properties"].get("estimated_minutes")
        required_distance_value = required_distance if required_distance is not None else 9999
        if required_distance_value <= safe_window_min:
            decision = {
                "kind": "direct_within_window",
                "title": "DIRECT — WITHIN SAFE WINDOW",
                "message": f"{required_hospital['properties']['hospital_name']} ({required_level_code}) is {required_distance_value:.1f} min away — within the {safe_window_min}-min safe window for {injury['label']}.",
                "recommended_level_code": required_level_code,
            }
        else:
            lower_levels = [code for code in ("L2", "L3") if _level_order(code) > _level_order(required_level_code)]
            stabilization_candidates = [top_by_level.get(code) for code in lower_levels if top_by_level.get(code)]
            stabilization_candidate = None
            if stabilization_candidates:
                stabilization_candidate = min(
                    stabilization_candidates,
                    key=lambda item: item["properties"].get("estimated_minutes") or 9999,
                )

            if stabilization_candidate and (stabilization_candidate["properties"].get("estimated_minutes") or 9999) < required_distance_value:
                recommended_level_code = stabilization_candidate["properties"].get("level_code", required_level_code)
                decision = {
                    "kind": "stabilize_then_transfer",
                    "title": f"STABILIZE — USE {stabilization_candidate['properties']['hospital_name']}",
                    "message": f"{required_hospital['properties']['hospital_name']} ({required_level_code}) is {required_distance_value:.1f} min away — outside the {safe_window_min}-min safe window for {injury['label']}. {stabilization_candidate['properties']['hospital_name']} ({stabilization_candidate['properties']['level_code']}) is faster at {(stabilization_candidate['properties'].get('estimated_minutes') or 0):.1f} min, so stabilize there and transfer onward.",
                    "recommended_level_code": recommended_level_code,
                }
            else:
                decision = {
                    "kind": "direct_outside_window",
                    "title": "DIRECT — OUTSIDE SAFE WINDOW",
                    "message": f"{required_hospital['properties']['hospital_name']} ({required_level_code}) is {required_distance_value:.1f} min away — OUTSIDE the {safe_window_min}-min safe window for {injury['label']}, but no faster lower-tier hospital is available for stabilization. Proceed directly with urgent pre-alert and aeromedical request.",
                    "recommended_level_code": required_level_code,
                }

    return {
        "injury": injury,
        "required_level_code": required_level_code,
        "safe_window_min": safe_window_min,
        "decision": decision,
        "top_hospitals": [
            top_by_level[level_code]
            for level_code in ("L1", "L2", "L3")
            if top_by_level.get(level_code)
        ],
    }


def _build_recommend_hospitals_payload(ambulance_id, injury_key, radius_km=50.0):
    injury = _injury_by_key(injury_key)

    with engine.connect() as conn:
        ambulance = conn.execute(
            text("SELECT latitude, longitude FROM ambulances WHERE unique_id = :uid"),
            {"uid": ambulance_id}
        ).fetchone()
        if not ambulance:
            return None, ({"error": "ambulance not found"}, 404)

        features = _fetch_nearby_hospital_features(conn, ambulance.latitude, ambulance.longitude, radius_km)

    recommendation = _build_recommendation(features, injury)
    top_hospitals = []
    by_level = {}

    for feature in recommendation["top_hospitals"]:
        summary = _level_summary(feature)
        summary["is_recommended"] = summary["level_code"] == recommendation["decision"]["recommended_level_code"]
        feature["properties"].update(summary)
        feature["properties"]["is_recommended"] = summary["is_recommended"]
        top_hospitals.append(feature)
        by_level[summary["level_code"]] = summary

    stabilize_at = None
    transfer_to = None
    if recommendation["decision"]["kind"] == "stabilize_then_transfer":
        stabilize_level_code = recommendation["decision"]["recommended_level_code"]
        stabilize_at = by_level.get(stabilize_level_code)
        transfer_to = by_level.get(recommendation["required_level_code"])
    else:
        transfer_to = by_level.get(recommendation["required_level_code"])

    payload = {
        "ambulance": {
            "unique_id": ambulance_id,
            "latitude": ambulance.latitude,
            "longitude": ambulance.longitude,
        },
        "radius_km": float(radius_km),
        "injury": injury,
        "decision": recommendation["decision"],
        "required_level_code": recommendation["required_level_code"],
        "safe_window_min": recommendation["safe_window_min"],
        "top_hospitals": top_hospitals,
        "by_level": by_level,
        "recommendation": {
            "injury_label": injury["label"],
            "injury_type": injury["key"],
            "mode": "CHAIN" if recommendation["decision"]["kind"] == "stabilize_then_transfer" else "DIRECT",
            "reasoning": recommendation["decision"]["message"],
            "required_level": injury["required_level"],
            "safe_window_min": injury["safe_window_min"],
            "stabilize_at": stabilize_at,
            "transfer_to": transfer_to,
        },
    }
    return payload, None

PATIENT_INJURIES_PATH = os.path.join(os.path.dirname(__file__), "data", "patient_injuries.json")
DEFAULT_PATIENT_INJURIES = [
    {"key": "tbi", "label": "TBI / Head injury", "required_level": 1, "safe_window_min": 10},
    {"key": "polytrauma", "label": "Polytrauma", "required_level": 1, "safe_window_min": 10},
    {"key": "spinal", "label": "Spinal injury", "required_level": 1, "safe_window_min": 10},
    {"key": "burns_major", "label": "Major burns", "required_level": 1, "safe_window_min": 10},
    {"key": "cardiac", "label": "Cardiac arrest", "required_level": 1, "safe_window_min": 10},
    {"key": "pediatric_trauma", "label": "Pediatric trauma", "required_level": 1, "safe_window_min": 10},
    {"key": "thoracic", "label": "Thoracic injury", "required_level": 2, "safe_window_min": 20},
    {"key": "abdominal", "label": "Abdominal injury", "required_level": 2, "safe_window_min": 20},
    {"key": "orthopedic", "label": "Orthopedic / Fractures", "required_level": 2, "safe_window_min": 30},
    {"key": "minor", "label": "Minor / Observation", "required_level": 3, "safe_window_min": 45},
]


# ───────────────────────────────────────────── helpers ──────────

def _geojson_feature_point(lon, lat, props):
    return {
        "type": "Feature",
        "geometry": {"type": "Point", "coordinates": [lon, lat]},
        "properties": props,
    }


def _ambulance_to_feature(row):
    props = {k: row[k] for k in row.keys() if k not in ("longitude", "latitude")}
    return _geojson_feature_point(row["longitude"], row["latitude"], props)


def _hotspot_to_feature(row):
    props = dict(row)
    geometry = json.loads(props.pop("geometry"))
    return {
        "type": "Feature",
        "geometry": geometry,
        "properties": props,
    }


def _hospital_to_feature(row):
    props = dict(row)
    lon = props.pop("longitude")
    lat = props.pop("latitude")
    return _geojson_feature_point(lon, lat, props)


def _multi_query_values(name):
    values = request.args.getlist(name)
    if not values:
        raw = request.args.get(name)
        if raw:
            values = [part.strip() for part in raw.split(",")]
    return [value for value in values if value and value.lower() != "all"]


def _distance_km(value):
    try:
        return float(value) if value is not None else None
    except (TypeError, ValueError):
        return None


def _ambulance_columns():
    return [
        ("unique_id", "Unique ID"),
        ("day", "Day"),
        ("time_period", "Time Period"),
        ("country", "Country"),
        ("state", "State"),
        ("district", "District"),
        ("city", "City"),
        ("postal_code", "Postal Code"),
        ("latitude", "Latitude"),
        ("longitude", "Longitude"),
        ("address", "Address"),
    ]


def _ambulance_filter_clauses(params):
    state = request.args.get("state")
    districts = _multi_query_values("district")
    days = _multi_query_values("day")
    time_periods = _multi_query_values("time_period")

    clauses = []
    if state and state.lower() != "all":
        clauses.append("state ILIKE :state")
        params["state"] = state
    if districts:
        clauses.append("district IN :districts")
        params["districts"] = districts
    if days:
        clauses.append("day IN :days")
        params["days"] = days
    if time_periods:
        clauses.append("time_period IN :time_periods")
        params["time_periods"] = time_periods
    return clauses


def _fetch_filtered_ambulances():
    params = {}
    clauses = _ambulance_filter_clauses(params)
    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    sql = text(f"""
        SELECT unique_id, day, time_period, country, state, district, city,
               postal_code, latitude, longitude, address
        FROM ambulances
        {where}
        ORDER BY unique_id
    """)
    if params.get("districts"):
        sql = sql.bindparams(bindparam("districts", expanding=True))
    if params.get("days"):
        sql = sql.bindparams(bindparam("days", expanding=True))
    if params.get("time_periods"):
        sql = sql.bindparams(bindparam("time_periods", expanding=True))

    with engine.connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return rows


def _workbook_response(workbook, filename):
    buffer = BytesIO()
    workbook.save(buffer)
    buffer.seek(0)
    return send_file(
        buffer,
        as_attachment=True,
        download_name=filename,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


def _load_patient_injuries():
    try:
                with open(PATIENT_INJURIES_PATH, "r", encoding="utf-8") as handle:
                        payload = json.load(handle)
                return payload if isinstance(payload, list) else DEFAULT_PATIENT_INJURIES
    except (FileNotFoundError, json.JSONDecodeError):
                return DEFAULT_PATIENT_INJURIES


def _build_upload_template_workbook():
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = "Sample Upload"
    headers = [column for column, _ in _ambulance_columns()]
    worksheet.append(headers)
    worksheet.append([
        1101, "Monday", "12AM - 3AM", "India", "Haryana", "Hisar", "Hisar City",
        "125001", 29.1492, 75.7217, "Sample ambulance location"
    ])
    worksheet.freeze_panes = "A2"
    return workbook


def _build_filtered_ambulance_export_workbook():
    workbook = Workbook()
    filters_ws = workbook.active
    filters_ws.title = "Applied Filters"
    filters_ws.append(["Filter", "Value"])
    filters_ws.append(["State", request.args.get("state", "All")])
    filters_ws.append(["Districts", ", ".join(_multi_query_values("district")) or "All"])
    filters_ws.append(["Days", ", ".join(_multi_query_values("day")) or "All"])
    filters_ws.append(["Time Periods", ", ".join(_multi_query_values("time_period")) or "All"])

    data_ws = workbook.create_sheet("Ambulances")
    headers = [label for _, label in _ambulance_columns()]
    data_ws.append(headers)

    for row in _fetch_filtered_ambulances():
        mapping = row._mapping
        data_ws.append([mapping[column] for column, _ in _ambulance_columns()])

    filters_ws.freeze_panes = "A2"
    data_ws.freeze_panes = "A2"
    return workbook


# ───────────────────────────────────────────── routes ──────────

@app.get("/api/health")
def health():
    return {"status": "ok"}


@app.get("/api/patient-injuries")
def patient_injuries():
    return jsonify(_load_patient_injuries())


@app.get("/api/recommend-hospitals")
def recommend_hospitals():
    ambulance_id = request.args.get("ambulance_id", type=int)
    if not ambulance_id:
        return {"error": "ambulance_id is required"}, 400
    injury_key = request.args.get("injury_type") or request.args.get("injury_key")
    radius_km = request.args.get("radius_km", default=50, type=float) or 50.0

    payload, error = _build_recommend_hospitals_payload(ambulance_id, injury_key, radius_km)
    if error:
        return error
    return jsonify(payload)


@app.get("/api/upload/template")
def upload_template():
    return _workbook_response(_build_upload_template_workbook(), "ambulance-upload-template.xlsx")


@app.get("/api/ambulances/export")
def export_ambulances():
    return _workbook_response(_build_filtered_ambulance_export_workbook(), "filtered-ambulances.xlsx")


@app.route("/api/ambulances/<int:ambulance_id>/recommendation", methods=["GET", "POST"])
def ambulance_recommendation(ambulance_id):
    injury_key = request.args.get("injury_key")
    if request.method == "POST":
        payload = request.get_json(silent=True) or {}
        injury_key = injury_key or payload.get("injury_key")
    radius_km = request.args.get("radius_km", default=50, type=float) or 50.0

    payload, error = _build_recommend_hospitals_payload(ambulance_id, injury_key, radius_km)
    if error:
        return error
    return jsonify(payload)


@app.get("/api/filters/options")
def filter_options():
    """Distinct values for the filter dropdowns."""
    def _sort_time_period(value):
        text_value = str(value or "").strip().upper()
        match = text_value.split("-")[0].strip()
        token = re.match(r"^(\d{1,2})\s*(AM|PM)$", match)
        if not token:
            return 999
        hour = int(token.group(1)) % 12
        if token.group(2) == "PM":
            hour += 12
        return hour

    state = request.args.get("state")
    state_clause = ""
    params = {}
    if state and state.lower() != "all":
        state_clause = " WHERE state ILIKE :state"
        params["state"] = state

    with engine.connect() as conn:
        states = [r[0] for r in conn.execute(
            text("SELECT DISTINCT state FROM ambulances WHERE state IS NOT NULL ORDER BY state")
        )]
        districts = [r[0] for r in conn.execute(
            text(f"SELECT DISTINCT district FROM ambulances{state_clause} "
                 "AND district IS NOT NULL ORDER BY district" if state_clause
                 else "SELECT DISTINCT district FROM ambulances WHERE district IS NOT NULL ORDER BY district"),
            params,
        )]
        days = [r[0] for r in conn.execute(
            text(f"SELECT DISTINCT day FROM ambulances{state_clause} "
                 "AND day IS NOT NULL ORDER BY day" if state_clause
                 else "SELECT DISTINCT day FROM ambulances WHERE day IS NOT NULL ORDER BY day"),
            params,
        )]
        time_periods = sorted(
            [r[0] for r in conn.execute(
                text(f"SELECT DISTINCT time_period FROM ambulances{state_clause} "
                     "AND time_period IS NOT NULL" if state_clause
                     else "SELECT DISTINCT time_period FROM ambulances WHERE time_period IS NOT NULL"),
                params,
            )],
            key=_sort_time_period,
        )

    return jsonify({
        "states": states,
        "districts": districts,
        "days": days,
        "time_periods": time_periods,
    })


@app.get("/api/districts")
def districts():
    state = request.args.get("state", "Haryana")
    state_filter = ""
    params = {}
    if state and state.lower() != "all":
        state_filter = "WHERE state ILIKE :state"
        params["state"] = state
    with engine.connect() as conn:
        rows = conn.execute(
            text(f"SELECT name, state, ST_AsGeoJSON(geom) AS geom "
                 f"FROM districts {state_filter} ORDER BY state, name"),
            params,
        ).fetchall()

    features = [{
        "type": "Feature",
        "geometry": json.loads(r.geom),
        "properties": {"name": r.name, "state": r.state}
    } for r in rows]
    return jsonify({"type": "FeatureCollection", "features": features})


@app.get("/api/ambulances")
def list_ambulances():
    state = request.args.get("state")
    districts = _multi_query_values("district")
    days = _multi_query_values("day")
    time_periods = _multi_query_values("time_period")

    clauses, params = [], {}
    if state and state.lower() != "all":
        clauses.append("state ILIKE :state"); params["state"] = state
    if districts:
        clauses.append("district IN :districts"); params["districts"] = districts
    if days:
        clauses.append("day IN :days"); params["days"] = days
    if time_periods:
        clauses.append("time_period IN :time_periods"); params["time_periods"] = time_periods

    where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
    sql = text(f"""
        SELECT unique_id, day, time_period, country, state, district, city,
               postal_code, latitude, longitude, address,
               hotspot_id, hotspot_state, hotspot_district,
               hotspot_station, hotspot_final_id
        FROM ambulances
        LEFT JOIN LATERAL (
            SELECT h.hotspot_id, h.state_name AS hotspot_state,
                   h.hotspot_district, h.station AS hotspot_station,
                   h.final_id AS hotspot_final_id
            FROM hotspots h
            WHERE UPPER(h.state_name) = UPPER(ambulances.state)
              AND ST_Intersects(
                  h.geom,
                  ST_SetSRID(ST_MakePoint(ambulances.longitude, ambulances.latitude), 4326)
              )
            ORDER BY h.hotspot_id
            LIMIT 1
        ) matched_hotspot ON TRUE
        {where}
        ORDER BY unique_id
    """)
    if districts:
        sql = sql.bindparams(bindparam("districts", expanding=True))
    if days:
        sql = sql.bindparams(bindparam("days", expanding=True))
    if time_periods:
        sql = sql.bindparams(bindparam("time_periods", expanding=True))
    with engine.connect() as conn:
        rows = conn.execute(sql, params).fetchall()

    features = [_ambulance_to_feature(r._mapping) for r in rows]
    return jsonify({"type": "FeatureCollection", "features": features})


@app.get("/api/hotspots")
def list_hotspots():
    state = request.args.get("state")
    districts = _multi_query_values("district")
    days = _multi_query_values("day")
    time_periods = _multi_query_values("time_period")
    params = {}
    filters = []
    if state and state.lower() != "all":
        filters.append("UPPER(h.state_name) = UPPER(:state)")
        params["state"] = state
    if districts or days or time_periods:
        ambulance_filters = ["UPPER(selected_ambulance.state) = UPPER(h.state_name)"]
        if districts:
            ambulance_filters.append("selected_ambulance.district IN :districts")
            params["districts"] = districts
        if days:
            ambulance_filters.append("selected_ambulance.day IN :days")
            params["days"] = days
        if time_periods:
            ambulance_filters.append("selected_ambulance.time_period IN :time_periods")
            params["time_periods"] = time_periods
        filters.append("""
            EXISTS (
                SELECT 1
                FROM ambulances selected_ambulance
                WHERE {ambulance_conditions}
                  AND ST_Intersects(
                      h.geom,
                      ST_SetSRID(
                          ST_MakePoint(
                              selected_ambulance.longitude,
                              selected_ambulance.latitude
                          ),
                          4326
                      )
                  )
            )
        """.format(
            ambulance_conditions=" AND ".join(ambulance_filters)
        ))
    where = f"WHERE {' AND '.join(filters)}" if filters else ""
    with engine.connect() as conn:
        sql = text(f"""
            SELECT h.hotspot_id, h.state_name, h.hotspot_district, h.station,
                   h.final_id, h.hotspot_day, h.time_period, h.fatalities,
                   h.total_crashes, h.latitude, h.longitude,
                   ST_AsGeoJSON(h.geom) AS geometry,
                   COUNT(a.unique_id) AS matched_ambulance_count
            FROM hotspots h
            LEFT JOIN ambulances a
              ON UPPER(h.state_name) = UPPER(a.state)
             AND ST_Intersects(
                 h.geom,
                 ST_SetSRID(ST_MakePoint(a.longitude, a.latitude), 4326)
             )
            {where}
            GROUP BY h.hotspot_id, h.state_name, h.hotspot_district, h.station,
                     h.final_id, h.hotspot_day, h.time_period, h.fatalities,
                     h.total_crashes, h.latitude, h.longitude, h.geom
            ORDER BY h.hotspot_id
        """)
        if districts:
            sql = sql.bindparams(bindparam("districts", expanding=True))
        if days:
            sql = sql.bindparams(bindparam("days", expanding=True))
        if time_periods:
            sql = sql.bindparams(bindparam("time_periods", expanding=True))
        rows = conn.execute(sql, params).fetchall()
    return jsonify({
        "type": "FeatureCollection",
        "features": [_hotspot_to_feature(r._mapping) for r in rows],
    })


@app.get("/api/ambulances/<int:uid>")
def get_ambulance(uid):
    with engine.connect() as conn:
        row = conn.execute(
            text("""SELECT unique_id, day, time_period, country, state, district, city,
                           postal_code, latitude, longitude, address,
                           hotspot_id, hotspot_state, hotspot_district,
                           hotspot_station, hotspot_final_id
                    FROM ambulances WHERE unique_id = :uid"""),
            {"uid": uid}
        ).fetchone()
    if not row:
        return {"error": "not found"}, 404
    return jsonify(_ambulance_to_feature(row._mapping))


@app.get("/api/hospitals")
def list_hospitals():
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT hospital_id, record_id, state, district, hospital_name, pincode,
                   hospital_type, level_code, level_label, latitude, longitude,
                   creation_date, date_submission,
                   avg_primary, avg_secondary, avg_tertiary,
                   e_primary, e_secondary, e_tertiary,
                   i_primary, i_secondary, i_tertiary,
                   b_primary, b_secondary, b_tertiary,
                   s_primary, s_secondary, s_tertiary
            FROM hospitals
            ORDER BY hospital_name
        """)).fetchall()
    return jsonify({"type": "FeatureCollection", "features": [_hospital_to_feature(r._mapping) for r in rows]})


@app.get("/api/hospitals/<int:hospital_id>")
def get_hospital(hospital_id):
    with engine.connect() as conn:
        row = conn.execute(text("""
            SELECT hospital_id, record_id, state, district, hospital_name, pincode,
                   hospital_type, level_code, level_label, latitude, longitude,
                   creation_date, date_submission,
                   avg_primary, avg_secondary, avg_tertiary,
                   e_primary, e_secondary, e_tertiary,
                   i_primary, i_secondary, i_tertiary,
                   b_primary, b_secondary, b_tertiary,
                   s_primary, s_secondary, s_tertiary
            FROM hospitals
            WHERE hospital_id = :hospital_id
        """), {"hospital_id": hospital_id}).fetchone()
    if not row:
        return {"error": "not found"}, 404
    return jsonify(_hospital_to_feature(row._mapping))


@app.get("/api/hospitals/nearby")
def nearby_hospitals():
    ambulance_id = request.args.get("ambulance_id", type=int)
    if not ambulance_id:
        return {"error": "ambulance_id is required"}, 400
    radius_km = request.args.get("radius_km", default=50, type=float) or 50.0

    with engine.connect() as conn:
        ambulance = conn.execute(
            text("SELECT latitude, longitude FROM ambulances WHERE unique_id = :uid"),
            {"uid": ambulance_id}
        ).fetchone()
        if not ambulance:
            return {"error": "ambulance not found"}, 404

        rows = conn.execute(text("""
            SELECT hospital_id, record_id, state, district, hospital_name, pincode,
                   hospital_type, level_code, level_label, latitude, longitude,
                   creation_date, date_submission,
                   avg_primary, avg_secondary, avg_tertiary,
                   e_primary, e_secondary, e_tertiary,
                   i_primary, i_secondary, i_tertiary,
                   b_primary, b_secondary, b_tertiary,
                   s_primary, s_secondary, s_tertiary,
                   ST_Distance(geom, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography) / 1000.0 AS distance_km
            FROM hospitals
            WHERE ST_DWithin(
                geom,
                ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography,
                :radius_meters
            )
            ORDER BY distance_km, hospital_name
        """), {
            "lon": ambulance.longitude,
            "lat": ambulance.latitude,
            "radius_meters": radius_km * 1000,
        }).fetchall()

    features = []
    for row in rows:
        feature = _hospital_to_feature(row._mapping)
        feature["properties"]["distance_km"] = _distance_km(row._mapping.get("distance_km"))
        features.append(feature)
    return jsonify({"type": "FeatureCollection", "features": features})


@app.post("/api/upload/ambulances")
def upload_ambulances():
    if "file" not in request.files:
        return {"error": "no file uploaded"}, 400
    file = request.files["file"]
    try:
        records = parse_ambulances(BytesIO(file.read()))
    except ExcelValidationError as e:
        return {"error": str(e)}, 400

    by_id = {r["unique_id"]: r for r in records}
    deduped = list(by_id.values())

    with engine.begin() as conn:
        for r in deduped:
            conn.execute(
                text("""
                    INSERT INTO ambulances (
                        unique_id, day, time_period, country, state, district, city,
                        postal_code, latitude, longitude, address, geom
                    ) VALUES (
                        :unique_id, :day, :time_period, :country, :state, :district, :city,
                        :postal_code, :latitude, :longitude, :address,
                        ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)::geography
                    )
                    ON CONFLICT (unique_id) DO UPDATE SET
                        day = EXCLUDED.day,
                        time_period = EXCLUDED.time_period,
                        latitude = EXCLUDED.latitude,
                        longitude = EXCLUDED.longitude,
                        address = EXCLUDED.address,
                        geom = EXCLUDED.geom
                """),
                r
            )

    return jsonify({"inserted_or_updated": len(deduped)})


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=FLASK_PORT, debug=True)
