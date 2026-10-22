import React, { useEffect, useMemo } from "react";
import {
  MapContainer, TileLayer, GeoJSON, Marker, Popup, useMap, Circle, Polyline, CircleMarker, useMapEvents, Pane,
} from "react-leaflet";
import L from "leaflet";

const HARYANA_CENTER = [29.0588, 76.0856];
const HARYANA_ZOOM = 8;
const HARYANA_BOUNDS = [
  [27.6, 74.0],
  [30.9, 77.9],
];

function FitBounds({ bounds }) {
  const map = useMap();
  useEffect(() => {
    if (bounds) {
      map.fitBounds(bounds, { padding: [40, 40] });
    } else {
      map.fitBounds(HARYANA_BOUNDS, { padding: [20, 20] });
    }
  }, [bounds, map]);
  return null;
}

function MapClickHandler({ measureMode, onMapClick }) {
  useMapEvents({
    click: (event) => {
      if (measureMode && onMapClick) {
        onMapClick(event.latlng);
      }
    },
  });

  return null;
}

export default function MapView({
  ambulances,
  hotspots,
  hotspotLayerKey,
  districtLayerKey,
  indiaBoundary,
  districts,
  selectedDistricts,
  selectedAmbulance,
  nearbyHospitals,
  selectedHospital,
  route,
  measureMode,
  measurementPoints,
  onAmbulanceClick,
  onHospitalClick,
  onMapClick,
}) {
  const radiusBounds = (lat, lon, radiusKm) => {
    const latDelta = radiusKm / 111.0;
    const lonScale = Math.max(Math.cos((lat * Math.PI) / 180), 0.2);
    const lonDelta = radiusKm / (111.0 * lonScale);
    return L.latLngBounds(
      [lat - latDelta, lon - lonDelta],
      [lat + latDelta, lon + lonDelta]
    );
  };

  const fitBounds = useMemo(() => {
    if (selectedDistricts?.length && districts) {
      const selectedNames = new Set(selectedDistricts.map((name) => name.toLowerCase()));
      let bounds = null;

      districts.features.forEach((feature) => {
        if (selectedNames.has(feature.properties.name?.toLowerCase())) {
          const layerBounds = L.geoJSON(feature).getBounds();
          bounds = bounds ? bounds.extend(layerBounds) : layerBounds;
        }
      });

      if (bounds?.isValid()) return bounds;
    }
    if (selectedAmbulance?.geometry?.coordinates) {
      const [lon, lat] = selectedAmbulance.geometry.coordinates;
      let bounds = radiusBounds(lat, lon, 50);
      nearbyHospitals?.features?.forEach((feature) => {
        const hospitalBounds = L.latLngBounds(
          [feature.geometry.coordinates[1], feature.geometry.coordinates[0]],
          [feature.geometry.coordinates[1], feature.geometry.coordinates[0]]
        );
        bounds = bounds.extend(hospitalBounds);
      });
      // If a route is present, include its geometry in the bounds so the map fits the route
      if (route?.geometry?.coordinates?.length) {
        const routeBounds = L.latLngBounds(route.geometry.coordinates.map(([rlon, rlat]) => [rlat, rlon]));
        bounds = bounds.extend(routeBounds);
      }
      return bounds;
    }
    if (hotspots?.features?.length) {
      const bounds = L.geoJSON(hotspots).getBounds();
      if (bounds.isValid()) return bounds;
    }
    return null;
  }, [selectedDistricts, districts, selectedAmbulance, nearbyHospitals, route, hotspots]);

  // Expand fitBounds to include route geometry when available
  useEffect(() => {
    // noop - keep hook dependency for linting; actual bounds consumed in FitBounds
  }, [route]);

  const selectedDistrictNames = useMemo(
    () => new Set((selectedDistricts || []).map((name) => name.toLowerCase())),
    [selectedDistricts]
  );

  const districtStyle = (feature) => {
    const isSelected = selectedDistrictNames.has(feature.properties.name?.toLowerCase());
    return {
      color: isSelected ? "#EA580C" : "#94A3B8",
      weight: isSelected ? 3 : 1.4,
      fillOpacity: isSelected ? 0.08 : 0,
      fillColor: isSelected ? "#FDBA74" : "transparent",
      opacity: isSelected ? 0.9 : 0.4,
    };
  };

  const indiaStyle = {
    color: "#8e50b5",
    weight: 1.8,
    fillOpacity: 0,
    fill: false,
    opacity: 0.9,
    lineCap: "round",
    lineJoin: "round",
  };

  const hotspotStyle = {
    color: "#5B21B6",
    weight: 3,
    fillColor: "#8B5CF6",
    fillOpacity: 0.57,
    opacity: 1,
  };

  const createAmbulanceIcon = (selected = false) => L.divIcon({
    className: "",
    html: `
      <div class="map-pin map-pin--ambulance ${selected ? "is-selected" : ""}">
        <div class="map-pin__core">
          <svg viewBox="0 0 72 72" aria-hidden="true" focusable="false">
            <path d="M20 38.5c0-1.1.9-2 2-2h21.3l7 7v4.5c0 1.1-.9 2-2 2H22c-1.1 0-2-.9-2-2v-9.5Z" fill="#DC2626"/>
            <path d="M24 35h18.8l5.2 5.2" fill="none" stroke="#991B1B" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
            <path d="M24.4 31.6c0-.9.7-1.6 1.6-1.6h15.1c.6 0 1.2.2 1.7.7l4.7 4.7H24.4v-3.8Z" fill="#FCA5A5"/>
            <rect x="25" y="33" width="9.5" height="5.5" rx="1.2" fill="white"/>
            <path d="M30 45h7" stroke="white" stroke-width="2.4" stroke-linecap="round"/>
            <path d="M33.5 41.5v7" stroke="white" stroke-width="2.4" stroke-linecap="round"/>
            <circle cx="26.5" cy="46.8" r="4.2" fill="#111827"/>
            <circle cx="43.8" cy="46.8" r="4.2" fill="#111827"/>
            <circle cx="26.5" cy="46.8" r="1.7" fill="#F3F4F6"/>
            <circle cx="43.8" cy="46.8" r="1.7" fill="#F3F4F6"/>
          </svg>
        </div>
      </div>
    `,
    iconSize: [54, 54],
    iconAnchor: [27, 50],
    popupAnchor: [0, -42],
  });

  const createHospitalIcon = (levelCode = "L2", selected = false) => {
    const styles = {
      L1: { background: "#B91C1C", border: "#7F1D1D", label: "L1", shape: "shield" },
      L2: { background: "#D97706", border: "#92400E", label: "L2", shape: "square" },
      L3: { background: "#2563EB", border: "#1D4ED8", label: "L3", shape: "circle" },
    };
    const theme = styles[levelCode] || styles.L2;
    return L.divIcon({
      className: "",
      html: `
        <div class="map-pin map-pin--hospital ${selected ? "is-selected" : ""}">
          <div class="hospital-badge hospital-badge--${theme.shape}" style="background:${theme.background}; border-color:${theme.border};">
            <span class="hospital-badge__label">${theme.label}</span>
          </div>
        </div>
      `,
      iconSize: [27, 27],
      iconAnchor: [13, 24],
      popupAnchor: [0, -20],
    });
  };

  const selectedAmbulanceCoords = selectedAmbulance?.geometry?.coordinates;

  return (
    <MapContainer center={HARYANA_CENTER} zoom={HARYANA_ZOOM} scrollWheelZoom>
      <TileLayer
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
      />

      <FitBounds bounds={fitBounds} />

      {indiaBoundary && (
        <GeoJSON
          key="india-boundary"
          data={indiaBoundary}
          style={indiaStyle}
        />
      )}

      {selectedAmbulanceCoords && (
        <Circle
          center={[selectedAmbulanceCoords[1], selectedAmbulanceCoords[0]]}
          radius={50000}
          pathOptions={{ color: "#E11D48", fillColor: "#E11D48", fillOpacity: 0.04, weight: 1.2, dashArray: "6 8" }}
        />
      )}

      {districts && (
        <GeoJSON
          key={`districts-${districtLayerKey || "all"}`}
          data={districts}
          style={districtStyle}
        />
      )}

      {hotspots && (
        <Pane name="hotspots" style={{ zIndex: 450 }}>
          <GeoJSON
            key={`super-hotspots-${hotspotLayerKey || "initial"}`}
            data={hotspots}
            style={hotspotStyle}
            onEachFeature={(feature, layer) => {
              const properties = feature.properties || {};
              layer.bindPopup(`
                <div class="marker-popup">
                  <strong>Super hotspot ${properties.final_id || properties.hotspot_id}</strong>
                  <div class="meta">${properties.state_name || ""} · ${properties.hotspot_district || ""}</div>
                  <div class="meta">Crashes: ${properties.total_crashes ?? "—"} · Fatalities: ${properties.fatalities ?? "—"}</div>
                  <div class="meta">Ambulances in polygon: ${properties.matched_ambulance_count ?? 0}</div>
                </div>
              `);
            }}
          />
        </Pane>
      )}

      {hotspots?.features?.length > 0 && (
        <div className="map-legend">
          <div className="map-legend__row">
            <span className="map-legend__swatch map-legend__swatch--hotspot" />
            <span>Super-hotspot polygon ({hotspots.features.length})</span>
          </div>
          <div className="map-legend__row">
            <span className="map-legend__swatch map-legend__swatch--ambulance" />
            <span>Ambulance</span>
          </div>
        </div>
      )}

      {ambulances?.features?.map((f) => (
        <Marker
          key={`amb-${f.properties.unique_id}`}
          position={[f.geometry.coordinates[1], f.geometry.coordinates[0]]}
          icon={createAmbulanceIcon(selectedAmbulance?.properties.unique_id === f.properties.unique_id)}
          eventHandlers={{ click: () => onAmbulanceClick(f) }}
        >
          <Popup>
            <div className="marker-popup">
              <strong>Ambulance #{f.properties.unique_id}</strong>
              <div className="meta">
                {f.properties.district} · {f.properties.day} · {f.properties.time_period}
              </div>
              <div className="meta">{f.properties.address}</div>
            </div>
          </Popup>
        </Marker>
      ))}

      {selectedAmbulance && nearbyHospitals?.features?.map((feature) => (
        <Marker
          key={`hosp-${feature.properties.hospital_id}`}
          position={[feature.geometry.coordinates[1], feature.geometry.coordinates[0]]}
          icon={createHospitalIcon(feature.properties.level_code, selectedHospital?.properties?.hospital_id === feature.properties.hospital_id)}
          eventHandlers={{ click: () => onHospitalClick(feature) }}
        >
          <Popup>
            <div className="marker-popup marker-popup--hospital">
              <strong>{feature.properties.hospital_name}</strong>
              <div className="meta">
                {feature.properties.district} · {feature.properties.hospital_type}
              </div>
              <div className="meta">{feature.properties.level_code} · {feature.properties.level_label}</div>
              <div className="meta">Distance: {Number(feature.properties.distance_km || 0).toFixed(1)} km</div>
            </div>
          </Popup>
        </Marker>
      ))}

      {route?.geometry?.coordinates && (
        <Polyline
          positions={route.geometry.coordinates.map(([lon, lat]) => [lat, lon])}
          pathOptions={{ color: "#2563EB", weight: 5, opacity: 0.85 }}
        />
      )}

      {/* Draw start/end markers for the active route for visual clarity */}
      {route?.geometry?.coordinates?.length > 0 && (
        (() => {
          const coords = route.geometry.coordinates;
          const [startLon, startLat] = coords[0];
          const [endLon, endLat] = coords[coords.length - 1];
          const startIcon = L.divIcon({
            className: "",
            html: `<div class="map-pin map-pin--route-start"><div class="map-pin__core">▶</div></div>`,
            iconSize: [28, 28],
            iconAnchor: [14, 14],
          });
          const endIcon = L.divIcon({
            className: "",
            html: `<div class="map-pin map-pin--route-end"><div class="map-pin__core">■</div></div>`,
            iconSize: [24, 24],
            iconAnchor: [12, 12],
          });

          return (
            <>
              <Marker
                key="route-start"
                position={[startLat, startLon]}
                icon={startIcon}
              />
              <Marker
                key="route-end"
                position={[endLat, endLon]}
                icon={endIcon}
              />
            </>
          );
        })()
      )}

      {measurementPoints?.length === 2 && (
        <Polyline
          positions={measurementPoints.map((point) => [point.lat, point.lng])}
          pathOptions={{ color: "#F59E0B", weight: 4, opacity: 0.8, dashArray: "8 6" }}
        />
      )}

      {measurementPoints?.map((point, idx) => (
        <CircleMarker
          key={`measure-${idx}`}
          center={[point.lat, point.lng]}
          radius={7}
          pathOptions={{ color: "#111827", fillColor: "#F59E0B", fillOpacity: 1, weight: 2 }}
        >
          <Popup>{`Point ${idx + 1}: ${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`}</Popup>
        </CircleMarker>
      ))}

      <MapClickHandler measureMode={measureMode} onMapClick={onMapClick} />
    </MapContainer>
  );
}
