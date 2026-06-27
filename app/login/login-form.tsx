'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) { setError('Plotëso të dy fushat.'); return }
    setLoading(true)
    setError('')

    const timeout = setTimeout(() => {
      setError('Lidhja me serverin dështoi. Kontrollo variablat e mjedisit në Vercel.')
      setLoading(false)
    }, 10000)

    try {
      const supabase = createClient()
      const { error: authErr } = await supabase.auth.signInWithPassword({ email, password })
      clearTimeout(timeout)
      if (authErr) {
        setError(authErr.message)
        setLoading(false)
        return
      }
      router.push('/map')
      router.refresh()
    } catch (err) {
      clearTimeout(timeout)
      setError('Gabim i papritur. Provo sërish.')
      setLoading(false)
    }
  }

  return (
    <div className="login-overlay">
      <div className="login-card">
        <div className="login-logo">MV</div>
        <div className="login-title">MV CRM</div>
        <div className="login-sub">Hyr për të vazhduar</div>
        {error && <div className="login-err">{error}</div>}
        <form onSubmit={handleSubmit}>
          <div className="login-field">
            <label>Email</label>
            <input
              type="email"
              placeholder="emri@email.com"
              autoComplete="email"
              value={email}
              onChange={e => setEmail(e.target.value)}
            />
          </div>
          <div className="login-field">
            <label>Fjalëkalimi</label>
            <input
              type="password"
              placeholder="••••••••"
              autoComplete="current-password"
              value={password}
              onChange={e => setPassword(e.target.value)}
            />
          </div>
          <button className="btn-login" type="submit" disabled={loading}>
            {loading ? 'Po hyj...' : 'Hyr'}
          </button>
        </form>
      </div>
    </div>
  )
}
