import { isValidCoordinates, type AttachedVisitLocation } from '../lifecycle'
import type { CurrentLocation } from './types'
import { isAccuracyPoor, isLocationFresh, resolveVisitLocationUrl } from './utils'

export const LOCATION_REFRESH_ERROR = "Vendndodhja nuk u rifreskua. Provo përsëri ose çaktivizo 'Attach location' për ta ruajtur vizitën pa vendndodhje."
export const LOCATION_ACCURACY_ERROR = "Saktësia e vendndodhjes është e ulët. Zgjidh 'Attach anyway' ose çaktivizo 'Attach location'."

type LocationSaveResult<T> =
  | { kind: 'location_error'; message: string }
  | { kind: 'saved'; value: T }

/** The persistence callback is unreachable while an explicitly requested GPS attachment is unusable. */
export async function saveVisitWithLocation<T>(params: {
  attachLocation: boolean
  attachAnyway: boolean
  currentLocation: CurrentLocation | null
  manualLocationUrl: string | null
  refreshLocation: () => Promise<CurrentLocation | null>
  persist: (locationUrl: string | null, attachedLocation: AttachedVisitLocation | null) => Promise<T>
}): Promise<LocationSaveResult<T>> {
  const { attachLocation, attachAnyway, manualLocationUrl, refreshLocation, persist } = params
  if (!attachLocation) {
    return { kind: 'saved', value: await persist(manualLocationUrl, null) }
  }

  let location = params.currentLocation
  if (!location || !isLocationFresh(location.timestamp) || !isValidCoordinates(location.latitude, location.longitude)) {
    try {
      location = await refreshLocation()
    } catch {
      return { kind: 'location_error', message: LOCATION_REFRESH_ERROR }
    }
  }
  if (!location || !isLocationFresh(location.timestamp) || !isValidCoordinates(location.latitude, location.longitude)) {
    return { kind: 'location_error', message: LOCATION_REFRESH_ERROR }
  }
  if (isAccuracyPoor(location.accuracy) && !attachAnyway) {
    return { kind: 'location_error', message: LOCATION_ACCURACY_ERROR }
  }

  const locationUrl = resolveVisitLocationUrl({ attachLocation, attachAnyway, currentLocation: location, manualLocationUrl })
  return {
    kind: 'saved',
    value: await persist(locationUrl, { location, acknowledgedPoorAccuracy: attachAnyway }),
  }
}
