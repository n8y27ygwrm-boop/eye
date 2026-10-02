import { ActionError } from './errors'

/** Retired V1 owner impersonation boundary: no credential is consumed or created. */
export async function verifiedJobClient(_owner: string): Promise<never> {
  throw new ActionError('configuration', 'Canonical background owner sessions are disabled; explicit user interaction required', 503)
}
