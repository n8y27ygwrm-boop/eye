import type { CurrentLocation, LocationStatus } from './types'

export const LOCATION_STORAGE_KEY = 'eye_location_enabled'
export const LOCATION_DISMISSED_KEY = 'eye_location_dismissed'

/** Freshness boundary: 2 minutes in milliseconds */
export const FRESHNESS_THRESHOLD_MS = 120_000

/** Accuracy warning boundary: 250 meters */
export const POOR_ACCURACY_THRESHOLD_M = 250

/** Default geolocation options for watchPosition */
export const DEFAULT_GEOLOCATION_OPTIONS: PositionOptions = {
  enableHighAccuracy: true,
  maximumAge: 30000,
  timeout: 15000,
}

/**
 * Generates canonical Google Maps URL from latitude and longitude.
 * Format: https://www.google.com/maps?q=<lat>,<lng>
 */
export function generateGoogleMapsUrl(lat: number, lng: number): string {
  return `https://www.google.com/maps?q=${lat},${lng}`
}

/**
 * Checks whether a given location timestamp is fresh (<= 2 minutes old).
 */
export function isLocationFresh(
  timestamp: number,
  maxAgeMs = FRESHNESS_THRESHOLD_MS,
  now = Date.now()
): boolean {
  if (!timestamp || typeof timestamp !== 'number') return false
  return now - timestamp <= maxAgeMs
}

/**
 * Determines if accuracy is poor (> 250 meters).
 */
export function isAccuracyPoor(
  accuracy: number | null | undefined,
  thresholdMeters = POOR_ACCURACY_THRESHOLD_M
): boolean {
  if (accuracy == null || isNaN(accuracy)) return true
  return accuracy > thresholdMeters
}

/**
 * Formats numeric accuracy in meters (e.g. "±12 m").
 */
export function formatAccuracy(accuracy: number | null | undefined): string {
  if (accuracy == null || isNaN(accuracy)) return '±-- m'
  return `±${Math.round(accuracy)} m`
}

/**
 * Maps Geolocation API error codes to application LocationStatus and user-friendly copy.
 */
export function mapGeolocationError(
  err: { code?: number; message?: string } | null | undefined
): { status: LocationStatus; message: string } {
  if (!err) {
    return {
      status: 'error',
      message: 'Location services are not available on this device.',
    }
  }

  switch (err.code) {
    case 1: // GeolocationPositionError.PERMISSION_DENIED
      return {
        status: 'denied',
        message: 'Location access is off.',
      }
    case 2: // GeolocationPositionError.POSITION_UNAVAILABLE
      return {
        status: 'unavailable',
        message: 'Current location is unavailable.',
      }
    case 3: // GeolocationPositionError.TIMEOUT
      return {
        status: 'error',
        message: 'Location request timed out.',
      }
    default:
      return {
        status: 'error',
        message: err.message || 'Location services are not available on this device.',
      }
  }
}

/**
 * Gets the persistent client preference for location.
 * Returns true if enabled, false if disabled, null if not yet set.
 */
export function getStoredLocationPreference(): boolean | null {
  if (typeof window === 'undefined') return null
  try {
    const val = localStorage.getItem(LOCATION_STORAGE_KEY)
    if (val === 'true') return true
    if (val === 'false') return false
    return null
  } catch {
    return null
  }
}

/**
 * Sets the persistent client preference for location.
 */
export function setStoredLocationPreference(enabled: boolean): void {
  if (typeof window === 'undefined') return
  try {
    localStorage.setItem(LOCATION_STORAGE_KEY, enabled ? 'true' : 'false')
  } catch {
    // Ignore storage quota or security errors in strict private browsing
  }
}

/**
 * Checks if the user clicked "Not now" in the current session.
 */
export function isSessionDismissed(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return sessionStorage.getItem(LOCATION_DISMISSED_KEY) === 'true'
  } catch {
    return false
  }
}

/**
 * Records that the user clicked "Not now" so we don't nag during the same session.
 */
export function setSessionDismissed(): void {
  if (typeof window === 'undefined') return
  try {
    sessionStorage.setItem(LOCATION_DISMISSED_KEY, 'true')
  } catch {
    // Ignore storage quota or security errors
  }
}

/**
 * Converts browser GeolocationPosition into CurrentLocation structure.
 */
export function toCurrentLocation(pos: GeolocationPosition): CurrentLocation {
  return {
    latitude: pos.coords.latitude,
    longitude: pos.coords.longitude,
    accuracy: pos.coords.accuracy,
    timestamp: pos.timestamp || Date.now(),
  }
}

/**
 * Resolves the final location URL snapshot to be persisted for a Visit.
 * Enforces:
 * 1. If attachLocation is false or currentLocation is null -> returns manualLocationUrl || null
 * 2. If accuracy is poor (> 250m) and user did NOT explicitly choose attachAnyway -> returns manualLocationUrl || null
 * 3. Otherwise returns canonical Google Maps URL snapshot.
 */
export function resolveVisitLocationUrl(params: {
  attachLocation: boolean
  attachAnyway: boolean
  currentLocation: CurrentLocation | null
  manualLocationUrl?: string | null
}): string | null {
  const { attachLocation, attachAnyway, currentLocation, manualLocationUrl } = params
  if (!attachLocation || !currentLocation) {
    return manualLocationUrl || null
  }

  // Enforce poor accuracy policy: poor accuracy + !attachAnyway -> do not attach GPS
  if (isAccuracyPoor(currentLocation.accuracy) && !attachAnyway) {
    return manualLocationUrl || null
  }

  return generateGoogleMapsUrl(currentLocation.latitude, currentLocation.longitude)
}
