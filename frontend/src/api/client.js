async function request(path, options = {}) {
  const res = await fetch(path, options);
  if (!res.ok) {
    let body;
    try { body = await res.json(); } catch { body = { error: res.statusText }; }
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

async function download(path, filename) {
  const res = await fetch(path);
  if (!res.ok) {
    let body;
    try { body = await res.json(); } catch { body = { error: res.statusText }; }
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = objectUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(objectUrl);
}

export const api = {
  health:        () => request("/api/health"),
  patientInjuries: () => request("/api/patient-injuries"),
  filterOptions: (state = "All") => request(`/api/filters/options?state=${encodeURIComponent(state)}`),
  districts:     (state = "Haryana") => request(`/api/districts?state=${encodeURIComponent(state)}`),
  hotspots:      (state = "all", districts = [], days = [], timePeriods = []) => {
    const qs = new URLSearchParams({ state });
    districts.forEach((district) => qs.append("district", district));
    days.forEach((day) => qs.append("day", day));
    timePeriods.forEach((timePeriod) => qs.append("time_period", timePeriod));
    return request(`/api/hotspots?${qs.toString()}`);
  },
  hospitalsNearby: (ambulanceId, radiusKm = 50) => request(`/api/hospitals/nearby?ambulance_id=${encodeURIComponent(ambulanceId)}&radius_km=${encodeURIComponent(radiusKm)}`),
  recommendHospitals: (ambulanceId, injuryKey, radiusKm = 50) => request(`/api/recommend-hospitals?ambulance_id=${encodeURIComponent(ambulanceId)}&injury_type=${encodeURIComponent(injuryKey)}&radius_km=${encodeURIComponent(radiusKm)}`),
  ambulanceRecommendation: (ambulanceId, injuryKey) => request(`/api/ambulances/${encodeURIComponent(ambulanceId)}/recommendation`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ injury_key: injuryKey }),
  }),
  downloadFilteredAmbulances: (filters = {}) => {
    const qs = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (!v) return;
      if (Array.isArray(v)) {
        v.filter(Boolean).forEach((item) => {
          if (String(item).toLowerCase() !== "all") qs.append(k, item);
        });
        return;
      }
      if (String(v).toLowerCase() !== "all") qs.set(k, v);
    });
    return download(`/api/ambulances/export?${qs.toString()}`, "filtered-ambulances.xlsx");
  },
  downloadUploadTemplate: () => download("/api/upload/template", "ambulance-upload-template.xlsx"),
  ambulances:    (filters = {}) => {
    const qs = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => {
      if (!v) return;
      if (Array.isArray(v)) {
        v.filter(Boolean).forEach((item) => {
          if (String(item).toLowerCase() !== "all") qs.append(k, item);
        });
        return;
      }
      if (String(v).toLowerCase() !== "all") qs.set(k, v);
    });
    return request(`/api/ambulances?${qs.toString()}`);
  },
  hospital: (id) => request(`/api/hospitals/${id}`),
  ambulance: (id) => request(`/api/ambulances/${id}`),
  uploadAmbulances: (file) => {
    const fd = new FormData();
    fd.append("file", file);
    return request("/api/upload/ambulances", { method: "POST", body: fd });
  },
};
