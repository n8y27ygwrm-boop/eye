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
    <main className="relative isolate min-h-[100dvh] overflow-x-hidden bg-[#0d0e10] text-[#f5f3ef]">
      <div className="relative min-h-[100dvh] overflow-x-hidden">
        {/* Territory Map Layer (Calm Architectural Field Visual) */}
        <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
          {/* Ambient Lighting & Soft Edge Vignette */}
          <div className="absolute inset-0 z-10 bg-gradient-to-r from-[#0d0e10]/80 via-[#0d0e10]/40 to-[#0d0e10]/35" />
          <div className="absolute inset-0 z-10 bg-gradient-to-b from-[#0d0e10]/25 via-transparent to-[#0d0e10]/70" />

          {/* Clean Territory Grid & Geometry */}
          <svg
            aria-hidden="true"
            className="absolute -right-[85%] -top-[45%] h-[110%] w-[185%] text-[#3b3d41]/70 opacity-70 sm:-right-[35%] sm:top-[-5%] sm:w-[145%] lg:-right-[7%] lg:-top-[12%] lg:h-[125%] lg:w-[105%] lg:opacity-80"
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
              className="animate-route"
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
              <circle className="animate-breathe" cx="0" cy="0" fill="url(#soft-pulse)" r="24" />
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

        <div className="relative z-20 flex min-h-[100dvh] items-center px-4 py-6 sm:px-8 sm:py-10 lg:px-[clamp(56px,10vw,160px)]">
          <section
            aria-label="Sign in to EYE"
            className="mx-auto w-full max-w-[460px] rounded-[22px] border border-[#414247]/80 bg-[#191a1d]/90 px-7 py-8 backdrop-blur-xl sm:px-10 sm:py-10 lg:mx-0"
            style={{ boxShadow: '0 32px 80px -24px rgba(0, 0, 0, 0.72), inset 0 1px 0 rgba(255, 255, 255, 0.04)' }}
          >
            <header>
              <div className="mb-7 flex items-center gap-3">
                <span className="h-2 w-2 rounded-full bg-[#d15353] ring-[5px] ring-[#d15353]/15" />
                <span className="text-[11px] font-semibold tracking-[0.18em] text-[#bbbcc1]">FIELD SALES</span>
                <span className="ml-auto h-px w-12 bg-gradient-to-r from-[#55565b] to-transparent" />
              </div>
              <h1
                className="text-[48px] font-semibold leading-none tracking-[-0.065em] text-[#f5f3ef] sm:text-[54px]"
                style={{ fontFamily: "'Space Grotesk', sans-serif" }}
              >
                EYE
              </h1>
              <p className="mt-2 text-[11px] font-medium tracking-[0.16em] text-[#aaaab0]">by SAVVY SYSTEMS</p>
              <p className="mt-4 text-[14px] leading-6 text-[#aaabb0]">Field Sales Workspace</p>
            </header>

            {error && (
              <div className="mt-7 flex items-start gap-2.5 rounded-[10px] border border-[#a94a4a]/50 bg-[#8e2230]/15 px-3.5 py-3 text-[13px] leading-5 text-[#ffb4ab]" role="alert">
                <span className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-[#ffb4ab]" />
                <span>{error}</span>
              </div>
            )}

            <form className="mt-8 flex flex-col gap-5" onSubmit={handleSubmit}>
              <div className="flex flex-col gap-2">
                <label className="text-[12px] font-medium tracking-[0.02em] text-[#d0d0d3]" htmlFor="email">
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
                  className="h-[52px] w-full rounded-[10px] border border-[#44454a] bg-[#101114] px-4 text-[14px] text-[#f5f3ef] placeholder:text-[#777980] transition-colors duration-150 focus:border-[#d15353] focus:outline-none focus:ring-[3px] focus:ring-[#d15353]/15"
                />
              </div>

              <div className="flex flex-col gap-2">
                <label className="text-[12px] font-medium tracking-[0.02em] text-[#d0d0d3]" htmlFor="password">
                  Password
                </label>
                <div className="relative">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="h-[52px] w-full rounded-[10px] border border-[#44454a] bg-[#101114] pl-4 pr-14 text-[14px] text-[#f5f3ef] placeholder:text-[#777980] transition-colors duration-150 focus:border-[#d15353] focus:outline-none focus:ring-[3px] focus:ring-[#d15353]/15"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Fshih fjalëkalimin' : 'Shfaq fjalëkalimin'}
                    className="absolute right-1.5 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-[7px] text-[#a2a3a9] transition-colors hover:bg-[#292a2f] hover:text-[#f5f3ef] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d15353]"
                  >
                    <EyeToggleIcon open={showPassword} />
                  </button>
                </div>
              </div>

              <label className="flex w-fit cursor-pointer select-none items-center gap-2.5 pt-0.5 text-[13px] text-[#b9bac0] transition-colors hover:text-[#f5f3ef]">
                <span className="relative flex h-[18px] w-[18px] items-center justify-center">
                  <input
                    type="checkbox"
                    checked={rememberDevice}
                    onChange={e => setRememberDevice(e.target.checked)}
                    className="peer h-[18px] w-[18px] cursor-pointer appearance-none rounded-[5px] border border-[#66676c] bg-[#101114] transition-colors checked:border-[#d15353] checked:bg-[#d15353] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#d15353]/60 focus-visible:ring-offset-2 focus-visible:ring-offset-[#191a1d]"
                  />
                  <svg className="pointer-events-none absolute h-3 w-3 text-white opacity-0 transition-opacity peer-checked:opacity-100" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="20 6 9 17 4 12" />
                  </svg>
                </span>
                <span>Remember this device</span>
              </label>

              <button
                type="submit"
                disabled={loading}
                className="mt-1 flex h-[52px] w-full items-center justify-center rounded-[10px] bg-[#f1efea] text-[14px] font-semibold text-[#141518] shadow-[0_8px_24px_rgba(0,0,0,0.18)] transition-colors duration-150 hover:bg-white active:bg-[#dedbd5] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#f1efea] focus-visible:ring-offset-2 focus-visible:ring-offset-[#191a1d] disabled:cursor-wait disabled:opacity-60"
              >
                {loading ? (
                  <span className="flex items-center gap-2">
                    <svg className="h-4 w-4 animate-spin text-[#0d0e10]" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                    </svg>
                    <span>Authenticating...</span>
                  </span>
                ) : (
                  <span>Sign in</span>
                )}
              </button>
            </form>

            <div className="mt-8 flex items-center justify-between border-t border-[#3b3c41] pt-5 font-mono text-[10px] tracking-[0.05em] text-[#898b92]">
              <span>Private workspace</span>
              <span>SAVVY SYSTEMS</span>
            </div>
          </section>

          <div className="pointer-events-none absolute bottom-8 right-10 hidden items-center gap-2 font-mono text-[11px] tracking-[0.08em] text-[#8a8c92] lg:flex">
            <span className="h-1.5 w-1.5 rounded-full bg-[#d15353]" />
            <span>TERRITORY WORKSPACE</span>
          </div>
        </div>
      </div>
    </main>
  )
}
