import React, { useRef, useState } from "react"
import { useApp } from "@/contexts/AppContext"
import type { ImportPreviewRow, ImportPreviewSummary, ClientImportCommitItem } from "@/lib/import/types"
import ImportSourceStep from "./ImportSourceStep"
import ImportPreview from "./ImportPreview"

export default function ImportModal() {
  const { closeImportModal, loadClients, toast } = useApp()

  const [step, setStep] = useState<"source" | "preview" | "confirm">("source")
  const [summary, setSummary] = useState<ImportPreviewSummary | null>(null)
  const [rows, setRows] = useState<ImportPreviewRow[]>([])
  const [headerMapping, setHeaderMapping] = useState<Record<string, string>>({})
  const [ignoredHeaders, setIgnoredHeaders] = useState<string[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pendingClients, setPendingClients] = useState<ClientImportCommitItem[] | null>(null)
  const commitInFlight = useRef(false)

  const requestCommit = (clientsToCommit: ClientImportCommitItem[]) => {
    if (isSubmitting || clientsToCommit.length === 0) return
    setPendingClients(clientsToCommit)
    setError(null)
    setStep("confirm")
  }

  // 1. Analyze Google Sheet
  const handleAnalyzeGoogleSheet = async (url: string) => {
    setIsLoading(true)
    setError(null)

    try {
      const res = await fetch("/api/import/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "google_sheet", url }),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || "Dështoi analiza e Google Sheet.")
      }

      setSummary(data.summary)
      setRows(data.rows)
      setHeaderMapping(data.headerMapping || {})
      setIgnoredHeaders(data.ignoredHeaders || [])
      setStep("preview")
    } catch (err: any) {
      setError(err.message || "Ndodhi një gabim i papritur.")
    } finally {
      setIsLoading(false)
    }
  }

  // 2. Analyze Uploaded File (CSV or XLSX)
  const handleUploadFile = async (file: File) => {
    setIsLoading(true)
    setError(null)

    try {
      const formData = new FormData()
      formData.append("file", file)

      const res = await fetch("/api/import/preview", {
        method: "POST",
        body: formData,
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || "Dështoi leximi i skedarit.")
      }

      setSummary(data.summary)
      setRows(data.rows)
      setHeaderMapping(data.headerMapping || {})
      setIgnoredHeaders(data.ignoredHeaders || [])
      setStep("preview")
    } catch (err: any) {
      setError(err.message || "Ndodhi një gabim i papritur gjatë leximit.")
    } finally {
      setIsLoading(false)
    }
  }

  // 3. Commit clean clients to Supabase
  const handleCommit = async (clientsToCommit: ClientImportCommitItem[]) => {
    if (commitInFlight.current || !pendingClients || clientsToCommit !== pendingClients || clientsToCommit.length === 0) return
    commitInFlight.current = true
    setIsSubmitting(true)
    setError(null)

    try {
      const res = await fetch("/api/import/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: clientsToCommit }),
      })

      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || "Dështoi ruajtja e klientëve.")
      }

      if (data.failed > 0 && data.imported === 0) {
        throw new Error(`Importimi dështoi: ${data.errors.join("; ")}`)
      }

      // Success: reload clients and show toast
      await loadClients()
      toast(`U importuan me sukses ${data.imported} klientë.`)
      closeImportModal()
    } catch (err: any) {
      setError(err.message || "Ndodhi një gabim gjatë ruajtjes.")
    } finally {
      commitInFlight.current = false
      setIsSubmitting(false)
    }
  }

  const closeSafely = () => {
    if (!commitInFlight.current) closeImportModal()
  }

  return (
    <div
      className="modal-card import-modal-card"
      onClick={e => e.stopPropagation()}
      role="dialog"
      aria-modal="true"
      aria-labelledby="import-modal-title"
    >
      {/* Mobile Handle Bar */}
      <div className="modal-handle-bar" onClick={closeSafely} aria-label="Mbyll dritaren">
        <span className="modal-handle-pill" />
      </div>

      {/* Header */}
      <div className="modal-header">
        <div className="modal-header-left">
          <span className="imp-title-tag">IMPORT INBOX</span>
          <h2 id="import-modal-title">
            {step === "source" ? "Importo të dhëna klientësh" : step === "confirm" ? "Konfirmo importin" : "Shqyrtimi para importit"}
          </h2>
        </div>
        <button
          type="button"
          className="modal-close"
          onClick={closeSafely}
          disabled={isSubmitting}
          aria-label="Mbyll"
        >
          ✕
        </button>
      </div>

      {/* Modal Body */}
      <div className="modal-body import-modal-body">
        {step === "source" ? (
          <ImportSourceStep
            onAnalyzeGoogleSheet={handleAnalyzeGoogleSheet}
            onUploadFile={handleUploadFile}
            isLoading={isLoading}
            error={error}
          />
        ) : step === "confirm" && pendingClients ? (
          <div className="imp-confirm" onKeyDownCapture={event => {
            if (event.key === "Enter") event.preventDefault()
          }}>
            <div className="imp-confirm-content">
              <span className="imp-title-tag">KONFIRMIMI FINAL</span>
              <h3>Importoni {pendingClients.length} {pendingClients.length === 1 ? "klient" : "klientë"}?</h3>
              <p>Ky veprim shkruan <strong>{pendingClients.length} {pendingClients.length === 1 ? "klient" : "klientë"}</strong> në databazën e klientëve të EYE.</p>
              <p>Kontrolloni numrin dhe të dhënat në shqyrtim përpara konfirmimit.</p>
              {error && <div className="imp-error-banner" role="alert">{error}</div>}
            </div>
            <div className="imp-confirm-actions">
              <button type="button" className="imp-btn-back" onClick={() => {
                setStep("preview")
                setPendingClients(null)
                setError(null)
              }} disabled={isSubmitting}>← Kthehu te shqyrtimi</button>
              <button type="button" className="imp-btn-back" onClick={closeSafely} disabled={isSubmitting}>Anulo</button>
              <button type="button" className="imp-btn-commit" onClick={() => void handleCommit(pendingClients)} disabled={isSubmitting}>
                {isSubmitting ? "Duke ruajtur në EYE…" : `Konfirmo importin e ${pendingClients.length} ${pendingClients.length === 1 ? "klienti" : "klientëve"}`}
              </button>
            </div>
          </div>
        ) : summary ? (
          <ImportPreview
            summary={summary}
            rows={rows}
            headerMapping={headerMapping}
            ignoredHeaders={ignoredHeaders}
            onUpdateRows={setRows}
            onRequestCommit={requestCommit}
            onBack={() => {
              setStep("source")
              setError(null)
            }}
            isSubmitting={isSubmitting}
            error={error}
          />
        ) : null}
      </div>
    </div>
  )
}
