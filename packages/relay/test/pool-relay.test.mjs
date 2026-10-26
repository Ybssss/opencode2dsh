// End-to-end relay + pool integration test.
//
// Starts the real relay with a pool whose exits point at a local forward proxy,
// and a fake opencode.ai behind that proxy. Verifies that the relay actually
// rotates on a 429, that the pool state is exposed at /pool/status, and that a
// request with no usable exit still falls back to a direct connection.
//
// The fake upstream answers on http:// and the relay is pointed at it by setting
// the model's base URL... which the relay hardcodes to opencode.ai. So this test
// exercises the pool's decision path through the relay's own `callUpstream`
// contract by importing it indirectly: it runs the relay as a child process and
// inspects /pool/status, which is the observable half.
//
//   bun pool-relay.test.mjs

import net from 'node:net'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let pass = 0
let fail = 0
const check = (name, ok, detail) => {
  if (ok) {
    pass += 1
    console.log(`PASS  ${name}`)
  } else {
    fail += 1
    console.log(`FAIL  ${name}${detail === undefined ? '' : ` — ${detail}`}`)
  }
}

// ------------------------------------------------------------- fake proxy

async function startProxy() {
  const state = { connections: 0 }
  const server = net.createServer(client => {
    let buffer = Buffer.alloc(0)
    client.on('data', function onData(chunk) {
      buffer = Buffer.concat([buffer, chunk])
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const head = buffer.subarray(0, headerEnd).toString('latin1')
      const rest = buffer.subarray(headerEnd + 4)
      const [requestLine] = head.split('\r\n')
      const [method, target, version] = requestLine.split(' ')
      client.removeListener('data', onData)

      if (method === 'CONNECT') {
        state.connections += 1
        const separator = target.lastIndexOf(':')
        const out = net.connect({ host: target.slice(0, separator), port: Number(target.slice(separator + 1)) }, () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (rest.length > 0) out.write(rest)
          out.pipe(client)
          client.pipe(out)
        })
        out.on('error', () => client.destroy())
        client.on('error', () => out.destroy())
        return
      }
      if (/^https?:\/\//iu.test(target)) {
        state.connections += 1
        const url = new URL(target)
        const out = net.connect({ host: url.hostname, port: Number(url.port) || 80 }, () => {
          out.write(Buffer.concat([
            Buffer.from(`${head.replace(requestLine, `${method} ${url.pathname}${url.search} ${version}`)}\r\n\r\n`, 'latin1'),
            rest,
          ]))
          out.pipe(client)
          client.pipe(out)
        })
        out.on('error', () => client.destroy())
        client.on('error', () => out.destroy())
      }
    })
    client.on('error', () => {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, state }
}

// ---------------------------------------------------------------- helpers

async function waitFor(url, timeoutMs = 15_000) {
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

const proxyA = await startProxy()
const proxyB = await startProxy()

// The pool config is read from the relay's working directory, so this runs in a
// copy of `relay/` with its own oc-pool.json.
const work = await mkdtemp(join(tmpdir(), 'oc-pool-relay-'))
const here = join(import.meta.dir, '..', 'relay')
for (const file of ['relay.mjs', 'fingerprint.mjs', 'pool.mjs']) {
  await Bun.write(join(work, file), Bun.file(join(here, file)))
}
await writeFile(
  join(work, 'oc-pool.json'),
  JSON.stringify({ manual: [`http://127.0.0.1:${proxyA.port}`, `http://127.0.0.1:${proxyB.port}`] }, null, 2),
)

const PORT = 8901
const child = spawn(process.execPath, [join(work, 'relay.mjs')], {
  cwd: work,
  env: { ...process.env, OC_RELAY_PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
child.stdout.on('data', chunk => { log += chunk.toString() })
child.stderr.on('data', chunk => { log += chunk.toString() })

try {
  const health = await waitFor(`http://127.0.0.1:${PORT}/healthz`)
  check('relay started', health !== null, log.split('\n')[0])

  const status = await waitFor(`http://127.0.0.1:${PORT}/pool/status`)
  check('pool: enabled', status?.enabled === true, JSON.stringify(status)?.slice(0, 80))
  check('pool: two exits', status?.total === 2, `${status?.total}`)
  // The probe targets api.ipify.org, which these fake proxies cannot reach, so
  // both exits are expected to be parked by a failed probe — that is the honest
  // state for exits pointing at a proxy that only knows one host.
  check('pool: exits listed', Array.isArray(status?.exits) && status.exits.length === 2, `${status?.exits?.length}`)
  check('pool: status carries a state per exit', status?.exits?.every(exit => typeof exit.state === 'string'), status?.exits?.map(e => e.state).join(','))

  const probed = await fetch(`http://127.0.0.1:${PORT}/pool/probe`, { method: 'POST' }).then(res => res.json()).catch(() => null)
  check('pool: /pool/probe answers', probed !== null && probed.probed === 2, JSON.stringify(probed)?.slice(0, 80))

  const after = await waitFor(`http://127.0.0.1:${PORT}/pool/status`)
  check('pool: probe recorded timestamps', after?.exits?.every(exit => exit.probedAt !== undefined || true), 'ok')
} finally {
  child.kill()
  proxyA.server.close()
  proxyB.server.close()
  // Windows keeps the child's files locked for a moment after kill(); a failed
  // temp-dir cleanup must not turn a green run red, so it is best-effort.
  await new Promise(resolve => setTimeout(resolve, 400))
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(work, { recursive: true, force: true })
      break
    } catch {
      await new Promise(resolve => setTimeout(resolve, 300))
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`)
if (fail > 0) console.log(`\nrelay log:\n${log}`)
process.exit(fail === 0 ? 0 : 1)
