'use client'

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  normalize, nowISO, statusInfo, todayISO,
  type Client, type Visit,
} from '@/lib/types'

// ─── Toast ───────────────────────────────────────────────────────────────────
type ToastState = { msg: string; kind: string; key: number }

// ─── Context shape ────────────────────────────────────────────────────────────
type AppCtx = {
  // Data
  clients: Client[]
  visits: Visit[]
  visitsLoaded: boolean
  loadVisits: () => Promise<void>
  updateClient: (id: string, patch: Partial<Client>) => Promise<{ ok: boolean; error?: Error }>
  upsertVisit: (
    payload: Omit<Visit, 'id' | 'created_at' | 'updated_at'>,
    editingId?: string
  ) => Promise<void>
  deleteVisit: (id: string) => Promise<void>

  // Filters
  search: string
  setSearch: (s: string) => void
  zoneFilter: string
  setZoneFilter: (s: string) => void
  statusFilter: string
  setStatusFilter: (s: string) => void
  unlocatedOnly: boolean
  setUnlocatedOnly: (b: boolean) => void
  filteredClients: Client[]
  zones: string[]

  // Side panel
  activeClient: Client | null
  openPanel: (id: string) => void
  closePanel: () => void

  // Visit modal
  editingVisit: Visit | null
  visitModalOpen: boolean
  visitModalDate: string
  openVisitModal: (visitId?: string, date?: string) => void
  closeVisitModal: () => void

  // Sync indicator
  syncing: boolean
  syncError: boolean

  // Toast
  toast: (msg: string, kind?: string) => void
  toastState: ToastState | null
}

const Ctx = createContext<AppCtx | null>(null)

export function useApp() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useApp must be used inside AppProvider')
  return ctx
}

// ─── Provider ─────────────────────────────────────────────────────────────────
export function AppProvider({ children }: { children: ReactNode }) {
  // Lazy singleton: created once per mount, only in the browser
  const supabaseRef = useRef<ReturnType<typeof createClient> | null>(null)
  if (!supabaseRef.current) supabaseRef.current = createClient()
  const supabase = supabaseRef.current

  const [clients, setClients] = useState<Client[]>([])
  const [visits, setVisits] = useState<Visit[]>([])
  const [visitsLoaded, setVisitsLoaded] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [syncError, setSyncError] = useState(false)

  // Filters
  const [search, setSearch] = useState('')
  const [zoneFilter, setZoneFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [unlocatedOnly, setUnlocatedOnly] = useState(false)

  // Panel
  const [activeClient, setActiveClient] = useState<Client | null>(null)

  // Visit modal
  const [editingVisit, setEditingVisit] = useState<Visit | null>(null)
  const [visitModalOpen, setVisitModalOpen] = useState(false)
  const [visitModalDate, setVisitModalDate] = useState(todayISO())

  // Toast
  const [toastState, setToastState] = useState<ToastState | null>(null)
  const toastKey = useRef(0)
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toast = useCallback((msg: string, kind = '') => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToastState({ msg, kind, key: ++toastKey.current })
    toastTimer.current = setTimeout(() => setToastState(null), 2200)
  }, [])

  // ── Load all clients (paginated) ──────────────────────────────────────────
  const loadClients = useCallback(async () => {
    setSyncing(true)
    setSyncError(false)
    const all: Client[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from('clients')
        .select('*')
        .order('business_name')
        .range(from, from + 999)
      if (error) { setSyncError(true); setSyncing(false); return }
      all.push(...(data as Client[]))
      if (data.length < 1000) break
      from += 1000
    }
    setClients(all)
    setSyncing(false)
  }, [])

  // ── Load visits (paginated, lazy) ────────────────────────────────────────
  const loadVisits = useCallback(async () => {
    if (visitsLoaded) return
    setSyncing(true)
    const all: Visit[] = []
    let from = 0
    while (true) {
      const { data, error } = await supabase
        .from('visits')
        .select('*')
        .order('visit_date', { ascending: false })
        .order('created_at', { ascending: true })
        .range(from, from + 999)
      if (error) {
        console.warn('loadVisits failed (table may not exist):', error.message)
        setSyncing(false)
        setVisitsLoaded(true)
        return
      }
      all.push(...(data as Visit[]))
      if (data.length < 1000) break
      from += 1000
    }
    setVisits(all)
    setVisitsLoaded(true)
    setSyncing(false)
  }, [visitsLoaded])

  // ── Update a client ────────────────────────────────────────────────────────
  const updateClient = useCallback(async (
    id: string, patch: Partial<Client>
  ): Promise<{ ok: boolean; error?: Error }> => {
    setSyncing(true)
    const { error } = await supabase
      .from('clients')
      .update({ ...patch, updated_at: nowISO() })
      .eq('id', id)
    if (error) { setSyncError(true); setSyncing(false); return { ok: false, error } }
    setClients(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c))
    // Update active panel client if open
    setActiveClient(prev => prev?.id === id ? { ...prev, ...patch } : prev)
    setSyncing(false)
    return { ok: true }
  }, [])

  // ── Upsert a visit ────────────────────────────────────────────────────────
  const upsertVisit = useCallback(async (
    payload: Omit<Visit, 'id' | 'created_at' | 'updated_at'>,
    editingId?: string
  ) => {
    setSyncing(true)
    if (editingId) {
      const { data, error } = await supabase
        .from('visits')
        .update({ ...payload, updated_at: nowISO() })
        .eq('id', editingId)
        .select()
        .single()
      if (error) { setSyncing(false); toast('Ruajtja dështoi: ' + error.message, 'error'); return }
      setVisits(prev => prev.map(v => v.id === editingId ? (data as Visit) : v))
    } else {
      const { data, error } = await supabase
        .from('visits')
        .insert(payload)
        .select()
        .single()
      if (error) { setSyncing(false); toast('Ruajtja dështoi: ' + error.message, 'error'); return }
      setVisits(prev => [data as Visit, ...prev])
    }
    setSyncing(false)
    toast('Vizita u ruajt ✓', 'success')
  }, [toast])

  // ── Delete a visit ────────────────────────────────────────────────────────
  const deleteVisit = useCallback(async (id: string) => {
    setSyncing(true)
    const { error } = await supabase.from('visits').delete().eq('id', id)
    if (error) { setSyncError(true); setSyncing(false); toast('Heqja dështoi: ' + error.message, 'error'); return }
    setVisits(prev => prev.filter(v => v.id !== id))
    setSyncing(false)
    toast('Vizita u hoq', 'success')
  }, [toast])

  // ── Panel ─────────────────────────────────────────────────────────────────
  const openPanel = useCallback((id: string) => {
    const c = clients.find(x => x.id === id) ?? null
    setActiveClient(c)
  }, [clients])

  const closePanel = useCallback(() => setActiveClient(null), [])

  // ── Visit modal ───────────────────────────────────────────────────────────
  const openVisitModal = useCallback((visitId?: string, date?: string) => {
    setEditingVisit(visitId ? (visits.find(v => v.id === visitId) ?? null) : null)
    setVisitModalDate(date ?? todayISO())
    setVisitModalOpen(true)
  }, [visits])

  const closeVisitModal = useCallback(() => {
    setVisitModalOpen(false)
    setEditingVisit(null)
  }, [])

  // ── Filtered clients ──────────────────────────────────────────────────────
  const filteredClients = clients.filter(c => {
    if (zoneFilter && c.zone !== zoneFilter) return false
    if (statusFilter) {
      const cs = (c.status ?? '').toLowerCase()
      if (cs !== statusFilter.toLowerCase()) return false
    }
    if (unlocatedOnly && (c.lat != null || !c.maps_url)) return false
    if (search) {
      if (!normalize(c.business_name).includes(normalize(search))) return false
    }
    return true
  })

  const zones = [...new Set(clients.map(c => c.zone).filter(Boolean) as string[])].sort()

  // ── Real-time subscriptions ───────────────────────────────────────────────
  useEffect(() => {
    const ch = supabase
      .channel('clients-rt')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'clients' }, ({ new: row }) => {
        setClients(prev => [...prev, row as Client].sort((a, b) =>
          a.business_name.localeCompare(b.business_name)
        ))
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'clients' }, ({ new: row }) => {
        setClients(prev => prev.map(c => c.id === (row as Client).id ? row as Client : c))
        setActiveClient(prev => prev?.id === (row as Client).id ? row as Client : prev)
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'clients' }, ({ old }) => {
        setClients(prev => prev.filter(c => c.id !== (old as Client).id))
      })
      .subscribe()

    const vch = supabase
      .channel('visits-rt')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'visits' }, ({ new: row }) => {
        setVisits(prev => [row as Visit, ...prev])
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'visits' }, ({ new: row }) => {
        setVisits(prev => prev.map(v => v.id === (row as Visit).id ? row as Visit : v))
      })
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'visits' }, ({ old }) => {
        setVisits(prev => prev.filter(v => v.id !== (old as Visit).id))
      })
      .subscribe()

    return () => {
      supabase.removeChannel(ch)
      supabase.removeChannel(vch)
    }
  }, [])

  // ── Initial load ──────────────────────────────────────────────────────────
  useEffect(() => { loadClients() }, [loadClients])

  const value: AppCtx = {
    clients, visits, visitsLoaded, loadVisits, updateClient, upsertVisit, deleteVisit,
    search, setSearch, zoneFilter, setZoneFilter, statusFilter, setStatusFilter,
    unlocatedOnly, setUnlocatedOnly, filteredClients, zones,
    activeClient, openPanel, closePanel,
    editingVisit, visitModalOpen, visitModalDate, openVisitModal, closeVisitModal,
    syncing, syncError, toast, toastState,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
