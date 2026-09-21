import React, { useState, useMemo } from "react"
import type { ImportPreviewRow, ImportPreviewSummary, ClientImportCommitItem } from "@/lib/import/types"
import ImportRowCard from "./ImportRowCard"
import { resolveCommittedFields } from "@/lib/import/validation"

interface ImportPreviewProps {
  summary: ImportPreviewSummary
  rows: ImportPreviewRow[]
  onUpdateRows: (newRows: ImportPreviewRow[]) => void
  onCommit: (clientsToCommit: ClientImportCommitItem[]) => Promise<void>
  onBack: () => void
  isSubmitting: boolean
  error: string | null
}

export default function ImportPreview({
  summary,
  rows,
  onUpdateRows,
  onCommit,
  onBack,
  isSubmitting,
  error,
}: ImportPreviewProps) {
  const [activeTab, setActiveTab] = useState<"all" | "ready" | "duplicates" | "review">("all")

  // Toggle individual row inclusion
  const handleToggleInclude = (id: string, include: boolean) => {
    onUpdateRows(rows.map(r => (r.id === id ? { ...r, include } : r)))
  }

  // Handle duplicate resolution (skip vs import_new)
  const handleResolveDuplicate = (id: string, resolution: "skip" | "import_new") => {
    onUpdateRows(
      rows.map(r => {
        if (r.id === id) {
          return {
            ...r,
            duplicateResolution: resolution,
            include: resolution === "import_new",
          }
        }
        return r
      })
    )
  }

  // Update business name (for missing names or corrections)
  const handleUpdateBusinessName = (id: string, name: string) => {
    onUpdateRows(
      rows.map(r => {
        if (r.id === id) {
          const updatedNormalized = { ...r.normalized, business_name: name }
          return {
            ...r,
            editedBusinessName: name,
            normalized: updatedNormalized,
            missingName: false,
            include: true,
            status: r.duplicate.isDuplicate
              ? "POSSIBLE_DUPLICATE"
              : r.aiDerived
              ? "READY"
              : "READY_WITHOUT_ENRICHMENT",
          }
        }
        return r
      })
    )
  }

  // Select all / Deselect all
  const handleSelectAll = (select: boolean) => {
    onUpdateRows(
      rows.map(r => {
        if (r.missingName && select) return r // do not select rows missing names
        if (r.duplicate.isDuplicate && select && r.duplicateResolution === "skip") {
          return { ...r, include: true, duplicateResolution: "import_new" }
        }
        return { ...r, include: select }
      })
    )
  }

  // Filter rows based on selected tab
  const filteredRows = useMemo(() => {
    switch (activeTab) {
      case "ready":
        return rows.filter(r => !r.missingName && !r.duplicate.isDuplicate)
      case "duplicates":
        return rows.filter(r => r.duplicate.isDuplicate)
      case "review":
        return rows.filter(r => r.missingName)
      case "all":
      default:
        return rows
    }
  }, [rows, activeTab])

  // Calculate clients ready to commit
  const clientsToCommit = useMemo(() => {
    const list: ClientImportCommitItem[] = []

    for (const r of rows) {
      // Must be included
      if (!r.include) continue

      // Must not be missing name
      const name = (r.editedBusinessName || r.normalized.business_name || "").trim()
      if (!name) continue

      // If duplicate, only include if user chose "import_new"
      if (r.duplicate.isDuplicate && r.duplicateResolution !== "import_new") continue

      list.push({
        business_name: name,
        maps_url: r.sourceFacts.maps_url,
        lat: r.normalized.lat,
        lng: r.normalized.lng,
        general_notes: r.sourceFacts.general_notes,
        phone: r.sourceFacts.phone,
        address: r.sourceFacts.address,
        ...resolveCommittedFields(r.sourceFacts, r.aiDerived),
        status: "prospect",
        duplicateResolution: r.duplicateResolution,
      })
    }

    return list
  }, [rows])

  const readyTotal = rows.filter(r => !r.missingName && !r.duplicate.isDuplicate).length
  const dupTotal = rows.filter(r => r.duplicate.isDuplicate).length
  const reviewTotal = rows.filter(r => r.missingName).length

  return (
    <div className="import-preview-container">
      {/* Top Summary Metrics */}
      <div className="imp-summary-bar">
        <div className="imp-summary-stat">
          <span className="imp-stat-val">{rows.length}</span>
          <span className="imp-stat-label">rreshta gjithsej</span>
        </div>
        <div className="imp-summary-divider" />
        <div className="imp-summary-stat is-ready">
          <span className="imp-stat-val">{readyTotal}</span>
          <span className="imp-stat-label">gati</span>
        </div>
        <div className="imp-summary-divider" />
        <div className="imp-summary-stat is-dup">
          <span className="imp-stat-val">{dupTotal}</span>
          <span className="imp-stat-label">duplikatë</span>
        </div>
        <div className="imp-summary-divider" />
        <div className="imp-summary-stat is-review">
          <span className="imp-stat-val">{reviewTotal}</span>
          <span className="imp-stat-label">kërkojnë shqyrtim</span>
        </div>
      </div>

      {error && (
        <div className="imp-error-banner" role="alert">
          {error}
        </div>
      )}

      {/* Tabs & Bulk Actions */}
      <div className="imp-controls-bar">
        <div className="imp-tabs">
          <button
            type="button"
            className={`imp-tab ${activeTab === "all" ? "active" : ""}`}
            onClick={() => setActiveTab("all")}
          >
            Të gjitha ({rows.length})
          </button>
          <button
            type="button"
            className={`imp-tab ${activeTab === "ready" ? "active" : ""}`}
            onClick={() => setActiveTab("ready")}
          >
            Gati ({readyTotal})
          </button>
          <button
            type="button"
            className={`imp-tab ${activeTab === "duplicates" ? "active" : ""}`}
            onClick={() => setActiveTab("duplicates")}
          >
            Duplikatë ({dupTotal})
          </button>
          <button
            type="button"
            className={`imp-tab ${activeTab === "review" ? "active" : ""}`}
            onClick={() => setActiveTab("review")}
          >
            Pa emër ({reviewTotal})
          </button>
        </div>

        <div className="imp-bulk-actions">
          <button
            type="button"
            className="imp-bulk-btn"
            onClick={() => handleSelectAll(true)}
            title="Përzgjidh të gjitha rreshtat e vlefshëm"
          >
            Zgjidh të gjitha
          </button>
          <button
            type="button"
            className="imp-bulk-btn"
            onClick={() => handleSelectAll(false)}
            title="Hiq përzgjedhjen e të gjithëve"
          >
            Hiq përzgjedhjen
          </button>
        </div>
      </div>

      {/* Rows List */}
      <div className="imp-rows-scroll">
        {filteredRows.length === 0 ? (
          <div className="imp-empty-state">
            Nuk ka rreshta në këtë kategori.
          </div>
        ) : (
          filteredRows.map(row => (
            <ImportRowCard
              key={row.id}
              row={row}
              onToggleInclude={handleToggleInclude}
              onResolveDuplicate={handleResolveDuplicate}
              onUpdateBusinessName={handleUpdateBusinessName}
            />
          ))
        )}
      </div>

      {/* Footer Action Bar */}
      <div className="imp-footer">
        <button
          type="button"
          className="imp-btn-back"
          onClick={onBack}
          disabled={isSubmitting}
        >
          ← Ndrysho burimin
        </button>

        <div className="imp-footer-right">
          <span className="imp-commit-count-hint">
            Do të ruhen <strong>{clientsToCommit.length}</strong> klientë
          </span>
          <button
            type="button"
            className="imp-btn-commit"
            onClick={() => onCommit(clientsToCommit)}
            disabled={clientsToCommit.length === 0 || isSubmitting}
          >
            {isSubmitting ? (
              "Duke ruajtur në EYE…"
            ) : (
              `Importo ${clientsToCommit.length} klientë`
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
