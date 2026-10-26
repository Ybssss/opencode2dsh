/**
 * opencode2dsh-relay — DSH host half.
 *
 * Supervises the Bun relay for the whole life of the DSH process, so nothing has
 * to be started by hand. Why a relay at all is documented in the package README:
 * the free tier now gates on the TLS handshake, and DSH runs on Node (OpenSSL),
 * which is refused; the relay runs on Bun (BoringSSL) and reshapes the body.
 *
 * Lifecycle, deliberately boring:
 *
 *   1. `apply` starts the relay (idempotently) and reports the outcome once.
 *   2. `ctx.effect` registers the disposer, so a plugin reload or a DSH shutdown
 *      stops it — no orphan process, no port left bound.
 *   3. If the relay dies while DSH runs, a bounded restart loop brings it back;
 *      a port conflict or a missing Bun is reported, not retried forever.
 *
 * The relay is spawned as a child process rather than imported: it needs Bun,
 * DSH runs on Node, and an in-process Bun server is not available to a Node
 * host. `bun relay.mjs` is exactly the standalone entry point, so there is one
 * code path either way.
 *
 * Config (all optional, in `cordis.patch.yml`):
 *
 *   - id: opencode2dsh-relay
 *     name: opencode2dsh-relay
 *     config:
 *       port: 8899            # relay port; the plugin base URL must match
 *       bunPath: ''           # explicit bun.exe; else auto-detected
 *       autoStart: true       # false = manage nothing, just report
 *       restartDelayMs: 2000  # first restart delay; doubles per failure
 */
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

/** Cordis plugin name — must match the `id` in cordis.patch.yml. */
export const name = 'opencode2dsh-relay'

const HERE = dirname(fileURLToPath(import.meta.url))
/** The relay entry point shipped in this package. */
const RELAY_ENTRY = resolve(HERE, '..', 'relay', 'relay.mjs')
/** Where `oc-pool.json` lives for a supervised run. */
const DEFAULT_CONFIG_DIR = resolve(HERE, '..', 'relay')

const DEFAULTS = {
  port: 8899,
  bunPath: '',
  autoStart: true,
  restartDelayMs: 2000,
  maxRestartDelayMs: 30_000,
}

/**
 * Locate a real `bun.exe`.
 *
 * `spawn` cannot execute the npm shims (`bun.cmd` / `bun.ps1`), and a bare `bun`
 * only resolves through PATH, which DSH's child environment may not carry. So the
 * known install locations are probed first, then PATH.
 */
export function findBun(explicit = '') {
  if (explicit !== '') return existsSync(explicit) ? explicit : null
  const candidates = [
    join(process.env.APPDATA ?? '', 'npm', 'node_modules', 'bun', 'bin', 'bun.exe'),
    join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Links', 'bun.exe'),
    join(homedir(), '.bun', 'bin', 'bun.exe'),
    join(homedir(), '.bun', 'bin', 'bun'),
    '/usr/local/bin/bun',
    '/opt/homebrew/bin/bun',
  ]
  for (const candidate of candidates) {
    if (candidate !== '' && existsSync(candidate)) return candidate
  }
  return findOnPath('bun')
}

/** Synchronous PATH lookup — `where` on Windows, `which` elsewhere. */
function findOnPath(command) {
  try {
    const result = spawnSync(process.platform === 'win32' ? 'where' : 'which', [command], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 5000,
    })
    if (result.status !== 0) return null
    const first = String(result.stdout ?? '').trim().split(/\r?\n/u)[0]
    return first === '' ? null : first
  } catch {
    return null
  }
}

/**
 * Is `port` free on loopback?
 *
 * Plain `node:net`, not `Bun.serve` — this module runs inside DSH, which is a
 * Node process, so a Bun API would be a ReferenceError at the worst moment.
 */
function portFree(port) {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => server.close(() => resolve(true)))
    server.listen(port, '127.0.0.1')
  })
}

/** Is something already answering as our relay on `port`? */
async function relayAnswers(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return false
    const body = await res.json()
    return body?.ok === true
  } catch {
    return false
  }
}

/** The supervisor. One per plugin instance. */
export class RelaySupervisor {
  #config
  #log
  #child = null
  #stopped = false
  #restartTimer = null
  #failures = 0
  #state = 'idle'

  constructor({ config = {}, log = () => {} } = {}) {
    this.#config = { ...DEFAULTS, ...config }
    this.#log = log
  }

  get state() {
    return this.#state
  }

  get port() {
    return this.#config.port
  }

  /** Start the relay unless it is already running. Returns the final state. */
  async start() {
    if (!this.#config.autoStart) {
      this.#state = 'disabled'
      return this.#state
    }
    if (this.#state === 'running' || this.#state === 'starting') return this.#state

    this.#state = 'starting'

    // Something already on the port: adopt it if it is our relay, refuse if not.
    if (!(await portFree(this.#config.port))) {
      if (await relayAnswers(this.#config.port)) {
        this.#state = 'running'
        this.#log(`relay: already running on 127.0.0.1:${this.#config.port} (adopted)`)
        return this.#state
      }
      this.#state = 'port-busy'
      this.#log(`relay: port ${this.#config.port} is taken by something that is not the relay; not starting`)
      return this.#state
    }

    const bun = findBun(this.#config.bunPath)
    if (bun === null) {
      this.#state = 'no-bun'
      this.#log('relay: bun not found — install Bun (https://bun.sh) or set config.bunPath')
      return this.#state
    }
    if (!existsSync(RELAY_ENTRY)) {
      this.#state = 'no-entry'
      this.#log(`relay: entry point missing at ${RELAY_ENTRY}`)
      return this.#state
    }

    this.#child = spawn(bun, [RELAY_ENTRY], {
      cwd: DEFAULT_CONFIG_DIR,
      env: {
        ...process.env,
        OC_RELAY_PORT: String(this.#config.port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    this.#child.stdout?.on('data', chunk => {
      for (const line of chunk.toString().split(/\r?\n/u)) {
        if (line.trim() !== '') this.#log(line.trim())
      }
    })
    this.#child.stderr?.on('data', chunk => {
      for (const line of chunk.toString().split(/\r?\n/u)) {
        if (line.trim() !== '') this.#log(`relay(stderr): ${line.trim()}`)
      }
    })
    this.#child.on('exit', (code, signal) => {
      const wasRunning = this.#state === 'running'
      this.#child = null
      if (this.#stopped) return
      // A crash while DSH runs: retry with backoff, bounded by the delay cap.
      this.#failures += 1
      const delay = Math.min(
        this.#config.restartDelayMs * 2 ** (this.#failures - 1),
        this.#config.maxRestartDelayMs,
      )
      this.#state = 'restarting'
      this.#log(
        `relay: exited (${signal ?? code})${wasRunning ? '' : ' during startup'}; retrying in ${Math.round(delay / 1000)}s`,
      )
      this.#restartTimer = setTimeout(() => {
        this.#restartTimer = null
        this.#state = 'idle'
        this.start().catch(error => this.#log(`relay: restart failed — ${error.message}`))
      }, delay)
      // Do not keep the DSH process alive for a restart timer.
      this.#restartTimer.unref?.()
    })

    // Wait for health, but do not block plugin load forever.
    const deadline = Date.now() + 15_000
    while (Date.now() < deadline) {
      if (await relayAnswers(this.#config.port)) {
        this.#state = 'running'
        this.#failures = 0
        this.#log(`relay: listening on 127.0.0.1:${this.#config.port}`)
        return this.#state
      }
      if (this.#child === null) return this.#state
      await new Promise(done => setTimeout(done, 250))
    }
    this.#state = 'timeout'
    this.#log(`relay: did not answer on 127.0.0.1:${this.#config.port} within 15s`)
    return this.#state
  }

  /** Stop the relay and cancel any pending restart. Idempotent. */
  stop() {
    this.#stopped = true
    if (this.#restartTimer !== null) {
      clearTimeout(this.#restartTimer)
      this.#restartTimer = null
    }
    const child = this.#child
    this.#child = null
    if (child !== null && child.exitCode === null) {
      try {
        child.kill()
      } catch {
        // Already gone.
      }
    }
    this.#state = 'stopped'
  }

  /** One-line status for the plugin log / a settings card. */
  status() {
    return {
      state: this.#state,
      port: this.#config.port,
      url: `http://127.0.0.1:${this.#config.port}/inference`,
      entry: RELAY_ENTRY,
      failures: this.#failures,
    }
  }
}

/**
 * Cordis entry point.
 *
 * `ctx.effect` owns the lifecycle: the returned disposer runs on unload and on
 * DSH shutdown. Nothing here throws on a failed start — a broken relay must not
 * take the DSH layer down with it, since the rest of the host still works.
 */
export function apply(ctx, config = {}) {
  const log = line => {
    try {
      ctx.logger?.info?.(line)
    } catch {
      // A logger that throws must not break startup.
    }
  }

  ctx.effect(
    () => {
      const supervisor = new RelaySupervisor({ config, log })
      supervisor.start().catch(error => log(`relay: start failed — ${error.message}`))
      return () => supervisor.stop()
    },
    'opencode2dsh-relay: supervised Bun relay',
  )
}

export default { name, apply }
