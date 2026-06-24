'use client'

import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { AppProvider, useApp } from '@/contexts/AppContext'
import SidePanel from '@/components/SidePanel'
import VisitModal from '@/components/VisitModal'
import { STATUS_DEFS } from '@/lib/types'

export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <AppProvider>
      <AppShellInner>{children}</AppShellInner>
    </AppProvider>
  )
}

function AppShellInner({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const router = useRouter()
  const {
    clients, filteredClients: _fc, zones,
    search, setSearch,
    zoneFilter, setZoneFilter,
    statusFilter, setStatusFilter,
    unlocatedOnly, setUnlocatedOnly,
    syncing, syncError,
    toastState,
    activeClient, closePanel,
    visitModalOpen, closeVisitModal,
  } = useApp()

  const isRoute = pathname === '/route'

  const chips: { label: string; clear: () => void }[] = []
  if (zoneFilter) chips.push({ label: `Zona: ${zoneFilter}`, clear: () => setZoneFilter('') })
  if (statusFilter) {
    const lbl = STATUS_DEFS.find(s => s.key === statusFilter)?.label ?? statusFilter
    chips.push({ label: `Status: ${lbl}`, clear: () => setStatusFilter('') })
  }
  if (unlocatedOnly) chips.push({ label: 'Vetëm pa koordinata', clear: () => setUnlocatedOnly(false) })

  async function logout() {
    await createClient().auth.signOut()
    router.push('/login')
    router.refresh()
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>
          <span className="logo">MV</span>
          <span>
            <span className={`sync-dot${syncing ? ' syncing' : syncError ? ' error' : ''}`} />
            CRM
          </span>
        </h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button className="logout-btn" onClick={logout}>Dil</button>
          <span className="badge">{clients.length} biznese</span>
        </div>
      </header>

      {!isRoute && (
        <div className="controls">
          <div className="search-wrap">
            <input
              type="search"
              placeholder="Kërko biznes..."
              autoComplete="off"
              value={search}
              onChange={e => setSearch(e.target.value)}
            />
          </div>
          <div className="filter-selects">
            <select value={zoneFilter} onChange={e => setZoneFilter(e.target.value)}>
              <option value="">Të gjitha zonat</option>
              {zones.map(z => <option key={z} value={z}>{z}</option>)}
            </select>
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">Të gjithë statuset</option>
              {STATUS_DEFS.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </div>
          {chips.length > 0 && (
            <div className="active-chips">
              {chips.map((c, i) => (
                <span key={i} className="chip-active">
                  {c.label}
                  <span className="x" onClick={c.clear}>×</span>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <main className="main">{children}</main>

      <nav className="bottom-nav">
        {[
          { href: '/map',   icon: '🗺️', label: 'Harta'  },
          { href: '/list',  icon: '📋', label: 'Lista'  },
          { href: '/route', icon: '🛣️', label: 'Rruga'  },
        ].map(({ href, icon, label }) => (
          <Link key={href} href={href} className={`nav-btn${pathname === href ? ' active' : ''}`}>
            <span className="icon">{icon}</span>
            <span>{label}</span>
          </Link>
        ))}
      </nav>

      <div className={`side-backdrop${activeClient ? ' open' : ''}`} onClick={closePanel} />
      <SidePanel />

      {visitModalOpen && (
        <div className="modal-overlay-center" onClick={e => e.target === e.currentTarget && closeVisitModal()}>
          <VisitModal />
        </div>
      )}

      {toastState && (
        <div key={toastState.key} className={`toast show${toastState.kind ? ' ' + toastState.kind : ''}`}>
          {toastState.msg}
        </div>
      )}
    </div>
  )
}
