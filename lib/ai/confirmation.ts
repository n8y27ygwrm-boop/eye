
export type ConfirmationDecision = 'confirm' | 'cancel' | 'none'

function canonicalize(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]+/g, ' ')
    .replace(/\s+/g, ' ')
}

const CONFIRM = new Set([
  'po', 'po beje', 'po bëje', 'beje', 'bëje', 'konfirmo', 'konfirmoj',
  'dakord', 'ok', 'yes', 'confirm', 'proceed',
])

const CANCEL = new Set([
  'jo', 'anulo', 'anuloje', 'mos e bej', 'mos e bëj', 'cancel', 'no',
])

export function classifyConfirmationMessage(value: string): ConfirmationDecision {
  const normalized = canonicalize(value)
  if (CONFIRM.has(normalized)) return 'confirm'
  if (CANCEL.has(normalized)) return 'cancel'
  return 'none'
}
