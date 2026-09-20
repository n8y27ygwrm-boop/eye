import crypto from 'node:crypto'

/**
 * Deterministic UUID v5-style RFC 4122 generator derived server-side from visit_id.
 * Ensures the same visit_id always produces the exact same primary key ID.
 */
export function deterministicReminderId(visitId: string): string {
  const hash = crypto.createHash('sha256').update(`eye-reminder:${visitId}`).digest('hex')
  return [
    hash.substring(0, 8),
    hash.substring(8, 12),
    '5' + hash.substring(13, 16), // version 5
    ((parseInt(hash.substring(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hash.substring(18, 20), // RFC 4122 variant
    hash.substring(20, 32),
  ].join('-').toLowerCase()
}
