'use client'

import { useEffect, useRef } from 'react'
import L from 'leaflet'
import { useApp } from '@/contexts/AppContext'
import { statusInfo, TIRANA_CENTER, TIRANA_ZOOM } from '@/lib/types'

// ── Escape helpers ────────────────────────────────────────────────────────────
function esc(s: string | null | undefined) {
  return (s ?? '').replace(/[&<>"']/g, m =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m] ?? m)
  )
}
function escAttr(s: string | null | undefined) {
  return (s ?? '').replace(/"/g, '&quot;')
}

function makeIcon(color: string, isActive: boolean) {
  return L.divIcon({
    html: `<div style="background:${color};width:18px;height:18px;border-radius:50%;border:2.5px solid #fff;box-shadow:0 2px 6px rgba(0,0,0,.6)" class="${isActive ? 'pin-active' : ''}"></div>`,
    className: '',
    iconSize: [18, 18],
    iconAnchor: [9, 9],
  })
}

export default function MapView() {
  const { filteredClients, openPanel, setUnlocatedOnly } = useApp()
  const mapRef = useRef<L.Map | null>(null)
  const layerRef = useRef<L.LayerGroup | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  // stable ref for openPanel so marker callbacks don't go stale
  const openPanelRef = useRef(openPanel)
  openPanelRef.current = openPanel

  // Init map once
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    mapRef.current = L.map(containerRef.current, { zoomControl: true, attributionControl: false })
      .setView(TIRANA_CENTER, TIRANA_ZOOM)
    L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '©OSM ©CARTO',
    }).addTo(mapRef.current)
    L.control.attribution({ prefix: false, position: 'bottomright' }).addTo(mapRef.current)
    layerRef.current = L.layerGroup().addTo(mapRef.current)
    return () => {
      mapRef.current?.remove()
      mapRef.current = null
      layerRef.current = null
    }
  }, [])

  // Render markers when filtered clients change
  useEffect(() => {
    const map = mapRef.current
    const layer = layerRef.current
    if (!map || !layer) return

    setTimeout(() => map.invalidateSize(), 60)
    layer.clearLayers()

    const withCoords = filteredClients.filter(c => c.lat != null && c.lng != null)

    withCoords.forEach(c => {
      const info = statusInfo(c.status)
      const icon = makeIcon(info.color, info.key === 'active')
      const phoneClean = (c.phone ?? '').replace(/[^\d+]/g, '')
      const mapsHref = c.maps_url ?? `https://maps.google.com/?q=${c.lat},${c.lng}`
      const popup = `
        <div class="popup-title">${esc(c.business_name)}</div>
        ${c.address ? `<div class="popup-meta">${esc(c.address)}</div>` : ''}
        <div class="popup-meta">
          <span class="status-badge ${info.cls}">${esc(info.label)}</span>
          ${c.zone ? `<span class="zone-badge" style="margin-left:4px">${esc(c.zone)}</span>` : ''}
        </div>
        ${phoneClean ? `<div class="popup-meta">📞 <a href="tel:${escAttr(phoneClean)}" style="color:#60A5FA">${esc(c.phone)}</a></div>` : ''}
        <div class="popup-actions">
          <button class="popup-btn" data-id="${c.id}">Detaje</button>
          <a class="popup-btn maps-btn" href="${escAttr(mapsHref)}" target="_blank" rel="noopener">📍 Hap Maps</a>
        </div>`
      const m = L.marker([c.lat!, c.lng!], { icon })
      m.bindPopup(popup)
      m.on('popupopen', () => {
        const btn = m.getPopup()?.getElement()?.querySelector('[data-id]') as HTMLElement | null
        if (btn) btn.onclick = () => openPanelRef.current(btn.dataset.id!)
      })
      layer.addLayer(m)
    })

    if (withCoords.length > 0) {
      const bounds = withCoords.map(c => [c.lat!, c.lng!] as [number, number])
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 })
    } else {
      map.setView(TIRANA_CENTER, TIRANA_ZOOM)
    }
  }, [filteredClients])

  const unlocatedWithUrl = filteredClients.filter(c => (c.lat == null || c.lng == null) && c.maps_url)
  const withCoords = filteredClients.filter(c => c.lat != null && c.lng != null)

  function goToUnlocated() {
    setUnlocatedOnly(true)
    // navigation to /list happens via parent if needed — here we just set the filter
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      <div className="map-wrap">
        <div id="map" ref={containerRef} />

        {unlocatedWithUrl.length > 0 && (
          <button className="unlocated-badge" onClick={goToUnlocated}>
            <span className="num">{unlocatedWithUrl.length}</span> pa koordinata
          </button>
        )}

        <div className="map-counts">
          <strong>{withCoords.length}</strong> në hartë ·{' '}
          <strong>{filteredClients.length - withCoords.length}</strong> pa koordinata
        </div>
      </div>

      {/* Unlocated list panel below map */}
      {unlocatedWithUrl.length > 0 && (
        <div className="no-loc-panel">
          <div className="nlp-head">
            <h3>Pa koordinata</h3>
            <span className="nlp-count">{unlocatedWithUrl.length}</span>
          </div>
          <div>
            {unlocatedWithUrl.slice(0, 200).map(c => (
              <a
                key={c.id}
                className="nlp-item"
                href={c.maps_url!}
                target="_blank"
                rel="noopener"
              >
                <span className="nm">
                  {c.business_name}
                  {c.zone && <span className="zh">· {c.zone}</span>}
                </span>
                <span className="ic">📍</span>
              </a>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
