#!/usr/bin/env bun
/**
 * Harvest free HTTP proxies, keep only the ones that actually reach the Zen API,
 * and write them into an `oc-pool.json`.
 *
 * Three stages, because "alive" says nothing about "usable":
 *
 *   1. TCP handshake, cheap enough to run over thousands of candidates.
 *   2. A real HTTPS request through the tunnel to `/inference/v1/models`. This is
 *      the only test that matters: it proves CONNECT is allowed, TLS terminates
 *      correctly at opencode.ai, and the exit is not refused upstream.
 *   3. Resolve the egress IP the exit actually presents.
 *
 * Stage 3 exists because stage 2 overcounts badly. Public lists repeat one host
 * on several ports — the first run returned `102.244.78.61` on four of them —
 * and those share a single public IP, hence a single daily allowance. The pool's
 * whole purpose is *distinct* IPs, so exits are deduped on egress IP and
 * `--keep` counts distinct addresses, not distinct host:port strings.
 *
 * A proxy does not disturb the fingerprint gate: through a CONNECT tunnel the
 * relay is still the TLS client and sends its own BoringSSL ClientHello. The
 * tunnel is also opaque end to end, so the operator sees ciphertext only — but
 * it does see which host you talk to, and that the traffic exists.
 *
 * Usage:
 *   bun scripts/harvest-proxies.mjs --out <oc-pool.json> [--keep 8] [--max 4000]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'

const SOURCES = [
  'https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt',
  'https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt',
  'https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt',
  'https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt',
  'https://www.proxy-list.download/api/v1/get?type=http',
]

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const i = args.indexOf(`--${name}`)
  return i === -1 ? fallback : args[i + 1]
}

const OUT = flag('out', '')
const KEEP = Number(flag('keep', 8))
const MAX = Number(flag('max', 4000))
const CONNECT_TIMEOUT = Number(flag('connect-timeout', 1500))
const PROBE_TIMEOUT = Number(flag('probe-timeout', 12000))

/**
 * The probe is a real completion, not a catalog listing.
 *
 * `GET /v1/models` answers 200 even when an exit's daily allowance is already
 * spent, so it cannot tell a usable exit from a burnt one — the first harvest
 * passed 8/8 on that check and every one of them turned out to be parked for
 * ~20 h. Only a completion surfaces FreeUsageLimitError, so only a completion
 * can verify an exit.
 *
 * `max_tokens: 8` keeps the cost to the exit's own allowance negligible.
 */
const PROBE_URL = 'https://opencode.ai/inference/v1/chat/completions'
const PROBE_BODY = JSON.stringify({
  model: 'mimo-v2.6-flash-free',
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  max_tokens: 8,
})
const PROBE_HEADERS = {
  authorization: 'Bearer public',
  'user-agent': 'opencode/1.18.35',
  'x-opencode-client': 'cli',
  'content-type': 'application/json',
  accept: 'application/json',
}

/** Asked through each exit to learn which public address it presents. */
const EGRESS_URLS = ['https://api.ipify.org?format=json', 'https://icanhazip.com', 'https://ifconfig.me/ip']

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/u
const log = line => console.log(line)

/**
 * Pull `host:port` out of whatever shape a list uses — bare, `http://`, or the
 * `host:port:country` form proxy-list.download emits. Anything with an explicit
 * non-http scheme is skipped rather than guessed at.
 */
function extract(text) {
  const found = new Set()
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const scheme = line.match(/^([a-z0-9]+):\/\//iu)?.[1]?.toLowerCase()
    if (scheme !== undefined && scheme !== 'http' && scheme !== 'https') continue
    const m = line.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})/u)
    if (m === null) continue
    const port = Number(m[2])
    if (port < 1 || port > 65535) continue
    found.add(`${m[1]}:${port}`)
  }
  return [...found]
}

/** A TCP handshake, which is cheap enough to run over thousands of candidates. */
function tcpAlive(hostPort) {
  const [host, port] = hostPort.split(':')
  return new Promise(resolve => {
    const socket = connect({ host, port: Number(port) })
    let settled = false
    const done = ok => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(ok)
    }
    socket.setTimeout(CONNECT_TIMEOUT, () => done(false))
    socket.once('connect', () => done(true))
    socket.once('error', () => done(false))
  })
}

/** Stage 2: the tunnel must carry a real completion, not merely a listing. */
async function proxyWorks(hostPort) {
  try {
    const res = await fetch(PROBE_URL, {
      method: 'POST',
      headers: PROBE_HEADERS,
      body: PROBE_BODY,
      proxy: `http://${hostPort}`,
      signal: AbortSignal.timeout(PROBE_TIMEOUT),
    })
    if (res.status === 429) {
      // The exit is fine; its shared public address has already been used up.
      return { ok: false, reason: 'quota spent' }
    }
    if (res.status !== 200) return { ok: false, reason: `status ${res.status}` }
    const body = await res.text()
    try {
      const parsed = JSON.parse(body)
      if (!Array.isArray(parsed?.choices)) return { ok: false, reason: 'not a completion' }
    } catch {
      return { ok: false, reason: 'not json' }
    }
    return { ok: true }
  } catch (error) {
    const name = error?.name
    // A proxy that re-signs TLS shows up here, which is exactly what we want.
    if (name === 'TimeoutError') return { ok: false, reason: 'timeout' }
    if (String(error?.message ?? '').includes('UNABLE_TO_VERIFY_LEAF_SIGNATURE')) return { ok: false, reason: 'tls mitm' }
    return { ok: false, reason: error?.code ?? 'error' }
  }
}

/** Stage 3: which public address does this exit actually present? */
async function egressIp(hostPort) {
  for (const url of EGRESS_URLS) {
    try {
      const res = await fetch(url, { proxy: `http://${hostPort}`, signal: AbortSignal.timeout(8000) })
      if (!res.ok) continue
      const text = (await res.text()).trim()
      const ip = text.startsWith('{') ? JSON.parse(text).ip : text
      if (IPV4.test(ip)) return ip
    } catch {
      // try the next echo service
    }
  }
  return null
}

/** Run `fn` over `items` with bounded concurrency, preserving result order. */
async function pool(items, limit, fn) {
  const out = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++
      if (i >= items.length) return
      out[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return out
}

// ---------------------------------------------------------------- harvest ----

const harvested = new Set()
for (const source of SOURCES) {
  try {
    const res = await fetch(source, { signal: AbortSignal.timeout(25_000) })
    if (!res.ok) {
      log(`skip  ${source}  (${res.status})`)
      continue
    }
    const found = extract(await res.text())
    for (const entry of found) harvested.add(entry)
    log(`read  ${String(found.length).padStart(5)}  ${source}`)
  } catch (error) {
    log(`skip  ${source}  (${error?.name ?? error})`)
  }
}

let candidates = [...harvested]
log(`\n${candidates.length} unique candidates`)

// Shuffle before truncating so a truncated run is a sample, not the
// alphabetically first slice of one list.
for (let i = candidates.length - 1; i > 0; i -= 1) {
  const j = Math.floor(Math.random() * (i + 1))
  ;[candidates[i], candidates[j]] = [candidates[j], candidates[i]]
}
if (candidates.length > MAX) {
  candidates = candidates.slice(0, MAX)
  log(`testing the first ${MAX} (raise --max to widen)`)
}

// --------------------------------------------------------------- stage 1 ----

log(`\nstage 1: tcp handshake (${CONNECT_TIMEOUT} ms, 300 at a time)`)
const startedAt = Date.now()
const aliveFlags = await pool(candidates, 300, tcpAlive)
const alive = candidates.filter((_, i) => aliveFlags[i])
log(`  ${alive.length}/${candidates.length} answered a tcp connect  (${((Date.now() - startedAt) / 1000).toFixed(0)}s)`)

// -------------------------------------------------------- stages 2 and 3 ----

// Probe in chunks and stop as soon as `KEEP` *distinct egress addresses* are in
// hand. Both bounds matter: every extra probe is a request against upstream from
// a third-party IP, and every duplicate address buys no additional allowance.
const CHUNK = 60
const byEgress = new Map() // egress ip -> host:port
const reasons = new Map()
let working = 0
let duplicates = 0

log(`\nstage 2+3: real completion through the tunnel, then resolve egress — need ${KEEP} distinct`)
for (let offset = 0; offset < alive.length && byEgress.size < KEEP; offset += CHUNK) {
  const chunk = alive.slice(offset, offset + CHUNK)
  const results = await pool(chunk, 30, proxyWorks)

  const good = []
  results.forEach((result, i) => {
    if (result.ok) good.push(chunk[i])
    else reasons.set(result.reason, (reasons.get(result.reason) ?? 0) + 1)
  })
  working += good.length

  const ips = await pool(good, 15, egressIp)
  good.forEach((hostPort, i) => {
    const ip = ips[i]
    if (ip === null) {
      reasons.set('no egress ip', (reasons.get('no egress ip') ?? 0) + 1)
      return
    }
    if (byEgress.has(ip)) {
      duplicates += 1
      return
    }
    if (byEgress.size < KEEP) byEgress.set(ip, hostPort)
  })

  log(`  probed ${Math.min(offset + CHUNK, alive.length)}/${alive.length} — ${working} working, ${byEgress.size} distinct`)
}

if (reasons.size > 0) {
  const summary = [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([r, n]) => `${r}:${n}`).join('  ')
  log(`  failures — ${summary}`)
}
if (duplicates > 0) {
  log(`  collapsed ${duplicates} working exit(s) that shared an address with one already kept`)
}

// ------------------------------------------------------------------ write ----

if (byEgress.size === 0) {
  log('\nno usable exits found. Nothing written; the pool stays empty and the relay keeps using the direct connection.')
  process.exitCode = 1
} else {
  log(`\n${byEgress.size} distinct exit(s):`)
  for (const [ip, hostPort] of byEgress) log(`  ${ip}  via  http://${hostPort}`)

  if (OUT === '') {
    log('\n(no --out given, nothing written)')
  } else {
    // Merge rather than replace, so a re-harvest does not discard exits that
    // were working before and simply were not sampled this time.
    let existing = { manual: [], subscriptions: [] }
    if (existsSync(OUT)) {
      try {
        const parsed = JSON.parse(readFileSync(OUT, 'utf8'))
        existing = {
          manual: Array.isArray(parsed.manual) ? parsed.manual : [],
          subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
        }
      } catch {
        log('existing pool file was unreadable; rewriting it')
      }
    }
    const added = [...byEgress.values()].map(entry => `http://${entry}`)
    const merged = [...new Set([...existing.manual, ...added])]
    writeFileSync(OUT, `${JSON.stringify({ manual: merged, subscriptions: existing.subscriptions }, null, 2)}\n`)
    log(`\nwrote ${merged.length} manual exit(s) -> ${OUT}`)
    log('the relay reads this once at startup, so restart it (or DSH) to apply.')
  }
}
