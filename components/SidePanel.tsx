'use client'

import { useState, useEffect, useRef } from 'react'
import { useApp } from '@/contexts/AppContext'
import { statusInfo, STATUS_DEFS, fmtDate, todayISO, type Client } from '@/lib/types'
import { attentionBadge, deriveClientAttention } from '@/lib/actions/attention'
import type { OperationalAction, SurfaceCommand } from '@/lib/actions/types'
import { formatFollowupDate, formatFollowupDateTime, formatHistoryDate, addDaysISO } from '@/lib/followup'

type FuMode = 'view' | 'edit' | 'reschedule'

export default function SidePanel() {
  const { activeClient: client, closePanel, updateClient, openVisitModal, visits, visitsLoaded, visitsError, loadVisits, operationalActions, actionState, actionAttention, changeAction } = useApp()

  const [editing, setEditing] = useState<Partial<Client>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')

  // Follow-up operational state
  const [fuMode, setFuMode] = useState<FuMode>('view')
  const [fuAction, setFuAction] = useState('')
  const [fuDate, setFuDate] = useState('')
  const [fuTime, setFuTime] = useState('')
  const [fuRescheduleDate, setFuRescheduleDate] = useState('')
  const [fuConfirmDone, setFuConfirmDone] = useState(false)
  const [fuSaving, setFuSaving] = useState(false)
  const fuSavingRef = useRef(false)
  const [fuError, setFuError] = useState('')
  const [historyError, setHistoryError] = useState('')
  const fuTargetRef = useRef<OperationalAction | null>(null)
  const attention = client ? actionAttention(client.id) : null
  const [selectedActionId, setSelectedActionId] = useState<string | null>(null)
  const selectedAction = attention?.open.find(a => a.id === selectedActionId) ?? attention?.nearest ?? null
  const historyRecords = client ? operationalActions.clientSnapshot(client.id) : undefined
  useEffect(() => {
    if (!client || actionState.status !== 'loaded') return
    let current = true
    setHistoryError('')
    void operationalActions.forClient(client.id).catch(cause => { if (current) setHistoryError(cause instanceof Error ? cause.message : 'Historia nuk u ngarkua') })
    return () => { current = false }
  }, [client?.id, actionState.status, actionState.status === 'loaded' ? actionState.actions : null, operationalActions])

  // Reset local edits and errors whenever we switch to a different client
  useEffect(() => {
    setEditing({})
    setSaveError('')
    setSelectedActionId(null)
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
    fuTargetRef.current = null
    setFuAction('')
    setFuDate(todayISO())
    setFuTime('')
    setFuError('')
    setFuConfirmDone(false)
    setFuMode('edit')
  }

  function startEditFollowup(target = selectedAction) {
    fuTargetRef.current = target
    setFuAction(target?.description || '')
    setFuDate(target?.due_date || '')
    setFuTime(target?.due_time || '')
    setFuError('')
    setFuConfirmDone(false)
    setFuMode('edit')
  }

  function startReschedule() {
    fuTargetRef.current = selectedAction
    setFuRescheduleDate(selectedAction?.due_date || todayISO())
    setFuError('')
    setFuConfirmDone(false)
    setFuMode('reschedule')
  }

  async function handleSaveFollowupEdit() {
    if (!client || fuSavingRef.current) return
    const trimmedAction = fuAction.trim()
    const trimmedDate = fuDate.trim()
    if (!trimmedAction) {
      setFuError('Ju lutem vendosni veprimin.')
      return
    }
    const target = fuTargetRef.current
    const dueTime = target?.version != null ? fuTime.trim() || null : target?.due_time ?? null
    if (target?.version != null && dueTime && !trimmedDate) {
      setFuError('Ora kërkon një datë të afatit.')
      return
    }
    fuSavingRef.current = true
    setFuSaving(true)
    setFuError('')
    try {
      const res = await changeAction({ operation: 'surface', intent: target ? 'edit' : 'create', requestId: crypto.randomUUID(), channel: 'client_detail', clientId: client.id, actionId: target?.id, expectedVersion: target?.version, expectedRevision: target?.revision, fields: { description: trimmedAction, action_type: target?.action_type ?? 'follow_up', due_date: trimmedDate || null, due_time: dueTime, priority: target?.priority ?? 'medium' } })
      if (!res.ok) {
        setFuError(res.error || 'Ruajtja e follow-up dështoi.')
        return
      }
      setFuMode('view')
    } catch (cause) {
      setFuError(cause instanceof Error ? cause.message : 'Ruajtja e follow-up dështoi.')
    } finally {
      fuSavingRef.current = false
      setFuSaving(false)
    }
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
    const target = fuTargetRef.current
    if (!target) { setFuSaving(false); setFuError('Veprimi nuk është më i disponueshëm.'); return }
    const res = await changeAction({ operation: 'surface', intent: 'reschedule', requestId: crypto.randomUUID(), channel: 'client_detail', clientId: client.id, actionId: target.id, expectedVersion: target.version, expectedRevision: target.revision, fields: { description: target.description, action_type: target.action_type, due_date: trimmedDate, due_time: target.due_time, priority: target.priority } })
    setFuSaving(false)
    if (!res.ok) {
      setFuError(res.error || 'Riprogramimi dështoi.')
      return
    }
    setFuMode('view')
  }

  async function handleConfirmMarkDone() {
    if (!client) return
    setFuSaving(true)
    setFuError('')
    const target = fuTargetRef.current
    if (!target) { setFuSaving(false); setFuError('Veprimi nuk është më i disponueshëm.'); return }
    const res = await changeAction({ operation: 'surface', intent: 'complete', requestId: crypto.randomUUID(), channel: 'client_detail', clientId: client.id, actionId: target.id, expectedVersion: target.version, expectedRevision: target.revision })
    setFuSaving(false)
    if (!res.ok) {
      setFuError(res.error || 'Shënimi i përfundimit dështoi.')
      return
    }
    setFuConfirmDone(false)
    setFuMode('view')
  }

  const mapsHref = client.maps_url ?? (client.lat != null ? `https://maps.google.com/?q=${client.lat},${client.lng}` : null)
  const info = statusInfo(client.status)

  const clientVisits = (client ? visits.filter(v => v.client_id === client.id) : [])
    .sort((a, b) => (b.visit_date || '').localeCompare(a.visit_date || '') || (b.created_at || '').localeCompare(a.created_at || ''))

  const hasActiveFollowup = Boolean(selectedAction)
  const actionAttentionForSelected = selectedAction ? deriveClientAttention([selectedAction], client.id).group : null
  const followupInfo = { cls: attentionBadge(selectedAction ? actionAttentionForSelected : null, selectedAction?.due_date)?.cls ?? '', badgeText: attentionBadge(selectedAction ? actionAttentionForSelected : null, selectedAction?.due_date)?.label ?? '' }

  return (
    <div className="side-panel open" role="dialog" aria-modal="true">
      {/* Mobile Drag Handle Bar */}
      <div className="sp-handle-bar" onClick={closePanel} aria-label="Mbyll fletën e detajeve">
        <span className="sp-handle-pill" />
      </div>
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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '4px' }}>
            <label style={{ margin: 0 }}>Telefon</label>
            {field('phone') && (
              <a
                href={`tel:${field('phone')}`}
                className="sp-phone-link"
                title="Telefono direkt"
              >
                📞 Telefono
              </a>
            )}
          </div>
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

        {/* Latest visit before operational actions */}
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


        <div className="sp-section" style={{ marginBottom: 12 }}><label>Vizita e fundit</label>{visitsError ? <div role="alert">{visitsError}<button type="button" onClick={loadVisits}>Provo përsëri</button></div> : !visitsLoaded ? <div>Duke ngarkuar vizitat…</div> : clientVisits[0] ? <div className="sp-static">{formatHistoryDate(clientVisits[0].visit_date)} · {clientVisits[0].shenime || statusInfo(clientVisits[0].statusi).label}</div> : <div className="sp-static">Nuk ka vizita të regjistruara.</div>}</div>
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
              {fuTargetRef.current?.version != null && (
                <div className="sp-field">
                  <label htmlFor="followup-due-time">Ora e afatit</label>
                  <input id="followup-due-time" type="time" step="1" value={fuTime} onChange={e => setFuTime(e.target.value)} />
                </div>
              )}
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
              {actionState.status !== 'loaded' ? <div className="sp-fu-error" role={actionState.status === 'query_error' || actionState.status === 'authentication_error' ? 'alert' : 'status'}>{actionState.status === 'authentication_error' ? 'Identifikohu për veprimet.' : actionState.status === 'query_error' ? 'Veprimet nuk u ngarkuan.' : 'Duke ngarkuar veprimet…'}</div> : hasActiveFollowup ? (
                <div className="sp-fu-content">
                  <div className="sp-fu-row">
                    <span className="sp-fu-label">Veprimi:</span>
                    <span className={`sp-fu-val ${!selectedAction?.description ? 'sp-fu-empty' : ''}`}>
                      {selectedAction?.description || 'Veprimi nuk është përcaktuar'}
                    </span>
                  </div>

                  <div className="sp-fu-row">
                    <span className="sp-fu-label">Afati:</span>
                    <span className="sp-fu-val sp-fu-due">
                      {formatFollowupDateTime(selectedAction?.due_date, selectedAction?.due_time, { withYear: true })}
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
                        onClick={() => startEditFollowup()}
                        disabled={!selectedAction?.allowed_operations?.includes('edit')}
                      >
                        Ndrysho
                      </button>
                      <button
                        type="button"
                        className="sp-fu-tool-btn"
                        onClick={startReschedule}
                        disabled={!selectedAction?.allowed_operations?.includes('reschedule')}
                      >
                        Riprogramo
                      </button>
                      <button
                        type="button"
                        className="sp-fu-tool-btn sp-fu-done-btn"
                        onClick={() => { fuTargetRef.current = selectedAction; setFuConfirmDone(true) }}
                        disabled={!selectedAction?.allowed_operations?.includes('complete')}
                      >
                        ✓ Shëno si të kryer
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

        {attention && attention.open.length > 1 && <div className="sp-followup-block"><div className="sp-fu-title">VEPRIME TË TJERA</div>{attention.open.filter(a => a.id !== selectedAction?.id).map(a => <div className="sp-fu-row" key={a.id}><span>{a.description} · {a.due_date ? formatFollowupDate(a.due_date) : 'Pa afat'}</span>{a.allowed_operations?.includes('edit') && <button type="button" className="sp-fu-tool-btn" disabled={fuSaving} onClick={() => { setSelectedActionId(a.id); startEditFollowup(a) }}>Ndrysho</button>}<button type="button" className="sp-fu-tool-btn" disabled={fuSaving || !a.allowed_operations?.includes('complete')} onClick={() => changeAction({ operation: 'surface', intent: 'complete', requestId: crypto.randomUUID(), channel: 'client_detail', clientId: client.id, actionId: a.id, expectedVersion: a.version, expectedRevision: a.revision })}>✓ Kryer</button></div>)}</div>}
        <div className="sp-section" style={{ marginTop: 12 }}><label>Historia e veprimeve</label>
          {historyError ? <div role="alert">{historyError}</div> : actionState.status !== 'loaded' ? <div>Duke ngarkuar…</div> : !operationalActions.capabilities?.history ? <div className="sp-static">Historia e përfundimeve nuk është regjistruar në burimin aktual.{historyRecords?.filter(a => a.state === 'legacy_closed').map(a => <div key={a.id}>{a.description} — Mbyllur më parë (pa aktor ose datë përfundimi)</div>)}</div> : <div>{historyRecords?.map(a => <div key={a.id}><button type="button" className="sp-fu-tool-btn" onClick={() => operationalActions.history(a.id).catch(cause => setHistoryError(cause.message))}>{a.description} · {({ open: 'Hapur', completed: 'Përfunduar', cancelled: 'Anuluar', replaced: 'Zëvendësuar', legacy_closed: 'Mbyllur më parë' } as const)[a.state]}</button>{operationalActions.historySnapshot(a.id)?.map(event => <div key={event.id}>{({ completed: 'Përfunduar', created: 'Krijuar', imported: 'Importuar', updated: 'Përditësuar' } as Record<string, string>)[event.event_type] ?? event.event_type} · {formatHistoryDate(event.recorded_at)}</div>)}</div>)}</div>}
        </div>

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

          {visitsError ? <div role="alert">{visitsError}</div> : !visitsLoaded ? <div>Duke ngarkuar vizitat…</div> : clientVisits.length === 0 ? (
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
                      <span style={{ fontWeight: 500, color: 'var(--text-1)' }}>{formatHistoryDate(v.visit_date)}</span>
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
