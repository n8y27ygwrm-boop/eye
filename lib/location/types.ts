export type CurrentLocation = {
  latitude: number
  longitude: number
  accuracy: number
  timestamp: number
}

export type LocationStatus =
  | 'idle'
  | 'requesting'
  | 'active'
  | 'denied'
  | 'unavailable'
  | 'error'

export interface LocationState {
  currentLocation: CurrentLocation | null
  locationStatus: LocationStatus
  locationError: string | null
}
