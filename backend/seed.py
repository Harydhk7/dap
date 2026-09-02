"""
One-shot DB initialization and ambulance/district seeding (ambulance-only baseline).

Run:
    python seed.py                  # full reset + seed ambulances + districts
    python seed.py --districts-only # reload districts GeoJSON only
"""

import argparse
import json
import os
from urllib.parse import urlsplit, urlunsplit
from pathlib import Path
from urllib.request import urlretrieve

from dotenv import load_dotenv
from sqlalchemy import create_engine, text

from services.excel_parser import parse_ambulances, parse_hospitals

load_dotenv()

DATABASE_URL = os.environ.get(
    "DATABASE_URL",
    "postgresql+psycopg2://ambumap:ambumap@localhost:5432/ambumap"
)
DATA_DIR = Path(__file__).parent / "data"
AMBULANCES_XLSX = DATA_DIR / "ambulances_haryana.xlsx"
DISTRICTS_GEOJSON = DATA_DIR / "haryana_districts.geojson"
HOSPITALS_WORKBOOK = DATA_DIR / "Hospital_data.xlsx"
ROOT_HOSPITALS_WORKBOOK = Path(__file__).resolve().parents[1] / "Hospital_data (1).xlsx"
DISTRICT_GEOJSON_URLS = [
    "https://raw.githubusercontent.com/datameet/maps/master/docs/data/geojson/dists11.geojson",
    "https://raw.githubusercontent.com/datameet/maps/master/Districts/districts.geojson",
]


def _resolve_database_url(url):
    if url.startswith("postgres://"):
        url = url.replace("postgres://", "postgresql+psycopg2://", 1)

    parsed = urlsplit(url)
    if parsed.hostname == "db" and not Path("/.dockerenv").exists():
        netloc = parsed.netloc.replace("db", "localhost", 1)
        url = urlunsplit((parsed.scheme, netloc, parsed.path, parsed.query, parsed.fragment))

    return url


SCHEMA_SQL = """
CREATE EXTENSION IF NOT EXISTS postgis;

DROP TABLE IF EXISTS ambulances CASCADE;
CREATE TABLE ambulances (
    unique_id    INTEGER PRIMARY KEY,
    day          VARCHAR(8),
    time_period  VARCHAR(32),
    country      VARCHAR(64),
    state        VARCHAR(64),
    district     VARCHAR(64),
    city         VARCHAR(128),
    postal_code  VARCHAR(16),
    latitude     DOUBLE PRECISION NOT NULL,
    longitude    DOUBLE PRECISION NOT NULL,
    address      TEXT,
    geom         GEOGRAPHY(Point, 4326),
    created_at   TIMESTAMP DEFAULT NOW()
);
CREATE INDEX idx_amb_geom ON ambulances USING GIST (geom);
CREATE INDEX idx_amb_district ON ambulances (district);
CREATE INDEX idx_amb_day_time ON ambulances (day, time_period);

DROP TABLE IF EXISTS districts CASCADE;
CREATE TABLE districts (
    id     SERIAL PRIMARY KEY,
    name   VARCHAR(64) NOT NULL,
    state  VARCHAR(64) NOT NULL,
    geom   GEOMETRY(MultiPolygon, 4326) NOT NULL
);
CREATE INDEX idx_dist_geom ON districts USING GIST (geom);

DROP TABLE IF EXISTS hospitals CASCADE;
CREATE TABLE hospitals (
    hospital_id     INTEGER PRIMARY KEY,
    record_id       INTEGER,
    state           VARCHAR(64),
    district        VARCHAR(64),
    hospital_name   VARCHAR(255),
    pincode         VARCHAR(16),
    hospital_type   VARCHAR(64),
    level_code      VARCHAR(2),
    level_label     VARCHAR(16),
    latitude        DOUBLE PRECISION NOT NULL,
    longitude       DOUBLE PRECISION NOT NULL,
    creation_date   TIMESTAMP,
    date_submission TIMESTAMP,
    avg_primary     DOUBLE PRECISION,
    avg_secondary   DOUBLE PRECISION,
    avg_tertiary    DOUBLE PRECISION,
    e_primary       DOUBLE PRECISION,
    e_secondary     DOUBLE PRECISION,
    e_tertiary      DOUBLE PRECISION,
    i_primary       DOUBLE PRECISION,
    i_secondary     DOUBLE PRECISION,
    i_tertiary      DOUBLE PRECISION,
    b_primary       DOUBLE PRECISION,
    b_secondary     DOUBLE PRECISION,
    b_tertiary      DOUBLE PRECISION,
    s_primary       DOUBLE PRECISION,
    s_secondary     DOUBLE PRECISION,
    s_tertiary      DOUBLE PRECISION,
    geom            GEOGRAPHY(Point, 4326)
);
CREATE INDEX idx_hospitals_geom ON hospitals USING GIST (geom);
CREATE INDEX idx_hospitals_district ON hospitals (district);
CREATE INDEX idx_hospitals_level ON hospitals (level_code);
"""


def init_schema(engine):
    with engine.begin() as conn:
        for stmt in SCHEMA_SQL.split(";"):
            s = stmt.strip()
            if s:
                conn.execute(text(s))
    print("Schema initialised")


def seed_ambulances(engine):
    if not AMBULANCES_XLSX.exists():
        print(f"⚠ {AMBULANCES_XLSX} not found, skipping ambulances")
        return
    records = parse_ambulances(AMBULANCES_XLSX)
    by_id = {r["unique_id"]: r for r in records}
    deduped = list(by_id.values())
    with engine.begin() as conn:
        for r in deduped:
            conn.execute(text("""
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
                    geom = EXCLUDED.geom
            """), r)
    print(f"Seeded {len(deduped)} ambulances")


def _ensure_hospitals_workbook():
    if HOSPITALS_WORKBOOK.exists():
        return HOSPITALS_WORKBOOK
    if ROOT_HOSPITALS_WORKBOOK.exists():
        return ROOT_HOSPITALS_WORKBOOK
    return None


def _load_geojson_features(path):
    with open(path, "rb") as f:
        raw = f.read()
    if raw[:3] == b"\xef\xbb\xbf":
        raw = raw[3:]
    text_data = raw.decode("utf-8").strip()
    try:
        obj = json.loads(text_data)
        if obj.get("type") == "FeatureCollection":
            return obj["features"]
        if obj.get("type") == "Feature":
            return [obj]
    except json.JSONDecodeError:
        pass
    features = []
    for line in text_data.splitlines():
        line = line.strip().rstrip(",")
        if not line:
            continue
        try:
            feat = json.loads(line)
        except json.JSONDecodeError:
            continue
        if feat.get("type") == "Feature":
            features.append(feat)
        elif feat.get("type") == "FeatureCollection":
            features.extend(feat["features"])
    return features


def _ensure_district_geojson():
    if DISTRICTS_GEOJSON.exists():
        return DISTRICTS_GEOJSON

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    for url in DISTRICT_GEOJSON_URLS:
        try:
            urlretrieve(url, DISTRICTS_GEOJSON)
            if DISTRICTS_GEOJSON.exists() and DISTRICTS_GEOJSON.stat().st_size > 0:
                print(f"Downloaded district outlines from {url}")
                return DISTRICTS_GEOJSON
        except Exception as exc:
            print(f"Failed to download district outlines from {url}: {exc}")

    return None


def seed_districts(engine):
    geojson_path = _ensure_district_geojson()
    if not geojson_path:
        print(f"{DISTRICTS_GEOJSON} not found - skipping district outlines.")
        print("   A district GeoJSON download is required to render the Haryana boundaries.")
        return
    try:
        features = _load_geojson_features(geojson_path)
    except Exception as e:
        print(f"Could not parse {geojson_path}: {e}")
        return

    with engine.begin() as conn:
        conn.execute(text("DELETE FROM districts WHERE state = 'Haryana'"))
        inserted = 0
        for feat in features:
            geom = feat.get("geometry")
            if not geom:
                continue
            props = feat.get("properties", {})
            name = (props.get("DISTRICT") or props.get("district") or
                    props.get("NAME_2") or props.get("name") or
                    props.get("DIST_NAME") or props.get("dtname") or "Unknown")
            geom_json = json.dumps(geom)
            try:
                conn.execute(text("""
                    INSERT INTO districts (name, state, geom)
                    VALUES (:name, 'Haryana',
                            ST_Multi(ST_GeomFromGeoJSON(:geom)))
                """), {"name": name, "geom": geom_json})
                inserted += 1
            except Exception as e:
                print(f"  skipped '{name}': {e}")
    print(f"Seeded {inserted} district polygons")


def seed_hospitals(engine):
    workbook = _ensure_hospitals_workbook()
    if not workbook:
        print(f"{HOSPITALS_WORKBOOK} not found - skipping hospitals.")
        print("   Add the hospital workbook to backend/data/ or the repo root to seed hospitals.")
        return

    records = parse_hospitals(workbook)
    with engine.begin() as conn:
        for record in records:
            conn.execute(text("""
                INSERT INTO hospitals (
                    hospital_id, record_id, state, district, hospital_name, pincode,
                    hospital_type, level_code, level_label, latitude, longitude,
                    creation_date, date_submission,
                    avg_primary, avg_secondary, avg_tertiary,
                    e_primary, e_secondary, e_tertiary,
                    i_primary, i_secondary, i_tertiary,
                    b_primary, b_secondary, b_tertiary,
                    s_primary, s_secondary, s_tertiary, geom
                ) VALUES (
                    :hospital_id, :record_id, :state, :district, :hospital_name, :pincode,
                    :hospital_type, :level_code, :level_label, :latitude, :longitude,
                    :creation_date, :date_submission,
                    :avg_primary, :avg_secondary, :avg_tertiary,
                    :e_primary, :e_secondary, :e_tertiary,
                    :i_primary, :i_secondary, :i_tertiary,
                    :b_primary, :b_secondary, :b_tertiary,
                    :s_primary, :s_secondary, :s_tertiary,
                    ST_SetSRID(ST_MakePoint(:longitude, :latitude), 4326)::geography
                )
                ON CONFLICT (hospital_id) DO UPDATE SET
                    record_id = EXCLUDED.record_id,
                    state = EXCLUDED.state,
                    district = EXCLUDED.district,
                    hospital_name = EXCLUDED.hospital_name,
                    pincode = EXCLUDED.pincode,
                    hospital_type = EXCLUDED.hospital_type,
                    level_code = EXCLUDED.level_code,
                    level_label = EXCLUDED.level_label,
                    latitude = EXCLUDED.latitude,
                    longitude = EXCLUDED.longitude,
                    creation_date = EXCLUDED.creation_date,
                    date_submission = EXCLUDED.date_submission,
                    avg_primary = EXCLUDED.avg_primary,
                    avg_secondary = EXCLUDED.avg_secondary,
                    avg_tertiary = EXCLUDED.avg_tertiary,
                    e_primary = EXCLUDED.e_primary,
                    e_secondary = EXCLUDED.e_secondary,
                    e_tertiary = EXCLUDED.e_tertiary,
                    i_primary = EXCLUDED.i_primary,
                    i_secondary = EXCLUDED.i_secondary,
                    i_tertiary = EXCLUDED.i_tertiary,
                    b_primary = EXCLUDED.b_primary,
                    b_secondary = EXCLUDED.b_secondary,
                    b_tertiary = EXCLUDED.b_tertiary,
                    s_primary = EXCLUDED.s_primary,
                    s_secondary = EXCLUDED.s_secondary,
                    s_tertiary = EXCLUDED.s_tertiary,
                    geom = EXCLUDED.geom
            """), record)
    print(f"Seeded {len(records)} hospitals")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--districts-only", action="store_true")
    args = parser.parse_args()

    engine = create_engine(_resolve_database_url(DATABASE_URL), pool_pre_ping=True)

    if args.districts_only:
        seed_districts(engine)
        return

    init_schema(engine)
    seed_districts(engine)
    seed_ambulances(engine)
    seed_hospitals(engine)
    print("\nAll done.")


if __name__ == "__main__":
    main()
