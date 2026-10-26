// Does a request through a real pool exit still pass both gates?
//
// The pool's exits are external proxies. This proves the whole chain end to end
// with a local pass-through proxy standing in for an exit:
//
//   Bun fetch -> pool exit (CONNECT proxy) -> opencode.ai
//
// The body is the shaped one, so a 200 proves the proxy hop did not break the
// TLS fingerprint. The quota is currently spent, so the expected result is a 429
// WITH a `retry-after` — which is itself the proof that the request reached the
// gate rather than failing in the tunnel (a tunnel failure has no such header).
//
//   bun pool-live.test.mjs

import net from 'node:net'
import { ExitPool, parseProxyUrl } from '../relay/pool.mjs'
import { GENUINE_TOOLS, HARNESS_PREAMBLE } from '../relay/fingerprint.mjs'

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

// A pass-through CONNECT proxy: the exit's only job.
const proxy = net.createServer(client => {
  client.once('data', chunk => {
    const headerEnd = chunk.indexOf('\r\n\r\n')
    if (headerEnd < 0) {
      client.destroy()
      return
    }
    const head = chunk.subarray(0, headerEnd + 4).toString('latin1')
    const rest = chunk.subarray(headerEnd + 4)
    const [method, target] = head.split('\r\n')[0].split(' ')
    if (method !== 'CONNECT') {
      client.destroy()
      return
    }
    const separator = target.lastIndexOf(':')
    const out = net.connect({ host: target.slice(0, separator), port: Number(target.slice(separator + 1)) }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (rest.length > 0) out.write(rest)
      out.pipe(client)
      client.pipe(out)
    })
    out.on('error', () => client.destroy())
    client.on('error', () => out.destroy())
  })
  client.on('error', () => {})
})
await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve))
const proxyPort = proxy.address().port
console.log(`stand-in exit on 127.0.0.1:${proxyPort}`)

const pool = new ExitPool({ log: line => console.log(`  ${line}`) })
pool.add([parseProxyUrl(`http://127.0.0.1:${proxyPort}`, 'test')])
const exit = pool.list()[0]
exit.state = 'ok'

const b62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const session = () => {
  const value = ~(BigInt(Date.now()) * 0x1000n + 1n)
  let hex = ''
  for (let i = 0; i < 6; i += 1) hex += ((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')
  return `ses_${hex}${Array.from(crypto.getRandomValues(new Uint8Array(14)), b => b62[b % 62]).join('')}`
}

const ses = session()
const proxyUrl = await pool.proxyUrlFor(exit)
const res = await fetch('https://opencode.ai/inference/v1/chat/completions', {
  method: 'POST',
  proxy: proxyUrl,
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer public',
    'user-agent': 'opencode/1.18.35',
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-session': ses,
    'x-opencode-session-id': ses,
    'x-session-affinity': ses,
    'x-session-id': ses,
    accept: 'text/event-stream',
  },
  body: JSON.stringify({
    model: 'deepseek-v4.1-flash-free',
    stream: true,
    max_tokens: 8,
    messages: [
      { role: 'system', content: HARNESS_PREAMBLE },
      { role: 'user', content: 'ping' },
    ],
    tools: GENUINE_TOOLS,
    tool_choice: 'auto',
  }),
})

const retryAfter = res.headers.get('retry-after')
const text = await res.text()
console.log(`\nthrough the exit: status=${res.status} retry-after=${retryAfter ?? '-'}`)

check('exit: the request reached the gate', res.status === 200 || res.status === 429, `status=${res.status}`)
check(
  'exit: the proxy hop did not break the tunnel',
  res.status !== 0 && !/Unable to connect|socket connection was closed/iu.test(text),
  text.slice(0, 80),
)
if (res.status === 429) {
  // A gate answer carries the reset; a tunnel failure does not.
  check('exit: a 429 carries the quota reset', retryAfter !== null, String(retryAfter))
  const resetAt = new Date(Date.now() + Number(retryAfter) * 1000)
  console.log(`  (quota spent; resets ${resetAt.toLocaleString()} — this is the third gate, not a failure)`)
} else {
  check('exit: a 200 carried content', text.includes('data:'), text.slice(0, 60))
}

// The pool's own bookkeeping should reflect what the upstream said.
pool.report(exit, res.status === 429 ? 'quota' : 'ok', { model: 'deepseek-v4.1-flash-free', retryAfterMs: Number(retryAfter ?? 0) * 1000 })
const status = pool.status()
check('exit: pool recorded the outcome', status.exits[0].uses === 1, `uses=${status.exits[0].uses} reason=${status.exits[0].reason}`)

proxy.close()
pool.close()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
