#!/usr/bin/env node
// Report which credential opencode2dsh would use and whether the free lane
// currently answers. One 1-token chat request; nothing is written.
//
//   node scripts/lane-status.mjs            # config/env/auth.json chain
//   node scripts/lane-status.mjs --key sk-  # test a specific key
//
// Exit codes: 0 lane open, 2 lane capped (429 + Retry-After), 1 other failure.
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const MODEL = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : 'deepseek-v4.1-flash-free'
const URL_ = 'https://opencode.ai/inference/v1/chat/completions'

function fromArgv() {
  const i = process.argv.indexOf('--key')
  return i > -1 ? (process.argv[i + 1] ?? '').trim() : ''
}

function fromAuthFile() {
  const file = join(homedir(), '.local', 'share', 'opencode', 'auth.json')
  if (!existsSync(file)) return { key: '', file, entries: 0 }
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'))
    const entries = Object.values(data ?? {}).filter((v) => v && typeof v === 'object')
    for (const entry of entries) {
      for (const field of ['access', 'key', 'token']) {
        const value = entry[field]
        if (typeof value === 'string' && value.trim() !== '') return { key: value.trim(), file, entries: entries.length }
      }
    }
    return { key: '', file, entries: entries.length }
  } catch {
    return { key: '', file, entries: -1 }
  }
}

function resolveKey() {
  const argv = fromArgv()
  if (argv !== '') return { key: argv, source: '--key' }
  const env = (process.env.OPENCODE_ZEN_API_KEY ?? '').trim()
  if (env !== '') return { key: env, source: 'OPENCODE_ZEN_API_KEY' }
  const auth = fromAuthFile()
  if (auth.key !== '') return { key: auth.key, source: `${auth.file} (${auth.entries} entries)` }
  return { key: 'public', source: 'anonymous shared lane', auth }
}

function resetLabel(seconds) {
  if (!Number.isFinite(seconds) || seconds <= 0) return ''
  const at = new Date(Date.now() + seconds * 1000)
  const local = at.toLocaleString()
  return `${local} local (${at.toISOString()})`
}

const { key, source, auth } = resolveKey()
const shown = key === 'public' ? 'public' : `${key.slice(0, 8)}…(${key.length} chars)`
console.log(`credential  ${shown}  <- ${source}`)
if (auth && source === 'anonymous shared lane' && auth.file) {
  console.log(`auth.json   ${auth.file}  entries=${auth.entries}${auth.entries === 0 ? '  (run `opencode auth login`)' : ''}`)
}

const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 30_000)
let response
try {
  response = await fetch(URL_, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'user-agent': 'opencode/latest/2.2.0/cli',
      'x-opencode-client': 'cli',
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
      stream: true,
    }),
  })
} catch (err) {
  clearTimeout(timer)
  console.log(`request     FAILED  ${err instanceof Error ? err.message : String(err)}`)
  process.exit(1)
}

const retryAfter = Number(response.headers.get('retry-after') ?? 0)
let body = ''
try {
  const reader = response.body?.getReader()
  if (reader) {
    const chunk = await reader.read()
    body = new TextDecoder().decode(chunk.value ?? new Uint8Array()).slice(0, 400)
    await reader.cancel()
  }
} catch {
  // the status line is the verdict; a body read failure changes nothing
} finally {
  clearTimeout(timer)
}

console.log(`model       ${MODEL}`)
console.log(`status      ${response.status}${response.statusText ? ` ${response.statusText}` : ''}`)
if (retryAfter > 0) console.log(`retry-after ${retryAfter}s  resets ${resetLabel(retryAfter)}`)

const free = /FreeUsageLimitError|free usage limit reached/i.test(body)
if (response.status === 200) {
  console.log('verdict     lane OPEN')
  process.exit(0)
}
if (response.status === 429 && free) {
  console.log('verdict     shared free lane CAPPED (credential-keyed; rotation cannot clear it)')
  if (retryAfter === 0) console.log(`reset       next 00:00 UTC: ${new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() + 1)).toISOString()}`)
  process.exit(2)
}
console.log(`verdict     unexpected response${body ? `: ${body.replace(/\s+/gu, ' ').slice(0, 200)}` : ''}`)
process.exit(1)
