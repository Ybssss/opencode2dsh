/**
 * Does any harvested free exit still have free-tier allowance left?
 *
 * The relay parks an exit for ~20 h the moment it sees 429 + retry-after, so it
 * cannot answer this question itself without waiting a day. This asks each exit
 * directly for one tiny completion and reports the raw verdict.
 */

import { readFileSync } from 'node:fs'

const poolFile = process.argv[2]
const { manual } = JSON.parse(readFileSync(poolFile, 'utf8'))

const URL_BASE = 'https://opencode.ai/inference/v1/chat/completions'
const body = JSON.stringify({
  model: 'mimo-v2.6-flash-free',
  messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  max_tokens: 8,
})

for (const entry of manual) {
  const proxy = entry.replace(/^\/+|\/+$/gu, '')
  const hostPort = proxy.replace(/^https?:\/\//u, '')
  try {
    const res = await fetch(URL_BASE, {
      method: 'POST',
      headers: {
        authorization: 'Bearer public',
        'user-agent': 'opencode/1.18.35',
        'x-opencode-client': 'cli',
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body,
      proxy: `http://${hostPort}`,
      signal: AbortSignal.timeout(45_000),
    })
    const text = await res.text()
    const retry = res.headers.get('retry-after')
    let kind = 'ok'
    if (res.status === 429) kind = 'QUOTA SPENT'
    else if (res.status !== 200) kind = `http ${res.status}`
    const snippet = text.replace(/\s+/gu, ' ').slice(0, 90)
    console.log(`${kind.padEnd(12)} ${hostPort.padEnd(24)} ${retry ? `retry-after=${retry}s ` : ''}${snippet}`)
  } catch (error) {
    console.log(`${'FAIL'.padEnd(12)} ${hostPort.padEnd(24)} ${error?.name ?? error}`)
  }
}
