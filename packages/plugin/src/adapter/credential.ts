/**
 * Upstream credential for the Zen free lane.
 *
 * `Bearer public` is the shared anonymous credential. It is metered globally:
 * once its daily allowance is spent it answers every request with
 * `429 FreeUsageLimitError` plus a multi-hour `Retry-After`, from every exit
 * IP. Supplying a key moves the request onto that user's own quota.
 */
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const ANONYMOUS_KEY = 'public'

export interface CredentialSource {
  upstreamApiKey?: string
  upstreamApiKeyEnv?: string
}

/** Reuse a local OpenCode login when the user has one (`opencode auth login`). */
function opencodeLoginKey(): string {
  const file = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
  try {
    if (!existsSync(file)) return ''
    const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
    for (const entry of Object.values(data)) {
      if (entry === null || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      for (const field of ['access', 'key', 'token']) {
        const value = record[field]
        if (typeof value === 'string' && value.trim() !== '') return value.trim()
      }
    }
  } catch {
    // an unreadable auth store just means "no login to reuse"
  }
  return ''
}

/** Resolve the upstream key: explicit config, then env var, then anonymous. */
export function resolveUpstreamKey(source: CredentialSource | undefined): string {
  if (source === undefined) return opencodeLoginKey() || ANONYMOUS_KEY
  const direct = (source.upstreamApiKey ?? '').trim()
  if (direct !== '') return direct
  const name = (source.upstreamApiKeyEnv ?? '').trim()
  if (name === '') return opencodeLoginKey() || ANONYMOUS_KEY
  const fromEnv = (process.env[name] ?? '').trim()
  if (fromEnv !== '') return fromEnv
  const login = opencodeLoginKey()
  return login === '' ? ANONYMOUS_KEY : login
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
