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
    <main className="w-full min-h-[100dvh] bg-[#0d0e10] relative z-10 flex overflow-x-hidden">
      <div className="relative w-full min-h-[100dvh] flex flex-col lg:flex-row overflow-x-hidden select-none bg-[#0d0e10]">
        {/* Territory Map Layer (Calm Architectural Field Visual) */}
        <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
          {/* Ambient Lighting & Soft Edge Vignette */}
          <div className="absolute inset-0 bg-gradient-to-r from-[#0d0e10]/30 via-transparent to-[#0d0e10]/90 z-10" />
          <div className="absolute inset-0 bg-gradient-to-b from-[#0d0e10]/50 via-transparent to-[#0d0e10]/70 z-10" />

          {/* Clean Territory Grid & Geometry */}
          <svg
            className="w-[130%] h-[130%] -top-[15%] -left-[10%] absolute text-[#26282b]/60"
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

        {/* Left Territory Context (Minimal, Quiet, Editorial) */}
        <div className="relative z-10 flex lg:flex-1 flex-col justify-between p-4 lg:p-12 pointer-events-none">
          {/* Calm Territory Badge */}
          <div className="flex items-center gap-3 pt-1">
            <div className="flex items-center justify-center w-2 h-2 rounded-full bg-[#c93b3b] ring-4 ring-[#c93b3b]/20" />
            <span className="text-[12px] text-[#f5f3ef] font-medium tracking-tight font-sans">
              FIELD SALES
            </span>
          </div>

          {/* Bottom Region Note */}
          <div className="hidden lg:flex items-center gap-2 text-[#6b6f79] text-[11px] font-mono tracking-wide">
            <span className="w-1.5 h-1.5 rounded-full bg-[#26282b]" />
            <span>TERRITORY WORKSPACE</span>
          </div>
        </div>

        {/* Right-Anchored Premium Login Monolith */}
        <div className="relative z-20 w-full lg:w-[460px] xl:w-[480px] min-h-[calc(100dvh-54px)] lg:min-h-[100dvh] flex flex-col justify-between bg-[#0d0e10]/95 backdrop-blur-xl border-t lg:border-t-0 border-l-0 lg:border-l border-[#26282b]/80 shadow-2xl">
          {/* Top Brand & Form Section */}
          <div className="w-full flex flex-col pt-6 sm:pt-10 lg:pt-20 px-6 sm:px-12 lg:px-14">
            {/* Brand Block */}
            <div className="flex flex-col">
              <div className="flex items-baseline gap-2.5">
                <h1
                  className="text-[36px] font-bold tracking-tight text-[#f5f3ef]"
                  style={{ fontFamily: "'Space Grotesk', sans-serif" }}
                >
                  EYE
                </h1>
                <span className="text-[13px] tracking-normal text-[#8e9199] font-normal">
                  by SAVVY SYSTEMS
                </span>
              </div>
              <p className="mt-1 text-[13px] text-[#6b6f79]">
                Field Sales Workspace
              </p>
            </div>

            {/* Error Message Callout */}
            {error && (
              <div className="mt-6 p-3 bg-[#93000a]/20 border border-[#93000a]/50 text-[#ffb4ab] text-[12.5px] rounded flex items-center gap-2">
                <span className="w-1.5 h-1.5 rounded-full bg-[#ffb4ab] flex-shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {/* Authentication Form */}
            <form className="flex flex-col gap-5 mt-8" onSubmit={handleSubmit}>
              {/* Email Field */}
              <div className="flex flex-col gap-1.5">
                <label className="text-[13px] text-[#a5a7ad] font-medium" htmlFor="email">
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
                  className="w-full h-10 px-3 bg-[#151618] border border-[#26282b] text-[#f5f3ef] text-[13.5px] placeholder:text-[#6b6f79] rounded focus:outline-none focus:border-[#8E2230] focus:ring-1 focus:ring-[#8E2230] transition-all duration-150"
                />
              </div>

              {/* Password Field */}
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between items-center">
                  <label className="text-[13px] text-[#a5a7ad] font-medium" htmlFor="password">
                    Password
                  </label>
                </div>
                <div className="relative flex items-center">
                  <input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    required
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="••••••••••••"
                    className="w-full h-10 pl-3 pr-10 bg-[#151618] border border-[#26282b] text-[#f5f3ef] text-[13.5px] placeholder:text-[#6b6f79] rounded focus:outline-none focus:border-[#8E2230] focus:ring-1 focus:ring-[#8E2230] transition-all duration-150"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Fshih fjalëkalimin' : 'Shfaq fjalëkalimin'}
                    className="absolute right-3 text-[#8e9199] hover:text-[#f5f3ef] transition-colors flex items-center focus:outline-none"
                  >
                    <EyeToggleIcon open={showPassword} />
                  </button>
                </div>
              </div>

              {/* Remember Device Option */}
              <div className="flex items-center pt-0.5">
                <label className="flex items-center gap-2.5 cursor-pointer group select-none">
                  <input
                    type="checkbox"
                    checked={rememberDevice}
                    onChange={e => setRememberDevice(e.target.checked)}
                    className="sr-only peer"
                  />
                  <div className="w-4 h-4 border border-[#26282b] bg-[#151618] rounded flex items-center justify-center peer-checked:bg-[#f5f3ef] peer-checked:border-[#f5f3ef] transition-colors">
                    <svg
                      className="w-3 h-3 text-[#0d0e10] opacity-0 peer-checked:opacity-100 transition-opacity"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="3"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>
                  <span className="text-[13px] text-[#8e9199] group-hover:text-[#a5a7ad] transition-colors">
                    Remember this device
                  </span>
                </label>
              </div>

              {/* CTA Button */}
              <div className="flex flex-col gap-2 pt-2">
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full h-10 bg-[#f5f3ef] text-[#0d0e10] hover:bg-white active:bg-[#e3e2e5] text-[13px] font-medium transition-all duration-150 flex items-center justify-center rounded shadow-sm disabled:opacity-60 disabled:cursor-wait"
                >
                  {loading ? (
                    <span className="flex items-center gap-2">
                      <svg className="animate-spin w-4 h-4 text-[#0d0e10]" viewBox="0 0 24 24" fill="none">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
                      </svg>
                      <span>Authenticating...</span>
                    </span>
                  ) : (
                    <span>Sign in</span>
                  )}
                </button>
              </div>
            </form>
          </div>

          {/* Quiet, Architectural Footer */}
          <div className="w-full px-8 sm:px-12 lg:px-14 pb-10 pt-8 border-t border-[#26282b]/40 flex items-center justify-between text-[11px] text-[#6b6f79] tracking-wider font-mono">
            <span>Private workspace</span>
            <span>SAVVY SYSTEMS</span>
          </div>
        </div>
      </div>
    </main>
  )
}
