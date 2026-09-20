'use client'

import { calculateNextClientStatus, findDuplicateClient, orchestrateUpsertVisit, type LifecycleDbAdapter, type UpsertVisitResult } from '@/lib/lifecycle'

import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
  type ReactNode,
} from 'react'
import { createClient } from '@/lib/supabase/client'
import {
  normalize, nowISO, statusInfo, todayISO,
  type Client, type Visit,
} from '@/lib/types'
import { getFollowupState, type FollowupFilter } from '@/lib/followup'
import { enqueueVisitReminder } from '@/lib/ai/client-enqueue'

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
  ) => Promise<UpsertVisitResult>
  deleteVisit: (id: string) => Promise<{ ok: boolean; error?: string }>

  // Filters
  search: string
  setSearch: (s: string) => void
  zoneFilter: string
  setZoneFilter: (s: string) => void
  statusFilter: string
  setStatusFilter: (s: string) => void
  followupFilter: FollowupFilter
  setFollowupFilter: (f: FollowupFilter) => void
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

  // Authenticated user identity for tenant isolation
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      setCurrentUserId(data.user?.id ?? null)
    })

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setCurrentUserId(session?.user?.id ?? null)
    })

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  // Filters
  const [search, setSearch] = useState('')
  const [zoneFilter, setZoneFilter] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [followupFilter, setFollowupFilter] = useState<FollowupFilter>('all')
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
    if (error) {
      setSyncError(true)
      setSyncing(false)
      toast('Përditësimi dështoi: ' + error.message, 'error')
      return { ok: false, error: new Error(error.message) }
    }
    setClients(prev => prev.map(c => c.id === id ? { ...c, ...patch } : c))
    // Update active panel client if open
    setActiveClient(prev => prev?.id === id ? { ...prev, ...patch } : prev)
    setSyncing(false)
    toast('Klienti u përditësua ✓', 'success')
    return { ok: true }
  }, [toast])

  const upsertInProgressRef = useRef(false)

  // ── Upsert a visit (with client lifecycle integrity & verified rollbacks) ──
  const upsertVisit = useCallback(async (
    payload: Omit<Visit, "id" | "created_at" | "updated_at">,
    editingId?: string
  ): Promise<UpsertVisitResult> => {
    if (upsertInProgressRef.current) {
      return { ok: false, kind: "failure", error: "Një veprim është në proces. Ju lutem prisni." }
    }
    upsertInProgressRef.current = true
    setSyncing(true)

    try {
      const { data: { user } } = await supabase.auth.getUser()
      const ownerUserId = user?.id

      const enrichedPayload = {
        ...payload,
        ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
      }

      const adapter: LifecycleDbAdapter = {
        createClient: async client => {
          const clientPayload = {
            ...client,
            ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
          }
          const { data, error } = await supabase.from("clients").insert(clientPayload).select().single()
          return { data: data as Client | null, error }
        },
        deleteClient: async clientId => {
          const { error } = await supabase.from("clients").delete().eq("id", clientId)
          return { error }
        },
        updateClientStatus: async (clientId, status, updatedAt) => {
          const { error } = await supabase.from("clients").update({ status, updated_at: updatedAt }).eq("id", clientId)
          return { error }
        },
        createVisit: async visit => {
          const visitPayload = {
            ...visit,
            ...(ownerUserId ? { owner_user_id: ownerUserId } : {}),
          }
          const { data, error } = await supabase.from("visits").insert(visitPayload).select().single()
          return { data: data as Visit | null, error }
        },
        updateVisit: async (id, patch) => {
          const { data, error } = await supabase.from("visits").update(patch).eq("id", id).select().single()
          return { data: data as Visit | null, error }
        },
        deleteVisit: async visitId => {
          const { error } = await supabase.from("visits").delete().eq("id", visitId)
          return { error }
        },
      }

      const result = await orchestrateUpsertVisit({
        payload: enrichedPayload,
        editingId,
        clients,
        adapter,
        nowISO,
      })

      if (result.kind === "success") {
        if (result.client) {
          const newCl = result.client
          setClients(prev => {
            if (prev.some(c => c.id === newCl.id)) return prev
            return [...prev, newCl].sort((a, b) => a.business_name.localeCompare(b.business_name))
          })
        }
        if (result.clientStatusUpdated && result.newStatus && (payload.client_id || result.data.client_id)) {
          const clId = payload.client_id || result.data.client_id!
          setClients(prev => prev.map(c => c.id === clId ? { ...c, status: result.newStatus!, updated_at: nowISO() } : c))
          setActiveClient(prev => prev?.id === clId ? { ...prev, status: result.newStatus!, updated_at: nowISO() } : prev)
        }
        setVisits(prev => editingId ? prev.map(v => v.id === editingId ? result.data : v) : [result.data, ...prev.filter(v => v.id !== result.data.id)])
        toast(result.client ? "Vizita dhe klienti i ri u ruajtën ✓" : "Vizita u ruajt ✓", "success")

        // Observable, resilient AI reminder extraction (visit persistence is already complete and primary)
        enqueueVisitReminder(result.data.id)
          .then(res => {
            if (!res.ok && res.warning) {
              toast(res.warning, "warning")
            }
          })
          .catch(() => {
            // Guard against any client exceptions
          })
      } else if (result.kind === "failure") {
        toast("Veprimi dështoi: " + result.error, "error")
      } else if (result.kind === "partial") {
        if (result.visit) {
          const v = result.visit
          setVisits(prev => editingId ? prev.map(x => x.id === editingId ? v : x) : [v, ...prev.filter(x => x.id !== v.id)])
        }
        if (result.client) {
          const cl = result.client
          setClients(prev => {
            if (prev.some(c => c.id === cl.id)) return prev
            return [...prev, cl].sort((a, b) => a.business_name.localeCompare(b.business_name))
          })
        }
        toast(result.message, "warning")
      }

      return result
    } finally {
      upsertInProgressRef.current = false
      setSyncing(false)
    }
  }, [clients, toast])

  // ── Delete a visit ────────────────────────────────────────────────────────
  const deleteVisit = useCallback(async (id: string): Promise<{ ok: boolean; error?: string }> => {
    setSyncing(true)
    const { error } = await supabase.from('visits').delete().eq('id', id)
    if (error) {
      setSyncError(true)
      setSyncing(false)
      toast('Heqja dështoi: ' + error.message, 'error')
      return { ok: false, error: error.message }
    }
    setVisits(prev => prev.filter(v => v.id !== id))
    setSyncing(false)
    toast('Vizita u hoq', 'success')
    return { ok: true }
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
    if (followupFilter !== 'all') {
      const fuState = getFollowupState(c.next_followup)
      if (followupFilter === 'overdue' && fuState !== 'OVERDUE') return false
      if (followupFilter === 'today' && fuState !== 'DUE_TODAY') return false
      if (followupFilter === 'upcoming' && fuState !== 'UPCOMING') return false
    }
    if (unlocatedOnly && (c.lat != null || !c.maps_url)) return false
    if (search) {
      if (!normalize(c.business_name).includes(normalize(search))) return false
    }
    return true
  })

  const zones = [...new Set(clients.map(c => c.zone).filter(Boolean) as string[])].sort()

  // ── Real-time subscriptions (strictly tenant-filtered by current authenticated user) ──
  useEffect(() => {
    if (!currentUserId) return

    const ch = supabase
      .channel(`clients-rt-${currentUserId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'clients',
          filter: `owner_user_id=eq.${currentUserId}`,
        },
        ({ new: row }) => {
          const item = row as Client
          setClients(prev => {
            if (prev.some(c => c.id === item.id)) return prev
            return [...prev, item].sort((a, b) => a.business_name.localeCompare(b.business_name))
          })
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'clients',
          filter: `owner_user_id=eq.${currentUserId}`,
        },
        ({ new: row }) => {
          setClients(prev => prev.map(c => c.id === (row as Client).id ? (row as Client) : c))
          setActiveClient(prev => prev?.id === (row as Client).id ? (row as Client) : prev)
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'clients',
          filter: `owner_user_id=eq.${currentUserId}`,
        },
        ({ old }) => {
          setClients(prev => prev.filter(c => c.id !== (old as Client).id))
        }
      )
      .subscribe()

    const vch = supabase
      .channel(`visits-rt-${currentUserId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'visits',
          filter: `owner_user_id=eq.${currentUserId}`,
        },
        ({ new: row }) => {
          const item = row as Visit
          setVisits(prev => {
            if (prev.some(v => v.id === item.id)) return prev
            return [item, ...prev]
          })
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'visits',
          filter: `owner_user_id=eq.${currentUserId}`,
        },
        ({ new: row }) => {
          setVisits(prev => prev.map(v => v.id === (row as Visit).id ? (row as Visit) : v))
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'DELETE',
          schema: 'public',
          table: 'visits',
          filter: `owner_user_id=eq.${currentUserId}`,
        },
        ({ old }) => {
          setVisits(prev => prev.filter(v => v.id !== (old as Visit).id))
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(ch)
      supabase.removeChannel(vch)
    }
  }, [currentUserId])

  // ── Initial load ──────────────────────────────────────────────────────────
  useEffect(() => { loadClients() }, [loadClients])

  const value: AppCtx = {
    clients, visits, visitsLoaded, loadVisits, updateClient, upsertVisit, deleteVisit,
    search, setSearch, zoneFilter, setZoneFilter, statusFilter, setStatusFilter, followupFilter, setFollowupFilter,
    unlocatedOnly, setUnlocatedOnly, filteredClients, zones,
    activeClient, openPanel, closePanel,
    editingVisit, visitModalOpen, visitModalDate, openVisitModal, closeVisitModal,
    syncing, syncError, toast, toastState,
  }

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
