import { normalize, type Client, type Visit, STATUS_DEFS } from "./types"

export type ClientStatusKey = typeof STATUS_DEFS[number]["key"]

/**
 * Explicit V1 lifecycle policy for Eye MVP:
 * Deterministically computes the next client status based on their current status
 * and a new visit outcome.
 *
 * Rules:
 * 1. Customer/Purchase always results in "Customer/Purchase".
 * 2. App downloaded advances "prospect", "No contact", "Catalog sent", "No interest" to "App downloaded".
 *    Preserves "Customer/Purchase".
 * 3. Catalog sent advances "prospect", "No contact", "No interest" to "Catalog sent".
 *    Preserves "Customer/Purchase" and "App downloaded".
 * 4. No contact transitions "prospect" or null to "No contact".
 *    Preserves "Customer/Purchase", "App downloaded", "Catalog sent", and "No interest".
 * 5. No interest transitions any non-customer status to "No interest".
 *    Preserves "Customer/Purchase".
 * 6. prospect (default outcome) never downgrades any existing status.
 */
export function calculateNextClientStatus(
  currentStatus: string | null | undefined,
  visitOutcome: string | null | undefined
): string {
  const normOutcome = (visitOutcome ?? "").trim()
  const normCurrent = (currentStatus ?? "").trim()

  if (!normOutcome) {
    return normCurrent || "prospect"
  }

  // Canonical key matching (case-insensitive lookup for safety)
  const matchedDef = STATUS_DEFS.find(
    s => s.key.toLowerCase() === normOutcome.toLowerCase()
  )
  const outcomeKey = matchedDef ? matchedDef.key : normOutcome

  // If no previous status, outcome directly determines initial status
  if (!normCurrent) {
    return outcomeKey
  }

  const currentDef = STATUS_DEFS.find(
    s => s.key.toLowerCase() === normCurrent.toLowerCase()
  )
  const currentKey = currentDef ? currentDef.key : normCurrent

  switch (outcomeKey) {
    case "Customer/Purchase":
      return "Customer/Purchase"

    case "App downloaded":
      if (currentKey === "Customer/Purchase") {
        return "Customer/Purchase" // Preserve customer
      }
      return "App downloaded"

    case "Catalog sent":
      if (currentKey === "Customer/Purchase" || currentKey === "App downloaded") {
        return currentKey // Preserve further milestones
      }
      return "Catalog sent"

    case "No interest":
      if (currentKey === "Customer/Purchase") {
        return "Customer/Purchase" // Customer status requires deliberate account action
      }
      return "No interest"

    case "No contact":
      if (
        currentKey === "Customer/Purchase" ||
        currentKey === "App downloaded" ||
        currentKey === "Catalog sent" ||
        currentKey === "No interest"
      ) {
        return currentKey // Missed visit does not erase past achievements/decisions
      }
      return "No contact"

    case "prospect":
      // Generic default outcome preserves whatever milestone was already reached
      return currentKey || "prospect"

    default:
      return currentKey || outcomeKey
  }
}

/**
 * Searches for an existing client that matches the given business name,
 * protecting against whitespace, casing, and punctuation differences.
 */
export function findDuplicateClient(
  clients: Client[],
  businessName: string
): Client | undefined {
  const normInput = normalize(businessName)
  if (!normInput) return undefined
  return clients.find(c => normalize(c.business_name) === normInput)
}

/**
 * Safe display resolution for visit business name:
 * 1. If client_id matches an existing client, return the client business_name.
 * 2. Otherwise fall back to the visit stored business_name.
 * 3. Render "—" only when neither source contains usable information.
 */
export function getVisitDisplayName(
  visit: { client_id?: string | null; business_name?: string | null },
  clients?: Client[]
): string {
  if (visit.client_id && clients && clients.length > 0) {
    const found = clients.find(c => c.id === visit.client_id)
    if (found?.business_name && found.business_name.trim()) {
      return found.business_name.trim()
    }
  }

  if (visit.business_name && visit.business_name.trim()) {
    return visit.business_name.trim()
  }

  return "—"
}

// -----------------------------------------------------------------------------
// Orchestration & Persistence Contract
// -----------------------------------------------------------------------------

export type UpsertVisitResult =
  | {
      ok: true
      kind: "success"
      data: Visit
      client?: Client
      clientStatusUpdated?: boolean
      newStatus?: string
    }
  | {
      ok: false
      kind: "failure"
      error: string
    }
  | {
      ok: false
      kind: "partial"
      error: string
      message: string
      visit?: Visit
      client?: Client
      clientStatusUpdated?: boolean
    }

export interface LifecycleDbAdapter {
  createClient: (client: {
    business_name: string
    status: string
    source: string
    maps_url: string | null
  }) => Promise<{ data: Client | null; error: { message: string } | null }>

  deleteClient: (clientId: string) => Promise<{ error: { message: string } | null }>

  updateClientStatus: (
    clientId: string,
    status: string,
    updatedAt: string
  ) => Promise<{ error: { message: string } | null }>

  createVisit: (
    visit: Omit<Visit, "id" | "created_at" | "updated_at">
  ) => Promise<{ data: Visit | null; error: { message: string } | null }>

  updateVisit: (
    id: string,
    visit: Partial<Visit>
  ) => Promise<{ data: Visit | null; error: { message: string } | null }>

  deleteVisit: (visitId: string) => Promise<{ error: { message: string } | null }>
}

/**
 * Orchestrates visit saving and client lifecycle updates with verified rollbacks.
 *
 * Rules:
 * 1. Historical edit (editingId present): Updates visit ONLY. Never mutates client lifecycle.
 * 2. New business visit: Creates client -> creates visit.
 *    If visit creation fails, attempts client deletion.
 *    - If deletion succeeds -> clean failure.
 *    - If deletion fails -> partial persistence result; client is kept in local state for duplicate safety.
 * 3. Existing client visit: Creates visit -> updates client status if applicable.
 *    If client status update fails, attempts visit deletion.
 *    - If deletion succeeds -> clean failure.
 *    - If deletion fails -> partial persistence result; informs user that visit exists and must not be retried.
 */
export async function orchestrateUpsertVisit(params: {
  payload: Omit<Visit, "id" | "created_at" | "updated_at">
  editingId?: string
  clients: Client[]
  adapter: LifecycleDbAdapter
  nowISO?: () => string
}): Promise<UpsertVisitResult> {
  const {
    payload,
    editingId,
    clients,
    adapter,
    nowISO = () => new Date().toISOString(),
  } = params

  let resolvedClientId = payload.client_id || null
  let matchedClient = resolvedClientId
    ? clients.find(c => c.id === resolvedClientId)
    : undefined

  // Cross-user relationship validation: if client_id is supplied, verify it belongs to user
  if (resolvedClientId) {
    if (!matchedClient) {
      return { ok: false, kind: "failure", error: "Klienti i zgjedhur nuk ekziston ose nuk ju përket juve." }
    }
    if (payload.owner_user_id && matchedClient.owner_user_id && matchedClient.owner_user_id !== payload.owner_user_id) {
      return { ok: false, kind: "failure", error: "Klienti i zgjedhur nuk ju përket juve." }
    }
  }

  // Duplicate safety resolution: if no client_id was provided, check if business_name matches an existing client
  if (!resolvedClientId && payload.business_name) {
    matchedClient = findDuplicateClient(clients, payload.business_name)
    if (matchedClient) {
      resolvedClientId = matchedClient.id
    }
  }

  // -------------------------------------------------------------------------
  // BRANCH 1: EDITING AN EXISTING VISIT (Historical edit)
  // Per Requirement: An edit of an existing visit must NOT mutate current client lifecycle
  // -------------------------------------------------------------------------
  if (editingId) {
    const targetBusinessName = matchedClient?.business_name ?? payload.business_name
    const visitPayload: Partial<Visit> = {
      ...payload,
      client_id: resolvedClientId,
      business_name: targetBusinessName,
      updated_at: nowISO(),
    }

    const { data, error } = await adapter.updateVisit(editingId, visitPayload)
    if (error || !data) {
      const msg = error?.message || "Ruajtja e vizitës dështoi"
      return { ok: false, kind: "failure", error: msg }
    }

    // Deliberately do NOT update client status on historical edits
    return { ok: true, kind: "success", data }
  }

  // -------------------------------------------------------------------------
  // BRANCH 2: NEW BUSINESS VISIT (No existing client)
  // -------------------------------------------------------------------------
  if (!resolvedClientId) {
    const rawName = (payload.business_name ?? "").trim()
    if (!rawName) {
      return { ok: false, kind: "failure", error: "Emri i biznesit është i detyrueshëm" }
    }

    const initialStatus = calculateNextClientStatus("prospect", payload.statusi)
    const newClientPayload = {
      business_name: rawName,
      status: initialStatus,
      source: "field_visit",
      maps_url: payload.location_url || null,
      ...(payload.owner_user_id ? { owner_user_id: payload.owner_user_id } : {}),
    }

    // Step 2.1: Create client
    const { data: createdClient, error: clientErr } = await adapter.createClient(newClientPayload)
    if (clientErr || !createdClient) {
      const msg = clientErr?.message || "Krijimi i klientit dështoi"
      return { ok: false, kind: "failure", error: msg }
    }

    // Step 2.2: Insert visit linked to new client
    const newVisitPayload = {
      ...payload,
      client_id: createdClient.id,
      business_name: createdClient.business_name,
    }

    const { data: createdVisit, error: visitErr } = await adapter.createVisit(newVisitPayload)
    if (visitErr || !createdVisit) {
      // Visit creation failed -> Attempt compensating deletion of created client
      const { error: rollbackErr } = await adapter.deleteClient(createdClient.id)

      if (rollbackErr) {
        // Rollback failed! Client exists in database, but visit does not
        return {
          ok: false,
          kind: "partial",
          error: `Shtimi i vizitës dështoi (${visitErr?.message || "gabim"}), dhe anulimi i klientit dështoi (${rollbackErr.message}).`,
          message: "Klienti u regjistrua në sistem, por vizita nuk mund të ruhej. Klienti mbetet në listë për të shmangur duplikimet.",
          client: createdClient,
        }
      }

      // Rollback succeeded: client was deleted, nothing persisted
      return {
        ok: false,
        kind: "failure",
        error: `Shtimi i vizitës dështoi (${visitErr?.message || "gabim"}). Regjistrimi i klientit u anulua me sukses.`,
      }
    }

    // Both client and visit created successfully
    return {
      ok: true,
      kind: "success",
      data: createdVisit,
      client: createdClient,
    }
  }

  // -------------------------------------------------------------------------
  // BRANCH 3: NEW VISIT FOR EXISTING CLIENT
  // -------------------------------------------------------------------------
  const targetBusinessName = matchedClient?.business_name ?? payload.business_name
  const visitPayload = {
    ...payload,
    client_id: resolvedClientId,
    business_name: targetBusinessName,
  }

  // Step 3.1: Insert visit
  const { data: createdVisit, error: visitErr } = await adapter.createVisit(visitPayload)
  if (visitErr || !createdVisit) {
    const msg = visitErr?.message || "Shtimi i vizitës dështoi"
    return { ok: false, kind: "failure", error: msg }
  }

  // Step 3.2: Check if client status progression applies
  if (matchedClient) {
    const currentStatus = matchedClient.status
    const nextStatus = calculateNextClientStatus(currentStatus, payload.statusi)

    if (nextStatus !== currentStatus) {
      const { error: clientUpdateErr } = await adapter.updateClientStatus(
        resolvedClientId,
        nextStatus,
        nowISO()
      )

      if (clientUpdateErr) {
        // Attempt compensating deletion of newly inserted visit
        const { error: visitRollbackErr } = await adapter.deleteVisit(createdVisit.id)

        if (visitRollbackErr) {
          // Rollback failed! Visit remains in database, but client status was not updated
          return {
            ok: false,
            kind: "partial",
            error: `Përditësimi i statusit të klientit dështoi (${clientUpdateErr.message}), dhe anulimi i vizitës dështoi (${visitRollbackErr.message}).`,
            message: "Vizita u ruajt në sistem, por statusi i klientit nuk mund të përditësohej. Mos e ri-dërgoni vizitën për të shmangur duplikimet.",
            visit: createdVisit,
          }
        }

        // Rollback succeeded: visit was deleted, nothing persisted
        return {
          ok: false,
          kind: "failure",
          error: `Përditësimi i statusit të klientit dështoi: ${clientUpdateErr.message}. Vizita u anulua për të shmangur të dhëna të paplota.`,
        }
      }

      // Both visit insert and client status update succeeded
      return {
        ok: true,
        kind: "success",
        data: createdVisit,
        clientStatusUpdated: true,
        newStatus: nextStatus,
      }
    }
  }

  // Visit created, no client status change was required
  return {
    ok: true,
    kind: "success",
    data: createdVisit,
  }
}

// -----------------------------------------------------------------------------
// Modal Submission State Evaluator
// -----------------------------------------------------------------------------

export type ModalSubmissionState = {
  isVisitPersisted: boolean
  canRetrySave: boolean
  error: string
  action: "close_modal" | "show_warning_and_lock" | "show_error_allow_retry"
}

/**
 * Pure evaluation helper for modal state based on upsertVisit result:
 * 1. success -> close modal.
 * 2. partial with persisted visit -> lock modal (disallow Save, display warning, allow close only).
 * 3. partial with client only -> show message but keep Save enabled for legitimate retry against client.
 * 4. normal failure -> show error, allow retry.
 */
export function evaluateModalSaveResult(
  result: UpsertVisitResult
): ModalSubmissionState {
  if (result.kind === "success") {
    return {
      isVisitPersisted: false,
      canRetrySave: false,
      error: "",
      action: "close_modal",
    }
  }

  if (result.kind === "partial" && result.visit) {
    return {
      isVisitPersisted: true,
      canRetrySave: false,
      error: result.message,
      action: "show_warning_and_lock",
    }
  }

  if (result.kind === "partial" && result.client && !result.visit) {
    return {
      isVisitPersisted: false,
      canRetrySave: true,
      error: result.message,
      action: "show_error_allow_retry",
    }
  }

  return {
    isVisitPersisted: false,
    canRetrySave: true,
    error: result.error || "Ruajtja e vizitës dështoi. Provo sërish.",
    action: "show_error_allow_retry",
  }
}
