'use client'

import { EYE_ROUTES } from '@/lib/product/capabilities'

import { useState, useMemo, useEffect, useRef } from 'react'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useApp } from '@/contexts/AppContext'
import type { OperationalAction } from '@/lib/actions/types'
import { formatFollowupDate } from '@/lib/followup'

// ── Minimal Monochrome Hairline Icons (Savvy Systems) ──────────────────────────
function MapIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="3 6 9 3 15 6 21 3 21 18 15 21 9 18 3 21 3 6" />
      <line x1="9" y1="3" x2="9" y2="18" />
      <line x1="15" y1="6" x2="15" y2="21" />
    </svg>
  )
}

function RouteIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  )
}

function ClientsIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  )
}

function NextActionIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

// ── Time & Date Helpers ────────────────────────────────────────────────────────
function formatReminderTime(dueTime: string | null | undefined): string {
  if (!dueTime) return ''
  const trimmed = dueTime.trim()
  if (trimmed.length >= 5) {
    return trimmed.slice(0, 5)
  }
  return trimmed
}

function formatReminderSchedule(
  dueDate: string | null | undefined,
  dueTime: string | null | undefined,
  category: 'OVERDUE' | 'TODAY' | 'UPCOMING' | 'UNSCHEDULED'
): string {
  if (category === 'UNSCHEDULED') return 'Pa afat'
  const timeStr = formatReminderTime(dueTime)

  if (category === 'TODAY') {
    return timeStr ? timeStr : 'Sot'
  }

  if (category === 'OVERDUE') {
    const dStr = dueDate ? formatFollowupDate(dueDate, { short: true }) : 'Me vonesë'
    return timeStr ? (dStr + ' ' + timeStr) : dStr
  }

  // UPCOMING
  if (!dueDate) return timeStr || 'Në vijim'
  const dStr = formatFollowupDate(dueDate, { short: true })
  return timeStr ? (dStr + ' ' + timeStr) : dStr
}

export default function FieldControlPanel() {
  const pathname = usePathname()
  const { clients, todayVisitsCount, operationalActions, actionState, changeAction, openPanel } = useApp()

  // Desktop foldout state
  const [isExpanded, setIsExpanded] = useState(false)
  const [showAllInList, setShowAllInList] = useState(false)
  const [dismissingReminderIds, setDismissingReminderIds] = useState<Set<string>>(new Set())

  // Mobile 3-state bottom sheet: 'collapsed' | 'half' | 'full'
  const [mobileSheetState, setMobileSheetState] = useState<'collapsed' | 'half' | 'full'>('collapsed')
  const touchStartY = useRef<number | null>(null)



  // Close desktop on Escape key press
  useEffect(() => {
    if (!isExpanded && mobileSheetState === 'collapsed') return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setIsExpanded(false)
        setMobileSheetState('collapsed')
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isExpanded, mobileSheetState])

  // Reset mobile sheet when pathname changes
  useEffect(() => {
    setMobileSheetState('collapsed')
  }, [pathname])

  const categorized = useMemo(() => {
    const groups = operationalActions.groups()
    return { overdue: groups?.overdue ?? [], dueToday: groups?.today ?? [], upcoming: groups?.upcoming ?? [], unscheduled: groups?.unscheduled ?? [] }
  }, [operationalActions, actionState])
  const totalActiveActions = actionState.status === 'loaded' ? actionState.actions.length : 0
  const hasOverdue = categorized.overdue.length > 0
  const prioritizedItems = useMemo(() => {
    let remaining = showAllInList ? Infinity : 5
    const take = (items: OperationalAction[]) => { const result = items.slice(0, remaining); remaining -= result.length; return result }
    const overdue = take(categorized.overdue), dueToday = take(categorized.dueToday), upcoming = take(categorized.upcoming), unscheduled = take(categorized.unscheduled)
    return { overdue, dueToday, upcoming, unscheduled, totalShown: overdue.length + dueToday.length + upcoming.length + unscheduled.length }
  }, [categorized, showAllInList])

  const mobilePreview = useMemo(() => {
    let remaining = 3
    const take = (items: OperationalAction[]) => { const result = items.slice(0, remaining); remaining -= result.length; return result }
    const overdue = take(categorized.overdue), dueToday = take(categorized.dueToday), upcoming = take(categorized.upcoming), unscheduled = take(categorized.unscheduled)
    return { overdue, dueToday, upcoming, unscheduled, totalShown: 3 - remaining }
  }, [categorized])

  const hasMoreActions = totalActiveActions > prioritizedItems.totalShown

  const handleReminderClick = (reminder: OperationalAction) => {
    if (reminder.client_id) {
      // Ensure bottom sheet collapses so detail sheet takes precedence
      setMobileSheetState('collapsed')
      openPanel(reminder.client_id)
    }
  }

  const handleReminderDone = async (event: React.MouseEvent<HTMLButtonElement>, reminder: OperationalAction) => {
    event.stopPropagation()
    if (dismissingReminderIds.has(reminder.id)) return
    setDismissingReminderIds(previous => new Set(previous).add(reminder.id))
    try {
      await changeAction({ operation: 'surface', intent: 'complete', requestId: crypto.randomUUID(), channel: 'field_control', clientId: reminder.client_id, actionId: reminder.id, expectedVersion: reminder.version, expectedRevision: reminder.revision })
    } finally {
      setDismissingReminderIds(previous => {
        const next = new Set(previous)
        next.delete(reminder.id)
        return next
      })
    }
  }

  const renderReminderSide = (reminder: OperationalAction, category: 'OVERDUE' | 'TODAY' | 'UPCOMING' | 'UNSCHEDULED') => (
    <div className="fc-action-side">
      <div className={'fc-action-time' + (category === 'OVERDUE' ? ' fc-time-overdue' : '')}>
        {formatReminderSchedule(reminder.due_date, reminder.due_time, category)}
      </div>
      <button
        type="button"
        className="fc-action-done"
        disabled={dismissingReminderIds.has(reminder.id) || !reminder.allowed_operations?.includes('complete')}
        onClick={event => handleReminderDone(event, reminder)}
        aria-label={`Shëno si të kryer: ${reminder.client_name_snapshot || 'veprimi'}`}
      >
        {dismissingReminderIds.has(reminder.id) ? '…' : '✓ Kryer'}
      </button>
    </div>
  )

  const activeWorkspaceName =
    pathname === EYE_ROUTES.ROUTE ? 'Visits' : pathname === EYE_ROUTES.CLIENTS ? 'Clients' : 'Map'

  // ── Touch swipe gesture handler for mobile bottom sheet ──────────────────────
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartY.current = e.touches[0].clientY
  }

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (touchStartY.current === null) return
    const touchEndY = e.changedTouches[0].clientY
    const deltaY = touchEndY - touchStartY.current
    touchStartY.current = null

    // Swipe up
    if (deltaY < -35) {
      if (mobileSheetState === 'collapsed') {
        setMobileSheetState('half')
      } else if (mobileSheetState === 'half') {
        setMobileSheetState('full')
      }
    }
    // Swipe down
    else if (deltaY > 35) {
      if (mobileSheetState === 'full') {
        setMobileSheetState('half')
      } else if (mobileSheetState === 'half') {
        setMobileSheetState('collapsed')
      }
    }
  }

  const cycleMobileState = () => {
    if (mobileSheetState === 'collapsed') {
      setMobileSheetState('half')
    } else if (mobileSheetState === 'half') {
      setMobileSheetState('full')
    } else {
      setMobileSheetState('collapsed')
    }
  }

  // ── Render Actions Content ───────────────────────────────────────────────────
  const renderNextActionsList = (itemsToRender = prioritizedItems) => {
    if (actionState.status === 'idle' || actionState.status === 'loading') return <div className="fc-empty-actions" role="status">Duke ngarkuar veprimet…</div>
    if (actionState.status !== 'loaded') return <div className="fc-empty-actions" role="alert">{actionState.status === 'authentication_error' ? 'Identifikohu për veprimet.' : 'Veprimet nuk u ngarkuan.'} <button type="button" onClick={() => operationalActions.refresh()}>Provo përsëri</button></div>
    if (totalActiveActions === 0) return <div className="fc-empty-actions">Nuk ka veprime aktive në pritje</div>
    const sections = [
      { key: 'overdue' as const, cls: 'overdue', label: 'ME VONESË', schedule: 'OVERDUE' as const },
      { key: 'dueToday' as const, cls: 'today', label: 'SOT', schedule: 'TODAY' as const },
      { key: 'upcoming' as const, cls: 'upcoming', label: 'NË VIJIM', schedule: 'UPCOMING' as const },
      { key: 'unscheduled' as const, cls: 'upcoming', label: 'PA AFAT', schedule: 'UNSCHEDULED' as const },
    ]
    return <div className="fc-actions-scroll">
      {sections.map(section => itemsToRender[section.key].length > 0 && <div className="fc-group" key={section.key}>
        <div className={`fc-group-title fc-group-${section.cls}`}><span className={`fc-${section.cls}-dot`} />{section.label} ({categorized[section.key].length})</div>
        {itemsToRender[section.key].map(r => <div key={r.id} className={`fc-action-item fc-action-item--${section.cls}`} onClick={() => handleReminderClick(r)} onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') handleReminderClick(r) }} role="button" tabIndex={0}>
          <div className="fc-action-main"><div className="fc-action-header-row"><span className={`fc-action-pip fc-pip-${section.cls}`} /><div className="fc-action-name">{r.client_name_snapshot || 'Klient pa emër'}</div></div><div className="fc-action-desc">{r.description}</div></div>
          {renderReminderSide(r, section.schedule)}
        </div>)}
      </div>)}
      {hasMoreActions && !showAllInList && <button type="button" className="fc-more-btn" onClick={e => { e.stopPropagation(); setShowAllInList(true) }}><span>Shfaq të gjitha ({totalActiveActions})</span><span>▾</span></button>}
    </div>
  }

  return (
    <>
      {/* ── DESKTOP DOCKED / EXPANDABLE FIELD CONTROL (Preserved) ─────────── */}
      {!isExpanded ? (
        <button
          type="button"
          className="field-control-dock"
          onClick={() => setIsExpanded(true)}
          aria-label="Hap Field Control Panel"
          title="Field Control — Navigimi & Veprimet e ardhshme"
        >
          <div className="fc-dock-left">
            <span className="fc-dock-icon">
              {pathname === '/map' && <MapIcon />}
              {pathname === '/route' && <RouteIcon />}
              {pathname === '/list' && <ClientsIcon />}
            </span>
            <span className="fc-dock-label">CONTROL</span>
            <span className="fc-dock-sep">·</span>
            <span className="fc-dock-active-route">{activeWorkspaceName}</span>
          </div>

          <div className="fc-dock-right">
            {hasOverdue && (
              <span className="fc-dock-badge-overdue" title={categorized.overdue.length + ' me vonesë'}>
                {categorized.overdue.length}
              </span>
            )}
            <span className="fc-dock-chevron">›</span>
          </div>
        </button>
      ) : (
        <>
          <div
            className="field-control-backdrop"
            onClick={() => setIsExpanded(false)}
            aria-hidden="true"
          />

          <aside
            className="field-control-desktop expanded"
            aria-label="Field Control Navigation"
          >
            <div className="fc-header">
              <div className="fc-header-left">
                <span className="fc-title">FIELD CONTROL</span>
                <span className="fc-status-live" title="Sistem aktiv" />
              </div>
              <button
                type="button"
                className="fc-close-btn"
                onClick={() => setIsExpanded(false)}
                aria-label="Mbyll Field Control"
                title="Mbyll panelin (Esc)"
              >
                <CloseIcon />
              </button>
            </div>

            <nav className="fc-nav" aria-label="Workspace Navigation">
              <Link
                href="/map"
                className={'fc-nav-row' + (pathname === '/map' ? ' active' : '')}
              >
                <div className="fc-row-left">
                  <span className="fc-icon"><MapIcon /></span>
                  <span className="fc-label">Map</span>
                </div>
                <div className="fc-row-right">
                  {pathname === '/map' ? (
                    <span className="fc-active-indicator">Aktiv</span>
                  ) : (
                    <span className="fc-inactive-dot" />
                  )}
                </div>
              </Link>

              <Link
                href="/route"
                className={'fc-nav-row' + (pathname === '/route' ? ' active' : '')}
              >
                <div className="fc-row-left">
                  <span className="fc-icon"><RouteIcon /></span>
                  <span className="fc-label">Visits</span>
                </div>
                <div className="fc-row-right">
                  <span className={pathname === '/route' ? 'fc-active-pill' : 'fc-count-pill'}>
                    {todayVisitsCount} sot
                  </span>
                </div>
              </Link>

              <Link
                href="/list"
                className={'fc-nav-row' + (pathname === '/list' ? ' active' : '')}
              >
                <div className="fc-row-left">
                  <span className="fc-icon"><ClientsIcon /></span>
                  <span className="fc-label">Clients</span>
                </div>
                <div className="fc-row-right">
                  <span className={pathname === '/list' ? 'fc-active-pill' : 'fc-count-pill'}>
                    {clients.length}
                  </span>
                </div>
              </Link>
            </nav>

            <div className="fc-divider" />

            {/* Next Actions Section */}
            <div className="fc-actions-section">
              <div className="fc-actions-head">
                <div className="fc-actions-head-left">
                  <span className="fc-icon-actions"><NextActionIcon /></span>
                  <span className="fc-actions-label">NEXT ACTIONS</span>
                </div>
                <div className="fc-actions-head-right">
                  <span className={'fc-count-pill' + (hasOverdue ? ' fc-pill-crimson' : '')}>
                    {totalActiveActions}
                  </span>
                </div>
              </div>

              {hasOverdue && (
                <div className="fc-overdue-banner">
                  <span className="fc-crimson-dot" />
                  <span>{categorized.overdue.length} veprime me vonesë</span>
                </div>
              )}

              {renderNextActionsList()}
            </div>

            <div className="fc-footer">
              <button
                type="button"
                className="fc-collapse-bar"
                onClick={() => setIsExpanded(false)}
              >
                <span>‹ Palos panelin</span>
              </button>
            </div>
          </aside>
        </>
      )}

      {/* ── MOBILE FIELD CONTROL: 3-STATE NATIVE BOTTOM SHEET (<= 767px) ──── */}
      {mobileSheetState !== 'collapsed' && (
        <div
          className="fcm-sheet-backdrop"
          onClick={() => setMobileSheetState('collapsed')}
          aria-hidden="true"
        />
      )}

      <div
        className={'field-control-mobile state-' + mobileSheetState}
        aria-label="Mobile Field Control"
      >
        {/* Drag Handle Bar */}
        <div
          className="fcm-handle-bar"
          onTouchStart={handleTouchStart}
          onTouchEnd={handleTouchEnd}
          onClick={cycleMobileState}
          role="button"
          tabIndex={0}
          aria-label="Ndrysho gjendjen e panelit (Collapsed / Half / Full)"
        >
          <span className="fcm-handle-pill" />
        </div>

        {/* Collapsed Bar / Header */}
        <div
          className="fcm-bar"
          onClick={() => {
            if (mobileSheetState === 'collapsed') {
              setMobileSheetState('half')
            }
          }}
          role="button"
          tabIndex={0}
        >
          <div className="fcm-header-row">
            <div className="fcm-title-wrap">
              <span className="fcm-view-icon">
                {pathname === '/map' && <MapIcon />}
                {pathname === '/route' && <RouteIcon />}
                {pathname === '/list' && <ClientsIcon />}
              </span>
              <span className="fcm-title">CONTROL</span>
              <span className="fcm-sep">·</span>
              <span className="fcm-active-view">{activeWorkspaceName}</span>
            </div>

            <div className="fcm-right-wrap">
              {hasOverdue ? (
                <span className="fcm-crimson-badge">
                  <span className="fc-action-pip fc-pip-overdue" />
                  {categorized.overdue.length} me vonesë
                </span>
              ) : totalActiveActions > 0 ? (
                <span className="fcm-count-badge">
                  {totalActiveActions} veprime
                </span>
              ) : null}

              <button
                type="button"
                className="fcm-chevron-toggle"
                onClick={e => {
                  e.stopPropagation()
                  cycleMobileState()
                }}
                aria-label="Zgjero ose palos panelin"
              >
                {mobileSheetState === 'full' ? '▼' : mobileSheetState === 'half' ? '▼' : '▲'}
              </button>
            </div>
          </div>
        </div>

        {/* Navigation Surface (Visible in 'half' and 'full' states) */}
        {mobileSheetState !== 'collapsed' && (
          <div className="fcm-expanded-content">
            <nav className="fcm-nav-grid" aria-label="Mobile Navigation">
              <Link
                href="/map"
                className={'fcm-nav-btn' + (pathname === '/map' ? ' active' : '')}
                onClick={() => setMobileSheetState('collapsed')}
              >
                <span className="fcm-btn-icon"><MapIcon /></span>
                <span className="fcm-btn-text">Map</span>
                {pathname === '/map' && <span className="fcm-btn-dot" />}
              </Link>
              <Link
                href="/route"
                className={'fcm-nav-btn' + (pathname === '/route' ? ' active' : '')}
                onClick={() => setMobileSheetState('collapsed')}
              >
                <span className="fcm-btn-icon"><RouteIcon /></span>
                <span className="fcm-btn-text">Visits</span>
                <span className="fcm-btn-pill">{todayVisitsCount} sot</span>
                {pathname === '/route' && <span className="fcm-btn-dot" />}
              </Link>
              <Link
                href="/list"
                className={'fcm-nav-btn' + (pathname === '/list' ? ' active' : '')}
                onClick={() => setMobileSheetState('collapsed')}
              >
                <span className="fcm-btn-icon"><ClientsIcon /></span>
                <span className="fcm-btn-text">Clients</span>
                <span className="fcm-btn-pill">{clients.length}</span>
                {pathname === '/list' && <span className="fcm-btn-dot" />}
              </Link>
            </nav>

            <div className="fcm-actions-section">
              <div className="fcm-actions-header">
                <div className="fcm-actions-title-wrap">
                  <NextActionIcon />
                  <span className="fcm-actions-title">NEXT ACTIONS ({totalActiveActions})</span>
                </div>
                {hasOverdue && (
                  <span className="fc-crimson-tag">{categorized.overdue.length} ME VONESË</span>
                )}
              </div>

              {mobileSheetState === 'half' ? (
                <>
                  {renderNextActionsList(mobilePreview)}
                  {totalActiveActions > 3 && (
                    <button
                      type="button"
                      className="fcm-expand-full-btn"
                      onClick={() => setMobileSheetState('full')}
                    >
                      <span>Shiko të gjitha veprimet ({totalActiveActions})</span>
                      <span>▲</span>
                    </button>
                  )}
                </>
              ) : (
                <>
                  {renderNextActionsList({
                    overdue: categorized.overdue,
                    dueToday: categorized.dueToday,
                    upcoming: categorized.upcoming,
                    unscheduled: categorized.unscheduled,
                    totalShown: totalActiveActions,
                  })}
                  <div className="fcm-full-footer">
                    <button
                      type="button"
                      className="fcm-collapse-action"
                      onClick={() => setMobileSheetState('collapsed')}
                    >
                      <span>‹ Palos panelin</span>
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  )
}
