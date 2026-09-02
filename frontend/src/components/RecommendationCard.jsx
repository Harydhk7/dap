import React from "react";

function getTplForFeature(feature) {
  const levelCode = feature?.properties?.level_code;
  if (levelCode === "L1") return Number(feature?.properties?.avg_tertiary || 0).toFixed(1);
  if (levelCode === "L2") return Number(feature?.properties?.avg_secondary || 0).toFixed(1);
  return Number(feature?.properties?.avg_primary || 0).toFixed(1);
}

function getDecisionTone(kind = "direct") {
  if (kind === "stabilize_then_transfer") return "warning";
  if (kind === "direct_within_window") return "success";
  return "danger";
}

export default function RecommendationCard({
  ambulance,
  injuryOptions = [],
  selectedInjuryKey,
  onInjuryKeyChange,
  recommendation,
  onClose,
  onSelectHospital,
}) {
  if (!ambulance) return null;

  const injury = recommendation?.injury || injuryOptions.find((item) => item.key === selectedInjuryKey) || injuryOptions[0];
  const decision = recommendation?.decision;
  const topHospitals = recommendation?.top_hospitals || [];
  const decisionTone = getDecisionTone(decision?.kind);

  return (
    <div className="detail-card recommendation-card">
      <div className="detail-card__header">
        <div className="detail-card__title-wrap">
          <div className="detail-card__title">Ambulance #{ambulance.properties.unique_id}</div>
          <div className="detail-card__subtitle">Smart routing within 50 km</div>
        </div>
        <div className="detail-card__header-actions">
          <button
            type="button"
            className="detail-card__close"
            onClick={onClose}
            aria-label="Close recommendation card"
          >
            ×
          </button>
        </div>
      </div>

      <div className="detail-section-title">Patient injury</div>
      <div className="recommendation-select-wrap">
        <select
          className="recommendation-select"
          value={selectedInjuryKey}
          onChange={(event) => onInjuryKeyChange(event.target.value)}
        >
          {injuryOptions.map((item) => (
            <option key={item.key} value={item.key}>
              {item.label} → L{item.required_level} ({item.safe_window_min}-min window)
            </option>
          ))}
        </select>
      </div>

      {decision && (
        <div className={`recommendation-alert recommendation-alert--${decisionTone}`}>
          <div className="recommendation-alert__title">{decision.title}</div>
          <div className="recommendation-alert__body">{decision.message}</div>
        </div>
      )}

      <div className="detail-section-title">Top hospital per level</div>
      <div className="recommendation-list">
        {topHospitals.length ? topHospitals.map((feature) => {
          const props = feature.properties || {};
          const isRecommended = Boolean(props.is_recommended);
          const tpl = getTplForFeature(feature);

          return (
            <button
              type="button"
              key={props.hospital_id}
              className={`recommendation-row ${isRecommended ? "is-recommended" : ""}`}
              onClick={() => onSelectHospital(feature)}
            >
              <div className="recommendation-row__top">
                <div className="recommendation-level-chip">
                  {props.level_code}
                </div>
                <div className="recommendation-row__title">
                  {isRecommended ? <span className="recommendation-row__star">★</span> : null}
                  <span>{props.hospital_name}</span>
                </div>
              </div>
              <div className="recommendation-row__meta">
                <span>{props.hospital_type}</span>
                <span>TPL {tpl}%</span>
              </div>
              <div className="recommendation-row__meta recommendation-row__meta--secondary">
                <span>🛣 {Number(props.distance_km || 0).toFixed(2)} km</span>
                <span>⏱ {Number(props.estimated_minutes || props.distance_km || 0).toFixed(1)} min</span>
              </div>
            </button>
          );
        }) : (
          <div className="recommendation-empty">No nearby hospitals found within the search radius.</div>
        )}
      </div>
    </div>
  );
}
