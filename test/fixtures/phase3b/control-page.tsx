'use client'
export default function QAControl() {
  return <main style={{ padding: 30 }}><h1>Offline Phase 3B controls</h1><p>No production credentials or database connection.</p>{['reset','empty','error','recover','other','logout','stale'].map(control => <button key={control} style={{ margin: 12, padding: 15 }} onClick={() => fetch('/api/qa/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ control }) })}>{control}</button>)}<a href="/list">Open EYE</a></main>
}
