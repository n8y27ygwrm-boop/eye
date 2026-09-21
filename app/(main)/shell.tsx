'use client'

import { useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { AppProvider, useApp } from '@/contexts/AppContext'
import SidePanel from '@/components/SidePanel'
import VisitModal from '@/components/VisitModal'
import ImportModal from '@/components/import/ImportModal'
import AIChat from '@/components/AIChat'
import FieldControlPanel from '@/components/FieldControlPanel'
import SavvySelect, { type SelectOption } from '@/components/SavvySelect'
import { STATUS_DEFS } from '@/lib/types'
import { formatAccuracy } from '@/lib/location/utils'

function SystemReticleMark() {
  return (
    <svg
      width="20"
      height="20"
      viewBox="0 0 20 20"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="brand-reticle"
      aria-hidden="true"
    >
      {/* Outer precision registration ring */}
      <circle cx="10" cy="10" r="7.5" stroke="var(--text)" strokeWidth="1.1" strokeOpacity="0.75" />
      {/* Inner focal ring in Savvy Systems burgundy */}
      <circle cx="10" cy="10" r="3.75" stroke="#8E2230" strokeWidth="1.2" />
      {/* Precision center optical focal point */}
      <circle cx="10" cy="10" r="1.2" fill="var(--text)" />
      {/* 4 subtle cardinal alignment ticks */}
      <line x1="10" y1="1.5" x2="10" y2="3.2" stroke="var(--text)" strokeWidth="1" strokeOpacity="0.5" strokeLinecap="round" />
      <line x1="10" y1="16.8" x2="10" y2="18.5" stroke="var(--text)" strokeWidth="1" strokeOpacity="0.5" strokeLinecap="round" />
      <line x1="1.5" y1="10" x2="3.2" y2="10" stroke="var(--text)" strokeWidth="1" strokeOpacity="0.5" strokeLinecap="round" />
      <line x1="16.8" y1="10" x2="18.5" y2="10" stroke="var(--text)" strokeWidth="1" strokeOpacity="0.5" strokeLinecap="round" />
    </svg>
  )
}

function LocationHeaderControl() {
  const {
    currentLocation,
    locationStatus,
    locationError,
    openLocationPermissionModal,
    refreshLocation,
  } = useApp()
  const [showTooltip, setShowTooltip] = useState(false)

  const accuracyLabel = currentLocation ? formatAccuracy(currentLocation.accuracy) : null

  function handleClick() {
    if (locationStatus === 'active') {
      setShowTooltip(prev => !prev)
    } else {
      openLocationPermissionModal()
    }
  }

  const tooltipText =
    locationStatus === 'active'
      ? `Location active · ${accuracyLabel}`
      : locationStatus === 'requesting'
      ? 'Requesting location…'
      : locationStatus === 'denied'
      ? (locationError || 'Location access is off. Tap to configure.')
      : 'Location is off. Tap to enable.'

  return (
    <div className="loc-control-wrap">
      <button
        type="button"
        className={`loc-status-btn loc-status-${locationStatus}`}
        onClick={handleClick}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        aria-label={tooltipText}
        title={tooltipText}
      >
        <svg
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="loc-status-icon"
          aria-hidden="true"
        >
          <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.2" strokeOpacity="0.75" />
          <circle
            cx="8"
            cy="8"
            r="2.2"
            fill={locationStatus === 'active' ? '#8E2230' : 'currentColor'}
            className={locationStatus === 'requesting' ? 'loc-pulse-core' : ''}
          />
          <line x1="8" y1="1" x2="8" y2="2.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <line x1="8" y1="13.5" x2="8" y2="15" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <line x1="1" y1="8" x2="2.5" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
          <line x1="13.5" y1="8" x2="15" y2="8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
        </svg>
        {locationStatus === 'active' && <span className="loc-active-pip" />}
      </button>

      {showTooltip && (
        <div className="loc-popover" role="tooltip">
          <div className="loc-popover-row">
            <span className={`loc-popover-dot loc-dot-${locationStatus}`} />
            <span className="loc-popover-text">{tooltipText}</span>
          </div>
          {locationStatus === 'active' && (
            <button
              type="button"
              className="loc-popover-refresh"
              onClick={e => {
                e.stopPropagation()
                refreshLocation()
              }}
            >
              Refresh
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <AppShellInner>{children}</AppShellInner>
    </AppProvider>
  )
}

function AppShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const {
    clients, filteredClients: _fc, zones,
    search, setSearch,
    zoneFilter, setZoneFilter,
    statusFilter, setStatusFilter,
    followupFilter, setFollowupFilter,
    unlocatedOnly, setUnlocatedOnly,
    syncing, syncError,
    toastState,
    activeClient, closePanel,
    visitModalOpen, closeVisitModal,
    importModalOpen, closeImportModal,
    locationPermissionModalOpen, closeLocationPermissionModal, enableLocation, locationStatus,
  } = useApp()

  const [mobileFilterSheet, setMobileFilterSheet] = useState<'zone' | 'status' | 'followup' | null>(null)

  const isRoute = pathname === '/route'
  const zoneOptions: SelectOption[] = [
    { value: '', label: 'Të gjitha zonat' },
    ...zones.map(z => ({ value: z, label: z })),
  ]
  const statusOptions: SelectOption[] = [
    { value: '', label: 'Të gjithë statuset' },
    ...STATUS_DEFS.map(s => ({ value: s.key, label: s.label })),
  ]
  const followupOptions: SelectOption[] = [
    { value: 'all', label: 'Të gjitha ndjekjet' },
    { value: 'overdue', label: 'Me vonesë' },
    { value: 'today', label: 'Sot' },
    { value: 'upcoming', label: 'Në vijim' },
  ]
  const currentWorkspace = pathname === '/route' ? 'route' : pathname === '/list' ? 'list' : 'map'

  const fuLabels: Record<string, string> = {
    overdue: 'Me vonesë',
    today: 'Sot',
    upcoming: 'Në vijim',
  }

  const chips: { label: string; clear: () => void }[] = []
  if (zoneFilter) chips.push({ label: 'Zona: ' + zoneFilter, clear: () => setZoneFilter('') })
  if (statusFilter) {
    const lbl = STATUS_DEFS.find(s => s.key === statusFilter)?.label ?? statusFilter
    chips.push({ label: 'Status: ' + lbl, clear: () => setStatusFilter('') })
  }
  if (unlocatedOnly) chips.push({ label: 'Vetëm pa koordinata', clear: () => setUnlocatedOnly(false) })
  if (followupFilter !== 'all') {
    chips.push({ label: 'Ndjekja: ' + (fuLabels[followupFilter] || followupFilter), clear: () => setFollowupFilter('all') })
  }

  async function logout() {
    await createClient().auth.signOut()
    router.push('/login')
    router.refresh()
  }

  // Active filter label helpers for mobile chips
  const activeZoneLabel = zoneFilter ? `Zona: ${zoneFilter}` : 'Zona ▾'
  const activeStatusLabel = statusFilter
    ? `Status: ${STATUS_DEFS.find(s => s.key === statusFilter)?.label ?? statusFilter}`
    : 'Statusi ▾'
  const activeFollowupLabel = followupFilter !== 'all'
    ? `Ndjekja: ${fuLabels[followupFilter] || followupFilter}`
    : 'Ndjekja ▾'

  return (
    <div className={'app-shell workspace-' + currentWorkspace}>
      {/* ── APP HEADER (CALM ARCHITECTURAL FRAME & COMPACT MOBILE BAR) ────────── */}
      <header className="app-header">
        <div className="app-brand-lockup">
          <span className="logo-reticle"><SystemReticleMark /></span>
          <div className="brand-titles">
            <div className="brand-primary-line">
              <span
                className={'sync-dot' + (syncing ? ' syncing' : syncError ? ' error' : '')}
                title={syncError ? 'Gabim sinkronizimi' : syncing ? 'Duke sinkronizuar...' : 'Sinkronizuar'}
              />
              <span className="brand-title">EYE</span>
            </div>
            <span className="brand-sub">SAVVY SYSTEMS</span>
          </div>
        </div>

        <div className="app-header-right">
          <LocationHeaderControl />
          <span className="badge">{clients.length} biznese</span>
          <button className="logout-btn" onClick={logout} aria-label="Dil nga llogaria">Dil</button>
        </div>
      </header>

      {/* ── CONTROLS & FILTER RAIL ───────────────────────────────────────────── */}
      {!isRoute && (
        <div className="controls">
          <div className="search-wrap">
            <input
              type="search"
              placeholder="Kërko biznes..."
              autoComplete="off"
              value={search}
              onChange={e => setSearch(e.target.value)}
              aria-label="Kërko biznes"
            />
          </div>

          {/* Desktop 3-column SavvySelect filter controls (Preserved) */}
          <div className="filter-selects desktop-filter-selects">
            <SavvySelect
              value={zoneFilter}
              onChange={setZoneFilter}
              options={zoneOptions}
              ariaLabel="Filtro sipas zonës"
            />
            <SavvySelect
              value={statusFilter}
              onChange={setStatusFilter}
              options={statusOptions}
              ariaLabel="Filtro sipas statusit"
            />
            <SavvySelect
              value={followupFilter}
              onChange={val => setFollowupFilter(val as any)}
              options={followupOptions}
              ariaLabel="Filtro sipas ndjekjes"
            />
          </div>

          {/* Mobile horizontal filter chips row (<= 767px) */}
          <div className="mobile-filter-rail" aria-label="Filtrat e shpejtë">
            <button
              type="button"
              className={'m-chip' + (zoneFilter ? ' m-chip-active' : '')}
              onClick={() => setMobileFilterSheet('zone')}
            >
              <span>{activeZoneLabel}</span>
              {zoneFilter && (
                <span
                  className="m-chip-clear"
                  onClick={e => {
                    e.stopPropagation()
                    setZoneFilter('')
                  }}
                  title="Pastro filtrin e zonës"
                >×</span>
              )}
            </button>

            <button
              type="button"
              className={'m-chip' + (statusFilter ? ' m-chip-active' : '')}
              onClick={() => setMobileFilterSheet('status')}
            >
              <span>{activeStatusLabel}</span>
              {statusFilter && (
                <span
                  className="m-chip-clear"
                  onClick={e => {
                    e.stopPropagation()
                    setStatusFilter('')
                  }}
                  title="Pastro filtrin e statusit"
                >×</span>
              )}
            </button>

            <button
              type="button"
              className={'m-chip' + (followupFilter !== 'all' ? ' m-chip-active' : '')}
              onClick={() => setMobileFilterSheet('followup')}
            >
              <span>{activeFollowupLabel}</span>
              {followupFilter !== 'all' && (
                <span
                  className="m-chip-clear"
                  onClick={e => {
                    e.stopPropagation()
                    setFollowupFilter('all')
                  }}
                  title="Pastro filtrin e ndjekjes"
                >×</span>
              )}
            </button>
          </div>

          {/* Active chips row */}
          {chips.length > 0 && (
            <div className="active-chips">
              {chips.map((c, i) => (
                <span key={i} className="chip-active">
                  {c.label}
                  <span className="x" onClick={c.clear}>×</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ── ZONE 3: MAP CANVAS / WORKSPACE STAGE ──────────────────────────────── */}
      <div className="workspace-stage">
        <main className="main">
          {children}
        </main>

        {/* Docked / Foldable Field Control Navigation & Actions */}
        <FieldControlPanel />
      </div>

      {/* ── DETAIL PANEL SURFACE WITH DETERMINISTIC ELEVATION ─────────────────── */}
      <div className={'side-backdrop' + (activeClient ? ' open' : '')} onClick={closePanel} />
      <SidePanel />

      {/* ── SECONDARY AI ASSISTANT ───────────────────────────────────────────── */}
      <AIChat />

      {/* ── LOCATION PERMISSION SURFACE ───────────────────────────────────────── */}
      {locationPermissionModalOpen && (
        <div
          className="modal-overlay-center location-modal-overlay"
          onClick={e => e.target === e.currentTarget && closeLocationPermissionModal(true)}
        >
          <div
            className="location-permission-card"
            role="dialog"
            aria-modal="true"
            aria-labelledby="loc-perm-title"
          >
            <div className="loc-perm-header">
              <span className="loc-perm-tag" id="loc-perm-title">USE YOUR LOCATION</span>
              <button
                type="button"
                className="modal-close"
                onClick={() => closeLocationPermissionModal(true)}
                aria-label="Mbyll"
              >
                ✕
              </button>
            </div>

            <p className="loc-perm-desc">
              EYE can use your current location while the app is open to:
            </p>

            <ul className="loc-perm-list">
              <li>attach locations to visits</li>
              <li>show your position on the map</li>
              <li>support nearby clients and routing</li>
            </ul>

            {locationStatus === 'denied' && (
              <div className="loc-perm-denied-note">
                Location access is off in your browser. Please allow location permissions in browser settings, then tap Enable location.
              </div>
            )}

            <div className="loc-perm-actions">
              <button
                type="button"
                className="btn-primary loc-enable-btn"
                onClick={() => enableLocation()}
              >
                Enable location
              </button>
              <button
                type="button"
                className="btn-cancel loc-dismiss-btn"
                onClick={() => closeLocationPermissionModal(true)}
              >
                Not now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── VISIT MODAL ──────────────────────────────────────────────────────── */}
      {visitModalOpen && (
        <div className="modal-overlay-center" onClick={e => e.target === e.currentTarget && closeVisitModal()}>
          <VisitModal />
        </div>
      )}

      {/* ── IMPORT INBOX MODAL ─────────────────────────────────────────────────── */}
      {importModalOpen && (
        <div className="modal-overlay-center import-modal-overlay" onClick={e => e.target === e.currentTarget && closeImportModal()}>
          <ImportModal />
        </div>
      )}

      {/* ── MOBILE FILTER SELECTION SHEET (MODAL ACTION SHEET) ───────────────── */}
      {mobileFilterSheet && (
        <>
          <div
            className="mobile-sheet-backdrop"
            onClick={() => setMobileFilterSheet(null)}
            aria-hidden="true"
          />
          <div className="mobile-sheet-panel" role="dialog" aria-modal="true">
            <div className="mobile-sheet-handle-bar">
              <span className="mobile-sheet-pill" />
            </div>
            <div className="mobile-sheet-header">
              <span className="mobile-sheet-title">
                {mobileFilterSheet === 'zone' && 'ZGJIDH ZONËN'}
                {mobileFilterSheet === 'status' && 'ZGJIDH STATUSIN'}
                {mobileFilterSheet === 'followup' && 'ZGJIDH NDJEKJEN'}
              </span>
              <button
                type="button"
                className="mobile-sheet-close"
                onClick={() => setMobileFilterSheet(null)}
                aria-label="Mbyll"
              >
                ✕
              </button>
            </div>

            <div className="mobile-sheet-list">
              {mobileFilterSheet === 'zone' &&
                zoneOptions.map(opt => {
                  const isSelected = zoneFilter === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={'mobile-sheet-item' + (isSelected ? ' selected' : '')}
                      onClick={() => {
                        setZoneFilter(opt.value)
                        setMobileFilterSheet(null)
                      }}
                    >
                      <span className="mobile-sheet-item-label">{opt.label}</span>
                      {isSelected && <span className="mobile-sheet-check">✓</span>}
                    </button>
                  )
                })}

              {mobileFilterSheet === 'status' &&
                statusOptions.map(opt => {
                  const isSelected = statusFilter === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={'mobile-sheet-item' + (isSelected ? ' selected' : '')}
                      onClick={() => {
                        setStatusFilter(opt.value)
                        setMobileFilterSheet(null)
                      }}
                    >
                      <span className="mobile-sheet-item-label">{opt.label}</span>
                      {isSelected && <span className="mobile-sheet-check">✓</span>}
                    </button>
                  )
                })}

              {mobileFilterSheet === 'followup' &&
                followupOptions.map(opt => {
                  const isSelected = followupFilter === opt.value
                  return (
                    <button
                      key={opt.value}
                      type="button"
                      className={'mobile-sheet-item' + (isSelected ? ' selected' : '')}
                      onClick={() => {
                        setFollowupFilter(opt.value as any)
                        setMobileFilterSheet(null)
                      }}
                    >
                      <span className="mobile-sheet-item-label">{opt.label}</span>
                      {isSelected && <span className="mobile-sheet-check">✓</span>}
                    </button>
                  )
                })}
            </div>
          </div>
        </>
      )}

      {/* ── TOAST NOTIFICATIONS ──────────────────────────────────────────────── */}
      {toastState && (
        <div key={toastState.key} className={'toast show' + (toastState.kind ? ' ' + toastState.kind : '')}>
          {toastState.msg}
        </div>
      )}
    </div>
  )
}
