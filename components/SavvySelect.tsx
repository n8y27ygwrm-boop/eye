'use client'

import { useState, useRef, useEffect, useCallback } from 'react'

export type SelectOption = {
  value: string
  label: string
}

interface SavvySelectProps {
  value: string
  onChange: (value: string) => void
  options: SelectOption[]
  placeholder?: string
  ariaLabel?: string
}

export default function SavvySelect({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
}: SavvySelectProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [highlightedIndex, setHighlightedIndex] = useState(-1)
  const containerRef = useRef<HTMLDivElement>(null)
  const listboxRef = useRef<HTMLUListElement>(null)

  const selectedOption = options.find(o => o.value === value)
  const displayLabel = selectedOption ? selectedOption.label : (placeholder || options[0]?.label || '')
  const filterTitle = ariaLabel || placeholder || 'Filtro'

  // Close on outside click (desktop)
  useEffect(() => {
    if (!isOpen) return
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  // Close on Escape, navigate with Arrow keys
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (!isOpen) {
        if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          setIsOpen(true)
          const currIdx = options.findIndex(o => o.value === value)
          setHighlightedIndex(currIdx >= 0 ? currIdx : 0)
        }
        return
      }

      if (e.key === 'Escape') {
        e.preventDefault()
        setIsOpen(false)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightedIndex(prev => (prev + 1 < options.length ? prev + 1 : 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightedIndex(prev => (prev - 1 >= 0 ? prev - 1 : options.length - 1))
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        if (highlightedIndex >= 0 && highlightedIndex < options.length) {
          onChange(options[highlightedIndex].value)
          setIsOpen(false)
        }
      } else if (e.key === 'Tab') {
        setIsOpen(false)
      }
    },
    [isOpen, options, value, highlightedIndex, onChange]
  )

  // Scroll highlighted item into view
  useEffect(() => {
    if (isOpen && highlightedIndex >= 0 && listboxRef.current) {
      const items = listboxRef.current.children
      if (items[highlightedIndex]) {
        (items[highlightedIndex] as HTMLElement).scrollIntoView({
          block: 'nearest',
        })
      }
    }
  }, [highlightedIndex, isOpen])

  function selectOption(optValue: string) {
    onChange(optValue)
    setIsOpen(false)
  }

  return (
    <div
      ref={containerRef}
      className={'savvy-select-wrap' + (isOpen ? ' is-open' : '')}
      onKeyDown={handleKeyDown}
    >
      <button
        type="button"
        className={'savvy-select-trigger' + (value && value !== 'all' ? ' has-value' : '')}
        onClick={() => {
          setIsOpen(prev => !prev)
          const currIdx = options.findIndex(o => o.value === value)
          setHighlightedIndex(currIdx >= 0 ? currIdx : 0)
        }}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-label={filterTitle}
      >
        <span className="savvy-select-label">{displayLabel}</span>
        <svg
          className={'savvy-select-chevron' + (isOpen ? ' rotated' : '')}
          width="10"
          height="10"
          viewBox="0 0 12 12"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          aria-hidden="true"
        >
          <path
            d="M3 4.5L6 7.5L9 4.5"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {/* ── Desktop Floating Dropdown List (>= 768px) ─────────────────────────── */}
      {isOpen && (
        <ul
          ref={listboxRef}
          role="listbox"
          className="savvy-select-dropdown"
          aria-label={filterTitle}
        >
          {options.map((opt, index) => {
            const isSelected = opt.value === value
            const isHighlighted = index === highlightedIndex

            return (
              <li
                key={opt.value}
                role="option"
                aria-selected={isSelected}
                className={
                  'savvy-select-option' +
                  (isSelected ? ' is-selected' : '') +
                  (isHighlighted && !isSelected ? ' is-highlighted' : '')
                }
                onClick={() => selectOption(opt.value)}
                onMouseEnter={() => setHighlightedIndex(index)}
              >
                <span className="savvy-opt-label">{opt.label}</span>
                {isSelected && (
                  <svg
                    className="savvy-opt-check"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                )}
              </li>
            )
          })}
        </ul>
      )}

      {/* ── Mobile Action Bottom Sheet (< 768px) ──────────────────────────────── */}
      {isOpen && (
        <div className="savvy-mobile-sheet-portal" aria-modal="true" role="dialog">
          <div
            className="savvy-mobile-sheet-backdrop"
            onClick={() => setIsOpen(false)}
            aria-hidden="true"
          />
          <div className="savvy-mobile-sheet-container">
            <div className="savvy-mobile-sheet-drag" onClick={() => setIsOpen(false)}>
              <span className="drag-pill" />
            </div>
            <div className="savvy-mobile-sheet-head">
              <span className="savvy-mobile-sheet-title">{filterTitle}</span>
              <button
                type="button"
                className="savvy-mobile-sheet-close"
                onClick={() => setIsOpen(false)}
                aria-label="Mbyll zgjedhjet"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" y1="6" x2="6" y2="18" />
                  <line x1="6" y1="6" x2="18" y2="18" />
                </svg>
              </button>
            </div>
            <ul className="savvy-mobile-sheet-list" role="listbox">
              {options.map((opt) => {
                const isSelected = opt.value === value
                return (
                  <li
                    key={opt.value}
                    role="option"
                    aria-selected={isSelected}
                    className={'savvy-mobile-opt' + (isSelected ? ' is-selected' : '')}
                    onClick={() => selectOption(opt.value)}
                  >
                    <span className="savvy-mobile-opt-label">{opt.label}</span>
                    {isSelected && (
                      <svg
                        className="savvy-mobile-opt-check"
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    )}
                  </li>
                )
              })}
            </ul>
          </div>
        </div>
      )}
    </div>
  )
}
