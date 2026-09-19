'use client'

import { useState, useEffect } from 'react'
import { useApp } from '@/contexts/AppContext'
import { statusInfo, STATUS_DEFS, fmtDate, todayISO, type Client } from '@/lib/types'
import { getFollowupInfo, formatFollowupDate, addDaysISO } from '@/lib/followup'

type FuMode = 'view' | 'edit' | 'reschedule'

export default function SidePanel() {
  const { activeClient: client, closePanel, updateClient, openVisitModal, visits, visitsLoaded, loadVisits } = useApp()

  const [editing, setEditing] = useState<Partial<Client>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  // Follow-up operational state
  const [fuMode, setFuMode] = useState<FuMode>('view')
  const [fuAction, setFuAction] = useState('')
  const [fuDate, setFuDate] = useState('')
  const [fuRescheduleDate, setFuRescheduleDate] = useState('')
  const [fuConfirmDone, setFuConfirmDone] = useState(false)
  const [fuSaving, setFuSaving] = useState(false)
  const [fuError, setFuError] = useState('')

  // Reset local edits and errors whenever we switch to a different client
  useEffect(() => {
    setEditing({})
    setSaveError('')
    setFuMode('view')
    setFuConfirmDone(false)
    setFuError('')
  }, [client?.id])

  // Lazy load visits if not yet loaded
  useEffect(() => {
    if (client && !visitsLoaded) {
      loadVisits()
    }
  }, [client?.id, visitsLoaded, loadVisits])

  if (!client) return null

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

  // Follow-up handlers
  function startAddFollowup() {
    setFuAction('')
    setFuDate(todayISO())
    setFuError('')
    setFuConfirmDone(false)
    setFuMode('edit')
  }

  function startEditFollowup() {
    setFuAction(client?.next_action || '')
    setFuDate(client?.next_followup || todayISO())
    setFuError('')
    setFuConfirmDone(false)
    setFuMode('edit')
  }

  function startReschedule() {
    setFuRescheduleDate(client?.next_followup || todayISO())
    setFuError('')
    setFuConfirmDone(false)
    setFuMode('reschedule')
  }

  async function handleSaveFollowupEdit() {
    if (!client) return
    const trimmedAction = fuAction.trim()
    const trimmedDate = fuDate.trim()
    if (!trimmedAction || !trimmedDate) {
      setFuError('Ju lutem vendosni veprimin dhe datën e afatit.')
      return
    }
    setFuSaving(true)
    setFuError('')
    const res = await updateClient(client.id, {
      next_action: trimmedAction,
      next_followup: trimmedDate,
    })
    setFuSaving(false)
    if (!res.ok) {
      setFuError(res.error?.message || 'Ruajtja e follow-up dështoi.')
      return
    }
    setFuMode('view')
  }

  async function handleSaveReschedule() {
    if (!client) return
    const trimmedDate = fuRescheduleDate.trim()
    if (!trimmedDate) {
      setFuError('Ju lutem zgjidhni një datë të vlefshme për afatin.')
      return
    }
    setFuSaving(true)
    setFuError('')
    // Reschedule modifies ONLY next_followup, preserving next_action (even if null)
    const res = await updateClient(client.id, {
      next_followup: trimmedDate,
    })
    setFuSaving(false)
    if (!res.ok) {
      setFuError(res.error?.message || 'Riprogramimi dështoi.')
      return
    }
    setFuMode('view')
  }

  async function handleConfirmMarkDone() {
    if (!client) return
    setFuSaving(true)
    setFuError('')
    const res = await updateClient(client.id, {
      next_action: null,
      next_followup: null,
    })
    setFuSaving(false)
    if (!res.ok) {
      setFuError(res.error?.message || 'Shënimi i përfundimit dështoi.')
      return
    }
    setFuConfirmDone(false)
    setFuMode('view')
  }

  const mapsHref = client.maps_url ?? (client.lat != null ? `https://maps.google.com/?q=${client.lat},${client.lng}` : null)
  const info = statusInfo(client.status)

  const clientVisits = (client ? visits.filter(v => v.client_id === client.id) : [])
    .sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || '') || (b.created_at || '').localeCompare(a.created_at || ''))

  const hasActiveFollowup = Boolean(client.next_followup)
  const followupInfo = getFollowupInfo(client.next_followup)

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

        {/* Lat / Lng — editable inputs */}
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

        {/* OPERATIONAL BLOCK: NEXT ACTION */}
        <div className="sp-followup-block">
          <div className="sp-fu-header">
            <span className="sp-fu-title">NEXT ACTION</span>
            {hasActiveFollowup && fuMode === 'view' && (
              <span className={`status-badge ${followupInfo.cls}`}>{followupInfo.badgeText}</span>
            )}
          </div>

          {fuError && (
            <div className="sp-fu-error">
              {fuError}
            </div>
          )}

          {/* MODE: EDIT / CREATE */}
          {fuMode === 'edit' && (
            <div className="sp-fu-editor">
              <div className="sp-field">
                <label>Veprimi i radhës</label>
                <input
                  type="text"
                  value={fuAction}
                  onChange={e => setFuAction(e.target.value)}
                  placeholder="P.sh. Kontakto pronarin për ofertë"
                  autoFocus
                />
              </div>
              <div className="sp-field">
                <label>Data e afatit</label>
                <input
                  type="date"
                  value={fuDate}
                  onChange={e => setFuDate(e.target.value)}
                />
              </div>
              <div className="sp-fu-actions">
                <button
                  type="button"
                  className="btn-primary sp-fu-btn"
                  onClick={handleSaveFollowupEdit}
                  disabled={fuSaving}
                >
                  {fuSaving ? 'Duke ruajtur…' : 'Ruaj follow-up'}
                </button>
                <button
                  type="button"
                  className="btn-cancel sp-fu-btn"
                  onClick={() => {
                    setFuMode('view')
                    setFuError('')
                  }}
                  disabled={fuSaving}
                >
                  Anulo
                </button>
              </div>
            </div>
          )}

          {/* MODE: RESCHEDULE */}
          {fuMode === 'reschedule' && (
            <div className="sp-fu-reschedule">
              <div className="sp-field">
                <label>Zgjidh datë të re për afatin</label>
                <input
                  type="date"
                  value={fuRescheduleDate}
                  onChange={e => setFuRescheduleDate(e.target.value)}
                  autoFocus
                />
              </div>
              <div className="sp-fu-quick-btns">
                <button
                  type="button"
                  className="sp-fu-quick-btn"
                  onClick={() => setFuRescheduleDate(todayISO())}
                >
                  Sot
                </button>
                <button
                  type="button"
                  className="sp-fu-quick-btn"
                  onClick={() => setFuRescheduleDate(addDaysISO(todayISO(), 1))}
                >
                  Nesër
                </button>
                <button
                  type="button"
                  className="sp-fu-quick-btn"
                  onClick={() => setFuRescheduleDate(addDaysISO(todayISO(), 3))}
                >
                  +3 Ditë
                </button>
                <button
                  type="button"
                  className="sp-fu-quick-btn"
                  onClick={() => setFuRescheduleDate(addDaysISO(todayISO(), 7))}
                >
                  +1 Javë
                </button>
              </div>
              <div className="sp-fu-actions">
                <button
                  type="button"
                  className="btn-primary sp-fu-btn"
                  onClick={handleSaveReschedule}
                  disabled={fuSaving}
                >
                  {fuSaving ? 'Duke ruajtur…' : 'Riprogramo'}
                </button>
                <button
                  type="button"
                  className="btn-cancel sp-fu-btn"
                  onClick={() => {
                    setFuMode('view')
                    setFuError('')
                  }}
                  disabled={fuSaving}
                >
                  Anulo
                </button>
              </div>
            </div>
          )}

          {/* MODE: VIEW */}
          {fuMode === 'view' && (
            <>
              {hasActiveFollowup ? (
                <div className="sp-fu-content">
                  <div className="sp-fu-row">
                    <span className="sp-fu-label">Veprimi:</span>
                    <span className={`sp-fu-val ${!client.next_action ? 'sp-fu-empty' : ''}`}>
                      {client.next_action || 'Veprimi nuk është përcaktuar'}
                    </span>
                  </div>

                  <div className="sp-fu-row">
                    <span className="sp-fu-label">Afati:</span>
                    <span className="sp-fu-val sp-fu-due">
                      {formatFollowupDate(client.next_followup, { withYear: true })}
                    </span>
                  </div>

                  {fuConfirmDone ? (
                    <div className="sp-fu-confirm-box">
                      <div className="sp-fu-confirm-msg">A e keni përfunduar këtë ndjekje?</div>
                      <div className="sp-fu-actions">
                        <button
                          type="button"
                          className="btn-primary sp-fu-btn"
                          onClick={handleConfirmMarkDone}
                          disabled={fuSaving}
                        >
                          {fuSaving ? 'Duke përfunduar…' : '✓ Po, përfundo'}
                        </button>
                        <button
                          type="button"
                          className="btn-cancel sp-fu-btn"
                          onClick={() => setFuConfirmDone(false)}
                          disabled={fuSaving}
                        >
                          Anulo
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="sp-fu-action-bar">
                      <button
                        type="button"
                        className="sp-fu-tool-btn"
                        onClick={startEditFollowup}
                      >
                        Ndrysho
                      </button>
                      <button
                        type="button"
                        className="sp-fu-tool-btn"
                        onClick={startReschedule}
                      >
                        Riprogramo
                      </button>
                      <button
                        type="button"
                        className="sp-fu-tool-btn sp-fu-done-btn"
                        onClick={() => setFuConfirmDone(true)}
                      >
                        ✓ Mark Done
                      </button>
                    </div>
                  )}
                </div>
              ) : (
                <div className="sp-fu-empty-state">
                  <span className="sp-fu-empty-text">Asnjë follow-up aktiv</span>
                  <button
                    type="button"
                    className="sp-fu-add-btn"
                    onClick={startAddFollowup}
                  >
                    + Shto follow-up
                  </button>
                </div>
              )}
            </>
          )}
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
