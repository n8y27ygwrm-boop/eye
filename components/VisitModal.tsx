'use client'

import { useState, useEffect, useRef } from 'react'
import { useApp } from '@/contexts/AppContext'
import { STATUS_DEFS, todayISO, normalize, type Visit } from '@/lib/types'

export default function VisitModal() {
  const {
    clients, visits,
    visitModalOpen, visitModalDate, editingVisit,
    closeVisitModal, upsertVisit, deleteVisit,
    activeClient,
  } = useApp()

  const [date, setDate] = useState(todayISO())
  const [clientId, setClientId] = useState('')
  const [locationUrl, setLocationUrl] = useState('')
  const [statusi, setStatusi] = useState<string>(STATUS_DEFS[0].key)
  const [shenime, setShenime] = useState('')
  const [search, setSearch] = useState('')
  const [showDropdown, setShowDropdown] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState('')

  const isEdit = !!editingVisit

  useEffect(() => {
    if (!visitModalOpen) return
    if (editingVisit) {
      setDate(editingVisit.visit_date ?? todayISO())
      setClientId(editingVisit.client_id ?? '')
      setLocationUrl(editingVisit.location_url ?? '')
      setStatusi(editingVisit.statusi ?? STATUS_DEFS[0].key)
      setShenime(editingVisit.shenime ?? '')
      const cl = clients.find(c => c.id === editingVisit.client_id)
      setSearch(cl?.business_name ?? '')
    } else {
      setDate(visitModalDate ?? todayISO())
      // Pre-populate client from active side panel if any
      const preClient = activeClient
      setClientId(preClient?.id ?? '')
      setSearch(preClient?.business_name ?? '')
      setLocationUrl('')
      setStatusi(STATUS_DEFS[0].key)
      setShenime('')
    }
    setShowDropdown(false)
    setError('')
  }, [visitModalOpen, editingVisit?.id])

  if (!visitModalOpen) return null

  const filtered = search.length >= 1
    ? clients
        .filter(c => c.business_name.toLowerCase().includes(search.toLowerCase()))
        .slice(0, 8)
    : []

  async function handleSave() {
    const name = search.trim()
    if (!name || !date) return
    setSaving(true)
    setError('')

    // Conservative exact/normalized resolution: if no client selected but name matches an existing client
    let resolvedClientId = clientId || null
    if (!resolvedClientId) {
      const exactMatch = clients.find(c => normalize(c.business_name) === normalize(name))
      if (exactMatch) {
        resolvedClientId = exactMatch.id
      }
    }

    const payload: Omit<Visit, 'id' | 'created_at' | 'updated_at'> = {
      client_id: resolvedClientId,
      visit_date: date,
      business_name: resolvedClientId ? (clients.find(c => c.id === resolvedClientId)?.business_name ?? name) : name,
      location_url: locationUrl || null,
      statusi,
      shenime: shenime || null,
    }
    const res = await upsertVisit(payload, editingVisit?.id)
    setSaving(false)
    if (!res.ok) {
      setError(res.error || 'Ruajtja e vizitës dështoi. Provo sërish.')
      return
    }
    closeVisitModal()
  }

  async function handleDelete() {
    if (!editingVisit) return
    setDeleting(true)
    setError('')
    const res = await deleteVisit(editingVisit.id)
    setDeleting(false)
    if (!res.ok) {
      setError(res.error || 'Fshirja e vizitës dështoi.')
      return
    }
    closeVisitModal()
  }

  function selectClient(id: string, name: string) {
    setClientId(id)
    setSearch(name)
    setShowDropdown(false)
  }

  // Layout wraps this in modal-overlay-center — just return the card
  return (
    <div className="modal-card" onClick={e => e.stopPropagation()}>
      <div className="modal-header">
        <h2>{isEdit ? 'Ndrysho vizitën' : 'Shto vizitë të re'}</h2>
        <button className="modal-close" onClick={closeVisitModal}>✕</button>
      </div>

      <div className="modal-body">
        {error && (
          <div className="modal-err" style={{ color: 'var(--danger, #EF4444)', fontSize: '12px', marginBottom: '12px', padding: '8px 10px', background: 'rgba(239, 68, 68, 0.1)', borderRadius: '6px', border: '1px solid rgba(239, 68, 68, 0.2)' }}>
            {error}
          </div>
        )}
        {/* Date */}
        <div className="modal-field">
          <label>Data</label>
          <input type="date" value={date} onChange={e => setDate(e.target.value)} />
        </div>

        {/* Client autocomplete */}
        <div className="modal-field" style={{ position: 'relative' }}>
          <label>Biznesi</label>
          <input
            type="text"
            value={search}
            placeholder="Kërko biznesin…"
            onChange={e => { setSearch(e.target.value); setClientId(''); setShowDropdown(true) }}
            onFocus={() => search.length >= 1 && setShowDropdown(true)}
            autoComplete="off"
          />
          {showDropdown && filtered.length > 0 && (
            <div className="client-dropdown">
              {filtered.map(c => (
                <div
                  key={c.id}
                  className="client-option"
                  onMouseDown={() => selectClient(c.id, c.business_name)}
                >
                  <span className="co-name">{c.business_name}</span>
                  {c.zone && <span className="co-zone">{c.zone}</span>}
                </div>
              ))}
            </div>
          )}
          {!clientId && search && (
            <div style={{ fontSize: '11px', color: 'var(--text-3)', marginTop: '4px' }}>
              Biznes i ri (nuk është në listë) — do të ruhet me emrin e shtypur
            </div>
          )}
        </div>

        {/* Location URL */}
        <div className="modal-field">
          <label>URL e vendndodhjes</label>
          <input
            type="url"
            value={locationUrl}
            onChange={e => setLocationUrl(e.target.value)}
            placeholder="https://maps.google.com/…"
          />
        </div>

        {/* Status */}
        <div className="modal-field">
          <label>Statusi i vizitës</label>
          <select value={statusi} onChange={e => setStatusi(e.target.value)}>
            {STATUS_DEFS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
          </select>
        </div>

        {/* Notes */}
        <div className="modal-field">
          <label>Shënime</label>
          <textarea
            value={shenime}
            onChange={e => setShenime(e.target.value)}
            rows={3}
            placeholder="Shënime nga vizita…"
          />
        </div>
      </div>

      <div className="modal-footer">
        {isEdit && (
          <button className="btn-danger" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Duke fshirë…' : 'Fshi'}
          </button>
        )}
        <div style={{ flex: 1 }} />
        <button className="btn-cancel" onClick={closeVisitModal}>Anulo</button>
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving || !search.trim() || !date}
        >
          {saving ? 'Duke ruajtur…' : isEdit ? 'Ruaj' : 'Shto vizitën'}
        </button>
      </div>
    </div>
  )
}
