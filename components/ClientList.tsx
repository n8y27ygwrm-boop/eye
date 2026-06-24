'use client'

import { useApp } from '@/contexts/AppContext'
import { statusInfo } from '@/lib/types'

export default function ClientList() {
  const { clients, filteredClients, openPanel } = useApp()
  const CAP = 500

  return (
    <div className="list-wrap" style={{ overflowY: 'auto', flex: 1 }}>
      <div className="summary-bar">
        <span><strong>{filteredClients.length}</strong> rezultate</span>
        {filteredClients.filter(c => c.lat == null || c.lng == null).length > 0 && (
          <span style={{ color: 'var(--warning)' }}>
            {filteredClients.filter(c => c.lat == null || c.lng == null).length} pa koordinata
          </span>
        )}
      </div>

      {filteredClients.length === 0 ? (
        <div className="empty">
          <div className="empty-icon">🔎</div>
          <div>Asnjë rezultat</div>
        </div>
      ) : (
        <>
          {filteredClients.slice(0, CAP).map(c => {
            const info = statusInfo(c.status)
            const mapsHref = c.maps_url ?? (c.lat != null ? `https://maps.google.com/?q=${c.lat},${c.lng}` : null)
            return (
              <div key={c.id} className="card" onClick={() => openPanel(c.id)}>
                <div className="card-main">
                  <div className="card-head">
                    <div className="card-name">{c.business_name}</div>
                    <div className={`status-badge ${info.cls}`}>{info.label}</div>
                  </div>
                  <div className="card-meta">
                    {c.zone && <span className="zone-badge">{c.zone}</span>}
                    {c.business_type && <span>{c.business_type}</span>}
                    {c.phone && <><span className="sep">·</span><span>📞 {c.phone}</span></>}
                  </div>
                  {c.address && <div className="card-addr">📍 {c.address}</div>}
                </div>
                {mapsHref && (
                  <a
                    className="card-maps"
                    href={mapsHref}
                    target="_blank"
                    rel="noopener"
                    onClick={e => e.stopPropagation()}
                    title="Hap Maps"
                  >📍</a>
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
