/**
 * Lane cap: a 429 carrying a long `Retry-After` is the shared free lane's
 * daily allowance, not one exit's quota. It arrives identically from every
 * IP, so cooling exits one by one just burns probes against a closed lane.
 */
let capUntil = 0

/** Record a cap. Only a long window counts; short 429s stay exit-level. */
export function noteLaneCap(retryAfterSeconds: number, now = Date.now()): number {
  if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds >= 300) {
    capUntil = Math.max(capUntil, now + retryAfterSeconds * 1000)
  }
  return capUntil
}

/** Set an absolute deadline (the adapter only has the error body, not headers). */
export function markLaneCapUntil(timestamp: number): number {
  if (Number.isFinite(timestamp)) capUntil = Math.max(capUntil, timestamp)
  return capUntil
}

/** A chat that answers proves the lane is open: drop a stale deadline. */
export function clearLaneCap(): void {
  capUntil = 0
}

/** Next 00:00 UTC, the reset the free lane's daily allowance has used so far. */
export function nextUtcMidnight(now = Date.now()): number {
  const date = new Date(now)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1)
}

const FREE_LANE_MESSAGE = /\bfree ?usage ?limit\b|\bfreeusagelimiterror\b/i

/** True when the message is the shared lane's daily allowance, not one exit. */
export function isFreeLaneExhausted(message: string): boolean {
  return FREE_LANE_MESSAGE.test(message)
}

/**
 * Record a cap from an adapter error. The adapter sees the error body but not
 * the response headers, so the daily reset is the best deadline available;
 * a pool probe that does see `Retry-After` overwrites it with the real one.
 */
export function noteLaneCapFromMessage(message: string, now = Date.now()): number {
  if (!isFreeLaneExhausted(message)) return capUntil
  return markLaneCapUntil(nextUtcMidnight(now))
}

export function laneCapUntil(): number {
  return capUntil
}

export function laneCapRemainingMs(now = Date.now()): number {
  return Math.max(0, capUntil - now)
}

/** Human-readable reset, e.g. `2026-10-30 08:00` in the host's timezone. */
export function laneCapResetLabel(now = Date.now()): string {
  const at = capUntil === 0 ? nextUtcMidnight(now) : capUntil
  const date = new Date(at)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}
