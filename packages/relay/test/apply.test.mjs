// Integration test: drive the plugin's `apply` the way DSH does.
//
// A minimal Cordis context — `ctx.effect(fn)` runs `fn` and keeps its disposer,
// exactly the contract the plugin relies on. This proves the wiring DSH will
// actually execute, which the unit tests (which call RelaySupervisor directly)
// cannot.
//
//   node test/apply.test.mjs

import { apply, name } from '../lib/index.mjs'

let pass = 0
let fail = 0
const check = (label, ok, detail) => {
  if (ok) {
    pass += 1
    console.log(`PASS  ${label}`)
  } else {
    fail += 1
    console.log(`FAIL  ${label}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

/** The smallest context that satisfies the plugin's needs. */
function makeContext() {
  const disposers = []
  const logs = []
  return {
    ctx: {
      logger: { info: line => logs.push(line), warn: line => logs.push(line), error: line => logs.push(line) },
      effect(fn, label) {
        disposers.push({ dispose: fn(), label })
      },
    },
    logs,
    disposeAll() {
      for (const entry of disposers.reverse()) {
        try {
          entry.dispose?.()
        } catch {
          // A throwing disposer must not hide the rest.
        }
      }
    },
    disposerCount: () => disposers.length,
  }
}

const waitFor = async (url, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return await res.json()
    } catch {
      // not up yet
    }
    await new Promise(r => setTimeout(r, 200))
  }
  return null
}

// 1. The module's shape.
check('exports a name', name === 'opencode2dsh-relay', name)
check('exports apply', typeof apply === 'function', typeof apply)

// 2. autoStart:false must register a disposer and start nothing.
{
  const { ctx, logs, disposeAll, disposerCount } = makeContext()
  apply(ctx, { autoStart: false })
  check('apply: registers exactly one effect', disposerCount() === 1, `${disposerCount()}`)
  await new Promise(r => setTimeout(r, 300))
  const health = await fetch('http://127.0.0.1:8899/healthz', { signal: AbortSignal.timeout(800) }).then(() => 'up').catch(() => 'down')
  check('apply: autoStart false starts nothing', health === 'down', health)
  disposeAll()
}

// 3. A real start through apply, then dispose stops it.
{
  const PORT = 8961
  const { ctx, logs, disposeAll } = makeContext()
  apply(ctx, { port: PORT, autoStart: true })

  const health = await waitFor(`http://127.0.0.1:${PORT}/healthz`)
  check('apply: relay came up', health?.ok === true, JSON.stringify(health))
  check('apply: logged the port', logs.some(line => line.includes(String(PORT))), logs.slice(0, 3).join(' | '))

  if (health?.ok === true) {
    const pool = await fetch(`http://127.0.0.1:${PORT}/pool/status`).then(r => r.json()).catch(() => null)
    check('apply: pool endpoint answers', typeof pool?.enabled === 'boolean', JSON.stringify(pool)?.slice(0, 60))

    // The real thing: a plugin-shaped request through the relay.
    const ses = `ses_${'a'.repeat(12)}${'b'.repeat(14)}`
    const res = await fetch(`http://127.0.0.1:${PORT}/inference/v1/models`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(30_000),
    })
    check('apply: catalog listing works', res.status === 200, `status=${res.status}`)
  }

  disposeAll()
  await new Promise(r => setTimeout(r, 800))
  const after = await fetch(`http://127.0.0.1:${PORT}/healthz`, { signal: AbortSignal.timeout(800) }).then(() => 'up').catch(() => 'down')
  check('apply: dispose stopped the relay', after === 'down', after)
}

// 4. A second apply on a busy-but-ours port adopts rather than duplicating.
{
  const PORT = 8962
  const first = makeContext()
  apply(first.ctx, { port: PORT, autoStart: true })
  await waitFor(`http://127.0.0.1:${PORT}/healthz`)

  const second = makeContext()
  apply(second.ctx, { port: PORT, autoStart: true })
  await new Promise(r => setTimeout(r, 1200))
  check('apply: second instance adopts', second.logs.some(line => line.includes('adopted')), second.logs.join(' | ').slice(0, 120))
  check('apply: relay still up', (await waitFor(`http://127.0.0.1:${PORT}/healthz`, 3000))?.ok === true, 'health')

  second.disposeAll()
  first.disposeAll()
  await new Promise(r => setTimeout(r, 800))
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
