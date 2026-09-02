import React, { useEffect, useMemo, useRef, useState } from "react";

function CheckboxFilter({ label, options, value, onChange, emptyLabel, searchable = false }) {
  const [query, setQuery] = useState("");
  const selectedValues = Array.isArray(value) ? value : [];
  const visibleOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return options;
    return options.filter((option) => option.toLowerCase().includes(term));
  }, [options, query]);

  const toggleValue = (item) => {
    if (selectedValues.includes(item)) {
      onChange(selectedValues.filter((existing) => existing !== item));
      return;
    }
    onChange([...selectedValues, item]);
  };

  return (
    <div className="filter-group">
      <label className="filter-label">{label}</label>
      {searchable && (
        <input
          className="filter-search"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${label.toLowerCase()}...`}
        />
      )}
      <div className="checkbox-list">
        {visibleOptions.map((option) => (
          <label key={option} className="checkbox-item">
            <input
              type="checkbox"
              checked={selectedValues.includes(option)}
              onChange={() => toggleValue(option)}
            />
            <span>{option}</span>
          </label>
        ))}
      </div>
      <div className="filter-meta">
        {selectedValues.length ? `${selectedValues.length} selected` : emptyLabel}
      </div>
    </div>
  );
}

function ButtonFilter({ label, options, value, onChange, emptyLabel }) {
  const selectedValues = Array.isArray(value) ? value : [];

  const toggleValue = (item) => {
    if (selectedValues.includes(item)) {
      onChange(selectedValues.filter((existing) => existing !== item));
      return;
    }
    onChange([...selectedValues, item]);
  };

  return (
    <div className="filter-group">
      <label className="filter-label">{label}</label>
      <div className="button-group">
        {options.map((option) => (
          <button
            type="button"
            key={option}
            className={`toggle-pill ${selectedValues.includes(option) ? "is-active" : ""}`}
            onClick={() => toggleValue(option)}
          >
            {option}
          </button>
        ))}
      </div>
      <div className="filter-meta">
        {selectedValues.length ? `${selectedValues.length} selected` : emptyLabel}
      </div>
    </div>
  );
}

function DistrictDropdown({ options, value, onChange }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef(null);
  const selectedValues = Array.isArray(value) ? value : [];

  const visibleOptions = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return options;
    return options.filter((option) => option.toLowerCase().includes(term));
  }, [options, query]);

  const toggleValue = (item) => {
    if (selectedValues.includes(item)) {
      onChange(selectedValues.filter((existing) => existing !== item));
      return;
    }
    onChange([...selectedValues, item]);
  };

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setOpen(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("touchstart", handlePointerDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("touchstart", handlePointerDown);
    };
  }, [open]);

  return (
    <div className="filter-group filter-group--district" ref={dropdownRef}>
      <label className="filter-label">District</label>
      <button
        type="button"
        className={`district-trigger ${open ? "is-open" : ""}`}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="district-trigger__summary">
          {selectedValues.length ? `${selectedValues.length} selected` : "All districts"}
        </span>
        <span className="district-trigger__caret">▾</span>
      </button>

      {open && (
        <div className="district-dropdown">
          {selectedValues.length > 0 && (
            <div className="district-dropdown__selected">
              <SelectedChips
                label="Selected districts"
                values={selectedValues}
                onRemove={(item) => onChange(selectedValues.filter((existing) => existing !== item))}
                onClear={() => onChange([])}
              />
            </div>
          )}
          <input
            className="filter-search"
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search districts..."
          />
          <div className="checkbox-list">
            {visibleOptions.map((option) => (
              <label key={option} className="checkbox-item">
                <input
                  type="checkbox"
                  checked={selectedValues.includes(option)}
                  onChange={() => toggleValue(option)}
                />
                <span>{option}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="filter-meta">
        {selectedValues.length ? `${selectedValues.length} selected` : "All districts"}
      </div>
    </div>
  );
}

function SelectedChips({ label, values, onRemove, onClear }) {
  if (!values.length) return null;

  return (
    <div className="selected-block">
      <div className="selected-block__head">
        <span>{label} ({values.length})</span>
        <button type="button" className="text-button" onClick={onClear}>Clear</button>
      </div>
      <div className="chip-row">
        {values.map((value) => (
          <button
            type="button"
            key={value}
            className="chip"
            onClick={() => onRemove(value)}
          >
            {value} <span aria-hidden="true">×</span>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function Sidebar({
  filterOptions,
  filters,
  onChange,
  onClear,
  count,
  uniqueCount,
  selectedAmbulance,
}) {
  const { states = [], districts = [], days = [], time_periods = [] } = filterOptions || {};
  const orderedTimePeriods = [...time_periods].sort((a, b) => {
    const parsePeriod = (value) => {
      const hourPart = String(value || "").split("-")[0].trim().toUpperCase();
      const match = hourPart.match(/^(\d{1,2})\s*(AM|PM)$/);
      if (!match) return 999;
      let hour = Number(match[1]) % 12;
      if (match[2] === "PM") hour += 12;
      return hour;
    };
    return parsePeriod(a) - parsePeriod(b);
  });

  return (
    <aside className="sidebar">
      <div className="sidebar-summary">
        <div className="count-badge">
          <span className="count-num">{count}</span> Minimum Number of Ambulances Required for Vehicular Trauma
          <div className="count-badge__sub">
            Unique ambulances: <strong>{uniqueCount ?? 0}</strong>
          </div>
        </div>

        <div className="legend-card">
          <div className="legend-card__title">Legend</div>
          <div className="legend-list">
            <div className="legend-item">
              <span className="legend-mark legend-mark--ambulance" aria-hidden="true">
                <svg viewBox="0 0 72 72" focusable="false" aria-hidden="true">
                  <path d="M20 38.5c0-1.1.9-2 2-2h21.3l7 7v4.5c0 1.1-.9 2-2 2H22c-1.1 0-2-.9-2-2v-9.5Z" fill="#DC2626"/>
                  <path d="M24 35h18.8l5.2 5.2" fill="none" stroke="#991B1B" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round"/>
                  <path d="M24.4 31.6c0-.9.7-1.6 1.6-1.6h15.1c.6 0 1.2.2 1.7.7l4.7 4.7H24.4v-3.8Z" fill="#FCA5A5"/>
                  <rect x="25" y="33" width="9.5" height="5.5" rx="1.2" fill="white"/>
                  <path d="M30 45h7" stroke="white" strokeWidth="2.4" strokeLinecap="round"/>
                  <path d="M33.5 41.5v7" stroke="white" strokeWidth="2.4" strokeLinecap="round"/>
                  <circle cx="26.5" cy="46.8" r="4.2" fill="#111827"/>
                  <circle cx="43.8" cy="46.8" r="4.2" fill="#111827"/>
                  <circle cx="26.5" cy="46.8" r="1.7" fill="#F3F4F6"/>
                  <circle cx="43.8" cy="46.8" r="1.7" fill="#F3F4F6"/>
                </svg>
              </span>
              Ambulance
            </div>
            <div className="legend-item">
              <span className="legend-mark legend-mark--l1">L1</span>
              Tertiary Hospital
            </div>
            <div className="legend-item">
              <span className="legend-mark legend-mark--l2">L2</span>
              Secondary Hospital
            </div>
            <div className="legend-item">
              <span className="legend-mark legend-mark--l3">L3</span>
              Primary Hospital
            </div>
          </div>
        </div>
      </div>

      <h3>Filters</h3>

      <div className="filter-group">
        <label className="filter-label">State</label>
        <select
          className="filter-select"
          value={filters.state || "All"}
          onChange={(e) => onChange("state", e.target.value)}
        >
          <option value="All">All States</option>
          {states.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
      </div>

      <DistrictDropdown
        options={districts}
        value={filters.district}
        onChange={(value) => onChange("district", value)}
      />

      <ButtonFilter
        label="Day"
        options={days}
        value={filters.day}
        onChange={(value) => onChange("day", value)}
        emptyLabel="All days"
      />

      <ButtonFilter
        label="Time Period"
        options={orderedTimePeriods}
        value={filters.time_period}
        onChange={(value) => onChange("time_period", value)}
        emptyLabel="All time periods"
      />

      <button className="btn btn-secondary" onClick={onClear}>Clear filters</button>
    </aside>
  );
}
