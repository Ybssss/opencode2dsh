#!/usr/bin/env bun
// Exit-pool CLI for the opencode.ai relay.
//
//   bun oc-pool-cli.mjs add http://1.2.3.4:8080 [more…]
//   bun oc-pool-cli.mjs add socks5://user:pass@1.2.3.4:1080
//   bun oc-pool-cli.mjs subscribe https://airport.example/sub
//   bun oc-pool-cli.mjs list
//   bun oc-pool-cli.mjs probe            # health-check every exit now
//   bun oc-pool-cli.mjs remove <id|index>
//   bun oc-pool-cli.mjs clear
//   bun oc-pool-cli.mjs status           # what the running relay reports
//
// Exits live in `oc-pool.json` next to this script, which the relay reads at
// startup. Credentials stay in that file — it is the user's own machine, and the
// file is written 0600 where the platform supports it.

import { chmod, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ExitPool, parseProxyUrl, parseSubscription } from './pool.mjs'

const HERE = import.meta.dir
const CONFIG = join(HERE, 'oc-pool.json')
const RELAY = `http://127.0.0.1:${process.env.OC_RELAY_PORT ?? 8899}`

async function readConfig() {
  if (!existsSync(CONFIG)) return { manual: [], subscriptions: [] }
  try {
    const parsed = JSON.parse(await readFile(CONFIG, 'utf8'))
    return {
      manual: Array.isArray(parsed.manual) ? parsed.manual : [],
      subscriptions: Array.isArray(parsed.subscriptions) ? parsed.subscriptions : [],
      ...(typeof parsed.probeUrl === 'string' ? { probeUrl: parsed.probeUrl } : {}),
    }
  } catch (error) {
    throw new Error(`oc-pool.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function writeConfig(config) {
  await writeFile(CONFIG, `${JSON.stringify(config, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try {
    await chmod(CONFIG, 0o600)
  } catch {
    // Windows: the profile directory is already user-scoped.
  }
}

const [, , command = 'help', ...args] = process.argv

if (command === 'add') {
  if (args.length === 0) {
    console.error('usage: add <proxy-url> [more…]')
    process.exit(1)
  }
  const config = await readConfig()
  const added = []
  const rejected = []
  for (const raw of args) {
    const exit = parseProxyUrl(raw, 'manual')
    if (exit === null) {
      rejected.push(raw)
      continue
    }
    if (!config.manual.includes(raw)) config.manual.push(raw)
    added.push(exit.label)
  }
  await writeConfig(config)
  if (added.length > 0) console.log(`added ${added.length}: ${added.join(', ')}`)
  if (rejected.length > 0) {
    console.error(`rejected ${rejected.length} (need scheme://host:port): ${rejected.join(', ')}`)
    process.exitCode = 1
  }
  console.log(`restart the relay to use them (${config.manual.length} manual exit(s) configured)`)
}

else if (command === 'subscribe') {
  if (args.length === 0) {
    console.error('usage: subscribe <url> [more…]')
    process.exit(1)
  }
  const config = await readConfig()
  const subs = config.subscriptions ?? []
  for (const url of args) if (!subs.includes(url)) subs.push(url)
  await writeConfig({ ...config, subscriptions: subs })
  console.log(`subscriptions: ${subs.length}`)
  console.log('restart the relay to pull them')
}

else if (command === 'remove') {
  if (args.length === 0) {
    console.error('usage: remove <proxy-url|index>')
    process.exit(1)
  }
  const config = await readConfig()
  const before = config.manual.length
  const target = args[0]
  const index = Number(target)
  if (Number.isInteger(index) && index >= 0 && index < config.manual.length) {
    const [dropped] = config.manual.splice(index, 1)
    console.log(`removed [${index}] ${dropped}`)
  } else {
    config.manual = config.manual.filter(entry => entry !== target)
    console.log(config.manual.length < before ? `removed ${target}` : `not found: ${target}`)
  }
  await writeConfig(config)
}

else if (command === 'clear') {
  await writeConfig({ manual: [], subscriptions: [] })
  console.log('pool cleared; the relay will go direct after a restart')
}

else if (command === 'list') {
  const config = await readConfig()
  if (config.manual.length === 0 && (config.subscriptions ?? []).length === 0) {
    console.log('no exits configured — the relay goes direct')
    console.log('add one: bun oc-pool-cli.mjs add http://host:port')
    process.exit(0)
  }
  console.log(`manual (${config.manual.length}):`)
  config.manual.forEach((entry, index) => {
    const exit = parseProxyUrl(entry, 'manual')
    console.log(`  [${index}] ${exit === null ? `${entry}  (unparseable)` : `${exit.label}${exit.username === undefined ? '' : '  (auth)'}`}`)
  })
  const subs = config.subscriptions ?? []
  if (subs.length > 0) {
    console.log(`subscriptions (${subs.length}):`)
    for (const url of subs) console.log(`  ${url}`)
  }
}

else if (command === 'probe') {
  const config = await readConfig()
  const pool = new ExitPool({ log: line => console.log(line) })
  await pool.load(config)
  if (pool.size === 0) {
    console.log('no exits to probe')
    process.exit(0)
  }
  console.log(`probing ${pool.size} exit(s)…`)
  const results = await pool.probeAll()
  for (const result of results) {
    const exit = pool.get(result.id)
    console.log(
      result.ok
        ? `  OK   ${result.id}  ${result.latencyMs}ms  exit-ip=${result.exitIp || '?'}`
        : `  FAIL ${result.id}  ${String(result.reason).slice(0, 70)}`,
    )
    if (exit?.state === 'dead') console.log(`       (marked dead)`)
  }
  const status = pool.status()
  console.log(`\n${status.usable}/${status.total} usable`)
  pool.close()
}

else if (command === 'status') {
  try {
    const res = await fetch(`${RELAY}/pool/status`, { signal: AbortSignal.timeout(3000) })
    const status = await res.json()
    if (!status.enabled) {
      console.log('relay is running but has no pool (no oc-pool.json)')
      process.exit(0)
    }
    console.log(`usable ${status.usable}/${status.total}${status.quotaSpent > 0 ? `, ${status.quotaSpent} out of quota` : ''}`)
    for (const exit of status.exits) {
      const parked = exit.usable ? '' : `  parked ${Math.ceil(exit.parkedForMs / 60000)}min${exit.reason === '' ? '' : ` (${exit.reason})`}`
      console.log(`  ${exit.usable ? 'OK  ' : 'PARK'} ${exit.label}  uses=${exit.uses}${exit.exitIp === '' ? '' : `  ip=${exit.exitIp}`}${parked}`)
    }
  } catch {
    console.log(`relay not reachable at ${RELAY} — start it first`)
    process.exitCode = 1
  }
}

else if (command === 'test-subscription') {
  // Fetch and parse a subscription without saving it, to see what it yields.
  const url = args[0]
  if (url === undefined) {
    console.error('usage: test-subscription <url>')
    process.exit(1)
  }
  const response = await fetch(url, { headers: { 'user-agent': 'clash-verge/v2.0' }, signal: AbortSignal.timeout(20_000) })
  const body = await response.text()
  console.log(`HTTP ${response.status}, ${body.length} bytes`)
  const exits = parseSubscription(body, url)
  const byProtocol = new Map()
  for (const exit of exits) byProtocol.set(exit.protocol, (byProtocol.get(exit.protocol) ?? 0) + 1)
  console.log(`dialable exits: ${exits.length}`)
  for (const [protocol, count] of byProtocol) console.log(`  ${protocol}: ${count}`)
  if (exits.length === 0) {
    console.log('nothing dialable — the nodes are probably vmess/vless/trojan/ss, which need sing-box')
    console.log(`first 200 chars: ${body.slice(0, 200).replace(/\s+/gu, ' ')}`)
  } else {
    for (const exit of exits.slice(0, 10)) console.log(`  ${exit.label}`)
    if (exits.length > 10) console.log(`  … ${exits.length - 10} more`)
  }
}

else {
  console.log(`exit-pool CLI

  add <proxy-url>…          add manual exits (scheme://[user:pass@]host:port)
  subscribe <url>…          add subscription URLs
  remove <proxy-url|index>  drop one manual exit
  clear                     remove everything
  list                      show what is configured
  probe                     health-check every exit now
  status                    what the running relay reports
  test-subscription <url>   parse a subscription without saving it

Supported schemes: http, https, socks5, socks5h.
Not supported (need sing-box): vmess, vless, trojan, ss, hysteria2.`)
}
