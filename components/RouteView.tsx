'use client'

import { useState, useEffect } from 'react'
import { useApp } from '@/contexts/AppContext'
import {
  statusInfo, fmtAlbDate, todayISO,
  SQ_MONTHS, SQ_DAY_SHORT,
} from '@/lib/types'

function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

function firstDayOfMonth(year: number, month: number) {
  const d = new Date(year, month, 1).getDay()
  return (d + 6) % 7
}

export default function RouteView() {
  const { visits, loadVisits, visitsLoaded, clients, openVisitModal, deleteVisit } = useApp()

  const today = new Date()
  const [viewYear, setViewYear] = useState(today.getFullYear())
  const [viewMonth, setViewMonth] = useState(today.getMonth())
  const [selectedDay, setSelectedDay] = useState<string>(todayISO())

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

  const visitDays = new Set(visits.map(v => v.visit_date ?? '').filter(Boolean))
  const days = daysInMonth(viewYear, viewMonth)
  const firstDow = firstDayOfMonth(viewYear, viewMonth)

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
      <div className="calendar-card">
        <div className="cal-head">
          <div className="cal-controls">
            <button onClick={prevMonth}>‹</button>
          </div>
          <span className="cal-month">{SQ_MONTHS[viewMonth]} {viewYear}</span>
          <div className="cal-controls">
            <button onClick={nextMonth}>›</button>
          </div>
        </div>

        <div className="cal-weekdays">
          {SQ_DAY_SHORT.map(d => (
            <div key={d} className="cal-weekday">{d}</div>
          ))}
        </div>

        <div className="cal-grid">
          {Array.from({ length: firstDow }).map((_, i) => (
            <div key={`e${i}`} className="cal-day other-month" />
          ))}
          {Array.from({ length: days }, (_, i) => i + 1).map(day => {
            const iso = isoForDay(day)
            const isToday = iso === todayISO()
            const isSelected = iso === selectedDay
            const hasDot = visitDays.has(iso)
            const cls = [
              'cal-day',
              isToday ? 'today' : '',
              isSelected ? 'selected' : '',
              hasDot ? 'has-visits' : '',
            ].filter(Boolean).join(' ')
            return (
              <div key={day} className={cls} onClick={() => setSelectedDay(iso)}>
                {day}
              </div>
            )
          })}
        </div>
      </div>

      <div className="daily-log">
        <div className="dl-head">
          <span className="dl-title">
            {fmtAlbDate(selectedDay)}
            {dayVisits.length > 0 && (
              <span className="sub">{dayVisits.length} vizitë</span>
            )}
          </span>
          {dayVisits.length > 0 && (
            <span className="dl-count">{dayVisits.length}</span>
          )}
        </div>

        <button
          className="add-visit-btn"
          onClick={() => openVisitModal(undefined, selectedDay)}
        >
          + Shto Vizitë
        </button>

        {dayVisits.length === 0 ? (
          <div className="empty-route">Asnjë vizitë për këtë ditë.</div>
        ) : (
          dayVisits.map(v => {
            const info = statusInfo(v.statusi ?? undefined)
            return (
              <div key={v.id} className="visit-card">
                <div className="vc-head">
                  <span className="vc-name">{clientName(v.client_id)}</span>
                  <span className={`status-badge ${info.cls}`}>{info.label}</span>
                </div>
                {v.shenime && <div className="vc-notes">{v.shenime}</div>}
                {v.location_url && (
                  <a className="vc-loc" href={v.location_url} target="_blank" rel="noopener">
                    📍 Vendndodhja
                  </a>
                )}
                <div className="vc-actions">
                  <button
                    className="vc-edit"
                    onClick={() => openVisitModal(v.id, v.visit_date ?? undefined)}
                  >
                    ✏️ Ndrysho
                  </button>
                  <button
                    className="vc-delete"
                    onClick={async () => {
                      if (confirm('Fshi vizitën?')) await deleteVisit(v.id)
                    }}
                  >
                    🗑 Fshi
                  </button>
                </div>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
