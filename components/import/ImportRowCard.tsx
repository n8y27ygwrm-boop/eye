import React, { useState } from "react"
import type { ImportPreviewRow } from "@/lib/import/types"

interface ImportRowCardProps {
  row: ImportPreviewRow
  onToggleInclude: (id: string, include: boolean) => void
  onResolveDuplicate: (id: string, resolution: "skip" | "import_new") => void
  onUpdateBusinessName: (id: string, name: string) => void
}

export default function ImportRowCard({
  row,
  onToggleInclude,
  onResolveDuplicate,
  onUpdateBusinessName,
}: ImportRowCardProps) {
  const [editingName, setEditingName] = useState(row.editedBusinessName || row.normalized.business_name || "")
  const [isEditingName, setIsEditingName] = useState(row.missingName)

  const handleNameSave = () => {
    const trimmed = editingName.trim()
    if (trimmed) {
      onUpdateBusinessName(row.id, trimmed)
      setIsEditingName(false)
    }
  }

  const effectiveName = row.editedBusinessName || row.normalized.business_name || ""
  const isExcluded = !row.include || (row.duplicate.isDuplicate && row.duplicateResolution === "skip")

  return (
    <div className={`import-row-card ${isExcluded ? "is-excluded" : ""} ${row.missingName ? "is-missing-name" : ""} ${row.duplicate.isDuplicate ? "is-duplicate" : ""}`}>
      {/* Card Header */}
      <div className="irc-header">
        <label className="irc-checkbox-label">
          <input
            type="checkbox"
            checked={row.include}
            onChange={e => onToggleInclude(row.id, e.target.checked)}
            className="irc-checkbox"
          />
          <span className="irc-row-num">#{row.source_row_index + 1}</span>
        </label>

        <div className="irc-badges">
          {row.missingName ? (
            <span className="irc-status-badge badge-warning">KËRKON EMËR</span>
          ) : row.duplicate.isDuplicate ? (
            <span className="irc-status-badge badge-duplicate">DUPLIKATË</span>
          ) : row.status === "READY_WITHOUT_ENRICHMENT" ? (
            <span className="irc-status-badge badge-neutral">GATI (PA PASURIM)</span>
          ) : (
            <span className="irc-status-badge badge-ready">GATI</span>
          )}
        </div>
      </div>

      {/* Business Name & Missing Name Resolution */}
      <div className="irc-name-section">
        {row.missingName || isEditingName ? (
          <div className="irc-name-edit">
            <span className="irc-field-label">EMRI I BIZNESIT (I DETYRUESHËM)</span>
            <div className="irc-edit-row">
              <input
                type="text"
                value={editingName}
                placeholder="Vendosni emrin e biznesit…"
                onChange={e => setEditingName(e.target.value)}
                className="irc-input-name"
                autoFocus={row.missingName}
              />
              <button
                type="button"
                className="irc-btn-save-name"
                onClick={handleNameSave}
                disabled={!editingName.trim()}
              >
                Ruaj
              </button>
            </div>
            {row.missingName && (
              <span className="irc-helper-warn">
                Ky rresht nuk ka emër në skedar. Nuk mund të importohet pa plotësuar emrin.
              </span>
            )}
          </div>
        ) : (
          <div className="irc-name-row">
            <h3 className="irc-business-name">{effectiveName}</h3>
            <button
              type="button"
              className="irc-btn-edit-name"
              onClick={() => setIsEditingName(true)}
              title="Ndrysho emrin e biznesit"
            >
              Ndrysho
            </button>
          </div>
        )}
      </div>

      {/* Duplicate Warning & Choice */}
      {row.duplicate.isDuplicate && (
        <div className="irc-duplicate-box">
          <div className="irc-dup-text">
            <strong>Përputhje me:</strong> &ldquo;{row.duplicate.matchedClientName}&rdquo; (
            {row.duplicate.source === "current_batch" ? "në këtë skedar" : "klient ekzistues"}
            {row.duplicate.matchType === "exact_name" && " · sipas emrit të njëjtë"}
            {row.duplicate.matchType === "exact_phone" && " · sipas telefonit"}
            {row.duplicate.matchType === "exact_url" && " · sipas linkut të Maps"}
            {row.duplicate.matchType === "same_coords" && " · sipas koordinatave të njëjta"}
            )
          </div>
          <div className="irc-dup-actions">
            <button
              type="button"
              className={`irc-btn-choice ${row.duplicateResolution === "skip" ? "active" : ""}`}
              onClick={() => onResolveDuplicate(row.id, "skip")}
            >
              Anashkalo (Skip)
            </button>
            <button
              type="button"
              className={`irc-btn-choice ${row.duplicateResolution === "import_new" ? "active" : ""}`}
              onClick={() => onResolveDuplicate(row.id, "import_new")}
            >
              Importo si të ri
            </button>
          </div>
        </div>
      )}

      {/* Source Facts Section */}
      <div className="irc-facts-section">
        <div className="irc-section-title">TË DHËNA NGA SKEDARI (SOURCE FACTS)</div>

        {row.sourceFacts.maps_url ? (
          <div className="irc-fact-item">
            <span className="irc-fact-key">Vendndodhja:</span>
            <a
              href={row.sourceFacts.maps_url}
              target="_blank"
              rel="noopener noreferrer"
              className="irc-link"
              title={row.sourceFacts.maps_url}
            >
              Hap në Google Maps ↗
            </a>
            {row.normalized.lat != null && row.normalized.lng != null ? (
              <span className="irc-coords-pill" title="Koordinatat u lexuan nga linku">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="irc-inline-icon" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>{row.normalized.lat.toFixed(4)}, {row.normalized.lng.toFixed(4)}
              </span>
            ) : (
              <span className="irc-no-coords-pill">Pa koordinata fikse</span>
            )}
          </div>
        ) : (
          <div className="irc-fact-item irc-empty-fact">
            <span className="irc-fact-key">Vendndodhja:</span>
            <span className="irc-fact-val">—</span>
          </div>
        )}

        {row.sourceFacts.general_notes ? (
          <div className="irc-fact-item irc-notes-item">
            <span className="irc-fact-key">Shënime:</span>
            <div className="irc-note-content">&ldquo;{row.sourceFacts.general_notes}&rdquo;</div>
          </div>
        ) : (
          <div className="irc-fact-item irc-empty-fact">
            <span className="irc-fact-key">Shënime:</span>
            <span className="irc-fact-val">—</span>
          </div>
        )}

        <div className="irc-fact-grid">
          {row.sourceFacts.phone && (
            <div className="irc-fact-item">
              <span className="irc-fact-key">Tel:</span>
              <span className="irc-fact-val">{row.sourceFacts.phone}</span>
            </div>
          )}
          {row.sourceFacts.address && (
            <div className="irc-fact-item">
              <span className="irc-fact-key">Adresa:</span>
              <span className="irc-fact-val">{row.sourceFacts.address}</span>
            </div>
          )}
          {row.sourceFacts.zone && (
            <div className="irc-fact-item">
              <span className="irc-fact-key">Zona:</span>
              <span className="irc-fact-val">{row.sourceFacts.zone}</span>
            </div>
          )}
        </div>
      </div>

      {/* AI Derived Data Section */}
      {row.aiDerived && (
        <div className="irc-derived-section">
          <div className="irc-section-title">
            <span>PASURIM NGA AI (DERIVED)</span>
            {row.aiDerived.confidence != null && (
              <span className="irc-ai-conf">{(row.aiDerived.confidence * 100).toFixed(0)}% siguri</span>
            )}
          </div>

          <div className="irc-derived-pills">
            {row.aiDerived.category && (
              <span className="irc-pill irc-pill-cat"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="irc-inline-icon" aria-hidden="true"><path d="M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z"/><line x1="7" y1="7" x2="7.01" y2="7"/></svg>{row.aiDerived.category}</span>
            )}
            {row.aiDerived.zone && (
              <span className="irc-pill irc-pill-zone"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="irc-inline-icon" aria-hidden="true"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>{row.aiDerived.zone}</span>
            )}
            {row.aiDerived.followUpNeeded && (
              <span className="irc-pill irc-pill-fu"><svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="irc-inline-icon" aria-hidden="true"><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/></svg>Kërkohet ndjekje</span>
            )}
            {row.aiDerived.tags?.map((t, idx) => (
              <span key={idx} className="irc-pill irc-pill-tag">#{t}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
