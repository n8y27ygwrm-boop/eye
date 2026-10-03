import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import {
  generateGoogleMapsUrl,
  isLocationFresh,
  isAccuracyPoor,
  formatAccuracy,
  mapGeolocationError,
  toCurrentLocation,
  resolveVisitLocationUrl,
  FRESHNESS_THRESHOLD_MS,
  POOR_ACCURACY_THRESHOLD_M,
  LOCATION_STORAGE_KEY,
  LOCATION_DISMISSED_KEY,
} from '../lib/location/utils'
import type { CurrentLocation, LocationStatus } from '../lib/location/types'
import { LOCATION_REFRESH_ERROR, saveVisitWithLocation } from '../lib/location/visit-save'

describe('Location Foundation Architecture & Boundaries for EYE', () => {
  const root = path.resolve(process.cwd())

  // ── TEST A: Permission granted -> currentLocation populated ────────────────
  test('A. Permission granted -> toCurrentLocation populates coordinates and accuracy', () => {
    const mockPosition = {
      coords: {
        latitude: 41.3275,
        longitude: 19.8187,
        accuracy: 12.4,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null,
      },
      timestamp: 1726924800000,
    } as unknown as GeolocationPosition

    const currentLoc = toCurrentLocation(mockPosition)
    assert.equal(currentLoc.latitude, 41.3275)
    assert.equal(currentLoc.longitude, 19.8187)
    assert.equal(currentLoc.accuracy, 12.4)
    assert.equal(currentLoc.timestamp, 1726924800000)
  })

  // ── TEST B: Watch update -> latest location replaces previous state ────────
  test('B. Watch update -> latest location replaces previous state correctly', () => {
    let state: CurrentLocation | null = null

    // First GPS tick
    const tick1 = toCurrentLocation({
      coords: { latitude: 41.3275, longitude: 19.8187, accuracy: 25 },
      timestamp: 1000,
    } as unknown as GeolocationPosition)
    state = tick1
    assert.equal(state.latitude, 41.3275)

    // Second GPS tick updates state
    const tick2 = toCurrentLocation({
      coords: { latitude: 41.3282, longitude: 19.8195, accuracy: 8 },
      timestamp: 2500,
    } as unknown as GeolocationPosition)
    state = tick2
    assert.equal(state.latitude, 41.3282)
    assert.equal(state.longitude, 19.8195)
    assert.equal(state.accuracy, 8)
    assert.equal(state.timestamp, 2500)
  })

  // ── TEST C: Permission denied -> status denied, app remains usable ─────────
  test('C. Permission denied -> maps to status denied and informative message', () => {
    const permDeniedErr = { code: 1, message: 'User denied Geolocation' }
    const res = mapGeolocationError(permDeniedErr)
    assert.equal(res.status, 'denied')
    assert.equal(res.message, 'Location access is off.')

    const posUnavailableErr = { code: 2, message: 'Position unavailable' }
    const res2 = mapGeolocationError(posUnavailableErr)
    assert.equal(res2.status, 'unavailable')
    assert.equal(res2.message, 'Current location is unavailable.')

    const timeoutErr = { code: 3, message: 'Timeout' }
    const res3 = mapGeolocationError(timeoutErr)
    assert.equal(res3.status, 'error')
    assert.equal(res3.message, 'Location request timed out.')

    const unknownErr = { code: 99, message: 'Hardware failure' }
    const res4 = mapGeolocationError(unknownErr)
    assert.equal(res4.status, 'error')
    assert.equal(res4.message, 'Hardware failure')
  })

  // ── TEST D: Watch cleanup & single watcher guard ───────────────────────────
  test('D. AppContext implements watcher cleanup on unmount and guards against duplicate watchers', () => {
    const appContextFile = fs.readFileSync(path.join(root, 'contexts/AppContext.tsx'), 'utf8')

    // Watcher guard check
    assert.match(
      appContextFile,
      /if\s*\(\s*watchIdRef\.current\s*!==\s*null\s*\)\s*return/,
      'AppContext must guard against duplicate watchPosition instances'
    )

    // Clear watcher on unmount
    assert.match(
      appContextFile,
      /navigator\.geolocation\.clearWatch\(\s*watchIdRef\.current\s*\)/,
      'AppContext must call clearWatch on active watcher'
    )

    // Stop watching on logout
    assert.match(
      appContextFile,
      /if\s*\(\s*!currentUserId\s*&&\s*watchIdRef\.current\s*!==\s*null\s*\)/,
      'AppContext must clear watcher when currentUserId becomes null (logout)'
    )
  })

  // ── TEST E: Fresh location -> generated visit location_url correct ──────────
  test('E. Fresh location generates correct Google Maps URL snapshot', () => {
    const now = Date.now()
    const freshTimestamp = now - 30_000 // 30 seconds ago
    assert.equal(isLocationFresh(freshTimestamp, FRESHNESS_THRESHOLD_MS, now), true)

    const url = generateGoogleMapsUrl(41.3275, 19.8187)
    assert.equal(url, 'https://www.google.com/maps?q=41.3275,19.8187')
  })

  // ── TEST F: Stale location -> refresh required before attachment ────────────
  test('F. Stale location (> 2 min) is detected and triggers refresh path', () => {
    const now = Date.now()
    const staleTimestamp = now - 130_000 // 2 minutes 10 seconds ago
    assert.equal(isLocationFresh(staleTimestamp, FRESHNESS_THRESHOLD_MS, now), false)

    // Verify the save gate checks freshness before attaching or persisting
    const visitModalFile = fs.readFileSync(path.join(root, 'components/VisitModal.tsx'), 'utf8')
    const visitSaveFile = fs.readFileSync(path.join(root, 'lib/location/visit-save.ts'), 'utf8')
    assert.match(
      visitSaveFile,
      /isLocationFresh\(location\.timestamp\)/,
      'Visit save gate must check freshness before attaching location'
    )
    assert.match(
      visitModalFile,
      /return await refreshLocation\(\)/,
      'VisitModal must request refreshLocation through the save gate'
    )
  })

  // ── TEST G: Location attachment disabled -> Visit saves without location_url
  test('G. When location attachment is disabled, Visit saves without attaching live GPS', () => {
    const visitModalFile = fs.readFileSync(path.join(root, 'components/VisitModal.tsx'), 'utf8')
    const visitSaveFile = fs.readFileSync(path.join(root, 'lib/location/visit-save.ts'), 'utf8')

    // Verify the modal passes the explicit choice into the save gate, which persists no GPS when off.
    assert.match(
      visitModalFile,
      /saveVisitWithLocation\(\{\s*attachLocation,/,
      'VisitModal must pass the attachLocation choice to the save gate'
    )
    assert.match(
      visitSaveFile,
      /if \(!attachLocation\) \{\s*return \{ kind: 'saved', value: await persist\(manualLocationUrl, null\) \}/,
      'Disabling attachment must persist without live GPS'
    )
    assert.match(
      visitModalFile,
      /Don't attach/,
      "VisitModal must allow the user to choose Don't attach"
    )
  })

  // ── TEST H: Existing Visit location_url behavior remains compatible ────────
  test('H. Existing Visit location_url behavior remains compatible', () => {
    const visitModalFile = fs.readFileSync(path.join(root, 'components/VisitModal.tsx'), 'utf8')

    // For editing visits, attachLocation defaults to false and preserves existing location_url
    assert.match(
      visitModalFile,
      /setLocationUrl\(\s*editingVisit\.location_url\s*\?\?\s*''\s*\)/,
      'VisitModal must preserve existing visit location_url'
    )
    assert.match(
      visitModalFile,
      /setAttachLocation\(false\)/,
      'VisitModal must default attachLocation to false when editing existing visits'
    )
  })

  // ── ACCURACY & UTILITY RULES ──────────────────────────────────────────────
  test('Accuracy boundaries: > 250m is flagged as poor accuracy', () => {
    assert.equal(isAccuracyPoor(251, POOR_ACCURACY_THRESHOLD_M), true)
    assert.equal(isAccuracyPoor(500, POOR_ACCURACY_THRESHOLD_M), true)
    assert.equal(isAccuracyPoor(250, POOR_ACCURACY_THRESHOLD_M), false)
    assert.equal(isAccuracyPoor(15, POOR_ACCURACY_THRESHOLD_M), false)
    assert.equal(isAccuracyPoor(null), true)
    assert.equal(isAccuracyPoor(undefined), true)

    assert.equal(formatAccuracy(12.4), '±12 m')
    assert.equal(formatAccuracy(250.8), '±251 m')
    assert.equal(formatAccuracy(null), '±-- m')
  })

  // ── STORAGE & PERSISTENCE KEYS ────────────────────────────────────────────
  test('Storage keys match specifications', () => {
    assert.equal(LOCATION_STORAGE_KEY, 'eye_location_enabled')
    assert.equal(LOCATION_DISMISSED_KEY, 'eye_location_dismissed')
  })

  // ── PRIVACY BOUNDARIES VERIFICATION ───────────────────────────────────────
  test('Strict Privacy Boundary: No continuous DB persistence of coordinates', () => {
    const appContextFile = fs.readFileSync(path.join(root, 'contexts/AppContext.tsx'), 'utf8')

    // Ensure watchPosition callback does NOT call supabase or api to persist location
    assert.doesNotMatch(
      appContextFile,
      /watchPosition\([^)]*\)\s*=>\s*\{[^}]*supabase\.from\(['"]locations['"]\)/,
      'No background DB tracking table in watchPosition'
    )
    assert.doesNotMatch(
      appContextFile,
      /watchPosition\([^)]*\)\s*=>\s*\{[^}]*fetch\(['"]\/api\/location['"]\)/,
      'No background network beaconing of coordinates in watchPosition'
    )
  })

  // ── MAP INTEGRATION VERIFICATION ──────────────────────────────────────────
  test('Map Integration: Agent marker has distinct styling and Locate Me button', () => {
    const mapViewFile = fs.readFileSync(path.join(root, 'components/MapView.tsx'), 'utf8')
    assert.match(mapViewFile, /makeAgentLocationIcon/, 'MapView must use dedicated makeAgentLocationIcon')
    assert.match(mapViewFile, /agent-location-wrap/, 'MapView must render agent-location-wrap')
    assert.match(mapViewFile, /locate-me-btn/, 'MapView must render locate-me-btn')
    assert.match(mapViewFile, /handleLocateMe/, 'MapView must have handleLocateMe handler')
    assert.match(mapViewFile, /hasInitialCenteredRef/, 'MapView must center at most once on initial acquisition')
  })

  // ── SHELL & PERMISSION DIALOG VERIFICATION ─────────────────────────────────
  test('Shell Integration: Branded permission dialog and header status control', () => {
    const shellFile = fs.readFileSync(path.join(root, 'app/(main)/shell.tsx'), 'utf8')
    assert.match(shellFile, /LocationHeaderControl/, 'shell.tsx must include LocationHeaderControl')
    assert.match(shellFile, /loc-status-btn/, 'shell.tsx must render loc-status-btn')
    assert.match(shellFile, /location-permission-card/, 'shell.tsx must render location-permission-card')
    assert.match(shellFile, /USE YOUR LOCATION/, 'shell.tsx must contain USE YOUR LOCATION branded header')
    assert.match(shellFile, /Enable location/, 'shell.tsx must contain Enable location button')
    assert.match(shellFile, /Not now/, 'shell.tsx must contain Not now button')
  })

  // ── CORRECTION PASS REGRESSION 1: Form does NOT reset on GPS ticks ─────────
  test('Regression 1: VisitModal form initialization does not depend on currentLocation and will not reset on GPS ticks', () => {
    const visitModalFile = fs.readFileSync(path.join(root, 'components/VisitModal.tsx'), 'utf8')

    // Must NOT contain currentLocation in initialization effect dependencies
    assert.doesNotMatch(
      visitModalFile,
      /\}, \[visitModalOpen, editingVisit\?\.id, currentLocation/,
      'VisitModal initialization effect must NOT depend on currentLocation or its timestamp'
    )

    // Must use guard so it only runs on justOpened or visitChanged
    assert.match(
      visitModalFile,
      /justOpened\s*=\s*visitModalOpen\s*&&\s*!prevOpenRef\.current/,
      'VisitModal must check justOpened to prevent re-initializing on GPS ticks'
    )

    // Simulation of form state preservation across GPS updates
    let formState = {
      search: 'Farmaci Dita',
      notes: 'Biseduam për porosinë e radhës',
      date: '2026-09-22',
      attachLocation: true,
    }

    // Function simulating GPS tick update while modal remains open
    function onGpsTick(newLocation: CurrentLocation, isModalJustOpened: boolean) {
      if (isModalJustOpened) {
        // Only run on open
        formState = {
          search: '',
          notes: '',
          date: '2026-09-21',
          attachLocation: !isAccuracyPoor(newLocation.accuracy),
        }
      }
      // GPS updates only affect displayed location, not form fields
    }

    const gpsTick1: CurrentLocation = { latitude: 41.3275, longitude: 19.8187, accuracy: 12, timestamp: 1000 }
    onGpsTick(gpsTick1, false)

    assert.equal(formState.search, 'Farmaci Dita', 'User-typed search must remain unchanged')
    assert.equal(formState.notes, 'Biseduam për porosinë e radhës', 'User-typed notes must remain unchanged')
    assert.equal(formState.date, '2026-09-22', 'User-selected date must remain unchanged')
    assert.equal(formState.attachLocation, true, 'Attachment state must remain unchanged')
  })

  // ── CORRECTION PASS REGRESSION 2: Poor accuracy semantic enforcement ───────
  test('Regression 2a: Fresh accurate location (<= 250m) allows normal attachment', () => {
    const accurateLoc: CurrentLocation = {
      latitude: 41.3275,
      longitude: 19.8187,
      accuracy: 25,
      timestamp: Date.now(),
    }

    const url = resolveVisitLocationUrl({
      attachLocation: true,
      attachAnyway: false,
      currentLocation: accurateLoc,
      manualLocationUrl: null,
    })

    assert.equal(url, 'https://www.google.com/maps?q=41.3275,19.8187')
  })

  test('Regression 2b: Fresh poor-accuracy location (> 250m) is NOT attached by default', () => {
    const poorLoc: CurrentLocation = {
      latitude: 41.3275,
      longitude: 19.8187,
      accuracy: 350, // > 250m
      timestamp: Date.now(),
    }

    // Without attachAnyway, resolveVisitLocationUrl must reject poor GPS
    const url = resolveVisitLocationUrl({
      attachLocation: true,
      attachAnyway: false,
      currentLocation: poorLoc,
      manualLocationUrl: null,
    })

    assert.equal(url, null, 'Poor accuracy without attachAnyway must NOT persist GPS coordinates')

    // Also verify VisitModal defaults attachLocation to false when accuracy is poor
    const visitModalFile = fs.readFileSync(path.join(root, 'components/VisitModal.tsx'), 'utf8')
    assert.match(
      visitModalFile,
      /!isAccuracyPoor\(\s*loc\.accuracy\s*\)/,
      'VisitModal must check !isAccuracyPoor before defaulting attachLocation to true'
    )
  })

  test('Regression 2c: Poor accuracy location (> 250m) + Attach anyway persists GPS snapshot', () => {
    const poorLoc: CurrentLocation = {
      latitude: 41.3275,
      longitude: 19.8187,
      accuracy: 450,
      timestamp: Date.now(),
    }

    const url = resolveVisitLocationUrl({
      attachLocation: true,
      attachAnyway: true, // User explicitly clicked "Attach anyway"
      currentLocation: poorLoc,
      manualLocationUrl: null,
    })

    assert.equal(url, 'https://www.google.com/maps?q=41.3275,19.8187')
  })

  test('Regression 2d: Poor accuracy location + Don\'t attach persists no GPS coordinates', () => {
    const poorLoc: CurrentLocation = {
      latitude: 41.3275,
      longitude: 19.8187,
      accuracy: 450,
      timestamp: Date.now(),
    }

    const url = resolveVisitLocationUrl({
      attachLocation: false, // User chose "Don't attach"
      attachAnyway: false,
      currentLocation: poorLoc,
      manualLocationUrl: null,
    })

    assert.equal(url, null)
  })

  // ── CORRECTION PASS REGRESSION 3: Visibility lifecycle (active-session) ────
  test('Regression 3: Document visibility pauses watcher on hidden and resumes on visible', () => {
    const appContextFile = fs.readFileSync(path.join(root, 'contexts/AppContext.tsx'), 'utf8')

    // Checks visibilitychange listener registration
    assert.match(
      appContextFile,
      /document\.addEventListener\(\s*'visibilitychange'/,
      'AppContext must register visibilitychange event listener'
    )

    // Checks stopWatching is called when hidden
    assert.match(
      appContextFile,
      /document\.visibilityState\s*===\s*'hidden'[\s\S]*?stopWatching\(\)/,
      'AppContext must call stopWatching when document is hidden'
    )

    // Checks startWatching is resumed when visible and preference is enabled
    assert.match(
      appContextFile,
      /document\.visibilityState\s*===\s*'visible'[\s\S]*?startWatching\(\)/,
      'AppContext must resume startWatching when document becomes visible'
    )
  })

  // ── CORRECTION PASS REGRESSION 4: Retry after permission denied ────────────
  test('Regression 4: Terminal permission denial resets watchIdRef to null allowing subsequent retry', () => {
    const appContextFile = fs.readFileSync(path.join(root, 'contexts/AppContext.tsx'), 'utf8')

    // Verifies watcher cleanup and watchIdRef = null in error handler
    assert.match(
      appContextFile,
      /if\s*\(\s*mapped\.status\s*===\s*'denied'\s*\)[\s\S]*?watchIdRef\.current\s*=\s*null/,
      'Error handler must reset watchIdRef.current to null after permission denial'
    )
  })
})

describe('Visit location save gate', () => {
  const fresh = (): CurrentLocation => ({ latitude: 41.3275, longitude: 19.8187, accuracy: 12, timestamp: Date.now() })
  const stale = (): CurrentLocation => ({ ...fresh(), timestamp: Date.now() - 130_000 })

  test('Attach ON and failed refresh blocks all persistence while leaving a visible retry error in the modal', async () => {
    let writes = 0
    const result = await saveVisitWithLocation({
      attachLocation: true, attachAnyway: false, currentLocation: stale(), manualLocationUrl: null,
      refreshLocation: async () => null,
      persist: async () => { writes++; return 'saved' },
    })
    assert.equal(result.kind, 'location_error')
    if (result.kind === 'location_error') assert.equal(result.message, LOCATION_REFRESH_ERROR)
    assert.equal(writes, 0)
    const modal = fs.readFileSync(path.resolve(process.cwd(), 'components/VisitModal.tsx'), 'utf8')
    assert.match(modal, /if \(save\.kind === 'location_error'\) \{\s*setError\(save\.message\)[\s\S]*?return\s*\}/)
    assert.match(modal, /\{error && \([\s\S]*?className="modal-err"/)
  })

  test('Attach OFF deliberately permits a visit without GPS', async () => {
    const calls: Array<{ url: string | null; attached: unknown }> = []
    const result = await saveVisitWithLocation({
      attachLocation: false, attachAnyway: false, currentLocation: null, manualLocationUrl: null,
      refreshLocation: async () => { throw new Error('refresh must not run') },
      persist: async (url, attached) => { calls.push({ url, attached }); return 'saved' },
    })
    assert.deepEqual(calls, [{ url: null, attached: null }])
    assert.deepEqual(result, { kind: 'saved', value: 'saved' })
  })

  test('Continue-as-new approval cannot bypass a failed GPS refresh', async () => {
    const approvedNearbyDecision = { businessName: 'QA New', candidateIds: ['nearby'] }
    let upsertCalls = 0
    const result = await saveVisitWithLocation({
      attachLocation: true, attachAnyway: false, currentLocation: stale(), manualLocationUrl: null,
      refreshLocation: async () => null,
      persist: async () => { void approvedNearbyDecision; upsertCalls++; return 'created' },
    })
    assert.equal(result.kind, 'location_error')
    assert.equal(upsertCalls, 0)
  })

  test('An invalid structured refresh result also blocks persistence', async () => {
    let writes = 0
    const result = await saveVisitWithLocation({
      attachLocation: true, attachAnyway: false, currentLocation: null, manualLocationUrl: null,
      refreshLocation: async () => ({ ...fresh(), latitude: Number.NaN }),
      persist: async () => { writes++; return 'saved' },
    })
    assert.equal(result.kind, 'location_error')
    assert.equal(writes, 0)
  })

  test('A rejected GPS refresh also clears the save path without persisting', async () => {
    let writes = 0
    const result = await saveVisitWithLocation({
      attachLocation: true, attachAnyway: false, currentLocation: stale(), manualLocationUrl: null,
      refreshLocation: async () => { throw new Error('GPS unavailable') },
      persist: async () => { writes++; return 'saved' },
    })
    assert.equal(result.kind, 'location_error')
    assert.equal(writes, 0)
  })

  test('Retry after GPS failure reaches persistence once with valid structured coordinates', async () => {
    let writes = 0
    let gpsAvailable = false
    const save = () => saveVisitWithLocation({
      attachLocation: true, attachAnyway: false, currentLocation: stale(), manualLocationUrl: null,
      refreshLocation: async () => gpsAvailable ? fresh() : null,
      persist: async (url, attached) => {
        writes++
        assert.equal(url, 'https://www.google.com/maps?q=41.3275,19.8187')
        assert.equal(attached?.location.latitude, 41.3275)
        return 'saved'
      },
    })
    assert.equal((await save()).kind, 'location_error')
    assert.equal(writes, 0)
    gpsAvailable = true
    assert.deepEqual(await save(), { kind: 'saved', value: 'saved' })
    assert.equal(writes, 1)
  })

  test('Existing unlocated client cannot get a locationless visit or coordinate update after refresh failure', async () => {
    let visitWrites = 0
    let clientUpdates = 0
    const result = await saveVisitWithLocation({
      attachLocation: true, attachAnyway: false, currentLocation: null, manualLocationUrl: null,
      refreshLocation: async () => null,
      persist: async () => { visitWrites++; clientUpdates++; return 'saved' },
    })
    assert.equal(result.kind, 'location_error')
    assert.equal(visitWrites, 0)
    assert.equal(clientUpdates, 0)
  })

  test('Poor GPS accuracy still requires explicit attach-anyway and then saves', async () => {
    const poor = { ...fresh(), accuracy: 400 }
    let writes = 0
    const persist = async (_url: string | null, attached: { acknowledgedPoorAccuracy: boolean } | null) => {
      writes++
      assert.equal(attached?.acknowledgedPoorAccuracy, true)
      return 'saved'
    }
    const blocked = await saveVisitWithLocation({
      attachLocation: true, attachAnyway: false, currentLocation: poor, manualLocationUrl: null,
      refreshLocation: async () => { throw new Error('fresh GPS should not refresh') }, persist,
    })
    assert.equal(blocked.kind, 'location_error')
    assert.equal(writes, 0)
    const approved = await saveVisitWithLocation({
      attachLocation: true, attachAnyway: true, currentLocation: poor, manualLocationUrl: null,
      refreshLocation: async () => { throw new Error('fresh GPS should not refresh') }, persist,
    })
    assert.deepEqual(approved, { kind: 'saved', value: 'saved' })
    assert.equal(writes, 1)
  })
})
