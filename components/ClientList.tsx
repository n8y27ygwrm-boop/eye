'use client'

import { useApp } from '@/contexts/AppContext'
import { statusInfo } from '@/lib/types'
import { formatCardFollowupLabel } from '@/lib/followup'

export default function ClientList() {
  const { clients, filteredClients, openPanel, openImportModal } = useApp()
  const CAP = 500

  return (
    <div className="list-wrap" style={{ overflowY: 'auto', flex: 1 }}>
      <div className="summary-bar">
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span><strong>{filteredClients.length}</strong> rezultate</span>
          {filteredClients.filter(c => c.lat == null || c.lng == null).length > 0 && (
            <span style={{ color: "var(--warning)" }}>
              {filteredClients.filter(c => c.lat == null || c.lng == null).length} pa koordinata
            </span>
          )}
        </div>
        <div>
          <button
            type="button"
            className="btn-import-clients"
            onClick={openImportModal}
            title="Importo të dhëna klientësh (Google Sheets, CSV, Excel)"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ marginRight: 6 }}>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            IMPORT DATA
          </button>
        </div>
      </div>

      {filteredClients.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">✕</div>
          <div>Asnjë rezultat</div>
        </div>
      ) : (
        <>
          {filteredClients.slice(0, CAP).map(c => {
            const info = statusInfo(c.status)
            const fuBadge = formatCardFollowupLabel(c.next_followup)
            const mapsHref = c.maps_url ?? (c.lat != null ? `https://maps.google.com/?q=${c.lat},${c.lng}` : null)
            return (
              <div key={c.id} className="card" onClick={() => openPanel(c.id)}>
                <div className="card-main">
                  <div className="card-head">
                    <div className="card-name">{c.business_name}</div>
                    <div className="card-badges">
                      {fuBadge && (
                        <span
                          className={`fu-badge ${fuBadge.cls}`}
                          title={`Afati: ${c.next_followup}${c.next_action ? ` — ${c.next_action}` : ''}`}
                        >
                          {fuBadge.label}
                        </span>
                      )}
                      <div className={`status-badge ${info.cls}`}>{info.label}</div>
                    </div>
                  </div>
                  <div className="card-meta">
                    {c.zone && <span className="zone-badge">{c.zone}</span>}
                    {c.business_type && <span>{c.business_type}</span>}
                    {c.phone && <><span className="sep">·</span><span>{c.phone}</span></>}
                  </div>
                  {c.address && <div className="card-addr">{c.address}</div>}
                </div>
                {mapsHref && (
                  <a
                    className="card-maps"
                    href={mapsHref}
                    target="_blank"
                    rel="noopener"
                    onClick={e => e.stopPropagation()}
                    title="Hap Maps"
                  >Maps</a>
                )}
              </div>
            )
          })}
          {filteredClients.length > CAP && (
            <div style={{ textAlign: 'center', color: 'var(--text-3)', fontSize: '11.5px', padding: '14px' }}>
              Po shfaq {CAP} nga {filteredClients.length}. Përdor kërkimin për të gjetur specifik.
            </div>
          )}
        </>
      )}
    </div>
  )
}
