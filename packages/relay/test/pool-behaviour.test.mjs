// Behaviour tests for the exit pool: rotation, parking, and status.
//
// Each test runs a fake opencode.ai behind a real forward proxy, and the pool's
// exits point at that proxy. Two things the proxy must get right, both measured:
//
//   * a plain `http://` target arrives as an absolute-form request
//     (`POST http://host/path HTTP/1.1`) and must be rewritten to origin-form;
//   * an `https://` target arrives as `CONNECT host:port`, and any bytes
//     pipelined after the CONNECT header block must be forwarded.
//
// Tests use `http://` so no TLS is involved: the pool's job (choosing, parking,
// retrying) is independent of the transport, and the real `https://` path was
// verified against the live lane separately.
//
//   bun pool-behaviour.test.mjs

import net from 'node:net'
import { ExitPool, parseProxyUrl } from '../relay/pool.mjs'

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

// ------------------------------------------------------------ fake upstream

/** A fake opencode.ai: answers with the next scripted status. */
async function startUpstream(script) {
  const state = { hits: 0, paths: [] }
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0)
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk])
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return
      const head = buffer.subarray(0, headerEnd).toString('latin1')
      const length = Number(/content-length:\s*(\d+)/iu.exec(head)?.[1] ?? 0)
      if (buffer.length - (headerEnd + 4) < length) return
      state.hits += 1
      state.paths.push(head.split('\r\n')[0])
      const status = script(state.hits - 1) ?? 200
      const body = status === 429
        ? JSON.stringify({ type: 'error', error: { type: 'FreeUsageLimitError', message: 'free usage limit reached' } })
        : 'data: {"ok":true}\n\n'
      const retry = status === 429 ? 'retry-after: 3600\r\n' : ''
      socket.write(
        `HTTP/1.1 ${status} X\r\ncontent-type: text/event-stream\r\n${retry}content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      )
      socket.end()
    })
    socket.on('error', () => {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  return { server, port: server.address().port, state }
}

// -------------------------------------------------------------- fake proxy

/** A forward proxy that splices to whatever the client names, counting exits. */
async function startProxy() {
  const state = { connections: 0, absolute: 0, tunnels: 0 }
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

      if (method === 'CONNECT') {
        state.connections += 1
        state.tunnels += 1
        client.removeListener('data', onData)
        const separator = target.lastIndexOf(':')
        const host = target.slice(0, separator)
        const port = Number(target.slice(separator + 1))
        const out = net.connect({ host, port }, () => {
          client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (rest.length > 0) out.write(rest)
          out.pipe(client)
          client.pipe(out)
        })
        out.on('error', () => client.destroy())
        client.on('error', () => out.destroy())
        return
      }

      // Absolute-form: `POST http://host:port/path HTTP/1.1`.
      if (/^https?:\/\//iu.test(target)) {
        state.connections += 1
        state.absolute += 1
        client.removeListener('data', onData)
        const url = new URL(target)
        const port = Number(url.port) || 80
        const rewritten = head.replace(requestLine, `${method} ${url.pathname}${url.search} ${version}`)
        const out = net.connect({ host: url.hostname, port }, () => {
          out.write(Buffer.concat([Buffer.from(`${rewritten}\r\n\r\n`, 'latin1'), rest]))
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

/** Mirror of the relay's `callUpstream`, over http so no TLS is needed. */
async function call(pool, { upstreamPort, model = 'm', session = 's', rotations = 4 }) {
  const attempts = pool.size === 0 ? 1 : Math.max(1, Math.min(pool.size, rotations))
  let lastStatus = 0
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const exit = pool.size === 0 ? null : pool.pick({ session, model })
    if (exit === null && attempt > 0) break
    const proxy = exit === null ? undefined : await pool.proxyUrlFor(exit)
    let response
    try {
      response = await fetch(`http://127.0.0.1:${upstreamPort}/inference/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
        ...(proxy === undefined ? {} : { proxy }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      if (exit !== null) pool.report(exit, 'transport', { model })
      lastStatus = 0
      continue
    }
    lastStatus = response.status
    if (response.status === 429) {
      const retryAfterMs = Number(response.headers.get('retry-after') ?? 0) * 1000
      if (exit !== null) pool.report(exit, 'quota', { model, retryAfterMs })
      if (attempt === attempts - 1) return { status: 429, exit, attempts: attempt + 1 }
      continue
    }
    if (response.status === 401 || response.status === 403) {
      if (exit !== null) pool.report(exit, 'refused', { model })
      continue
    }
    if (exit !== null) pool.report(exit, 'ok', { model })
    return { status: response.status, exit, attempts: attempt + 1 }
  }
  return { status: lastStatus, exit: null, attempts }
}

// ------------------------------------------------------------------ tests

// 1. Rotation on quota: exit A answers 429, exit B answers 200.
{
  const proxyA = await startProxy()
  const proxyB = await startProxy()
  const upstream = await startUpstream(hit => (hit === 0 ? 429 : 200))
  const pool = new ExitPool({ log: () => {} })
  pool.add([parseProxyUrl(`http://127.0.0.1:${proxyA.port}`, 'test'), parseProxyUrl(`http://127.0.0.1:${proxyB.port}`, 'test')])
  // Exit A is picked first (fewest uses), exit B second.
  pool.list()[1].uses = 1

  const result = await call(pool, { upstreamPort: upstream.port })
  check('rotation: served after a 429', result.status === 200, `status=${result.status} tries=${result.attempts}`)
  check('rotation: two exits tried', result.attempts === 2, `${result.attempts}`)
  check('rotation: both proxies were used', proxyA.state.connections + proxyB.state.connections === 2, `${proxyA.state.connections}+${proxyB.state.connections}`)
  const parked = pool.list().find(exit => exit.reason === 'quota')
  check('rotation: the 429 exit is parked on quota', parked !== undefined, parked?.id)
  check('rotation: parked ~1h from retry-after', parked !== undefined && parked.until - Date.now() > 50 * 60_000, `${Math.round(((parked?.until ?? 0) - Date.now()) / 60000)}min`)
  proxyA.server.close()
  proxyB.server.close()
  upstream.server.close()
  pool.close()
}

// 2. Every exit parked: no rotation, the honest 429 comes back.
{
  const proxyA = await startProxy()
  const upstream = await startUpstream(() => 429)
  const pool = new ExitPool({ log: () => {} })
  pool.add([parseProxyUrl(`http://127.0.0.1:${proxyA.port}`, 'test')])
  const first = await call(pool, { upstreamPort: upstream.port })
  check('all parked: first call returns 429', first.status === 429, `status=${first.status}`)
  const connectionsAfterFirst = proxyA.state.connections
  const second = await call(pool, { upstreamPort: upstream.port })
  check('all parked: second call goes direct', second.exit === null, `${second.exit?.id}`)
  check('all parked: the parked exit was not retried', proxyA.state.connections === connectionsAfterFirst, `${proxyA.state.connections}`)
  proxyA.server.close()
  upstream.server.close()
  pool.close()
}

// 3. Transport failure: backoff grows, then dead after three strikes.
{
  const pool = new ExitPool({ log: () => {} })
  const exit = parseProxyUrl('http://127.0.0.1:1', 'test')
  pool.add([exit])
  pool.report(exit, 'transport', { model: 'm' })
  const firstPark = exit.until - Date.now()
  pool.report(exit, 'transport', { model: 'm' })
  const secondPark = exit.until - Date.now()
  check('transport: backoff grows', secondPark > firstPark, `${Math.round(firstPark / 1000)}s -> ${Math.round(secondPark / 1000)}s`)
  check('transport: still cooling after two', exit.state === 'cooling', exit.state)
  pool.report(exit, 'transport', { model: 'm' })
  check('transport: dead after three strikes', exit.state === 'dead', exit.state)
  check('transport: dead is not usable', !exit.usable(), 'usable')
}

// 4. A refusal bans the model on that exit, not the exit itself.
{
  const pool = new ExitPool({ log: () => {} })
  const exit = parseProxyUrl('http://127.0.0.1:1', 'test')
  pool.add([exit])
  pool.report(exit, 'refused', { model: 'model-a' })
  check('refusal: model-a banned', !exit.usableFor('model-a'), 'model-a')
  check('refusal: model-b still allowed', exit.usableFor('model-b'), 'model-b')
}

// 5. pick() prefers the least-used exit and sticks per session.
{
  const pool = new ExitPool({ log: () => {} })
  const a = parseProxyUrl('http://127.0.0.1:1001', 'test')
  const b = parseProxyUrl('http://127.0.0.1:1002', 'test')
  pool.add([a, b])
  a.state = 'ok'
  b.state = 'ok'
  a.uses = 0
  b.uses = 3
  const first = pool.pick({ session: 's1', model: 'm' })
  check('pick: least-used wins', first?.id === a.id, first?.id)
  const again = pool.pick({ session: 's1', model: 'm' })
  check('pick: session sticks', again?.id === a.id, again?.id)
  const other = pool.pick({ session: 's2', model: 'm' })
  check('pick: another session is served', other !== null, other?.id)
}

// 6. Status shape.
{
  const pool = new ExitPool({ log: () => {} })
  const exit = parseProxyUrl('http://127.0.0.1:1003', 'test')
  pool.add([exit])
  pool.report(exit, 'quota', { model: 'm', retryAfterMs: 3_600_000 })
  const status = pool.status()
  check('status: totals', status.total === 1 && status.usable === 0 && status.quotaSpent === 1, JSON.stringify({ total: status.total, usable: status.usable, quotaSpent: status.quotaSpent }))
  check('status: exit carries a park reason', status.exits[0].reason === 'quota', status.exits[0].reason)
}

// 7. Deduplication on add.
{
  const pool = new ExitPool({ log: () => {} })
  const added = pool.add([parseProxyUrl('http://127.0.0.1:1004', 'a'), parseProxyUrl('http://127.0.0.1:1004', 'b')])
  check('add: duplicate id rejected', added === 1 && pool.size === 1, `added=${added} size=${pool.size}`)
}

// 8. A dead exit is skipped by pick().
{
  const pool = new ExitPool({ log: () => {} })
  const dead = parseProxyUrl('http://127.0.0.1:1005', 'test')
  const live = parseProxyUrl('http://127.0.0.1:1006', 'test')
  pool.add([dead, live])
  dead.state = 'dead'
  live.state = 'ok'
  const picked = pool.pick({ session: 's', model: 'm' })
  check('pick: skips a dead exit', picked?.id === live.id, picked?.id)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
