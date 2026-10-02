/** One build-time timezone setting shared by future action scheduling consumers. */
export const DEFAULT_SCHEDULING_TIME_ZONE = 'Europe/Tirane'

export function resolveSchedulingTimeZone(configured?: string): string {
  const candidate = configured?.trim() || DEFAULT_SCHEDULING_TIME_ZONE
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: candidate })
  } catch {
    throw new Error(`Invalid EYE scheduling time zone: ${candidate}`)
  }
  return candidate
}

export const SCHEDULING_TIME_ZONE = resolveSchedulingTimeZone(
  process.env.NEXT_PUBLIC_EYE_SCHEDULING_TIME_ZONE
)
