'use client'

import { useState, useEffect } from 'react'
import { useApp } from '@/contexts/AppContext'
import { statusInfo, STATUS_DEFS, fmtDate, type Client } from '@/lib/types'

export default function SidePanel() {
  const { activeClient: client, closePanel, updateClient, openVisitModal } = useApp()

  const [editing, setEditing] = useState<Partial<Client>>({})
  const [saving, setSaving] = useState(false)

  // Reset local edits whenever we switch to a different client
  useEffect(() => { setEditing({}) }, [client?.id])

  if (!client) return null

  const merged = { ...client, ...editing }

  function field<K extends keyof Client>(key: K): Client[K] {
    return (editing[key] !== undefined ? editing[key] : client![key]) as Client[K]
  }
  function set<K extends keyof Client>(key: K, val: Client[K]) {
    setEditing(e => ({ ...e, [key]: val }))
  }

  async function save() {
    if (!Object.keys(editing).length) return
    setSaving(true)
    await updateClient(client!.id, editing)
    setEditing({})
    setSaving(false)
  }

  const mapsHref = client.maps_url ?? (client.lat != null ? `https://maps.google.com/?q=${client.lat},${client.lng}` : null)
  const info = statusInfo(client.status)

  return (
    <div className="side-panel open">
      <div className="sp-header">
        <div>
          <div className="sp-name">{client.business_name}</div>
          <div className={`status-badge ${info.cls}`}>{info.label}</div>
        </div>
        <button className="sp-close" onClick={closePanel} aria-label="Mbyll">✕</button>
      </div>

      <div className="sp-body">
        {/* Status */}
        <div className="sp-field">
          <label>Statusi</label>
          <select
            value={field('status') ?? ''}
            onChange={e => set('status', e.target.value as Client['status'])}
          >
            {STATUS_DEFS.map(s => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </div>

        {/* Decline reason — shown when status is No interest */}
        {field('status') === 'No interest' && (
          <div className="sp-field">
            <label>Arsyeja e refuzimit</label>
            <input
              type="text"
              value={field('decline_reason') ?? ''}
              onChange={e => set('decline_reason', e.target.value)}
              placeholder="Arsyeja…"
            />
          </div>
        )}

        {/* Phone */}
        <div className="sp-field">
          <label>Telefon</label>
          <input
            type="tel"
            value={field('phone') ?? ''}
            onChange={e => set('phone', e.target.value)}
            placeholder="Numri i telefonit"
          />
        </div>

        {/* Contact person */}
        <div className="sp-field">
          <label>Kontakti</label>
          <input
            type="text"
            value={field('contact_person') ?? ''}
            onChange={e => set('contact_person', e.target.value)}
            placeholder="Emri i kontaktit"
          />
        </div>

        {/* Zone — now editable */}
        <div className="sp-field">
          <label>Zona</label>
          <input
            type="text"
            value={field('zone') ?? ''}
            onChange={e => set('zone', e.target.value)}
            placeholder="Zona"
          />
        </div>

        {/* Business type — now editable */}
        <div className="sp-field">
          <label>Lloji i biznesit</label>
          <input
            type="text"
            value={field('business_type') ?? ''}
            onChange={e => set('business_type', e.target.value)}
            placeholder="Lloji i biznesit"
          />
        </div>

        {/* Address (read-only display) */}
        {client.address && (
          <div className="sp-field">
            <label>Adresa</label>
            <div className="sp-static">
              {mapsHref
                ? <a href={mapsHref} target="_blank" rel="noopener">{client.address}</a>
                : client.address}
            </div>
          </div>
        )}

        {/* Lat / Lng — NEW: editable inputs to fix broken feature */}
        <div className="sp-field sp-field-row">
          <div className="sp-field" style={{ flex: 1 }}>
            <label>Lat</label>
            <input
              type="number"
              step="any"
              value={field('lat') ?? ''}
              onChange={e => set('lat', e.target.value === '' ? null : parseFloat(e.target.value))}
              placeholder="41.3275"
            />
          </div>
          <div className="sp-field" style={{ flex: 1 }}>
            <label>Lng</label>
            <input
              type="number"
              step="any"
              value={field('lng') ?? ''}
              onChange={e => set('lng', e.target.value === '' ? null : parseFloat(e.target.value))}
              placeholder="19.8187"
            />
          </div>
        </div>

        {/* Next follow-up */}
        <div className="sp-field">
          <label>Follow-up i radhës</label>
          <input
            type="date"
            value={field('next_followup') ?? ''}
            onChange={e => set('next_followup', e.target.value || null)}
          />
        </div>

        {/* Order value */}
        <div className="sp-field">
          <label>Vlera e porosisë (ALL)</label>
          <input
            type="number"
            value={field('order_value') ?? ''}
            onChange={e => set('order_value', e.target.value === '' ? null : parseFloat(e.target.value))}
            placeholder="0"
          />
        </div>

        {/* General notes */}
        <div className="sp-field">
          <label>Shënime</label>
          <textarea
            value={field('general_notes') ?? ''}
            onChange={e => set('general_notes', e.target.value)}
            rows={3}
            placeholder="Shënime të përgjithshme…"
          />
        </div>

        {/* Save button */}
        {Object.keys(editing).length > 0 && (
          <button className="btn-save" onClick={save} disabled={saving}>
            {saving ? 'Duke ruajtur…' : 'Ruaj ndryshimet'}
          </button>
        )}

        {/* Add visit shortcut */}
        <button
          className="btn-add-visit-sp"
          onClick={() => openVisitModal(undefined, undefined)}
        >
          + Shto vizitë
        </button>

        {/* Meta info */}
        <div className="sp-meta-row">
          {client.created_at && <span>Krijuar: {fmtDate(client.created_at)}</span>}
        </div>
      </div>
    </div>
  )
}
