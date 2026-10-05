'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'

function EyeToggleIcon({ open }: { open: boolean }) {
  if (open) {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
        <circle cx="12" cy="12" r="3" />
      </svg>
    )
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
      <line x1="1" y1="1" x2="23" y2="23" />
    </svg>
  )
}

export default function LoginForm() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [rememberDevice, setRememberDevice] = useState(true)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!email || !password) {
      setError('Plotëso email-in dhe fjalëkalimin.')
      return
    }
    setLoading(true)
    setError('')

    const timeout = setTimeout(() => {
      setError('Lidhja me serverin dështoi. Kontrollo rrjetin ose provo sërish.')
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
    } catch {
      clearTimeout(timeout)
      setError('Gabim i papritur. Provo sërish.')
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <div className="login-canvas">
        {/* Territory Map Layer (Calm Architectural Field Visual) */}
        <div className="login-territory">
          {/* Ambient Lighting & Soft Edge Vignette */}
          <div className="login-vignette-horizontal" />
          <div className="login-vignette-vertical" />

          {/* Clean Territory Grid & Geometry */}
          <svg
            aria-hidden="true"
            className="login-territory-map"
            fill="none"
            viewBox="0 0 1600 1000"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <linearGradient id="route-grad" x1="0%" x2="100%" y1="100%" y2="0%">
                <stop offset="0%" stopColor="#8e9199" stopOpacity="0.4" />
                <stop offset="50%" stopColor="#c93b3b" stopOpacity="0.75" />
                <stop offset="100%" stopColor="#f5f3ef" stopOpacity="0.6" />
              </linearGradient>
              <radialGradient cx="50%" cy="50%" id="soft-pulse" r="50%">
                <stop offset="0%" stopColor="#c93b3b" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#c93b3b" stopOpacity="0" />
              </radialGradient>
            </defs>

            {/* Subtle Architectural Urban Blocks */}
            <g fill="rgba(255, 255, 255, 0.015)" stroke="currentColor" strokeOpacity="0.35" strokeWidth="0.5">
              <rect height="95" rx="2" width="140" x="180" y="180" />
              <rect height="115" rx="2" width="210" x="340" y="160" />
              <rect height="160" rx="2" width="130" x="190" y="295" />
              <rect height="160" rx="2" width="120" x="340" y="295" />
              <rect height="90" rx="2" width="180" x="480" y="295" />
              <rect height="110" rx="2" width="180" x="480" y="405" />
              <rect height="200" rx="2" width="160" x="160" y="475" />
              <rect height="130" rx="2" width="120" x="340" y="475" />
              <rect fill="rgba(201, 59, 59, 0.03)" height="140" rx="2" width="240" x="480" y="535" />
              <rect height="180" rx="2" width="240" x="220" y="695" />
              <rect height="180" rx="2" width="190" x="480" y="695" />
              <rect height="140" rx="2" width="210" x="690" y="695" />
              <rect height="140" rx="2" width="200" x="680" y="370" />
              <rect height="145" rx="2" width="150" x="740" y="530" />
              <rect height="170" rx="2" width="220" x="900" y="420" />
              <rect height="180" rx="2" width="210" x="910" y="610" />
            </g>

            {/* Refined Street Framework */}
            <g fill="none" stroke="currentColor" strokeOpacity="0.22" strokeWidth="0.75">
              <line x1="80" x2="1300" y1="285" y2="285" />
              <line strokeOpacity="0.35" strokeWidth="1" x1="80" x2="1300" y1="465" y2="465" />
              <line strokeOpacity="0.3" strokeWidth="0.9" x1="80" x2="1300" y1="685" y2="685" />
              <line x1="80" x2="1300" y1="885" y2="885" />
              <line strokeOpacity="0.35" strokeWidth="1" x1="330" x2="330" y1="100" y2="920" />
              <line x1="470" x2="470" y1="100" y2="920" />
              <line strokeOpacity="0.35" strokeWidth="1" x1="670" x2="670" y1="100" y2="920" />
              <line x1="890" x2="890" y1="100" y2="920" />
              <line strokeOpacity="0.25" x1="1130" x2="1130" y1="100" y2="920" />
            </g>

            {/* Natural Diagonal Transit Boulevard */}
            <path
              d="M 100 820 C 350 780, 520 620, 780 465 S 1080 340, 1340 310"
              fill="none"
              stroke="currentColor"
              strokeDasharray="6 8"
              strokeOpacity="0.28"
              strokeWidth="1.2"
            />

            {/* Sales Route Visit Flow (Smooth bezier curve connecting client meetings) */}
            <path
              className="login-route"
              d="M 260 760 C 310 650, 420 540, 470 465 C 530 380, 620 440, 670 465 C 730 495, 830 520, 930 465"
              fill="none"
              stroke="url(#route-grad)"
              strokeWidth="1.75"
            />

            {/* Client Stop 1 */}
            <g transform="translate(260, 760)">
              <circle cx="0" cy="0" fill="#18191c" r="4" stroke="#8e9199" strokeWidth="1.5" />
              <circle cx="0" cy="0" fill="#8e9199" r="1.5" />
            </g>

            {/* Client Stop 2 */}
            <g transform="translate(470, 465)">
              <circle cx="0" cy="0" fill="#18191c" r="4.5" stroke="#8e9199" strokeWidth="1.5" />
              <circle cx="0" cy="0" fill="#dfe2ed" r="2" />
            </g>

            {/* Client Stop 3 (Active Visit / Live Node) */}
            <g transform="translate(670, 465)">
              <circle className="login-node-pulse" cx="0" cy="0" fill="url(#soft-pulse)" r="24" />
              <circle cx="0" cy="0" fill="none" r="11" stroke="#c93b3b" strokeOpacity="0.4" strokeWidth="1" />
              <circle cx="0" cy="0" fill="#c93b3b" r="5.5" />
              <circle cx="0" cy="0" fill="#f5f3ef" r="2" />
            </g>

            {/* Client Stop 4 */}
            <g transform="translate(930, 465)">
              <circle cx="0" cy="0" fill="#18191c" r="4" stroke="#8e9199" strokeWidth="1.5" />
              <circle cx="0" cy="0" fill="#8e9199" r="1.5" />
            </g>

            {/* Background Client Accounts (Quiet muted pins) */}
            <circle cx="400" cy="220" fill="#8e9199" fillOpacity="0.45" r="2.5" />
            <circle cx="240" cy="380" fill="#8e9199" fillOpacity="0.4" r="2.5" />
            <circle cx="610" cy="350" fill="#8e9199" fillOpacity="0.45" r="2.5" />
            <circle cx="810" cy="600" fill="#8e9199" fillOpacity="0.4" r="2.5" />
            <circle cx="1020" cy="700" fill="#8e9199" fillOpacity="0.35" r="2.5" />
            <circle cx="1190" cy="440" fill="#8e9199" fillOpacity="0.35" r="2.5" />
          </svg>
        </div>

        <div className="login-layout">
          <section
            aria-label="Sign in to EYE"
            className="login-card"
          >
            <header>
              <div className="login-context">
                <span className="login-context-dot" />
                <span className="login-context-label">FIELD SALES</span>
                <span className="login-context-rule" />
              </div>
              <h1
                className="login-title"
              >
                EYE
              </h1>
              <p className="login-byline">by SAVVY SYSTEMS</p>
              <p className="login-description">Field Sales Workspace</p>
            </header>

            {error && (
              <div className="login-error" role="alert">
                <span className="login-error-dot" />
                <span>{error}</span>
              </div>
            )}

            <form className="login-form" onSubmit={handleSubmit}>
              <div className="login-field">
                <label className="login-label" htmlFor="email">
                  Email
                </label>
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  placeholder="name@company.com"
                  className="login-input"
                />
              </div>

              <div className="login-field">
                <label className="login-label" htmlFor="password">
                  Password
                </label>
                <div className="login-password-wrap">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="login-input login-password-input"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Fshih fjalëkalimin' : 'Shfaq fjalëkalimin'}
                    className="login-password-toggle"
                  >
                    <EyeToggleIcon open={showPassword} />
                  </button>
                </div>
              </div>

              <label className="login-remember">
                <span className="login-checkbox-wrap">
                  <input
                    type="checkbox"
                    checked={rememberDevice}
                    onChange={e => setRememberDevice(e.target.checked)}
                    className="login-checkbox"
                  />
                  <svg className="login-checkbox-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                <span>Remember this device</span>
              </label>

              <button
                type="submit"
                disabled={loading}
                className="login-submit"
              >
                {loading ? (
                  <span className="login-loading">
                    <svg className="login-spinner" viewBox="0 0 24 24" fill="none">
                      <circle className="login-spinner-track" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="login-spinner-arc" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    <span>Authenticating...</span>
                  </span>
                ) : (
                  <span>Sign in</span>
                )}
              </button>
            </form>

            <div className="login-footer">
              <span>Private workspace</span>
              <span>SAVVY SYSTEMS</span>
            </div>
          </section>

          <div className="login-territory-caption">
            <span className="login-caption-dot" />
            <span>TERRITORY WORKSPACE</span>
          </div>
        </div>
      </div>
    </main>
  )
}
