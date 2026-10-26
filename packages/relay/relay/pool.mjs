// Exit pool for the opencode.ai free tier.
//
// The fingerprint gate (body + TLS stack) is satisfied by the relay itself and
// does not care which IP a request leaves from — measured: a CONNECT tunnel
// preserves the ClientHello byte for byte. What IS per-IP is the third gate: the
// daily free allowance. So the only thing a pool can buy is more allowances.
//
// That shapes the design:
//
//   * an exit is valuable only while its quota window is open;
//   * a 429 with `retry-after` retires an exit until that instant, and the
//     request rotates to the next one;
//   * a 403/401 retires the (exit × model) pairing, not the exit;
//   * a transport failure retires the exit briefly, with exponential backoff.
//
// Bun's fetch speaks only http:// and https:// proxies (`UnsupportedProxyProtocol`
// for socks5), and most airport subscriptions are SOCKS5. So a SOCKS5 exit gets a
// private loopback CONNECT bridge that performs the SOCKS5 handshake and splices
// bytes; Bun then talks to the bridge. Verified end to end: Bun's ClientHello
// arrives through the bridge unchanged.

import net from 'node:net'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'

const PROBE_TIMEOUT_MS = 12_000

// ------------------------------------------------------------------- exits

/**
 * One egress. `protocol` decides the transport:
 *   http/https -> handed to Bun's fetch `proxy` option as-is
 *   socks5     -> a loopback CONNECT bridge is started on first use
 */
class Exit {
  constructor({ id, protocol, host, port, username, password, source }) {
    this.id = id
    this.protocol = protocol
    this.host = host
    this.port = port
    this.username = username
    this.password = password
    this.source = source
    /** 'unknown' | 'ok' | 'cooling' | 'dead' */
    this.state = 'unknown'
    /** Epoch ms until which this exit must not be used (quota or backoff). */
    this.until = 0
    /** Why it is parked: 'quota' | 'transport' | 'refused' | ''. */
    this.reason = ''
    /** Epoch ms of the last probe. */
    this.probedAt = 0
    this.latencyMs = 0
    /** Observed exit IP, when the probe could see it. */
    this.exitIp = ''
    /** `${model}` -> epoch ms until which that model is refused on this exit. */
    this.modelBans = new Map()
    this.uses = 0
    this.quotaHits = 0
    this.bridgePort = 0
    /** Live SOCKS5 bridge, when the protocol needs one. */
    this.bridge = null
  }

  get label() {
    return `${this.protocol}://${this.host}:${this.port}`
  }

  /** Is this exit usable right now (ignoring model bans)? */
  usable(now = Date.now()) {
    return this.state !== 'dead' && this.until <= now
  }

  /** Is this exit usable for `model` right now? */
  usableFor(model, now = Date.now()) {
    if (!this.usable(now)) return false
    const ban = this.modelBans.get(model)
    return ban === undefined || ban <= now
  }

  toJSON(now = Date.now()) {
    return {
      id: this.id,
      label: this.label,
      source: this.source,
      state: this.state,
      usable: this.usable(now),
      reason: this.reason,
      parkedForMs: Math.max(0, this.until - now),
      exitIp: this.exitIp,
      latencyMs: this.latencyMs,
      uses: this.uses,
      quotaHits: this.quotaHits,
      modelBans: [...this.modelBans].filter(([, at]) => at > now).map(([model]) => model),
    }
  }
}

// ------------------------------------------------------------------ parsing

const SUPPORTED_SCHEMES = new Set(['http', 'https', 'socks5', 'socks5h'])

/** Any `scheme://` prefix, so an unsupported one can be rejected by name. */
const ANY_SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//iu

/**
 * A plausible host: IPv4, bracketed IPv6, or a DNS name.
 *
 * This is what keeps a base64 blob (`NC40LjQuNDo4MDgw…=`) from being mistaken
 * for a hostname — base64 contains `=` and `+`, which no host may.
 */
const HOST_RE = /^(?:\[[0-9a-f:.]+\]|(?:\d{1,3}\.){3}\d{1,3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/iu

/**
 * `scheme://user:pass@host:port` -> an Exit, or null.
 *
 * A proxy address ALWAYS needs an explicit port: there is no such thing as a
 * default proxy port, and inferring one turns junk (a base64 line, a scheme we
 * do not dial) into a plausible-looking exit that fails at request time.
 */
function parseProxyUrl(text, source) {
  const trimmed = String(text ?? '').trim()
  if (trimmed === '' || trimmed.startsWith('#')) return null

  const scheme = ANY_SCHEME_RE.exec(trimmed)
  if (scheme !== null) {
    const name = scheme[1].toLowerCase()
    if (!SUPPORTED_SCHEMES.has(name)) return null
  }
  const withScheme = scheme !== null ? trimmed : `http://${trimmed}`

  let url
  try {
    url = new URL(withScheme)
  } catch {
    return null
  }
  const protocol = url.protocol.replace(':', '').toLowerCase()
  if (!SUPPORTED_SCHEMES.has(protocol)) return null
  if (!HOST_RE.test(url.hostname)) return null

  // `new URL()` blanks a DEFAULT port (`https://h:443` -> port ''), so the port
  // is read back from the raw authority instead of trusting `url.port`.
  const port = explicitPort(withScheme)
  if (port === null) return null

  return new Exit({
    id: `${protocol}://${url.hostname}:${port}`,
    protocol: protocol === 'socks5h' ? 'socks5' : protocol,
    host: url.hostname.replace(/^\[|\]$/gu, ''),
    port,
    username: decodeURIComponent(url.username) || undefined,
    password: decodeURIComponent(url.password) || undefined,
    source,
  })
}

/**
 * The `:N` an address literally carries, or null.
 *
 * The authority is the chunk before any path, minus userinfo, so
 * `user:pass@h:443` reads 443 rather than the password's digits.
 */
function explicitPort(text) {
  const authority = text.replace(/^[a-z][a-z0-9+.-]*:\/\//iu, '').split(/[/?#]/u)[0]
  const hostPort = authority.slice(authority.lastIndexOf('@') + 1)
  const match = /:(\d{1,5})$/u.exec(hostPort)
  if (match === null) return null
  const port = Number(match[1])
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null
}

/** Plain lines, optionally base64-wrapped (the common subscription shape). */
function parsePlainList(text, source) {
  // A base64-wrapped list decodes to something that parses; a plain list does
  // not decode to anything useful. So try the literal first and only decode when
  // that yields nothing — rather than guessing from the character set, which
  // mis-reads a long `host:port` line as base64.
  const literal = parseAddressLines(text, source)
  if (literal.length > 0) return literal
  const compact = text.replace(/\s+/gu, '')
  if (!/^[A-Za-z0-9+/=]{16,}$/u.test(compact)) return literal
  try {
    return parseAddressLines(Buffer.from(compact, 'base64').toString('utf8'), source)
  } catch {
    return literal
  }
}

/** One address per line; unparseable lines are skipped. */
function parseAddressLines(text, source) {
  const exits = []
  for (const line of text.split(/\r?\n/u)) {
    const exit = parseProxyUrl(line, source)
    if (exit !== null) exits.push(exit)
  }
  return exits
}

/**
 * Clash YAML, by targeted line scanning.
 *
 * Only the four fields a dialable exit needs are read (`type`, `server`, `port`,
 * and optional credentials); everything else in the node — ciphers, uuid, plugin
 * options — belongs to protocols this pool cannot dial anyway (vmess, vless,
 * trojan, ss …), and those nodes are skipped rather than half-parsed.
 */
function parseClashYaml(text, source) {
  const exits = []
  let current = null
  const flush = () => {
    if (current === null) return
    const { type, server, port, username, password } = current
    current = null
    const protocol = String(type ?? '').toLowerCase()
    if (!['http', 'https', 'socks5'].includes(protocol)) return
    if (server === undefined || port === undefined) return
    const numeric = Number(port)
    if (!Number.isInteger(numeric) || numeric <= 0 || numeric > 65535) return
    exits.push(new Exit({
      id: `${protocol}://${server}:${numeric}`,
      protocol,
      host: String(server),
      port: numeric,
      username,
      password,
      source,
    }))
  }
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/\t/gu, '  ')
    const startsNode = /^\s*-\s+/u.test(line) && /(?:name|type|server)\s*:/u.test(line)
    if (startsNode) {
      flush()
      current = {}
      // Flow style: the whole node sits on one line, `- {name: a, type: http, …}`.
      const flow = /\{(.*)\}/u.exec(line)
      if (flow !== null) {
        for (const pair of flow[1].split(',')) {
          const match = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/u.exec(pair)
          if (match === null) continue
          const key = match[1]
          if (!['type', 'server', 'port', 'username', 'password'].includes(key)) continue
          current[key] = match[2].replace(/^["']|["']$/gu, '')
        }
        flush()
        continue
      }
    }
    if (current === null) continue
    const match = /^\s*-?\s*([A-Za-z_][\w-]*)\s*:\s*(.+?)\s*$/u.exec(line)
    if (match === null) continue
    const key = match[1]
    const value = match[2].replace(/^["']|["']$/gu, '')
    if (['type', 'server', 'port', 'username', 'password'].includes(key)) current[key] = value
  }
  flush()
  return exits
}

/** Pick the right parser for a fetched subscription body. */
function parseSubscription(text, source) {
  if (/^\s*proxies\s*:/mu.test(text) || /^\s*-\s*\{?\s*name\s*:/mu.test(text)) {
    const clash = parseClashYaml(text, source)
    if (clash.length > 0) return clash
  }
  return parsePlainList(text, source)
}

// ------------------------------------------------------------- socks5 bridge

/**
 * A private loopback CONNECT listener for one SOCKS5 exit.
 *
 * Bun's fetch cannot speak SOCKS5, so the relay points at this bridge instead:
 * the bridge answers `CONNECT host:port` by performing the SOCKS5 handshake
 * upstream and then splicing raw bytes. No TLS is terminated here, so the
 * ClientHello Bun sends passes through untouched (verified).
 */
async function startSocksBridge(exit, log) {
  const server = net.createServer(client => {
    client.once('data', chunk => {
      const [method, target] = chunk.toString('latin1').split('\r\n')[0].split(' ')
      if (method !== 'CONNECT') {
        client.write('HTTP/1.1 405 Method Not Allowed\r\n\r\n')
        client.destroy()
        return
      }
      const separator = target.lastIndexOf(':')
      if (separator <= 0) {
        client.write('HTTP/1.1 400 Bad Request\r\n\r\n')
        client.destroy()
        return
      }
      const host = target.slice(0, separator)
      const port = Number(target.slice(separator + 1))
      socksConnect(exit, host, port)
        .then(upstream => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          upstream.pipe(client)
          client.pipe(upstream)
          upstream.on('error', () => client.destroy())
          client.on('error', () => upstream.destroy())
        })
        .catch(error => {
          log?.(`socks bridge ${exit.label}: ${error.message}`)
          if (client.writable) client.write('HTTP/1.1 502 Bad Gateway\r\n\r\n')
          client.destroy()
        })
    })
    client.on('error', () => {})
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  return { server, port: server.address().port }
}

/** SOCKS5 CONNECT handshake (no auth, or username/password). */
function socksConnect(exit, host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: exit.host, port: exit.port })
    let stage = 'greeting'
    let pending = Buffer.alloc(0)
    const fail = error => {
      socket.destroy()
      reject(error)
    }
    socket.setTimeout(15_000, () => fail(new Error('socks5: timeout')))
    socket.on('error', fail)
    socket.on('connect', () => {
      const methods = exit.username === undefined ? [0x00] : [0x00, 0x02]
      socket.write(Buffer.from([0x05, methods.length, ...methods]))
    })
    socket.on('data', chunk => {
      pending = Buffer.concat([pending, chunk])
      if (stage === 'greeting') {
        if (pending.length < 2) return
        const method = pending[1]
        pending = pending.subarray(2)
        if (method === 0x02) {
          if (exit.username === undefined) return fail(new Error('socks5: auth required'))
          const user = Buffer.from(exit.username, 'utf8')
          const pass = Buffer.from(exit.password ?? '', 'utf8')
          socket.write(Buffer.concat([
            Buffer.from([0x01, user.length]),
            user,
            Buffer.from([pass.length]),
            pass,
          ]))
          stage = 'auth'
          return
        }
        if (method !== 0x00) return fail(new Error('socks5: no acceptable auth method'))
        stage = 'send'
        pending = pending
        sendRequest()
        return
      }
      if (stage === 'auth') {
        if (pending.length < 2) return
        if (pending[1] !== 0x00) return fail(new Error('socks5: auth rejected'))
        pending = pending.subarray(2)
        stage = 'send'
        sendRequest()
        return
      }
      if (stage === 'reply') {
        if (pending.length < 5) return
        if (pending[1] !== 0x00) return fail(new Error(`socks5: connect failed (code ${pending[1]})`))
        const atyp = pending[3]
        const need = atyp === 0x01 ? 10 : atyp === 0x03 ? 5 + pending[4] + 2 : 22
        if (pending.length < need) return
        socket.removeAllListeners('data')
        socket.removeAllListeners('error')
        socket.setTimeout(0)
        resolve(socket)
      }
    })
    function sendRequest() {
      stage = 'reply'
      const name = Buffer.from(host, 'latin1')
      const looksLikeIp = /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)
      const address = looksLikeIp
        ? Buffer.concat([Buffer.from([0x01]), Buffer.from(host.split('.').map(Number))])
        : Buffer.concat([Buffer.from([0x03, name.length]), name])
      socket.write(Buffer.concat([
        Buffer.from([0x05, 0x01, 0x00]),
        address,
        Buffer.from([(port >> 8) & 0xff, port & 0xff]),
      ]))
    }
  })
}

// --------------------------------------------------------------------- pool

export class ExitPool {
  #exits = new Map()
  #log
  #probeUrl
  #rotation
  #sticky = new Map()

  constructor({ log = () => {}, probeUrl = 'https://api.ipify.org?format=json' } = {}) {
    this.#log = log
    this.#probeUrl = probeUrl
  }

  get size() {
    return this.#exits.size
  }

  /** Add exits from already-parsed input, skipping duplicates. */
  add(exits) {
    let added = 0
    for (const exit of exits) {
      if (this.#exits.has(exit.id)) continue
      this.#exits.set(exit.id, exit)
      added += 1
    }
    return added
  }

  /** Load `manual` entries and pull every subscription URL. */
  async load({ manual = [], subscriptions = [] } = {}) {
    const added = this.add(manual.flatMap(entry => parsePlainList(entry, 'manual')))
    for (const url of subscriptions) {
      try {
        const response = await fetch(url, {
          headers: { 'user-agent': 'clash-verge/v2.0' },
          signal: AbortSignal.timeout(20_000),
        })
        if (!response.ok) {
          this.#log(`subscription ${url}: HTTP ${response.status}`)
          continue
        }
        const body = await response.text()
        const exits = parseSubscription(body, url)
        const count = this.add(exits)
        this.#log(`subscription ${url}: ${exits.length} dialable exits, ${count} new`)
      } catch (error) {
        this.#log(`subscription ${url}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return added
  }

  /** Every exit, in insertion order. */
  list() {
    return [...this.#exits.values()]
  }

  get(id) {
    return this.#exits.get(id) ?? null
  }

  /**
   * The proxy URL Bun's fetch should use for this exit.
   *
   * http/https pass through; socks5 gets a loopback bridge started on demand,
   * because Bun's fetch rejects the scheme outright.
   */
  async proxyUrlFor(exit) {
    if (exit.protocol !== 'socks5') {
      const auth = exit.username === undefined
        ? ''
        : `${encodeURIComponent(exit.username)}:${encodeURIComponent(exit.password ?? '')}@`
      return `${exit.protocol}://${auth}${exit.host}:${exit.port}`
    }
    if (exit.bridge === null) {
      exit.bridge = await startSocksBridge(exit, this.#log)
      exit.bridgePort = exit.bridge.port
      this.#log(`socks bridge for ${exit.label} on 127.0.0.1:${exit.bridgePort}`)
    }
    return `http://127.0.0.1:${exit.bridgePort}`
  }

  /**
   * Choose an exit for this request.
   *
   * Preference: the session's current exit while it is usable (prompt-cache
   * affinity), then the least-used usable exit (spreads the daily allowances
   * evenly), then null when none is available.
   */
  pick({ session = '', model = '' } = {}) {
    const now = Date.now()
    const pinned = this.#sticky.get(session)
    if (pinned !== undefined) {
      const exit = this.#exits.get(pinned)
      if (exit !== undefined && exit.usableFor(model, now)) return exit
      this.#sticky.delete(session)
    }
    let best = null
    for (const exit of this.#exits.values()) {
      if (!exit.usableFor(model, now)) continue
      if (best === null || exit.uses < best.uses) best = exit
    }
    if (best !== null && session !== '') this.#sticky.set(session, best.id)
    return best
  }

  /**
   * Record an outcome against an exit.
   *
   * `verdict` is what the upstream said, already classified:
   *   ok        — served
   *   quota     — 429 with a reset: park until then
   *   refused   — 401/403: ban the model on this exit
   *   transport — the exit itself failed: exponential backoff
   */
  report(exit, verdict, { model = '', retryAfterMs = 0, detail = '' } = {}) {
    const now = Date.now()
    exit.uses += 1
    if (verdict === 'ok') {
      exit.state = 'ok'
      exit.until = 0
      exit.reason = ''
      return
    }
    if (verdict === 'quota') {
      // The daily allowance is per IP; the reset is the honest park duration.
      exit.quotaHits += 1
      exit.state = 'cooling'
      exit.reason = 'quota'
      exit.until = now + Math.max(retryAfterMs, 60_000)
      this.#log(`exit ${exit.label}: quota spent, parked ${Math.round(Math.max(retryAfterMs, 60_000) / 60000)}min${detail === '' ? '' : ` (${detail})`}`)
      return
    }
    if (verdict === 'refused') {
      // A 401/403 is a statement about this exit serving this MODEL (region
      // policy, a model-level ban). The exit itself is fine, so only the pairing
      // is banned — parking the whole exit would needlessly cost its other models.
      if (model !== '') exit.modelBans.set(model, now + 30 * 60_000)
      exit.reason = 'refused'
      if (model === '') {
        // No model to scope the ban to: the only safe move is to rest the exit.
        exit.state = 'cooling'
        exit.until = now + 60_000
      }
      this.#log(`exit ${exit.label}: refused${model === '' ? ' (whole exit)' : ` for ${model}`}`)
      return
    }
    // transport
    const strikes = (exit.strikes ?? 0) + 1
    exit.strikes = strikes
    exit.reason = 'transport'
    exit.until = now + Math.min(60_000 * 2 ** (strikes - 1), 30 * 60_000)
    exit.state = strikes >= 3 ? 'dead' : 'cooling'
    this.#log(`exit ${exit.label}: transport failure ${strikes}${detail === '' ? '' : ` (${detail})`}`)
  }

  /** Probe every exit that is not currently parked, in parallel. */
  async probeAll({ concurrency = 4 } = {}) {
    const queue = this.list()
    const results = []
    const worker = async () => {
      for (;;) {
        const exit = queue.shift()
        if (exit === undefined) return
        results.push(await this.probe(exit))
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker))
    return results
  }

  /** One health check: fetch the probe URL through the exit. */
  async probe(exit) {
    const started = Date.now()
    try {
      const proxy = await this.proxyUrlFor(exit)
      const response = await fetch(this.#probeUrl, {
        proxy,
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const body = await response.text()
      exit.probedAt = Date.now()
      exit.latencyMs = exit.probedAt - started
      if (!response.ok) {
        exit.state = 'cooling'
        exit.reason = `probe HTTP ${response.status}`
        exit.until = Date.now() + 5 * 60_000
        return { id: exit.id, ok: false, reason: exit.reason }
      }
      try {
        const parsed = JSON.parse(body)
        if (typeof parsed?.ip === 'string') exit.exitIp = parsed.ip
      } catch {
        // The probe URL answers JSON; a non-JSON body still proves the tunnel.
      }
      exit.state = 'ok'
      exit.reason = ''
      exit.until = 0
      exit.strikes = 0
      return { id: exit.id, ok: true, exitIp: exit.exitIp, latencyMs: exit.latencyMs }
    } catch (error) {
      exit.probedAt = Date.now()
      exit.state = 'cooling'
      exit.reason = 'probe transport'
      exit.until = Date.now() + 5 * 60_000
      return { id: exit.id, ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  /** Snapshot for the status endpoint. */
  status() {
    const now = Date.now()
    const exits = this.list().map(exit => exit.toJSON(now))
    return {
      total: exits.length,
      usable: exits.filter(exit => exit.usable).length,
      quotaSpent: exits.filter(exit => exit.reason === 'quota' && !exit.usable).length,
      exits,
    }
  }

  /** Release every bridge. */
  close() {
    for (const exit of this.#exits.values()) {
      exit.bridge?.server.close()
      exit.bridge = null
    }
  }
}

// ------------------------------------------------------------------- config

/** Read `oc-pool.json` next to this module, if present. */
export async function loadPoolConfig(directory) {
  const path = `${directory}/oc-pool.json`
  if (!existsSync(path)) return { manual: [], subscriptions: [], probeUrl: undefined }
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    return {
      manual: Array.isArray(parsed.manual) ? parsed.manual : [],
      subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
      probeUrl: typeof parsed.probeUrl === 'string' ? parsed.probeUrl : undefined,
    }
  } catch (error) {
    throw new Error(`oc-pool.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Build a pool from config, loading exits and probing them. */
export async function createPool({ directory, log = () => {} }) {
  const config = await loadPoolConfig(directory)
  const pool = new ExitPool({ log, probeUrl: config.probeUrl })
  await pool.load(config)
  if (pool.size > 0) {
    log(`pool: ${pool.size} exits loaded; probing`)
    await pool.probeAll()
    const status = pool.status()
    log(`pool: ${status.usable}/${status.total} usable`)
  } else {
    log('pool: no exits configured (oc-pool.json); every request goes direct')
  }
  return pool
}

// Exported for tests and for the CLI.
export { parseProxyUrl, parsePlainList, parseClashYaml, parseSubscription }
