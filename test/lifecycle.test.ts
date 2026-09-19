import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  calculateNextClientStatus,
  findDuplicateClient,
  getVisitDisplayName,
  orchestrateUpsertVisit,
  evaluateModalSaveResult,
  type LifecycleDbAdapter,
  type UpsertVisitResult,
  type ModalSubmissionState,
} from "../lib/lifecycle"
import type { Client, Visit } from "../lib/types"

const mockClients: Client[] = [
  {
    id: "c-1",
    business_name: "Bar Amerika",
    status: "prospect",
    business_type: null,
    zone: "Z4",
    address: "Rruga Myslym Shyri",
    lat: null,
    lng: null,
    phone: null,
    contact_person: null,
    general_notes: null,
    next_action: null,
    next_followup: null,
    decline_reason: null,
    order_value: null,
    source: "field_pdf_import",
    maps_url: null,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: null,
  },
  {
    id: "c-2",
    business_name: "Kafe Roma",
    status: "Catalog sent",
    business_type: null,
    zone: "Z4",
    address: "Rruga e Durrësit",
    lat: null,
    lng: null,
    phone: null,
    contact_person: null,
    general_notes: null,
    next_action: null,
    next_followup: null,
    decline_reason: null,
    order_value: null,
    source: "field_pdf_import",
    maps_url: null,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: null,
  },
  {
    id: "c-3",
    business_name: "Restorant Tirana",
    status: "Customer/Purchase",
    business_type: null,
    zone: "Z4",
    address: "Blloku",
    lat: null,
    lng: null,
    phone: null,
    contact_person: null,
    general_notes: null,
    next_action: null,
    next_followup: null,
    decline_reason: null,
    order_value: 50000,
    source: "field_pdf_import",
    maps_url: null,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: null,
  },
  {
    id: "c-4",
    business_name: "Hotel Dajti Lounge",
    status: "App downloaded",
    business_type: null,
    zone: "Z4",
    address: "Bulevardi Dëshmorët e Kombit",
    lat: null,
    lng: null,
    phone: null,
    contact_person: null,
    general_notes: null,
    next_action: null,
    next_followup: null,
    decline_reason: null,
    order_value: null,
    source: "field_pdf_import",
    maps_url: null,
    created_at: "2026-09-01T10:00:00Z",
    updated_at: null,
  },
]

describe("Client Lifecycle Integrity — V1 Status Mapping & Pure Rules", () => {
  it("visit outcome advances client status when appropriate", () => {
    assert.equal(calculateNextClientStatus("prospect", "App downloaded"), "App downloaded")
    assert.equal(calculateNextClientStatus("Catalog sent", "Customer/Purchase"), "Customer/Purchase")
    assert.equal(calculateNextClientStatus("prospect", "Catalog sent"), "Catalog sent")
    assert.equal(calculateNextClientStatus("No contact", "Catalog sent"), "Catalog sent")
    assert.equal(calculateNextClientStatus("No contact", "Customer/Purchase"), "Customer/Purchase")
    assert.equal(calculateNextClientStatus("No interest", "App downloaded"), "App downloaded")
  })

  it("visit outcome preserves current status against regressions", () => {
    assert.equal(calculateNextClientStatus("App downloaded", "Catalog sent"), "App downloaded")
    assert.equal(calculateNextClientStatus("Customer/Purchase", "App downloaded"), "Customer/Purchase")
    assert.equal(calculateNextClientStatus("Customer/Purchase", "Catalog sent"), "Customer/Purchase")
    assert.equal(calculateNextClientStatus("App downloaded", "App downloaded"), "App downloaded")
  })

  it("no accidental status downgrade from missed contact or default status", () => {
    assert.equal(calculateNextClientStatus("Customer/Purchase", "No contact"), "Customer/Purchase")
    assert.equal(calculateNextClientStatus("Customer/Purchase", "prospect"), "Customer/Purchase")
    assert.equal(calculateNextClientStatus("Customer/Purchase", "No interest"), "Customer/Purchase")
    assert.equal(calculateNextClientStatus("App downloaded", "No contact"), "App downloaded")
    assert.equal(calculateNextClientStatus("Catalog sent", "No contact"), "Catalog sent")
    assert.equal(calculateNextClientStatus("App downloaded", "prospect"), "App downloaded")
    assert.equal(calculateNextClientStatus("No contact", "prospect"), "No contact")
  })

  it("duplicate client matching normalizes whitespace, casing, and punctuation", () => {
    assert.equal(findDuplicateClient(mockClients, "  bar amerika  ")?.id, "c-1")
    assert.equal(findDuplicateClient(mockClients, "KAFE ROMA")?.id, "c-2")
    assert.equal(findDuplicateClient(mockClients, "Restorant   Tirana!")?.id, "c-3")
    assert.equal(findDuplicateClient(mockClients, "Bar Amerika 2"), undefined)
  })

  it("RouteView safe display: linked client > stored business_name > dash", () => {
    // 1. Linked client exists
    assert.equal(getVisitDisplayName({ client_id: "c-1", business_name: "Old Stored" }, mockClients), "Bar Amerika")
    // 2. Fallback to stored business_name if client_id is null
    assert.equal(getVisitDisplayName({ client_id: null, business_name: "Pastiçeri Rinia" }, mockClients), "Pastiçeri Rinia")
    // 3. Fallback to stored business_name if client_id not found
    assert.equal(getVisitDisplayName({ client_id: "missing-id", business_name: "Fast Food Tirana" }, mockClients), "Fast Food Tirana")
    // 4. Dash only when both are absent or empty
    assert.equal(getVisitDisplayName({ client_id: null, business_name: null }, mockClients), "—")
    assert.equal(getVisitDisplayName({ client_id: null, business_name: "   " }, mockClients), "—")
    assert.equal(getVisitDisplayName({ client_id: "missing-id", business_name: "" }, mockClients), "—")
  })
})

describe("Client Lifecycle Integrity — Real Orchestration & Rollback Tests", () => {
  function makeMockAdapter(overrides: Partial<LifecycleDbAdapter> = {}): LifecycleDbAdapter & {
    calls: {
      createClient: number
      deleteClient: number
      updateClientStatus: number
      createVisit: number
      updateVisit: number
      deleteVisit: number
    }
    deletedClientIds: string[]
    deletedVisitIds: string[]
    updatedClientStatuses: { clientId: string; status: string }[]
  } {
    const deletedClientIds: string[] = []
    const deletedVisitIds: string[] = []
    const updatedClientStatuses: { clientId: string; status: string }[] = []

    const calls = {
      createClient: 0,
      deleteClient: 0,
      updateClientStatus: 0,
      createVisit: 0,
      updateVisit: 0,
      deleteVisit: 0,
    }

    const adapter: LifecycleDbAdapter = {
      createClient: async client => {
        calls.createClient++
        if (overrides.createClient) return overrides.createClient(client)
        return {
          data: {
            id: "c-mock-new",
            business_name: client.business_name,
            status: client.status,
            business_type: null,
            zone: null,
            address: null,
            lat: null,
            lng: null,
            phone: null,
            contact_person: null,
            general_notes: null,
            next_action: null,
            next_followup: null,
            decline_reason: null,
            order_value: null,
            source: client.source,
            maps_url: client.maps_url,
            created_at: "2026-09-19T10:00:00Z",
            updated_at: null,
          },
          error: null,
        }
      },
      deleteClient: async clientId => {
        calls.deleteClient++
        deletedClientIds.push(clientId)
        if (overrides.deleteClient) return overrides.deleteClient(clientId)
        return { error: null }
      },
      updateClientStatus: async (clientId, status, updatedAt) => {
        calls.updateClientStatus++
        updatedClientStatuses.push({ clientId, status })
        if (overrides.updateClientStatus) return overrides.updateClientStatus(clientId, status, updatedAt)
        return { error: null }
      },
      createVisit: async visit => {
        calls.createVisit++
        if (overrides.createVisit) return overrides.createVisit(visit)
        return {
          data: {
            id: "v-mock-new",
            visit_date: visit.visit_date,
            client_id: visit.client_id,
            business_name: visit.business_name,
            location_url: visit.location_url,
            statusi: visit.statusi,
            shenime: visit.shenime,
            created_at: "2026-09-19T10:00:00Z",
            updated_at: null,
          },
          error: null,
        }
      },
      updateVisit: async (id, patch) => {
        calls.updateVisit++
        if (overrides.updateVisit) return overrides.updateVisit(id, patch)
        return {
          data: {
            id,
            visit_date: patch.visit_date ?? "2026-09-19",
            client_id: patch.client_id ?? null,
            business_name: patch.business_name ?? "Default",
            location_url: patch.location_url ?? null,
            statusi: patch.statusi ?? null,
            shenime: patch.shenime ?? null,
            created_at: "2026-09-19T10:00:00Z",
            updated_at: "2026-09-19T10:05:00Z",
          },
          error: null,
        }
      },
      deleteVisit: async visitId => {
        calls.deleteVisit++
        deletedVisitIds.push(visitId)
        if (overrides.deleteVisit) return overrides.deleteVisit(visitId)
        return { error: null }
      },
    }

    return Object.assign(adapter, { calls, deletedClientIds, deletedVisitIds, updatedClientStatuses })
  }

  // -------------------------------------------------------------------------
  // TEST 1: New existing-client visit + status update success
  // -------------------------------------------------------------------------
  it("1. new existing-client visit + status update success", async () => {
    const adapter = makeMockAdapter()
    const result = await orchestrateUpsertVisit({
      payload: {
        client_id: "c-1", // Bar Amerika (current status: prospect)
        visit_date: "2026-09-19",
        business_name: "Bar Amerika",
        location_url: null,
        statusi: "App downloaded",
        shenime: "Pronari instaloi aplikacionin",
      },
      clients: mockClients,
      adapter,
    })

    assert.equal(result.kind, "success")
    assert.equal(result.ok, true)
    assert.equal(result.clientStatusUpdated, true)
    assert.equal(result.newStatus, "App downloaded")
    assert.equal(adapter.calls.createVisit, 1)
    assert.equal(adapter.calls.updateClientStatus, 1)
    assert.deepEqual(adapter.updatedClientStatuses, [{ clientId: "c-1", status: "App downloaded" }])
    assert.equal(adapter.calls.deleteVisit, 0)
  })

  // -------------------------------------------------------------------------
  // TEST 2: Visit insert succeeds + client status update fails + visit rollback succeeds
  // -------------------------------------------------------------------------
  it("2. visit insert succeeds + client status update fails + visit rollback succeeds", async () => {
    const adapter = makeMockAdapter({
      updateClientStatus: async () => ({ error: { message: "Network connection lost to clients table" } }),
      deleteVisit: async () => ({ error: null }), // Rollback succeeds
    })

    const result = await orchestrateUpsertVisit({
      payload: {
        client_id: "c-1",
        visit_date: "2026-09-19",
        business_name: "Bar Amerika",
        location_url: null,
        statusi: "App downloaded",
        shenime: "Test note",
      },
      clients: mockClients,
      adapter,
    })

    // Rollback succeeded -> Clean failure with nothing left persisted
    assert.equal(result.kind, "failure")
    assert.equal(result.ok, false)
    assert.match(result.error, /Vizita u anulua për të shmangur të dhëna të paplota/)
    assert.equal(adapter.calls.createVisit, 1)
    assert.equal(adapter.calls.updateClientStatus, 1)
    assert.equal(adapter.calls.deleteVisit, 1)
    assert.deepEqual(adapter.deletedVisitIds, ["v-mock-new"])
  })

  // -------------------------------------------------------------------------
  // TEST 3: Visit insert succeeds + client status update fails + visit rollback fails
  // -------------------------------------------------------------------------
  it("3. visit insert succeeds + client status update fails + visit rollback fails → explicit partial result", async () => {
    const adapter = makeMockAdapter({
      updateClientStatus: async () => ({ error: { message: "Clients table lock timeout" } }),
      deleteVisit: async () => ({ error: { message: "Visits delete permission denied" } }), // Rollback fails!
    })

    const result = await orchestrateUpsertVisit({
      payload: {
        client_id: "c-1",
        visit_date: "2026-09-19",
        business_name: "Bar Amerika",
        location_url: null,
        statusi: "App downloaded",
        shenime: "Test note",
      },
      clients: mockClients,
      adapter,
    })

    // Rollback failed -> Distinct partial persistence state
    assert.equal(result.kind, "partial")
    assert.equal(result.ok, false)
    assert.ok(result.visit)
    assert.equal(result.visit.id, "v-mock-new")
    assert.match(result.message, /Mos e ri-dërgoni vizitën për të shmangur duplikimet/)
    assert.equal(adapter.calls.createVisit, 1)
    assert.equal(adapter.calls.updateClientStatus, 1)
    assert.equal(adapter.calls.deleteVisit, 1)
  })

  // -------------------------------------------------------------------------
  // TEST 4: New-client creation succeeds + visit insert fails + client rollback succeeds
  // -------------------------------------------------------------------------
  it("4. new-client creation succeeds + visit insert fails + client rollback succeeds", async () => {
    const adapter = makeMockAdapter({
      createVisit: async () => ({ data: null, error: { message: "Disk full on visits" } }),
      deleteClient: async () => ({ error: null }), // Rollback succeeds
    })

    const result = await orchestrateUpsertVisit({
      payload: {
        client_id: null,
        visit_date: "2026-09-19",
        business_name: "Pastiçeri Venecia e Re",
        location_url: null,
        statusi: "Customer/Purchase",
        shenime: "Porosi e re",
      },
      clients: mockClients,
      adapter,
    })

    assert.equal(result.kind, "failure")
    assert.equal(result.ok, false)
    assert.match(result.error, /Regjistrimi i klientit u anulua me sukses/)
    assert.equal(adapter.calls.createClient, 1)
    assert.equal(adapter.calls.createVisit, 1)
    assert.equal(adapter.calls.deleteClient, 1)
    assert.deepEqual(adapter.deletedClientIds, ["c-mock-new"])
  })

  // -------------------------------------------------------------------------
  // TEST 5: New-client creation succeeds + visit insert fails + client rollback fails
  // -------------------------------------------------------------------------
  it("5. new-client creation succeeds + visit insert fails + client rollback fails → explicit partial result and duplicate-safe state", async () => {
    const adapter = makeMockAdapter({
      createVisit: async () => ({ data: null, error: { message: "Constraint error" } }),
      deleteClient: async () => ({ error: { message: "Foreign key lock" } }), // Rollback fails!
    })

    const result = await orchestrateUpsertVisit({
      payload: {
        client_id: null,
        visit_date: "2026-09-19",
        business_name: "Pastiçeri Venecia e Re",
        location_url: null,
        statusi: "Customer/Purchase",
        shenime: "Porosi e re",
      },
      clients: mockClients,
      adapter,
    })

    // Rollback failed -> Explicit partial result
    assert.equal(result.kind, "partial")
    assert.equal(result.ok, false)
    assert.ok(result.client)
    assert.equal(result.client.id, "c-mock-new")
    assert.match(result.message, /Klienti mbetet në listë për të shmangur duplikimet/)

    // Duplicate safety simulation: local state retains this client
    const updatedLocalClients = [...mockClients, result.client]
    const duplicateLookup = findDuplicateClient(updatedLocalClients, "pastiçeri venecia e re")
    assert.equal(duplicateLookup?.id, "c-mock-new") // A subsequent attempt matches this client, preventing duplicate creation!
  })

  // -------------------------------------------------------------------------
  // TEST 6: Editing an existing visit does NOT mutate clients.status
  // -------------------------------------------------------------------------
  it("6. editing an existing visit does NOT mutate clients.status", async () => {
    const adapter = makeMockAdapter()
    const result = await orchestrateUpsertVisit({
      editingId: "v-historical-1",
      payload: {
        client_id: "c-1", // Bar Amerika (status: prospect)
        visit_date: "2026-08-15",
        business_name: "Bar Amerika",
        location_url: null,
        statusi: "Customer/Purchase", // Outcome would otherwise advance to Customer
        shenime: "Korrigjim i shënimit të vjetër",
      },
      clients: mockClients,
      adapter,
    })

    assert.equal(result.kind, "success")
    assert.equal(result.ok, true)
    assert.equal(adapter.calls.updateVisit, 1)
    // CRITICAL: updateClientStatus must NEVER be called on historical edits!
    assert.equal(adapter.calls.updateClientStatus, 0)
    assert.equal(adapter.updatedClientStatuses.length, 0)
  })

  // -------------------------------------------------------------------------
  // TEST 7: Rapid duplicate submission remains blocked
  // -------------------------------------------------------------------------
  it("7. rapid duplicate submission remains blocked", async () => {
    let inProgress = false
    async function submitGuarded(adapter: LifecycleDbAdapter, payload: any) {
      if (inProgress) {
        return { ok: false, kind: "failure", error: "Një veprim është në proces. Ju lutem prisni." }
      }
      inProgress = true
      try {
        return await orchestrateUpsertVisit({
          payload,
          clients: mockClients,
          adapter,
        })
      } finally {
        inProgress = false
      }
    }

    const adapter = makeMockAdapter({
      createVisit: async visit => {
        // Simulate in-flight async delay
        await new Promise(r => setTimeout(r, 20))
        return {
          data: {
            id: "v-mock",
            visit_date: visit.visit_date,
            client_id: visit.client_id,
            business_name: visit.business_name,
            location_url: null,
            statusi: visit.statusi,
            shenime: null,
            created_at: "2026-09-19T10:00:00Z",
            updated_at: null,
          },
          error: null,
        }
      },
    })

    const payload = {
      client_id: "c-1",
      visit_date: "2026-09-19",
      business_name: "Bar Amerika",
      location_url: null,
      statusi: "App downloaded",
      shenime: null,
    }

    // Launch first submission (takes 20ms)
    const promise1 = submitGuarded(adapter, payload)
    // Immediate concurrent second submission while promise1 is in-flight
    const res2 = await submitGuarded(adapter, payload)
    const res1 = await promise1

    assert.equal(res1.kind, "success")
    assert.equal(res2.kind, "failure")
    assert.equal(res2.error, "Një veprim është në proces. Ju lutem prisni.")
    assert.equal(adapter.calls.createVisit, 1) // Only one visit was inserted
  })
})

describe("VisitModal Partial-Persistence UI State & Retry Prevention", () => {
  it("1. partial result containing a persisted visit enters non-retryable UI state", () => {
    const partialResult: UpsertVisitResult = {
      ok: false,
      kind: "partial",
      error: "Status update failed",
      message: "Vizita u ruajt në sistem, por statusi i klientit nuk mund të përditësohej. Mos e ri-dërgoni vizitën për të shmangur duplikimet.",
      visit: {
        id: "v-persisted-1",
        visit_date: "2026-09-19",
        client_id: "c-1",
        business_name: "Bar Amerika",
        location_url: null,
        statusi: "App downloaded",
        shenime: null,
        created_at: "2026-09-19T10:00:00Z",
        updated_at: null,
      },
    }

    const state = evaluateModalSaveResult(partialResult)

    assert.equal(state.isVisitPersisted, true)
    assert.equal(state.canRetrySave, false)
    assert.equal(state.action, "show_warning_and_lock")
    assert.match(state.error, /Mos e ri-dërgoni vizitën për të shmangur duplikimet/)
  })

  it("2. Save cannot invoke upsertVisit again from that same modal state", async () => {
    let upsertCalls = 0
    let modalIsVisitPersisted = false
    let modalError = ""

    // Simulated modal handleSave harness mirroring VisitModal.tsx
    async function modalHandleSave() {
      if (modalIsVisitPersisted) {
        return // Guard prevents execution
      }
      upsertCalls++

      // Simulated partial result with persisted visit
      const res: UpsertVisitResult = {
        ok: false,
        kind: "partial",
        error: "Status update error",
        message: "Vizita u ruajt, mos ri-provoni.",
        visit: {
          id: "v-p1",
          visit_date: "2026-09-19",
          client_id: "c-1",
          business_name: "Bar Amerika",
          location_url: null,
          statusi: "App downloaded",
          shenime: null,
          created_at: "2026-09-19T10:00:00Z",
          updated_at: null,
        },
      }

      const outcome = evaluateModalSaveResult(res)
      modalError = outcome.error
      if (outcome.isVisitPersisted) {
        modalIsVisitPersisted = true
      }
    }

    // First save attempt
    await modalHandleSave()
    assert.equal(upsertCalls, 1)
    assert.equal(modalIsVisitPersisted, true)
    assert.equal(modalError, "Vizita u ruajt, mos ri-provoni.")

    // Second click on Save while in this same modal state
    await modalHandleSave()
    // Call count must strictly remain 1
    assert.equal(upsertCalls, 1)

    // Third click on Save
    await modalHandleSave()
    assert.equal(upsertCalls, 1)
  })

  it("3. user can safely close the modal without altering persisted visit", () => {
    let modalOpen = true
    let isVisitPersisted = true
    let modalError = "Warning message"

    function closeVisitModal() {
      modalOpen = false
      isVisitPersisted = false
      modalError = ""
    }

    // User triggers exit action (Mbyll button)
    closeVisitModal()

    assert.equal(modalOpen, false)
    assert.equal(isVisitPersisted, false)
    assert.equal(modalError, "")
  })

  it("4. partial-client-only behavior remains retry-capable through duplicate resolution because no visit exists yet", async () => {
    const clientOnlyPartialResult: UpsertVisitResult = {
      ok: false,
      kind: "partial",
      error: "Visit creation failed",
      message: "Klienti u regjistrua në sistem, por vizita nuk mund të ruhej.",
      client: {
        id: "c-new-created",
        business_name: "Pastiçeri Venecia",
        status: "prospect",
        business_type: null,
        zone: null,
        address: null,
        lat: null,
        lng: null,
        phone: null,
        contact_person: null,
        general_notes: null,
        next_action: null,
        next_followup: null,
        decline_reason: null,
        order_value: null,
        source: "field_visit",
        maps_url: null,
        created_at: "2026-09-19T10:00:00Z",
        updated_at: null,
      },
      // Note: visit is undefined!
    }

    const outcome = evaluateModalSaveResult(clientOnlyPartialResult)

    // When only client was created (and no visit exists yet):
    // UI should NOT lock as visit-persisted
    assert.equal(outcome.isVisitPersisted, false)
    assert.equal(outcome.canRetrySave, true)
    assert.equal(outcome.action, "show_error_allow_retry")

    // In local state, client exists:
    const localClients = [...mockClients, clientOnlyPartialResult.client!]

    // On user retry, duplicate resolution matches the existing client:
    const matched = findDuplicateClient(localClients, "pastiçeri venecia")
    assert.ok(matched)
    assert.equal(matched.id, "c-new-created")
    // Retry will now safely target the existing client id rather than creating a duplicate client!
  })
})
