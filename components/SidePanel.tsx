'use client'

import { useState, useEffect } from 'react'
import { useApp } from '@/contexts/AppContext'
import { statusInfo, STATUS_DEFS, fmtDate, type Client } from '@/lib/types'

export default function SidePanel() {
  const { activeClient: client, closePanel, updateClient, openVisitModal, visits, visitsLoaded, loadVisits } = useApp()

  const [editing, setEditing] = useState<Partial<Client>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  // Reset local edits and errors whenever we switch to a different client
  useEffect(() => {
    setEditing({})
    setSaveError('')
  }, [client?.id])

  // Lazy load visits if not yet loaded
  useEffect(() => {
    if (client && !visitsLoaded) {
      loadVisits()
    }
  }, [client?.id, visitsLoaded, loadVisits])

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
    setSaveError('')
    const res = await updateClient(client!.id, editing)
    setSaving(false)
    if (!res.ok) {
      setSaveError(res.error?.message || 'Ruajtja e ndryshimeve dështoi')
      return
    }
    setEditing({})
  }

  const mapsHref = client.maps_url ?? (client.lat != null ? `https://maps.google.com/?q=${client.lat},${client.lng}` : null)
  const info = statusInfo(client.status)

  const clientVisits = (client ? visits.filter(v => v.client_id === client.id) : [])
    .sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || '') || (b.created_at || '').localeCompare(a.created_at || ''))

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
          <div>
            <button className="btn-save" onClick={save} disabled={saving}>
              {saving ? 'Duke ruajtur…' : 'Ruaj ndryshimet'}
            </button>
            {saveError && (
              <div style={{ color: 'var(--danger, #EF4444)', fontSize: '12px', marginTop: '6px' }}>
                {saveError}
              </div>
            )}
          </div>
        )}

        {/* Add visit shortcut */}
        <button
          className="btn-add-visit-sp"
          onClick={() => openVisitModal(undefined, undefined)}
        >
          + Shto vizitë
        </button>

        {/* Client Visit History */}
        <div className="sp-section" style={{ marginTop: '16px', borderTop: '1px solid var(--border)', paddingTop: '12px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
            <span style={{ fontSize: '11px', fontWeight: 600, color: 'var(--text-2)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Historia e Vizitave ({clientVisits.length})
            </span>
          </div>

          {clientVisits.length === 0 ? (
            <div style={{ fontSize: '12px', color: 'var(--text-3)', fontStyle: 'italic', padding: '6px 0' }}>
              Nuk ka vizita të regjistruara për këtë klient.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              {clientVisits.map(v => {
                const sInfo = statusInfo(v.statusi)
                return (
                  <div
                    key={v.id}
                    style={{
                      background: 'var(--surface-2, rgba(255,255,255,0.03))',
                      border: '1px solid var(--border)',
                      borderRadius: '6px',
                      padding: '8px 10px',
                      fontSize: '12px',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
                      <span style={{ fontWeight: 500, color: 'var(--text-1)' }}>{fmtDate(v.visit_date)}</span>
                      <span className={`status-badge ${sInfo.cls}`} style={{ fontSize: '10px', padding: '2px 6px' }}>
                        {sInfo.label}
                      </span>
                    </div>
                    {v.shenime && (
                      <div style={{ color: 'var(--text-2)', fontSize: '11px', lineHeight: 1.4, wordBreak: 'break-word' }}>
                        {v.shenime}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>

        {/* Meta info */}
        <div className="sp-meta-row">
          {client.created_at && <span>Krijuar: {fmtDate(client.created_at)}</span>}
        </div>
      </div>
    </div>
  )
}
