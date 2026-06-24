'use client'

import { useState, useEffect } from 'react'
import { useApp } from '@/contexts/AppContext'
import {
  statusInfo, fmtAlbDate, fmtDateTime, todayISO, isoDate,
  SQ_MONTHS, SQ_DAY_SHORT, type Visit
} from '@/lib/types'

function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

function firstDayOfMonth(year: number, month: number) {
  // Monday-first: Sunday (0) → 6, Monday (1) → 0, ...
  const d = new Date(year, month, 1).getDay()
  return (d + 6) % 7
}

export default function RouteView() {
  const { visits, loadVisits, visitsLoaded, clients, openVisitModal, deleteVisit } = useApp()

  const today = new Date()
  const [viewYear, setViewYear] = useState(today.getFullYear())
  const [viewMonth, setViewMonth] = useState(today.getMonth())
  const [selectedDay, setSelectedDay] = useState<string>(todayISO())

  // Lazy-load visits on first RouteView mount
  useEffect(() => {
    if (!visitsLoaded) loadVisits()
  }, [])

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11) }
    else setViewMonth(m => m - 1)
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0) }
    else setViewMonth(m => m + 1)
  }

  // Build set of days that have visits for dot indicators
  const visitDays = new Set(visits.map(v => v.visit_date ?? '').filter(Boolean))

  const days = daysInMonth(viewYear, viewMonth)
  const firstDow = firstDayOfMonth(viewYear, viewMonth)

  // Visits for the selected day
  const dayVisits = visits
    .filter(v => v.visit_date === selectedDay)
    .sort((a, b) => (a.created_at ?? '') > (b.created_at ?? '') ? -1 : 1)

  function isoForDay(day: number) {
    return `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  function clientName(clientId: string | null) {
    if (!clientId) return '—'
    return clients.find(c => c.id === clientId)?.business_name ?? clientId
  }

  return (
    <div className="route-wrap">
      {/* Calendar header */}
      <div className="cal-header">
        <button className="cal-nav" onClick={prevMonth}>‹</button>
        <span className="cal-title">{SQ_MONTHS[viewMonth]} {viewYear}</span>
        <button className="cal-nav" onClick={nextMonth}>›</button>
      </div>

      {/* Day-of-week labels */}
      <div className="cal-grid">
        {SQ_DAY_SHORT.map(d => (
          <div key={d} className="cal-dow">{d}</div>
        ))}

        {/* Empty cells before first day */}
        {Array.from({ length: firstDow }).map((_, i) => (
          <div key={`e${i}`} className="cal-cell empty" />
        ))}

        {/* Day cells */}
        {Array.from({ length: days }, (_, i) => i + 1).map(day => {
          const iso = isoForDay(day)
          const isToday = iso === todayISO()
          const isSelected = iso === selectedDay
          const hasDot = visitDays.has(iso)
          return (
            <div
              key={day}
              className={`cal-cell${isToday ? ' today' : ''}${isSelected ? ' selected' : ''}`}
              onClick={() => setSelectedDay(iso)}
            >
              <span className="cal-day-num">{day}</span>
              {hasDot && <span className="cal-dot" />}
            </div>
          )
        })}
      </div>

      {/* Selected day visits */}
      <div className="day-panel">
        <div className="day-panel-head">
          <span className="day-title">{fmtAlbDate(selectedDay)}</span>
          <button
            className="btn-add-visit"
            onClick={() => openVisitModal(undefined, selectedDay)}
          >
            + Vizitë
          </button>
        </div>

        {dayVisits.length === 0 ? (
          <div className="day-empty">Asnjë vizitë për këtë ditë.</div>
        ) : (
          dayVisits.map(v => {
            const info = statusInfo(v.statusi ?? undefined)
            return (
              <div key={v.id} className="visit-card">
                <div className="vc-head">
                  <span className="vc-name">{clientName(v.client_id)}</span>
                  <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                    <span className={`status-badge ${info.cls}`}>{info.label}</span>
                    <button
                      className="vc-edit"
                      onClick={() => openVisitModal(v.id, v.visit_date ?? undefined)}
                      title="Ndrysho"
                    >✏️</button>
                    <button
                      className="vc-del"
                      onClick={async () => {
                        if (confirm('Fshi vizitën?')) await deleteVisit(v.id)
                      }}
                      title="Fshi"
                    >🗑</button>
                  </div>
                </div>
                {v.shenime && <div className="vc-notes">{v.shenime}</div>}
                {v.location_url && (
                  <a className="vc-loc" href={v.location_url} target="_blank" rel="noopener">
                    📍 Vendndodhja
                  </a>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
