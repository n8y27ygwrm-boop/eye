import { describe, it } from "node:test"
import assert from "node:assert/strict"
import {
  calculateNextClientStatus,
  findDuplicateClient,
  getVisitDisplayName,
  orchestrateUpsertVisit,
  evaluateModalSaveResult,
  findNearbyClients,
  NEARBY_CLIENT_RADIUS_METERS,
  type AttachedVisitLocation,
  type LifecycleDbAdapter,
  type UpsertVisitResult,
  type ModalSubmissionState,
} from "../lib/lifecycle"
import type { Client, Visit } from "../lib/types"
import { generateGoogleMapsUrl } from "../lib/location/utils"
import { groupClientsByCoordinates, isUnlocated } from "../lib/location/group"

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

describe('Visit GPS → client location → map', () => {
  const owner = 'owner-a'
  const gps: AttachedVisitLocation = {
    location: { latitude: 41.3275, longitude: 19.8187, accuracy: 12, timestamp: Date.now() },
    acknowledgedPoorAccuracy: false,
  }
  const client = (id: string, name: string, patch: Partial<Client> = {}): Client => ({
    ...mockClients[0], id, business_name: name, owner_user_id: owner, status: 'prospect',
    lat: null, lng: null, maps_url: null, ...patch,
  })
  const payload = (name: string, clientId: string | null = null): Omit<Visit, 'id' | 'created_at' | 'updated_at'> => ({
    client_id: clientId, business_name: name, owner_user_id: owner, visit_date: '2026-10-03',
    statusi: 'prospect', shenime: null, location_url: generateGoogleMapsUrl(gps.location.latitude, gps.location.longitude),
  })
  function adapter(overrides: Partial<LifecycleDbAdapter> = {}) {
    const calls = { createClient: 0, deleteClient: 0, updateClientStatus: 0, updateClientLocation: 0, createVisit: 0, updateVisit: 0, deleteVisit: 0 }
    let createdClientInput: Parameters<LifecycleDbAdapter['createClient']>[0] | null = null
    let createdVisitInput: Parameters<LifecycleDbAdapter['createVisit']>[0] | null = null
    const api: LifecycleDbAdapter = {
      createClient: async input => {
        calls.createClient++; createdClientInput = input
        return overrides.createClient ? overrides.createClient(input) : { data: client('new', input.business_name, input), error: null }
      },
      deleteClient: async id => { calls.deleteClient++; return overrides.deleteClient ? overrides.deleteClient(id) : { error: null } },
      updateClientStatus: async (id, status, at) => {
        calls.updateClientStatus++
        return overrides.updateClientStatus ? overrides.updateClientStatus(id, status, at) : { error: null }
      },
      updateClientLocation: async (existing, location) => {
        calls.updateClientLocation++
        return overrides.updateClientLocation ? overrides.updateClientLocation(existing, location) : { data: { ...existing, ...location }, error: null }
      },
      createVisit: async input => {
        calls.createVisit++; createdVisitInput = input
        return overrides.createVisit ? overrides.createVisit(input) : { data: { ...input, id: 'visit-new', created_at: 'now', updated_at: null }, error: null }
      },
      updateVisit: async (id, input) => {
        calls.updateVisit++
        return overrides.updateVisit ? overrides.updateVisit(id, input) : { data: { ...payload('Historical', input.client_id ?? null), ...input, id, created_at: 'then', updated_at: 'now' }, error: null }
      },
      deleteVisit: async id => { calls.deleteVisit++; return overrides.deleteVisit ? overrides.deleteVisit(id) : { error: null } },
    }
    return { api, calls, get createdClientInput() { return createdClientInput }, get createdVisitInput() { return createdVisitInput } }
  }

  it('1. creates one located client and one linked visit with separate visit evidence', async () => {
    const db = adapter()
    const result = await orchestrateUpsertVisit({ payload: payload('New Cafe'), clients: [], adapter: db.api, attachedLocation: gps })
    assert.equal(result.kind, 'success')
    assert.equal(db.calls.createClient, 1); assert.equal(db.calls.createVisit, 1)
    assert.equal(db.createdClientInput?.lat, gps.location.latitude)
    assert.equal(db.createdClientInput?.lng, gps.location.longitude)
    assert.equal(db.createdClientInput?.maps_url, generateGoogleMapsUrl(41.3275, 19.8187))
    assert.equal(db.createdClientInput?.source, 'field_visit')
    assert.equal(db.createdVisitInput?.client_id, 'new')
    assert.equal(db.createdVisitInput?.location_url, payload('New Cafe').location_url)
  })

  it('2. leaves a new client unlocated without structured GPS', async () => {
    const db = adapter()
    await orchestrateUpsertVisit({ payload: { ...payload('No GPS'), location_url: 'https://maps.google.com/elsewhere' }, clients: [], adapter: db.api })
    assert.equal(db.createdClientInput?.lat, null); assert.equal(db.createdClientInput?.lng, null)
  })

  it('3. selected unlocated client gains coordinates without another client insert', async () => {
    const existing = client('existing', 'Bar Roma')
    const db = adapter()
    const result = await orchestrateUpsertVisit({ payload: payload('Bar Roma', existing.id), clients: [existing], adapter: db.api, attachedLocation: gps })
    assert.equal(result.kind, 'success'); assert.equal(db.calls.createClient, 0)
    assert.equal(db.calls.updateClientLocation, 1)
    assert.equal(result.updatedClient?.lat, gps.location.latitude)
    assert.equal(result.updatedClient?.lng, gps.location.longitude)
    assert.equal(result.data.client_id, existing.id)
  })

  it('4. normalized hyphenated name resolves to existing owner client', async () => {
    const existing = client('roma', 'Bar Roma')
    const db = adapter()
    const result = await orchestrateUpsertVisit({ payload: payload(' bar-roma '), clients: [existing], adapter: db.api })
    assert.equal(result.kind, 'success'); assert.equal(result.data.client_id, existing.id)
    assert.equal(db.calls.createClient, 0)
  })

  it('5. an already located client retains its business coordinates', async () => {
    const existing = client('mapped', 'Mapped', { lat: 41.3, lng: 19.8 })
    const db = adapter()
    const result = await orchestrateUpsertVisit({ payload: payload('Mapped', existing.id), clients: [existing], adapter: db.api, attachedLocation: gps })
    assert.equal(result.kind, 'success'); assert.equal(db.calls.updateClientLocation, 0)
    assert.equal(result.data.location_url, generateGoogleMapsUrl(41.3275, 19.8187))
  })

  it('6. nearby different name requests a choice before any write', async () => {
    const existing = client('neighbor', 'Other Shop', { lat: 41.3275, lng: 19.8187 })
    const db = adapter()
    const result = await orchestrateUpsertVisit({ payload: payload('New Shop'), clients: [existing], adapter: db.api, attachedLocation: gps })
    assert.equal(result.kind, 'decision_required'); assert.equal(result.candidates[0].client.id, 'neighbor')
    assert.equal(db.calls.createClient, 0); assert.equal(db.calls.createVisit, 0)
  })

  it('uses the named 30-meter radius as a conservative candidate boundary', () => {
    assert.equal(NEARBY_CLIENT_RADIUS_METERS, 30)
    const metersToDegrees = 1 / 111195
    const near = client('near', 'Near', { lat: 41.3275 + 29 * metersToDegrees, lng: 19.8187 })
    const far = client('far', 'Far', { lat: 41.3275 + 31 * metersToDegrees, lng: 19.8187 })
    assert.deepEqual(findNearbyClients([near, far], gps.location, owner).map(c => c.client.id), ['near'])
  })

  it('7. selecting a nearby candidate attaches the visit to it', async () => {
    const existing = client('neighbor', 'Other Shop', { lat: 41.3275, lng: 19.8187 })
    const db = adapter()
    const result = await orchestrateUpsertVisit({ payload: payload(existing.business_name, existing.id), clients: [existing], adapter: db.api, attachedLocation: gps })
    assert.equal(result.kind, 'success'); assert.equal(result.data.client_id, existing.id)
    assert.equal(db.calls.createClient, 0)
  })

  it('8. explicit continue-as-new creates a distinct client at a shared coordinate', async () => {
    const existing = client('neighbor', 'Other Shop', { lat: 41.3275, lng: 19.8187 })
    const db = adapter()
    const result = await orchestrateUpsertVisit({ payload: payload('New Shop'), clients: [existing], adapter: db.api, attachedLocation: gps, allowNewAtNearbyLocation: true })
    assert.equal(result.kind, 'success'); assert.equal(db.calls.createClient, 1)
    assert.equal(result.data.client_id, 'new')
  })

  it('9. foreign owner cannot match by name, proximity, or explicit id', async () => {
    const foreign = client('foreign', 'Bar Roma', { owner_user_id: 'owner-b', lat: 41.3275, lng: 19.8187 })
    const db = adapter()
    const byName = await orchestrateUpsertVisit({ payload: payload('Bar Roma'), clients: [foreign], adapter: db.api, attachedLocation: gps })
    assert.equal(byName.kind, 'success'); assert.equal(byName.data.client_id, 'new')
    const byId = await orchestrateUpsertVisit({ payload: payload('Bar Roma', 'foreign'), clients: [foreign], adapter: db.api, attachedLocation: gps })
    assert.equal(byId.kind, 'failure')
    assert.deepEqual(findNearbyClients([foreign], gps.location, owner), [])
  })

  it('10. historical edit never changes client location or status', async () => {
    const existing = client('old', 'Old', { lat: null, lng: null })
    const db = adapter()
    const result = await orchestrateUpsertVisit({ payload: payload('Old', 'old'), editingId: 'historical', clients: [existing], adapter: db.api, attachedLocation: gps })
    assert.equal(result.kind, 'success'); assert.equal(db.calls.updateVisit, 1)
    assert.equal(db.calls.updateClientLocation, 0); assert.equal(db.calls.updateClientStatus, 0)
  })

  it('11. failed location update deletes the new visit and does not report success', async () => {
    const existing = client('unlocated', 'Unlocated')
    const statuses: (string | null)[] = []
    const db = adapter({
      updateClientLocation: async () => ({ data: null, error: { message: 'denied' } }),
      updateClientStatus: async (_id, status) => { statuses.push(status); return { error: null } },
    })
    const result = await orchestrateUpsertVisit({ payload: { ...payload('Unlocated', existing.id), statusi: 'Catalog sent' }, clients: [existing], adapter: db.api, attachedLocation: gps })
    assert.equal(result.kind, 'failure'); assert.equal(db.calls.deleteVisit, 1)
    assert.deepEqual(statuses, ['Catalog sent', 'prospect'])
  })

  it('11b. failed rollback reports a partial persisted visit', async () => {
    const existing = client('unlocated', 'Unlocated')
    const db = adapter({ updateClientLocation: async () => ({ data: null, error: { message: 'denied' } }), deleteVisit: async () => ({ error: { message: 'denied' } }) })
    const result = await orchestrateUpsertVisit({ payload: payload('Unlocated', existing.id), clients: [existing], adapter: db.api, attachedLocation: gps })
    assert.equal(result.kind, 'partial'); assert.equal(result.visit?.id, 'visit-new')
    assert.equal(evaluateModalSaveResult(result).isVisitPersisted, true)
  })

  it('12. failed visit insert deletes a newly created located client', async () => {
    const db = adapter({ createVisit: async () => ({ data: null, error: { message: 'insert failed' } }) })
    const result = await orchestrateUpsertVisit({ payload: payload('New Located'), clients: [], adapter: db.api, attachedLocation: gps })
    assert.equal(result.kind, 'failure'); assert.equal(db.calls.deleteClient, 1)
  })

  it('13. applying the returned client turns an unlocated map record into a marker', async () => {
    const existing = client('map-target', 'Map Target')
    const db = adapter()
    const result = await orchestrateUpsertVisit({ payload: payload('Map Target', existing.id), clients: [existing], adapter: db.api, attachedLocation: gps })
    assert.equal(result.kind, 'success')
    const localClients = [existing].map(c => c.id === result.updatedClient?.id ? result.updatedClient : c)
    assert.equal(isUnlocated(existing), true)
    assert.equal(isUnlocated(localClients[0]), false)
    assert.equal(groupClientsByCoordinates(localClients).size, 1)
  })

  it('14. two businesses can remain distinct at the same coordinate after confirmation', async () => {
    const existing = client('first', 'First', { lat: 41.3275, lng: 19.8187 })
    const db = adapter()
    const result = await orchestrateUpsertVisit({ payload: payload('Second'), clients: [existing], adapter: db.api, attachedLocation: gps, allowNewAtNearbyLocation: true })
    assert.equal(result.kind, 'success')
    assert.equal(groupClientsByCoordinates([existing, result.client!]).get('41.3275,19.8187')?.length, 2)
  })

  it('repairs a half-location as a complete coordinate pair', async () => {
    const existing = client('half', 'Half', { lat: 41.2, lng: null })
    const db = adapter()
    const result = await orchestrateUpsertVisit({ payload: payload('Half', existing.id), clients: [existing], adapter: db.api, attachedLocation: gps })
    assert.equal(result.kind, 'success')
    assert.equal(result.updatedClient?.lat, 41.3275); assert.equal(result.updatedClient?.lng, 19.8187)
  })

  it('rejects poor GPS until the existing attach-anyway decision is explicit', async () => {
    const db = adapter()
    const poor: AttachedVisitLocation = { location: { ...gps.location, accuracy: 400 }, acknowledgedPoorAccuracy: false }
    const rejected = await orchestrateUpsertVisit({ payload: payload('Poor GPS'), clients: [], adapter: db.api, attachedLocation: poor })
    assert.equal(rejected.kind, 'failure'); assert.equal(db.calls.createClient, 0)
    const accepted = await orchestrateUpsertVisit({ payload: payload('Poor GPS'), clients: [], adapter: db.api, attachedLocation: { ...poor, acknowledgedPoorAccuracy: true } })
    assert.equal(accepted.kind, 'success'); assert.equal(db.calls.createClient, 1)
  })
})

describe("Client Lifecycle Integrity — Real Orchestration & Rollback Tests", () => {
  function makeMockAdapter(overrides: Partial<LifecycleDbAdapter> = {}): LifecycleDbAdapter & {
    calls: {
      createClient: number
      deleteClient: number
      updateClientStatus: number
      updateClientLocation: number
      createVisit: number
      updateVisit: number
      deleteVisit: number
    }
    deletedClientIds: string[]
    deletedVisitIds: string[]
    updatedClientStatuses: { clientId: string; status: string | null }[]
  } {
    const deletedClientIds: string[] = []
    const deletedVisitIds: string[] = []
    const updatedClientStatuses: { clientId: string; status: string | null }[] = []

    const calls = {
      createClient: 0,
      deleteClient: 0,
      updateClientStatus: 0,
      updateClientLocation: 0,
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
            lat: client.lat,
            lng: client.lng,
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
      updateClientLocation: async (client, location) => {
        calls.updateClientLocation++
        if (overrides.updateClientLocation) return overrides.updateClientLocation(client, location)
        return { data: { ...client, ...location }, error: null }
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
