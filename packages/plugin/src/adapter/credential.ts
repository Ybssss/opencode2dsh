/**
 * Upstream credential for the Zen free lane.
 *
 * `Bearer public` is the shared anonymous credential. It is metered globally:
 * once its daily allowance is spent it answers every request with
 * `429 FreeUsageLimitError` plus a multi-hour `Retry-After`, from every exit
 * IP. Supplying a key moves the request onto that user's own quota.
 */
export const ANONYMOUS_KEY = 'public'

export interface CredentialSource {
  upstreamApiKey?: string
  upstreamApiKeyEnv?: string
}

/** Resolve the upstream key: explicit config, then env var, then anonymous. */
export function resolveUpstreamKey(source: CredentialSource | undefined): string {
  if (source === undefined) return ANONYMOUS_KEY
  const direct = (source.upstreamApiKey ?? '').trim()
  if (direct !== '') return direct
  const name = (source.upstreamApiKeyEnv ?? '').trim()
  if (name === '') return ANONYMOUS_KEY
  const fromEnv = (process.env[name] ?? '').trim()
  return fromEnv === '' ? ANONYMOUS_KEY : fromEnv
}

export function authorizationFor(key: string): string {
  return `Bearer ${key}`
}

/** Process-wide value, set once when the plugin applies its config. */
let configuredKey = ''

export function setUpstreamKey(key: string): void {
  configuredKey = key
}

/** The key catalog probes and pool admission should use. */
export function currentUpstreamKey(): string {
  return configuredKey === '' ? ANONYMOUS_KEY : configuredKey
}
