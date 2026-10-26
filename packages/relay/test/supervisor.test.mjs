// Supervisor tests. Runs under Node (what DSH uses), not Bun, so a Bun-only API
// leaking into the host half fails here rather than in DSH.
//
//   node test/supervisor.test.mjs

import { createServer } from 'node:net'
import { findBun, RelaySupervisor } from '../lib/index.mjs'

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

const isBun = typeof globalThis.Bun !== 'undefined'
if (isBun) {
  console.log('note: running under Bun; this suite is meant for Node (DSH host)')
}

// 1. No Bun API may be referenced at module scope. If `Bun` were touched on
//    import, this whole file would already have thrown under Node.
check('module imports cleanly under Node', true)

// 2. findBun() returns an absolute path to a real executable, or null.
{
  const bun = findBun()
  if (bun === null) {
    console.log('INFO  bun not found on this machine; skipping the spawn tests')
  } else {
    check('findBun: returns an absolute path', /^[A-Za-z]:[\\/]|^\//u.test(bun), bun)
    check('findBun: names bun', /bun(\.exe)?$/iu.test(bun), bun)
  }
  check('findBun: an explicit bad path yields null', findBun('C:\\definitely\\not\\here\\bun.exe') === null, 'null')
}

// 3. autoStart:false manages nothing and says so.
{
  const supervisor = new RelaySupervisor({ config: { autoStart: false }, log: () => {} })
  const state = await supervisor.start()
  check('autoStart:false -> disabled', state === 'disabled', state)
  check('autoStart:false -> no child', supervisor.status().failures === 0, 'failures')
  supervisor.stop()
  check('stop() is idempotent', supervisor.state === 'stopped', supervisor.state)
}

// 4. A busy port owned by something else is reported, not fought over.
{
  const blocker = createServer()
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve))
  const port = blocker.address().port
  const logs = []
  const supervisor = new RelaySupervisor({ config: { port, autoStart: true }, log: line => logs.push(line) })
  const state = await supervisor.start()
  check('busy port -> port-busy', state === 'port-busy', state)
  check('busy port -> logged a reason', logs.some(line => line.includes('not the relay')), logs.join(' | ').slice(0, 120))
  supervisor.stop()
  blocker.close()
}

// 5. A port already serving our relay is adopted, not duplicated.
{
  const server = createServer((socket) => {
    socket.once('data', () => {
      const body = JSON.stringify({ ok: true })
      socket.write(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${body.length}\r\nconnection: close\r\n\r\n${body}`)
      socket.end()
    })
    socket.on('error', () => {})
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const logs = []
  const supervisor = new RelaySupervisor({ config: { port, autoStart: true }, log: line => logs.push(line) })
  const state = await supervisor.start()
  check('answering relay -> adopted', state === 'running', state)
  check('answering relay -> logged adoption', logs.some(line => line.includes('adopted')), logs.join(' | ').slice(0, 120))
  supervisor.stop()
  server.close()
}

// 6. Full lifecycle: start a real relay, confirm it answers, stop it.
{
  const bun = findBun()
  if (bun === null) {
    console.log('INFO  skipping the real-relay lifecycle test (no bun)')
  } else {
    const port = 8951
    const logs = []
    const supervisor = new RelaySupervisor({ config: { port, autoStart: true }, log: line => logs.push(line) })
    const state = await supervisor.start()
    check('lifecycle: relay started', state === 'running', `${state}: ${logs.slice(-2).join(' | ')}`)
    if (state === 'running') {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`)
      const body = await res.json()
      check('lifecycle: /healthz answers', body?.ok === true, JSON.stringify(body))
      const pool = await fetch(`http://127.0.0.1:${port}/pool/status`).then(r => r.json())
      check('lifecycle: /pool/status answers', typeof pool?.enabled === 'boolean', JSON.stringify(pool).slice(0, 80))
    }
    supervisor.stop()
    await new Promise(r => setTimeout(r, 700))
    const after = await fetch(`http://127.0.0.1:${port}/healthz`).then(() => 'up').catch(() => 'down')
    check('lifecycle: stop() really stopped it', after === 'down', after)
  }
}

// 7. status() shape.
{
  const supervisor = new RelaySupervisor({ config: { port: 1234 }, log: () => {} })
  const status = supervisor.status()
  check('status: url points at the port', status.url === 'http://127.0.0.1:1234/inference', status.url)
  check('status: entry is absolute', /relay[\\/]relay\.mjs$/u.test(status.entry), status.entry)
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
