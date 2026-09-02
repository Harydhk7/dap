import React, { useEffect, useRef, useState, useCallback, useMemo } from "react";
import MapView from "./components/MapView.jsx";
import RecommendationCard from "./components/RecommendationCard.jsx";
import Sidebar from "./components/Sidebar.jsx";
import UploadModal from "./components/UploadModal.jsx";
import { api } from "./api/client.js";

function parseTimeSlot(value) {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const text = String(value).trim().toUpperCase();
  const firstTokenMatch = text.match(/(\d{1,2})\s*(AM|PM)/i);
  if (!firstTokenMatch) return Number.MAX_SAFE_INTEGER;
  let hour = Number(firstTokenMatch[1]) % 12;
  if (firstTokenMatch[2].toUpperCase() === "PM") hour += 12;
  return hour;
}

function getUniqueAmbulanceCount(features = []) {
  if (!Array.isArray(features) || !features.length) return 0;

  const records = features
    .map((feature) => {
      const props = feature?.properties || {};
      const [lon, lat] = feature?.geometry?.coordinates || [];
      return {
        id: props.unique_id ?? null,
        day: props.day ?? "",
        timePeriod: props.time_period ?? "",
        timeOrder: parseTimeSlot(props.time_period),
        lat,
        lon,
      };
    })
    .filter((record) => Number.isFinite(record.timeOrder) && Number.isFinite(record.lat) && Number.isFinite(record.lon))
    .sort((a, b) => a.timeOrder - b.timeOrder || String(a.day).localeCompare(String(b.day)));

  if (!records.length) return 0;

  const tracks = [];

  const maxTravelKm = (hoursGap) => {
    const maxSpeedKmh = 50;
    const timeWindowHours = 15 / 60;
    return Math.max(0, maxSpeedKmh * timeWindowHours * Math.max(1, hoursGap));
  };

  records.forEach((record) => {
    const exactId = record.id != null ? String(record.id) : null;
    let matchedTrack = null;

    if (exactId) {
      matchedTrack = tracks.find((track) => track.id === exactId);
    }

    if (!matchedTrack) {
      matchedTrack = tracks.find((track) => {
        if (track.lastTimeOrder === record.timeOrder) return false;
        const hoursGap = Math.max(1, record.timeOrder - track.lastTimeOrder);
        const distanceKm = Math.hypot(record.lon - track.lastLon, record.lat - track.lastLat) * 111;
        return hoursGap <= 0.25 && distanceKm <= maxTravelKm(hoursGap);
      });
    }

    if (matchedTrack) {
      matchedTrack.lastTimeOrder = record.timeOrder;
      matchedTrack.lastLon = record.lon;
      matchedTrack.lastLat = record.lat;
      matchedTrack.id = matchedTrack.id || exactId;
      return;
    }

    tracks.push({
      id: exactId,
      lastTimeOrder: record.timeOrder,
      lastLon: record.lon,
      lastLat: record.lat,
    });
  });

  return tracks.length;
}

export default function App() {
  const [filterOptions, setFilterOptions] = useState({});
  const [filters, setFilters] = useState({
    state: "All", district: [], day: [], time_period: [],
  });
  const [ambulances, setAmbulances] = useState(null);
  const [districts, setDistricts] = useState(null);
  const [indiaBoundary, setIndiaBoundary] = useState(null);
  const [nearbyHospitals, setNearbyHospitals] = useState(null);
  const [showUpload, setShowUpload] = useState(false);
  const [selectedAmbulance, setSelectedAmbulance] = useState(null);
  const [selectedHospital, setSelectedHospital] = useState(null);
  const [selectedPreparednessLevel, setSelectedPreparednessLevel] = useState("primary");
  const [injuryOptions, setInjuryOptions] = useState([]);
  const [selectedInjuryKey, setSelectedInjuryKey] = useState("tbi");
  const [recommendation, setRecommendation] = useState(null);
  const [toast, setToast] = useState(null);
  const [loading, setLoading] = useState(false);
  const [hospitalLoading, setHospitalLoading] = useState(false);
  const [recommendationLoading, setRecommendationLoading] = useState(false);
  const [route, setRoute] = useState(null);
  const [routeLoading, setRouteLoading] = useState(false);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurementPoints, setMeasurementPoints] = useState([]);
  const overlayStackRef = useRef(null);
  const [mapMinHeight, setMapMinHeight] = useState("calc(100vh - 60px)");

  useEffect(() => {
    api.filterOptions().then(setFilterOptions).catch(console.error);
    api.districts("Haryana").then(setDistricts).catch(console.error);
    api.patientInjuries().then((items) => {
      setInjuryOptions(items || []);
      if (!(items || []).some((item) => item.key === selectedInjuryKey) && items?.length) {
        setSelectedInjuryKey(items[0].key);
      }
    }).catch(console.error);
    fetch("/haryana_outline.geojson")
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setIndiaBoundary(data))
      .catch(() => setIndiaBoundary(null));
  }, []);

  useEffect(() => {
    const node = overlayStackRef.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;

    const updateHeight = () => {
      const height = Math.ceil(node.getBoundingClientRect().height || 0);
      const baseHeight = window.innerHeight - 60;
      const nextHeight = Math.max(baseHeight, height + 24);
      setMapMinHeight(`${nextHeight}px`);
    };

    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(node);
    window.addEventListener("resize", updateHeight);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [selectedAmbulance, selectedHospital, recommendation, nearbyHospitals, loading, hospitalLoading, recommendationLoading]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.ambulances(filters);
      setAmbulances(data);
    } catch (e) {
      showToast(`Error: ${e.message}`, "error");
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => { loadData(); }, [loadData]);

  const showToast = (message, type = "success") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  const handleFilterChange = (key, value) => {
    setFilters((f) => ({ ...f, [key]: value }));
    setSelectedAmbulance(null);
    setSelectedHospital(null);
    setNearbyHospitals(null);
  };

  const handleClearFilters = () => {
    setFilters({ state: "All", district: [], day: [], time_period: [] });
    setSelectedAmbulance(null);
    setSelectedHospital(null);
    setNearbyHospitals(null);
    setRoute(null);
    setMeasureMode(false);
    setMeasurementPoints([]);
  };

  const handleAmbulanceClick = (feature) => {
    setSelectedAmbulance(feature);
    setSelectedHospital(null);
    setRoute(null);
  };

  const handleHospitalClick = (feature) => {
    setSelectedHospital(feature);
  };

  const handleToggleMeasureMode = () => {
    setMeasureMode((current) => {
      const next = !current;
      if (!next) {
        setMeasurementPoints([]);
      }
      return next;
    });
  };

  const handleMapClick = (latlng) => {
    if (!measureMode) return;
    setMeasurementPoints((current) => {
      if (current.length < 2) return [...current, latlng];
      return [latlng];
    });
  };

  const handleClearMeasurement = () => {
    setMeasurementPoints([]);
  };

  const measurementDistance = useMemo(() => {
    if (measurementPoints.length !== 2) return null;
    const [first, second] = measurementPoints;
    const toRad = (deg) => (deg * Math.PI) / 180;
    const lat1 = first.lat;
    const lon1 = first.lng;
    const lat2 = second.lat;
    const lon2 = second.lng;
    const R = 6371;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2
      + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }, [measurementPoints]);

  useEffect(() => {
    if (!selectedHospital?.geometry?.coordinates || !selectedAmbulance?.geometry?.coordinates) {
      setRoute(null);
      return;
    }

    const ambulanceCoords = selectedAmbulance.geometry.coordinates;
    const hospitalCoords = selectedHospital.geometry.coordinates;
    const [ambulanceLon, ambulanceLat] = ambulanceCoords;
    const [hospitalLon, hospitalLat] = hospitalCoords;
    const url = `https://router.project-osrm.org/route/v1/driving/${ambulanceLon},${ambulanceLat};${hospitalLon},${hospitalLat}?overview=full&geometries=geojson`;
    let cancelled = false;

    setRouteLoading(true);
    fetch(url)
      .then((res) => {
        if (!res.ok) throw new Error(`Routing response ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        const routeData = data?.routes?.[0];
        if (routeData && routeData.geometry) {
          setRoute({
            geometry: routeData.geometry,
            distance: routeData.distance / 1000,
            duration: routeData.duration / 60,
          });
        } else {
          setRoute(null);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setRoute(null);
          showToast(`Road routing failed: ${error.message}`, "error");
        }
      })
      .finally(() => {
        if (!cancelled) setRouteLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [selectedAmbulance, selectedHospital]);

  useEffect(() => {
    if (!selectedHospital?.properties?.level_code) return;
    const levelFromHospital = selectedHospital.properties.level_code === "L1"
      ? "tertiary"
      : selectedHospital.properties.level_code === "L2"
        ? "secondary"
        : "primary";
    setSelectedPreparednessLevel(levelFromHospital);
  }, [selectedHospital]);

  useEffect(() => {
    let cancelled = false;

    async function loadRecommendation() {
      if (!selectedAmbulance?.properties?.unique_id) {
        setRecommendation(null);
        return;
      }

      setRecommendationLoading(true);
      try {
        const data = await api.recommendHospitals(selectedAmbulance.properties.unique_id, selectedInjuryKey, 50);
        if (!cancelled) {
          setRecommendation(data);
        }
      } catch (error) {
        if (!cancelled) {
          setRecommendation(null);
          showToast(`Recommendation lookup failed: ${error.message}`, "error");
        }
      } finally {
        if (!cancelled) {
          setRecommendationLoading(false);
        }
      }
    }

    loadRecommendation();
    return () => {
      cancelled = true;
    };
  }, [selectedAmbulance, selectedInjuryKey]);

  const handleUploaded = (count) => {
    showToast(`${count} ambulances uploaded`, "success");
    loadData();
    api.filterOptions().then(setFilterOptions);
  };

  useEffect(() => {
    let cancelled = false;

    async function loadHospitals() {
      if (!selectedAmbulance?.properties?.unique_id) {
        setNearbyHospitals(null);
        setHospitalLoading(false);
        return;
      }

      setHospitalLoading(true);
      try {
        const data = await api.hospitalsNearby(selectedAmbulance.properties.unique_id, 50);
        if (!cancelled) {
          setNearbyHospitals(data);
        }
      } catch (e) {
        if (!cancelled) {
          setNearbyHospitals(null);
          showToast(`Hospital lookup failed: ${e.message}`, "error");
        }
      } finally {
        if (!cancelled) {
          setHospitalLoading(false);
        }
      }
    }

    loadHospitals();
    return () => {
      cancelled = true;
    };
  }, [selectedAmbulance]);

  const visibleCount = ambulances?.features?.length || 0;
  const uniqueAmbulanceCount = useMemo(() => getUniqueAmbulanceCount(ambulances?.features || []), [ambulances]);
  const selectedDistricts = Array.isArray(filters.district) && filters.district.length
    ? filters.district
    : null;

  return (
    <div className="app">
      <header className="topnav">
        <div className="topnav-left">
          <div className="topnav-title">
            <span className="dot" />
            Dynamic Ambulance positioning
          </div>
          <button
            className={`btn ${measureMode ? "btn-active" : ""}`}
            onClick={handleToggleMeasureMode}
            type="button"
          >
            {measureMode ? "Exit Measure" : "Measure distance"}
          </button>
        </div>
        <div className="topnav-actions">
          <button
            className="btn btn-secondary btn-inline"
            onClick={() => api.downloadFilteredAmbulances(filters).catch((e) => showToast(e.message, "error"))}
          >
            Download Excel
          </button>
          <button className="btn" onClick={() => setShowUpload(true)}>
            Upload Excel
          </button>
        </div>
      </header>

      <div className="main">
        <Sidebar
          filterOptions={filterOptions}
          filters={filters}
          onChange={handleFilterChange}
          onClear={handleClearFilters}
          count={visibleCount}
          uniqueCount={uniqueAmbulanceCount}
          selectedHospital={selectedHospital}
          selectedAmbulance={selectedAmbulance}
          onCloseHospital={() => setSelectedHospital(null)}
        />

        <div className="map-container" style={{ minHeight: mapMinHeight }}>
          <div className="map-mode-card">
            <div className="map-mode-card__title">Distance measurement</div>
            <div className="map-mode-card__body">
              {measureMode ? (
                measurementPoints.length === 0 ? (
                  "Click on the map to place point 1."
                ) : measurementPoints.length === 1 ? (
                  "Click on the map to place point 2."
                ) : (
                  <>
                    <div className="map-mode-card__distance">{measurementDistance?.toFixed(2)} km</div>
                    <button
                      type="button"
                      className="btn btn-secondary btn-inline"
                      onClick={handleClearMeasurement}
                    >
                      Clear measurement
                    </button>
                  </>
                )
              ) : (
                "Click Measure distance to start measuring."
              )}
            </div>
          </div>
          <div className="hospital-overlay-stack" ref={overlayStackRef}>
            {selectedAmbulance && (
              <RecommendationCard
                ambulance={selectedAmbulance}
                injuryOptions={injuryOptions}
                selectedInjuryKey={selectedInjuryKey}
                onInjuryKeyChange={setSelectedInjuryKey}
                recommendation={recommendation}
                onClose={() => {
                  setSelectedAmbulance(null);
                  setSelectedHospital(null);
                  setNearbyHospitals(null);
                  setRecommendation(null);
                }}
                onSelectHospital={handleHospitalClick}
              />
            )}

            {selectedHospital && (
              <div className="detail-card">
                <div className="detail-card__header">
                  <div className="detail-card__title-wrap">
                    <div className="detail-card__title">{selectedHospital.properties.hospital_name}</div>
                    <div className="detail-card__subtitle">
                      {selectedHospital.properties.district} · {selectedHospital.properties.hospital_type}
                    </div>
                  </div>
                  <div className="detail-card__header-actions">
                    <button
                      type="button"
                      className="detail-card__close"
                      onClick={() => setSelectedHospital(null)}
                      aria-label="Close hospital details"
                    >
                      ×
                    </button>
                    <span className={`detail-pill detail-pill--${selectedHospital.properties.level_code.toLowerCase()}`}>
                      {selectedHospital.properties.level_code} · {selectedHospital.properties.level_label}
                    </span>
                  </div>
                </div>

                {route && (
                  <div className="detail-card__route">
                    <span>Road route: {route.distance.toFixed(1)} km · {route.duration.toFixed(0)} min</span>
                    {routeLoading && <span className="route-loading">Updating…</span>}
                  </div>
                )}

                <div className="detail-section-title">Trauma care Preparedness Level (%)</div>
                <div className="score-grid">
                  <button
                    type="button"
                    className={`score-box score-box--primary ${selectedPreparednessLevel === "primary" ? "is-active" : ""}`}
                    onClick={() => setSelectedPreparednessLevel("primary")}
                  >
                    <div className="score-label">Primary</div>
                    <div className="score-value">{Number(selectedHospital.properties.avg_primary || 0).toFixed(1)}%</div>
                    <div className="score-bar score-bar--primary"><span style={{ width: `${Number(selectedHospital.properties.avg_primary || 0)}%` }} /></div>
                  </button>
                  <button
                    type="button"
                    className={`score-box score-box--secondary ${selectedPreparednessLevel === "secondary" ? "is-active" : ""}`}
                    onClick={() => setSelectedPreparednessLevel("secondary")}
                  >
                    <div className="score-label">Secondary</div>
                    <div className="score-value">{Number(selectedHospital.properties.avg_secondary || 0).toFixed(1)}%</div>
                    <div className="score-bar score-bar--secondary"><span style={{ width: `${Number(selectedHospital.properties.avg_secondary || 0)}%` }} /></div>
                  </button>
                  <button
                    type="button"
                    className={`score-box score-box--tertiary ${selectedPreparednessLevel === "tertiary" ? "is-active" : ""}`}
                    onClick={() => setSelectedPreparednessLevel("tertiary")}
                  >
                    <div className="score-label">Tertiary</div>
                    <div className="score-value">{Number(selectedHospital.properties.avg_tertiary || 0).toFixed(1)}%</div>
                    <div className="score-bar score-bar--tertiary"><span style={{ width: `${Number(selectedHospital.properties.avg_tertiary || 0)}%` }} /></div>
                  </button>
                </div>

                <div className="breakdown-block">
                  <div className="breakdown-block__head">
                    Preparedness Level (%) · {selectedPreparednessLevel.charAt(0).toUpperCase() + selectedPreparednessLevel.slice(1)}
                  </div>
                  {Object.entries(
                    selectedPreparednessLevel === "tertiary"
                      ? {
                          Equipment: selectedHospital.properties.e_tertiary,
                          Infrastructure: selectedHospital.properties.i_tertiary,
                          Beds: selectedHospital.properties.b_tertiary,
                          Services: selectedHospital.properties.s_tertiary,
                        }
                      : selectedPreparednessLevel === "secondary"
                        ? {
                            Equipment: selectedHospital.properties.e_secondary,
                            Infrastructure: selectedHospital.properties.i_secondary,
                            Beds: selectedHospital.properties.b_secondary,
                            Services: selectedHospital.properties.s_secondary,
                          }
                        : {
                            Equipment: selectedHospital.properties.e_primary,
                            Infrastructure: selectedHospital.properties.i_primary,
                            Beds: selectedHospital.properties.b_primary,
                            Services: selectedHospital.properties.s_primary,
                          }
                  ).map(([label, value]) => (
                    <div className="breakdown-row" key={label}>
                      <span>{label}</span>
                      <div className={`breakdown-track breakdown-track--${selectedPreparednessLevel}`}>
                        <span style={{ width: `${Number(value || 0)}%` }} />
                      </div>
                      <strong>{Number(value || 0).toFixed(1)}</strong>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

          <div className="map-surface">
            <MapView
              ambulances={ambulances}
              indiaBoundary={indiaBoundary}
              districts={districts}
              selectedDistricts={selectedDistricts}
              selectedAmbulance={selectedAmbulance}
              nearbyHospitals={nearbyHospitals}
              selectedHospital={selectedHospital}
              route={route}
              measureMode={measureMode}
              measurementPoints={measurementPoints}
              onAmbulanceClick={handleAmbulanceClick}
              onHospitalClick={handleHospitalClick}
              onMapClick={handleMapClick}
            />
          </div>
        </div>
      </div>

      {showUpload && (
        <UploadModal
          onClose={() => setShowUpload(false)}
          onUploaded={handleUploaded}
        />
      )}

      {toast && <div className={`toast ${toast.type}`}>{toast.message}</div>}

      {(loading || hospitalLoading) && (
        <div style={{
          position: "fixed", top: 70, left: "50%", transform: "translateX(-50%)",
          padding: "6px 14px", background: "rgba(0,0,0,0.7)", color: "white",
          borderRadius: 16, fontSize: 12, zIndex: 1500,
        }}>
          <span className="spinner" style={{ marginRight: 8 }}/>Loading…
        </div>
      )}

      {recommendationLoading && selectedAmbulance && (
        <div className="recommendation-loading">
          <span className="spinner" style={{ marginRight: 8 }} />
          Building recommendation…
        </div>
      )}
    </div>
  );
}
