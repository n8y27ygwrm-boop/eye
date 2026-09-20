export type ProviderErrorCategory =
  | 'unconfigured'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'server_error'
  | 'structured_output'
  | 'auth_error'
  | 'bad_request'
  | 'unknown'

export class ProviderError extends Error {
  readonly category: ProviderErrorCategory
  readonly provider: string
  readonly status?: number

  constructor(options: {
    message: string
    category: ProviderErrorCategory
    provider: string
    status?: number
    cause?: unknown
  }) {
    super(options.message, { cause: options.cause })
    this.name = 'ProviderError'
    this.category = options.category
    this.provider = options.provider
    this.status = options.status
  }
}

export const FALLBACK_ALLOWED_CATEGORIES: ReadonlySet<ProviderErrorCategory> = new Set([
  'unconfigured',
  'rate_limit',
  'timeout',
  'network',
  'server_error',
  'structured_output',
  'auth_error',
])

export function isFallbackAllowed(category: ProviderErrorCategory): boolean {
  return FALLBACK_ALLOWED_CATEGORIES.has(category)
}

export function classifyError(err: unknown, provider: string): ProviderError {
  if (err instanceof ProviderError) return err

  const message = err instanceof Error ? err.message : String(err)
  const errName = err instanceof Error ? err.name : ''
  const status = (err as any)?.status

  if (message.includes('not configured') || message.includes('Missing API key')) {
    return new ProviderError({ message, category: 'unconfigured', provider, status, cause: err })
  }
  if (status === 429 || message.includes('429') || message.toLowerCase().includes('rate limit')) {
    return new ProviderError({ message, category: 'rate_limit', provider, status: 429, cause: err })
  }
  if (status === 401 || status === 403 || message.includes('401') || message.includes('403') || message.toLowerCase().includes('unauthorized')) {
    return new ProviderError({ message, category: 'auth_error', provider, status, cause: err })
  }
  if (status === 400 || message.includes('400') || message.toLowerCase().includes('bad request')) {
    return new ProviderError({ message, category: 'bad_request', provider, status: 400, cause: err })
  }
  if ((status && status >= 500 && status <= 599) || message.includes('500') || message.includes('502') || message.includes('503') || message.includes('504')) {
    return new ProviderError({ message, category: 'server_error', provider, status, cause: err })
  }
  if (errName === 'AbortError' || message.toLowerCase().includes('timeout') || message.toLowerCase().includes('aborted')) {
    return new ProviderError({ message, category: 'timeout', provider, status, cause: err })
  }
  if (message.includes('fetch failed') || message.includes('ECONNREFUSED') || message.includes('ENOTFOUND') || message.includes('ECONNRESET')) {
    return new ProviderError({ message, category: 'network', provider, status, cause: err })
  }
  if (message.includes('Zod') || message.includes('JSON') || message.includes('structured output') || message.includes('schema')) {
    return new ProviderError({ message, category: 'structured_output', provider, status, cause: err })
  }

  return new ProviderError({ message, category: 'unknown', provider, status, cause: err })
}
