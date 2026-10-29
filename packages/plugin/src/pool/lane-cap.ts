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

export function laneCapUntil(): number {
  return capUntil
}

export function laneCapRemainingMs(now = Date.now()): number {
  return Math.max(0, capUntil - now)
}
