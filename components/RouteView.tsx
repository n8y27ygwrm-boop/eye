'use client'

import { useState, useEffect } from 'react'
import { useApp } from '@/contexts/AppContext'
import { getVisitDisplayName } from '@/lib/lifecycle'
import {
  statusInfo, todayISO,
  SQ_MONTHS, SQ_DAY_SHORT, SQ_DAY_FULL, type Visit,
} from '@/lib/types'

function daysInMonth(year: number, month: number) {
  return new Date(year, month + 1, 0).getDate()
}

function firstDayOfMonth(year: number, month: number) {
  const d = new Date(year, month, 1).getDay()
  return (d + 6) % 7
}

function parseISODate(iso: string) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export default function RouteView() {
  const { visits, loadVisits, visitsLoaded, clients, openVisitModal, deleteVisit } = useApp()

  const today = new Date()
  const [viewMode, setViewMode] = useState<'month' | 'day'>('month')
  const [viewYear, setViewYear] = useState(today.getFullYear())
  const [viewMonth, setViewMonth] = useState(today.getMonth())
  const [selectedDay, setSelectedDay] = useState<string>(todayISO())

  useEffect(() => {
    if (!visitsLoaded) loadVisits()
  }, [visitsLoaded, loadVisits])

  function prevMonth() {
    if (viewMonth === 0) { setViewYear(y => y - 1); setViewMonth(11) }
    else setViewMonth(m => m - 1)
  }
  function nextMonth() {
    if (viewMonth === 11) { setViewYear(y => y + 1); setViewMonth(0) }
    else setViewMonth(m => m + 1)
  }
  function goToToday() {
    const now = new Date()
    setViewYear(now.getFullYear())
    setViewMonth(now.getMonth())
    setSelectedDay(todayISO())
  }

  const isCurrentMonth = today.getFullYear() === viewYear && today.getMonth() === viewMonth

  const visitDays = new Set(visits.map(v => v.visit_date ?? '').filter(Boolean))
  const days = daysInMonth(viewYear, viewMonth)
  const firstDow = firstDayOfMonth(viewYear, viewMonth)

  const dayVisits = visits
    .filter(v => v.visit_date === selectedDay)
    .sort((a, b) => (a.created_at ?? '') > (b.created_at ?? '') ? -1 : 1)

  function isoForDay(day: number) {
    return `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  // Resolved safely via centralized lifecycle helper
  const renderVisitName = (v: Visit) => getVisitDisplayName(v, clients)

  function handleSelectDay(iso: string) {
    setSelectedDay(iso)
    setViewMode('day')
  }

  const selectedDt = parseISODate(selectedDay)
  const selectedWeekday = SQ_DAY_FULL[selectedDt.getDay()]
  const selectedDayNum = selectedDt.getDate()
  const selectedMonthName = SQ_MONTHS[selectedDt.getMonth()]
  const selectedYear = selectedDt.getFullYear()

  return (
    <div className="route-wrap">
      {viewMode === 'month' ? (
        <div className="calendar-card">
          <div className="cal-head">
            <div className="cal-controls">
              <button onClick={prevMonth} aria-label="Muaji i kaluar">‹</button>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <span className="cal-month">{SQ_MONTHS[viewMonth]} {viewYear}</span>
              {!isCurrentMonth && (
                <button className="today-btn" onClick={goToToday}>Sot</button>
              )}
            </div>
            <div className="cal-controls">
              <button onClick={nextMonth} aria-label="Muaji i ardhshëm">›</button>
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
                <button
                  key={day}
                  type="button"
                  className={cls}
                  onClick={() => handleSelectDay(iso)}
                >
                  <span className="cal-day-num">{day}</span>
                </button>
              )
            })}
          </div>
        </div>
      ) : (
        <div className="day-view-card">
          <div className="dv-top-bar">
            <button className="dv-back-btn" onClick={() => setViewMode('month')}>
              <span className="dv-back-arrow">←</span>
              <span>Muaji</span>
            </button>

            <button
              className="dv-add-btn"
              onClick={() => openVisitModal(undefined, selectedDay)}
            >
              + Shto Vizitë
            </button>
          </div>

          <div className="dv-header">
            <div className="dv-date-block">
              <div className="dv-weekday">{selectedWeekday}</div>
              <div className="dv-date">{selectedDayNum} {selectedMonthName} {selectedYear}</div>
            </div>
            <div className="dv-count-badge">
              {dayVisits.length === 0 ? '0 vizita' : `${dayVisits.length} ${dayVisits.length === 1 ? 'vizitë' : 'vizita'}`}
            </div>
          </div>

          {dayVisits.length === 0 ? (
            <div className="dv-empty">
              <div className="dv-empty-icon">📅</div>
              <div className="dv-empty-title">Asnjë vizitë për këtë ditë.</div>
              <div className="dv-empty-sub">Planifiko një takim ose regjistro një vizitë në terren.</div>
              <button
                className="add-visit-btn"
                style={{ maxWidth: 220, margin: '16px auto 0' }}
                onClick={() => openVisitModal(undefined, selectedDay)}
              >
                + Shto Vizitë
              </button>
            </div>
          ) : (
            <div className="dv-visits-list">
              {dayVisits.map(v => {
                const info = statusInfo(v.statusi ?? undefined)
                return (
                  <div
                    key={v.id}
                    className="visit-card"
                    onClick={() => openVisitModal(v.id, v.visit_date ?? undefined)}
                    role="button"
                    tabIndex={0}
                  >
                    <div className="vc-head">
                      <span className="vc-name">{renderVisitName(v)}</span>
                      <span className={`status-badge ${info.cls}`}>{info.label}</span>
                    </div>
                    {v.shenime && <div className="vc-notes">{v.shenime}</div>}
                    {v.location_url && (
                      <a
                        className="vc-loc"
                        href={v.location_url}
                        target="_blank"
                        rel="noopener"
                        onClick={e => e.stopPropagation()}
                      >
                        Vendndodhja
                      </a>
                    )}
                    <div className="vc-actions">
                      <button
                        type="button"
                        className="vc-edit"
                        onClick={e => {
                          e.stopPropagation()
                          openVisitModal(v.id, v.visit_date ?? undefined)
                        }}
                      >
                        Ndrysho
                      </button>
                      <button
                        type="button"
                        className="vc-delete"
                        onClick={async e => {
                          e.stopPropagation()
                          if (confirm('Fshi vizitën?')) await deleteVisit(v.id)
                        }}
                      >
                        Fshi
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}
      {/* Mobile Floating / Sticky Add Visit CTA */}
      <div className="mobile-add-visit-container">
        <button
          type="button"
          className="mobile-sticky-add-btn"
          onClick={() => openVisitModal(undefined, selectedDay)}
          aria-label="Shto vizitë të re"
        >
          <span>+ Shto Vizitë</span>
        </button>
      </div>
    </div>
  )
}
