import React, { useState, useRef } from "react";
import { api } from "../api/client.js";

export default function UploadModal({ onClose, onUploaded }) {
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState(null);
  const inputRef = useRef();

  const handleFile = async (file) => {
    if (!file) return;
    if (!file.name.match(/\.xlsx$/i)) {
      setError("Only .xlsx files are accepted");
      return;
    }
    setError(null);
    setUploading(true);
    try {
      const result = await api.uploadAmbulances(file);
      onUploaded(result.inserted_or_updated);
      onClose();
    } catch (e) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>Upload ambulance Excel</h3>

        <div
          className={`drop-zone ${dragOver ? "dragover" : ""}`}
          onClick={() => inputRef.current.click()}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            handleFile(e.dataTransfer.files[0]);
          }}
        >
          {uploading ? (
            <><span className="spinner"/> Uploading…</>
          ) : (
            <>Drag &amp; drop <strong>.xlsx</strong> here or click to browse</>
          )}
        </div>

        <input
          ref={inputRef}
          type="file"
          accept=".xlsx"
          style={{ display: "none" }}
          onChange={(e) => handleFile(e.target.files[0])}
        />

        {error && <div style={{ marginTop: 12, color: "var(--red)" }}>{error}</div>}

        <div className="upload-sample">
          <div className="upload-sample__head">
            <span>Sample format</span>
            <button type="button" className="text-button" onClick={() => api.downloadUploadTemplate().catch((e) => setError(e.message))}>
              Download template
            </button>
          </div>
          <div className="upload-sample__grid upload-sample__grid--headers">
            <span>Unique ID</span><span>Day</span><span>Time Period</span><span>State</span><span>District</span><span>City</span><span>Postal Code</span><span>Latitude</span><span>Longitude</span><span>Address</span>
          </div>
          <div className="upload-sample__grid">
            <span>1101</span><span>Monday</span><span>12AM - 3AM</span><span>Haryana</span><span>Hisar</span><span>Hisar City</span><span>125001</span><span>29.1492</span><span>75.7217</span><span>Sample ambulance location</span>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
