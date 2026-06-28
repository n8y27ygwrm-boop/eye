'use client'

import { useState, useRef, useEffect } from 'react'

type Message = { role: 'user' | 'assistant'; content: string }

const SUGGESTIONS = [
  'Sa klientë kemi gjithsej?',
  'Cilat janë vizitat e sotme?',
  'Cilët klientë janë Customer/Purchase?',
]

export default function AIChat() {
  const [isOpen, setIsOpen] = useState(false)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [loading, setLoading] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages, loading])

  useEffect(() => {
    if (isOpen) inputRef.current?.focus()
  }, [isOpen])

  async function send(text?: string) {
    const msg = (text ?? input).trim()
    if (!msg || loading) return

    const userMsg: Message = { role: 'user', content: msg }
    const nextHistory = [...messages, userMsg]
    setMessages(nextHistory)
    setInput('')
    resetTextarea()
    setLoading(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg, conversationHistory: messages }),
      })
      let data: { reply?: string; error?: string }
      try {
        data = await res.json()
      } catch {
        const text = await res.text().catch(() => '')
        console.error('[chat] Non-JSON response:', res.status, text.slice(0, 200))
        setMessages([...nextHistory, { role: 'assistant', content: `Gabim serveri (${res.status}). Provo sërish.` }])
        return
      }
      const reply = data.reply ?? (data.error ? `Gabim: ${data.error}` : 'Nuk pata përgjigje.')
      setMessages([...nextHistory, { role: 'assistant', content: reply }])
    } catch (e) {
      console.error('[chat] fetch error:', e)
      setMessages([...nextHistory, { role: 'assistant', content: 'Gabim në lidhje. Kontrollo lidhjen dhe provo sërish.' }])
    } finally {
      setLoading(false)
    }
  }

  function handleKey(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  function handleInput(e: React.ChangeEvent<HTMLTextAreaElement>) {
    setInput(e.target.value)
    const el = e.target
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 120) + 'px'
  }

  function resetTextarea() {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto'
    }
  }

  return (
    <>
      <button
        className={`ai-fab${isOpen ? ' open' : ''}`}
        onClick={() => setIsOpen(o => !o)}
        aria-label="Asistenti AI"
      >
        {isOpen ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
          </svg>
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
          </svg>
        )}
      </button>

      {isOpen && <div className="ai-backdrop" onClick={() => setIsOpen(false)} />}

      <div className={`ai-panel${isOpen ? ' open' : ''}`} role="dialog" aria-label="Asistenti AI">
        <div className="ai-panel-head">
          <div className="ai-panel-title">
            <span className="ai-panel-star">✦</span>
            Asistenti AI
          </div>
          {messages.length > 0 && (
            <button
              className="ai-clear-btn"
              onClick={() => setMessages([])}
              title="Pastro bisedat"
            >
              Pastro
            </button>
          )}
          <button className="ai-panel-close" onClick={() => setIsOpen(false)}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none">
              <path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/>
            </svg>
          </button>
        </div>

        <div className="ai-messages">
          {messages.length === 0 && (
            <div className="ai-empty">
              <div className="ai-empty-star">✦</div>
              <p className="ai-empty-title">Si mund të ndihmoj?</p>
              <p className="ai-empty-sub">Pyet rreth klientëve, vizitave ose pipeline-it.</p>
              <div className="ai-suggestions">
                {SUGGESTIONS.map(s => (
                  <button key={s} className="ai-suggestion" onClick={() => send(s)}>
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => (
            <div key={i} className={`ai-bubble ai-bubble--${m.role}`}>
              {m.content}
            </div>
          ))}

          {loading && (
            <div className="ai-bubble ai-bubble--assistant ai-typing">
              <span /><span /><span />
            </div>
          )}

          <div ref={bottomRef} />
        </div>

        <div className="ai-input-row">
          <textarea
            ref={inputRef}
            className="ai-input"
            value={input}
            onChange={handleInput}
            onKeyDown={handleKey}
            placeholder="Shkruaj një mesazh..."
            rows={1}
            disabled={loading}
          />
          <button
            className="ai-send"
            onClick={() => send()}
            disabled={loading || !input.trim()}
            aria-label="Dërgo"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
              <path d="M12 19V5M5 12l7-7 7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    </>
  )
}
