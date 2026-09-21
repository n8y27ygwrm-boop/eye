import React, { useState } from "react"
import { useApp } from "@/contexts/AppContext"
import type { ImportPreviewRow, ImportPreviewSummary, ClientImportCommitItem } from "@/lib/import/types"
import ImportSourceStep from "./ImportSourceStep"
import ImportPreview from "./ImportPreview"

export default function ImportModal() {
  const { closeImportModal, loadClients, toast } = useApp()

  const [step, setStep] = useState<"source" | "preview">("source")
  const [summary, setSummary] = useState<ImportPreviewSummary | null>(null)
  const [rows, setRows] = useState<ImportPreviewRow[]>([])
  const [isLoading, setIsLoading] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
      setStep("preview")
    } catch (err: any) {
      setError(err.message || "Ndodhi një gabim i papritur gjatë leximit.")
    } finally {
      setIsLoading(false)
    }
  }

  // 3. Commit clean clients to Supabase
  const handleCommit = async (clientsToCommit: ClientImportCommitItem[]) => {
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
      setIsSubmitting(false)
    }
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
      <div className="modal-handle-bar" onClick={closeImportModal} aria-label="Mbyll dritaren">
        <span className="modal-handle-pill" />
      </div>

      {/* Header */}
      <div className="modal-header">
        <div className="modal-header-left">
          <span className="imp-title-tag">IMPORT INBOX</span>
          <h2 id="import-modal-title">
            {step === "source" ? "Importo të dhëna klientësh" : "Shqyrtimi para importit"}
          </h2>
        </div>
        <button
          type="button"
          className="modal-close"
          onClick={closeImportModal}
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
        ) : summary ? (
          <ImportPreview
            summary={summary}
            rows={rows}
            onUpdateRows={setRows}
            onCommit={handleCommit}
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
