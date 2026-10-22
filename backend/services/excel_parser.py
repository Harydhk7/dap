"""Excel parser for ambulance uploads and hospital seeding."""

import pandas as pd
from pathlib import Path


AMBULANCE_REQUIRED_COLS = {
    "Uniqueid", "Day", "Timeperiod", "Country", "State", "District",
    "City", "Postal Code", "Latitude", "Longitude", "Address"
}


class ExcelValidationError(Exception):
    pass


def _clean_str(value):
    if pd.isna(value):
        return None
    text = str(value).strip()
    return text or None


def _clean_number(value):
    if pd.isna(value):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _clean_datetime(value):
    if pd.isna(value):
        return None
    parsed = pd.to_datetime(value, errors="coerce")
    if pd.isna(parsed):
        return None
    return parsed.to_pydatetime()


def _parse_gps(gps_value):
    if pd.isna(gps_value):
        return None, None
    parts = [part.strip() for part in str(gps_value).split(",")]
    if len(parts) < 2:
        return None, None
    try:
        return float(parts[0]), float(parts[1])
    except (TypeError, ValueError):
        return None, None


def _hospital_level(hospital_type):
    hosp_type = (_clean_str(hospital_type) or "").upper()
    if "PRIVATE" in hosp_type:
        return "L1", "Tertiary"
    if "PHC" in hosp_type or "UPHC" in hosp_type or "UHC" in hosp_type:
        return "L3", "Primary"
    return "L2", "Secondary"


def _sheet_frame(excel_file, sheet_name):
    frame = pd.read_excel(excel_file, sheet_name=sheet_name)
    frame = frame.loc[:, ~frame.columns.astype(str).str.startswith("Unnamed")].copy()
    frame["_non_null_count"] = frame.notna().sum(axis=1)
    return frame


def parse_ambulances(file_path_or_stream) -> list[dict]:
    source_name = str(getattr(file_path_or_stream, "name", file_path_or_stream)).lower()
    df = pd.read_csv(file_path_or_stream) if source_name.endswith(".csv") else pd.read_excel(file_path_or_stream)
    optimized_columns = {"Uniqueid", "state", "day", "Timeperiod", "latitude", "longitude"}
    is_optimized = optimized_columns.issubset(set(df.columns))
    if not is_optimized:
        missing = AMBULANCE_REQUIRED_COLS - set(df.columns)
        if missing:
            raise ExcelValidationError(f"Missing required columns: {missing}")

    records = []
    for _, row in df.iterrows():
        try:
            lat = float(row["latitude"] if is_optimized else row["Latitude"])
            lon = float(row["longitude"] if is_optimized else row["Longitude"])
        except (TypeError, ValueError):
            continue

        def value(*columns):
            for column in columns:
                if column in row.index and pd.notna(row[column]):
                    return str(row[column]).strip() or None
            return None

        records.append({
            "unique_id": int(row["Uniqueid"]),
            "day": value("day", "Day"),
            "time_period": value("Timeperiod"),
            "country": value("country", "Country"),
            "state": value("state", "State"),
            "district": value("District", "city"),
            "city": value("city", "City"),
            "postal_code": value("postal_code", "Postal Code"),
            "latitude": lat,
            "longitude": lon,
            "address": value("full_address", "Address"),
        })
    return records


def parse_hospitals(file_path_or_stream) -> list[dict]:
    excel_file = pd.ExcelFile(file_path_or_stream)
    required_sheets = {"TPL", "Hospitals"}
    if not required_sheets.issubset(set(excel_file.sheet_names)):
        raise ExcelValidationError("Hospital workbook must contain TPL and Hospitals sheets")

    tpl_df = _sheet_frame(excel_file, "TPL")
    hospitals_df = _sheet_frame(excel_file, "Hospitals")

    tpl_df = tpl_df.sort_values(
        by=["_non_null_count", "date_submission", "creation_date", "recordId"],
        na_position="first",
    ).drop_duplicates(subset=["hospId"], keep="last")

    hospitals_df = hospitals_df.sort_values(
        by=["_non_null_count", "Record ID", "Hospital ID"],
        na_position="first",
    ).drop_duplicates(subset=["Hospital ID"], keep="last")

    hospitals_by_id = {
        int(row["Hospital ID"]): row
        for _, row in hospitals_df.iterrows()
        if pd.notna(row.get("Hospital ID"))
    }
    tpl_by_id = {
        int(row["hospId"]): row
        for _, row in tpl_df.iterrows()
        if pd.notna(row.get("hospId"))
    }

    all_ids = sorted(set(hospitals_by_id) | set(tpl_by_id))
    records = []
    for hospital_id in all_ids:
        hospital_row = hospitals_by_id.get(hospital_id)
        tpl_row = tpl_by_id.get(hospital_id)
        row = hospital_row if hospital_row is not None else tpl_row

        gps_value = _clean_str(row.get("GPS Location") if hospital_row is not None else row.get("GPS"))
        if not gps_value and tpl_row is not None:
            gps_value = _clean_str(tpl_row.get("GPS"))
        lat, lon = _parse_gps(gps_value)
        if lat is None or lon is None:
            continue

        hospital_type = _clean_str(row.get("Hospital Type") if hospital_row is not None else row.get("hosp_type"))
        if not hospital_type and tpl_row is not None:
            hospital_type = _clean_str(tpl_row.get("hosp_type"))
        level_code, level_label = _hospital_level(hospital_type)

        def tpl_value(column):
            return _clean_number(tpl_row.get(column)) if tpl_row is not None else None

        records.append({
            "hospital_id": hospital_id,
            "record_id": int(_clean_number(row.get("Record ID") if hospital_row is not None else row.get("recordId")) or 0) or None,
            "state": _clean_str(row.get("State") if hospital_row is not None else row.get("state")),
            "district": _clean_str(row.get("District") if hospital_row is not None else row.get("district")),
            "hospital_name": _clean_str(row.get("Hospital Name") if hospital_row is not None else row.get("hospname")),
            "pincode": _clean_str(row.get("Pincode") if hospital_row is not None else row.get("districtcode")),
            "hospital_type": hospital_type,
            "level_code": level_code,
            "level_label": level_label,
            "latitude": lat,
            "longitude": lon,
            "creation_date": _clean_datetime(tpl_row.get("creation_date")) if tpl_row is not None else None,
            "date_submission": _clean_datetime(tpl_row.get("date_submission")) if tpl_row is not None else None,
            "avg_primary": tpl_value("avg_primary"),
            "avg_secondary": tpl_value("avg_secondary"),
            "avg_tertiary": tpl_value("avg_tertiary"),
            "e_primary": tpl_value("e_primary"),
            "e_secondary": tpl_value("e_secondary"),
            "e_tertiary": tpl_value("e_tertiary"),
            "i_primary": tpl_value("i_primary"),
            "i_secondary": tpl_value("i_secondary"),
            "i_tertiary": tpl_value("i_tertiary"),
            "b_primary": tpl_value("b_primary"),
            "b_secondary": tpl_value("b_secondary"),
            "b_tertiary": tpl_value("b_tertiary"),
            "s_primary": tpl_value("s_primary"),
            "s_secondary": tpl_value("s_secondary"),
            "s_tertiary": tpl_value("s_tertiary"),
        })

    return records
