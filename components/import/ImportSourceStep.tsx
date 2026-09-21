import React, { useState, useRef } from "react"
import { isAllowedGoogleSheetsUrl } from "@/lib/import/google-sheet"

interface ImportSourceStepProps {
  onAnalyzeGoogleSheet: (url: string) => Promise<void>
  onUploadFile: (file: File) => Promise<void>
  isLoading: boolean
  error: string | null
}

export default function ImportSourceStep({
  onAnalyzeGoogleSheet,
  onUploadFile,
  isLoading,
  error,
}: ImportSourceStepProps) {
  const [googleUrl, setGoogleUrl] = useState("")
  const [urlError, setUrlError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleGoogleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setUrlError(null)

    const trimmed = googleUrl.trim()
    if (!trimmed) {
      setUrlError("Ju lutem vendosni një link të Google Sheets.")
      return
    }

    if (!isAllowedGoogleSheetsUrl(trimmed)) {
      setUrlError("Linku duhet të jetë një Google Sheet publik (https://docs.google.com/spreadsheets/d/...).")
      return
    }

    await onAnalyzeGoogleSheet(trimmed)
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (file) {
      validateAndUpload(file)
    }
  }

  const validateAndUpload = (file: File) => {
    const lower = file.name.toLowerCase()
    if (!lower.endsWith(".csv") && !lower.endsWith(".xlsx")) {
      setUrlError("Formati nuk mbështetet. Ngarkoni vetëm skedarë .csv ose .xlsx.")
      return
    }

    if (file.size > 5 * 1024 * 1024) {
      setUrlError("Madhësia e skedarit tejkalon 5 MB.")
      return
    }

    onUploadFile(file)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) {
      validateAndUpload(file)
    }
  }

  return (
    <div className="import-source-step">
      {/* Subtitle / Policy description */}
      <div className="iss-intro">
        <p className="iss-desc">
          Importoni klientë nga Google Sheets ose skedar CSV / Excel. Të dhënat do të
          normalizohen, do të kontrollohen për duplikata dhe do të pasurohen me inteligjencë para ruajtjes.
        </p>
      </div>

      {(error || urlError) && (
        <div className="iss-error-banner" role="alert">
          {error || urlError}
        </div>
      )}

      {isLoading ? (
        <div className="iss-loading-state">
          <div className="iss-spinner" />
          <div className="iss-loading-text">Duke lexuar dhe analizuar të dhënat…</div>
          <div className="iss-loading-sub">Verifikimi i duplikatave dhe klasifikimi i kategorive</div>
        </div>
      ) : (
        <div className="iss-cards-container">
          {/* Card 1: Google Sheets URL */}
          <div className="iss-card">
            <div className="iss-card-header">
              <span className="iss-card-badge">OPSIONI 1</span>
              <h3 className="iss-card-title">Google Sheets</h3>
            </div>
            <p className="iss-card-sub">
              Ngjitni linkun e një Google Sheet publik (Anyone with the link can view).
            </p>

            <form onSubmit={handleGoogleSubmit} className="iss-form">
              <div className="iss-input-wrap">
                <input
                  type="url"
                  value={googleUrl}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  onChange={e => {
                    setGoogleUrl(e.target.value)
                    setUrlError(null)
                  }}
                  className="iss-input"
                  disabled={isLoading}
                />
              </div>
              <button
                type="submit"
                className="iss-btn-submit"
                disabled={!googleUrl.trim() || isLoading}
              >
                Analizo Google Sheet
              </button>
            </form>
          </div>

          <div className="iss-divider">
            <span className="iss-divider-text">OSE</span>
          </div>

          {/* Card 2: File Upload (CSV / XLSX) */}
          <div className="iss-card">
            <div className="iss-card-header">
              <span className="iss-card-badge">OPSIONI 2</span>
              <h3 className="iss-card-title">Skedar CSV / XLSX</h3>
            </div>
            <p className="iss-card-sub">
              Tërhiqni skedarin këtu ose klikoni për ta ngarkuar (maksimumi 5 MB, 500 rreshta).
            </p>

            <div
              className={`iss-dropzone ${isDragOver ? "is-dragover" : ""}`}
              onDragOver={e => {
                e.preventDefault()
                setIsDragOver(true)
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={handleDrop}
              onClick={() => fileInputRef.current?.click()}
              role="button"
              tabIndex={0}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv, .xlsx"
                onChange={handleFileChange}
                style={{ display: "none" }}
              />
              <div className="iss-drop-icon">
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="17 8 12 3 7 8" />
                  <line x1="12" y1="3" x2="12" y2="15" />
                </svg>
              </div>
              <span className="iss-drop-prompt">Zgjidhni skedar CSV ose XLSX</span>
              <span className="iss-drop-hint">Mbështeten emër, link i vendndodhjes, shënime</span>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
