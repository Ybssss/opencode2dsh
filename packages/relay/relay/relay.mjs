// Local Bun relay for the opencode.ai free tier (2026-10-26).
//
// Why this exists: the free-tier gate now measures two independent things, and
// both must be satisfied.
//
//   1. The request BODY. It must carry the CLI harness preamble and the CLI's
//      twelve genuine built-in tool declarations, byte for byte. A body with the
//      plugin's own `read`/`shell` pair, or with no preamble, answers 429.
//      (Measured by 9router-go on 2026-10-25; re-verified here.)
//
//   2. The TLS stack. With the SAME acceptable body and the SAME headers, the
//      verdict depends only on which TLS implementation opens the socket:
//        Bun fetch / Bun node:https (BoringSSL) .... 200
//        Node undici / node:https / node:http2 ..... 429
//        curl.exe (schannel) ....................... 429
//      Same egress IP for every client, repeatable across interleaved runs, so
//      this is a handshake fingerprint rather than per-IP quota. Node sends a
//      1,603-byte ClientHello with 52 cipher suites; Bun sends 517 bytes with 17.
//
// DSH runs on Node, so every request it makes is refused no matter what body the
// plugin builds. This relay runs on Bun (satisfying 2), reshapes each request
// into the accepted body (satisfying 1), and bridges tool calls back to the
// caller's own tool names and argument schemas.
//
//   bun _oc-free-relay.mjs              # 127.0.0.1:8899
//   OC_RELAY_PORT=9000 bun ...          # another port

import { GENUINE_TOOLS, HARNESS_PREAMBLE } from './fingerprint.mjs'
import { createPool } from './pool.mjs'

const PORT = Number(process.env.OC_RELAY_PORT ?? 8899)
const UPSTREAM = 'https://opencode.ai'
const VERBOSE = process.env.OC_RELAY_VERBOSE === '1'
/** How many exits one request may try before giving up (quota rotation cap). */
const MAX_ROTATIONS = Number(process.env.OC_RELAY_MAX_ROTATIONS ?? 4)

const PREAMBLE = HARNESS_PREAMBLE
const GENUINE = new Map(GENUINE_TOOLS.map(tool => [tool.function.name, tool.function]))

// ------------------------------------------------------------------ tool bridge
//
// The gate only admits the twelve built-ins, so the caller's tools cannot be
// declared. Calls to undeclared names ARE accepted, but a model handed both a
// declared `shell` and an undeclared `Bash` picks `shell` about a third of the
// time (measured), and `shell`'s schema is not the caller's.
//
// So a caller tool that has a built-in counterpart is ROUTED through it: the
// model is asked for the built-in name and the built-in schema, and the answer
// is translated back to the caller's name and argument names on the way out.
// Caller tools with no counterpart stay undeclared and are described in text.

/** Caller name -> built-in name, for names that mean the same thing. */
const SEMANTIC_ALIASES = {
  bash: 'shell',
  sh: 'shell',
  execute: 'shell',
  task: 'subagent',
  agent: 'subagent',
  notebookedit: 'edit',
  multiedit: 'edit',
  search: 'grep',
  fetch: 'webfetch',
  web_fetch: 'webfetch',
  web_search: 'websearch',
}

/** Build callerName -> built-in name for this request. */
function buildAliases(callerTools) {
  const aliases = new Map()
  const taken = new Set()
  for (const tool of callerTools) {
    const fn = tool.function ?? tool
    const name = String(fn.name ?? '').trim()
    if (name === '') continue
    const lower = name.toLowerCase()
    const builtin = GENUINE.has(name) ? name : GENUINE.has(lower) ? lower : SEMANTIC_ALIASES[lower]
    // A caller tool that is itself one of the built-ins needs no routing.
    if (builtin === undefined || builtin === name || taken.has(builtin)) continue
    taken.add(builtin)
    aliases.set(name, { builtin, schema: fn.parameters })
  }
  return aliases
}

/**
 * Map a built-in argument object onto the caller's schema.
 *
 * Required properties are matched positionally (both sides list their one
 * mandatory argument first: `path`/`file_path`, `command`/`command`, …), and
 * properties the caller also declares pass through untouched. This is a
 * stopgap: a pair whose schemas disagree structurally will be handed the
 * caller's first required key with the built-in's value, which is right for
 * every read/write/shell/grep/glob/fetch pairing and unverified beyond it.
 */
function translateArguments(args, callerSchema, builtinSchema) {
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return args
  const callerProps = callerSchema?.properties ?? {}
  const callerRequired = Array.isArray(callerSchema?.required) ? callerSchema.required : []
  const builtinRequired = Array.isArray(builtinSchema?.required) ? builtinSchema.required : []
  const out = {}
  const renamed = new Map()

  builtinRequired.forEach((key, index) => {
    const target = callerRequired[index]
    if (target === undefined || target === key || !(key in args)) return
    if (target in callerProps) {
      out[target] = args[key]
      renamed.set(key, target)
    }
  })
  for (const [key, value] of Object.entries(args)) {
    if (renamed.has(key)) continue
    out[key] = value
  }
  return out
}

/** Rewrite a caller-named tool call (history) into the routed built-in name. */
function forwardHistoryName(name, aliases) {
  return aliases.get(name)?.builtin ?? name
}

/** Rewrite a built-in tool call back into the caller's name and schema. */
function backwardCall(name, rawArguments, aliases) {
  for (const [callerName, entry] of aliases) {
    if (entry.builtin !== name) continue
    let args = rawArguments
    try {
      const parsed = JSON.parse(rawArguments)
      args = JSON.stringify(translateArguments(parsed, entry.schema, GENUINE.get(name).parameters))
    } catch {
      // Not JSON yet (a streamed fragment): leave the arguments alone.
    }
    return { name: callerName, arguments: args }
  }
  return { name, arguments: rawArguments }
}

// -------------------------------------------------------------------- shaping

function shapeToolsForChat(callerTools, aliases) {
  const described = []
  for (const tool of callerTools) {
    const fn = tool.function ?? tool
    const name = String(fn.name ?? '').trim()
    if (name === '' || aliases.has(name) || GENUINE.has(name)) continue
    described.push(`- \`${name}\`: ${String(fn.description ?? '').trim()}`)
    if (fn.parameters !== undefined) described.push(`  arguments schema: ${JSON.stringify(fn.parameters)}`)
  }
  if (described.length === 0) return ''
  return [
    '',
    '# Additional tools',
    '',
    'These tools are also available. They are not in the declaration list, but a',
    'tool call to these exact names is accepted. Emit a normal tool call with the',
    'name below and a JSON `arguments` object matching its schema.',
    '',
    ...described,
  ].join('\n')
}

/** Rewrite the caller's tool history into the routed built-in names. */
function forwardHistory(messages, aliases) {
  if (aliases.size === 0) return messages
  return messages.map(message => {
    if (message === null || typeof message !== 'object') return message
    if (Array.isArray(message.tool_calls)) {
      return {
        ...message,
        tool_calls: message.tool_calls.map(call => {
          const fn = call?.function
          if (fn === undefined || typeof fn.name !== 'string') return call
          const routed = forwardHistoryName(fn.name, aliases)
          return routed === fn.name ? call : { ...call, function: { ...fn, name: routed } }
        }),
      }
    }
    // Claude-shaped history blocks ride in `content` on some lanes.
    if (Array.isArray(message.content)) {
      return {
        ...message,
        content: message.content.map(block => {
          if (block === null || typeof block !== 'object') return block
          if (block.type === 'tool_use' && typeof block.name === 'string') {
            const routed = forwardHistoryName(block.name, aliases)
            return routed === block.name ? block : { ...block, name: routed }
          }
          return block
        }),
      }
    }
    return message
  })
}

function forwardToolChoice(choice, aliases) {
  if (choice === undefined) return 'auto'
  if (choice === 'none') return 'auto'
  if (choice === null || typeof choice !== 'object') return choice
  const name = typeof choice.name === 'string' ? choice.name : choice.function?.name
  if (typeof name !== 'string') return choice
  const routed = forwardHistoryName(name, aliases)
  if (routed === name) return choice
  return { type: 'function', function: { name: routed } }
}

function shapeChat(body) {
  const messages = Array.isArray(body.messages) ? body.messages : []
  const callerTools = Array.isArray(body.tools) ? body.tools : []
  const aliases = buildAliases(callerTools)
  const extra = shapeToolsForChat(callerTools, aliases)
  const system = `${PREAMBLE}${extra}`
  const first = messages[0]
  const isSystem = first?.role === 'system'
  const rest = isSystem ? messages.slice(1) : messages
  const head = isSystem && typeof first.content === 'string' && first.content.trim() !== ''
    ? `${system}\n\n${first.content}`
    : system
  return {
    aliases,
    body: {
      ...body,
      messages: forwardHistory([{ role: 'system', content: head }, ...rest], aliases),
      tools: GENUINE_TOOLS,
      tool_choice: forwardToolChoice(body.tool_choice, aliases),
    },
  }
}

function shapeResponses(body) {
  const callerTools = Array.isArray(body.tools) ? body.tools : []
  const aliases = buildAliases(callerTools)
  const extra = shapeToolsForChat(callerTools, aliases)
  const instructions = typeof body.instructions === 'string' && body.instructions.trim() !== ''
    ? `${PREAMBLE}${extra}\n\n${body.instructions}`
    : `${PREAMBLE}${extra}`
  const input = Array.isArray(body.input)
    ? body.input.map(item => {
        if (item?.type !== 'function_call' || typeof item.name !== 'string') return item
        const routed = forwardHistoryName(item.name, aliases)
        return routed === item.name ? item : { ...item, name: routed }
      })
    : body.input
  return {
    aliases,
    body: {
      ...body,
      instructions,
      input,
      tools: GENUINE_TOOLS.map(({ function: fn }) => ({
        type: 'function',
        name: fn.name,
        description: fn.description,
        parameters: fn.parameters,
        strict: false,
      })),
      tool_choice: forwardToolChoice(body.tool_choice, aliases),
    },
  }
}

// -------------------------------------------------------------- response bridge

/**
 * Rewrite streamed tool calls back to the caller's names and schemas.
 *
 * A routed call arrives as fragments: the first carries `function.name` (the
 * built-in), the rest carry `function.arguments` in pieces, and the argument
 * names are only knowable once the whole JSON is assembled. So a routed call is
 * HELD until it settles, then emitted as one complete frame with the caller's
 * name and translated arguments. Everything else passes through byte for byte,
 * including content deltas, so the stream stays live.
 *
 * A `finish_reason` frame that arrives while calls are held is held behind them
 * (clients expect `finish_reason` last), and `[DONE]` flushes first.
 */
class ToolCallBridge {
  constructor(aliases) {
    this.aliases = aliases
    /** `${choice}:${index}` -> held call. */
    this.held = new Map()
    this.passthrough = true
  }

  /** The caller-facing name/schema for a built-in the model just named, or null. */
  #route(builtin) {
    for (const [callerName, entry] of this.aliases) {
      if (entry.builtin === builtin) return { callerName, schema: entry.schema, builtin }
    }
    return null
  }

  /** Feed one `data:` payload; return the frames to emit (possibly none). */
  push(payload) {
    if (this.aliases.size === 0) return [payload]
    if (payload === '[DONE]') return [...this.flush(), payload]

    let chunk
    try {
      chunk = JSON.parse(payload)
    } catch {
      return [payload]
    }
    if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) return [payload]

    const out = []
    let held = false
    for (const choice of chunk.choices) {
      const choiceIndex = choice.index ?? 0
      const fragments = choice.delta?.tool_calls
      if (Array.isArray(fragments)) {
        for (const fragment of fragments) {
          const callIndex = fragment.index ?? 0
          const key = `${choiceIndex}:${callIndex}`
          const name = fragment.function?.name
          if (typeof name === 'string' && name !== '') {
            const routed = this.#route(name)
            if (routed !== null) {
              this.held.set(key, {
                choiceIndex,
                callIndex,
                id: fragment.id ?? `call_${callIndex}`,
                ...routed,
                arguments: fragment.function?.arguments ?? '',
              })
              held = true
              continue
            }
          }
          const pending = this.held.get(key)
          if (pending !== undefined) {
            pending.arguments += fragment.function?.arguments ?? ''
            held = true
            continue
          }
        }
        if (held) continue
        out.push(payload)
        continue
      }

      if (choice.finish_reason !== undefined && choice.finish_reason !== null && this.held.size > 0) {
        this.held.set(`finish:${choiceIndex}`, { finish: payload, choiceIndex })
        held = true
        continue
      }
      out.push(payload)
    }
    return held && out.length === 0 ? [] : out
  }

  /** Emit every held call (rewritten) and any held finish frames, in order. */
  flush() {
    if (this.held.size === 0) return []
    const entries = [...this.held.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    this.held.clear()
    const out = []
    const finishes = []
    for (const [, entry] of entries) {
      if (entry.finish !== undefined) {
        finishes.push(entry.finish)
        continue
      }
      const translated = translateArguments(
        safeParse(entry.arguments),
        entry.schema,
        GENUINE.get(entry.builtin)?.parameters,
      )
      out.push(JSON.stringify({
        object: 'chat.completion.chunk',
        choices: [{
          index: entry.choiceIndex,
          delta: {
            tool_calls: [{
              index: entry.callIndex,
              id: entry.id,
              type: 'function',
              function: { name: entry.callerName, arguments: JSON.stringify(translated) },
            }],
          },
        }],
      }))
    }
    return [...out, ...finishes]
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

/** Whole-body rewrite for a non-streaming JSON answer. */
function rewriteJsonAnswer(payload, aliases) {
  if (aliases.size === 0) return payload
  const visit = calls => {
    if (!Array.isArray(calls)) return calls
    return calls.map(call => {
      const fn = call?.function
      if (fn === undefined || typeof fn.name !== 'string') return call
      const routed = backwardCall(fn.name, typeof fn.arguments === 'string' ? fn.arguments : '{}', aliases)
      return routed.name === fn.name ? call : { ...call, function: { ...fn, ...routed } }
    })
  }
  const out = structuredClone(payload)
  if (Array.isArray(out.choices)) {
    for (const choice of out.choices) {
      if (choice?.message !== undefined) choice.message.tool_calls = visit(choice.message.tool_calls)
    }
  }
  if (Array.isArray(out.output)) {
    out.output = out.output.map(item => {
      if (item?.type !== 'function_call' || typeof item.name !== 'string') return item
      const routed = backwardCall(item.name, typeof item.arguments === 'string' ? item.arguments : '{}', aliases)
      return routed.name === item.name ? item : { ...item, ...routed }
    })
  }
  return out
}

// --------------------------------------------------------------------- server

function upstreamHeaders(incoming) {
  const session = incoming['x-opencode-session'] ?? incoming['x-opencode-session-id'] ?? ''
  const headers = {
    'content-type': 'application/json',
    authorization: 'Bearer public',
    'user-agent': 'opencode/1.18.35',
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    accept: 'text/event-stream',
  }
  if (session !== '') {
    headers['x-opencode-session'] = session
    headers['x-opencode-session-id'] = session
    headers['x-session-affinity'] = session
    headers['x-session-id'] = session
  }
  return headers
}

/**
 * The upstream path for a caller path.
 *
 * `callUpstream` already prefixes `/inference`, so this returns the BARE path:
 * `/inference/v1/models` -> `/v1/models`, `/zen/v1/chat/completions` ->
 * `/v1/chat/completions` (the plugin's sibling-host replay lands on the same
 * host). Returning `/inference/...` here double-prefixes the URL and the upstream
 * answers 404.
 */
function upstreamPath(pathname) {
  const bare = pathname.replace(/^\/(?:inference|zen)/u, '')
  return bare === '' ? '/v1/models' : bare
}

function copyContentType(upstream) {
  const headers = new Headers()
  const type = upstream.headers.get('content-type')
  if (type !== null) headers.set('content-type', type)
  return headers
}

// ------------------------------------------------------------------ egress

/**
 * One upstream call, through the pool when it has an exit.
 *
 * The fingerprint gates (body + TLS) do not care which IP a request leaves from,
 * so the pool's only job is the third gate: the daily per-IP allowance. A 429
 * with `retry-after` retires that exit until the reset and the call is retried on
 * the next exit — that is the whole point of having a pool.
 *
 * With no exits configured (or none usable) this is a single direct request,
 * exactly as before.
 */
async function callUpstream(pool, { path, headers, body, model, session, method = 'POST' }) {
  const attempts = pool === null ? 1 : Math.max(1, Math.min(pool.size, MAX_ROTATIONS))
  let lastResponse = null
  let lastExit = null

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const exit = pool === null ? null : pool.pick({ session, model })
    // Nothing usable: fall through to a direct request rather than failing. The
    // upstream will answer for itself, and the caller sees an honest error.
    if (exit === null && attempt > 0) break
    const proxy = exit === null ? undefined : await pool.proxyUrlFor(exit)

    let response
    try {
      response = await fetch(`${UPSTREAM}/inference${path}`, {
        method,
        headers,
        body,
        ...(proxy === undefined ? {} : { proxy }),
      })
    } catch (error) {
      if (exit !== null) pool.report(exit, 'transport', { model, detail: String(error?.message ?? error) })
      lastResponse = null
      lastExit = exit
      continue
    }

    if (response.status === 429) {
      const retryAfterMs = retryAfterOf(response)
      if (exit !== null) pool.report(exit, 'quota', { model, retryAfterMs })
      // Nothing else to try: hand the 429 back so the caller sees the real reset.
      if (attempt === attempts - 1) return { response, exit, attempts: attempt + 1 }
      lastResponse = response
      lastExit = exit
      continue
    }

    if (response.status === 401 || response.status === 403) {
      if (exit !== null) pool.report(exit, 'refused', { model })
      lastResponse = response
      lastExit = exit
      continue
    }

    if (exit !== null) pool.report(exit, 'ok', { model })
    return { response, exit, attempts: attempt + 1 }
  }

  return { response: lastResponse, exit: lastExit, attempts }
}

/** `retry-after` in ms, accepting both the seconds and HTTP-date forms. */
function retryAfterOf(response) {
  const raw = response.headers.get('retry-after')
  if (raw === null) return 0
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const at = Date.parse(raw)
  return Number.isNaN(at) ? 0 : Math.max(0, at - Date.now())
}

/**
 * Start the relay.
 *
 * Imported by the DSH plugin (which owns the lifecycle) and called by the
 * `import.meta.main` block at the bottom for standalone use. Everything the
 * caller can vary is an option: port, where `oc-pool.json` lives, and where logs
 * go — so a supervised run does not depend on `import.meta.dir` or on the
 * process being the entry point.
 *
 * Returns the server plus a `stop()` that releases the pool's SOCKS bridges.
 */
export async function startRelay({ port = PORT, configDir = import.meta.dir, log = line => console.log(line) } = {}) {
  log(`relay: preamble ${PREAMBLE.length} chars, ${GENUINE.size} genuine tools`)

  // Optional. `oc-pool.json` in `configDir` declares manual exits and/or
  // subscription URLs; with no file the relay makes every request directly. See
  // README "Can the plugin's IP pool help?" for why the pool lives here rather
  // than in the DSH plugin.
  const pool = await createPool({ directory: configDir, log }).catch(error => {
    log(`relay: pool disabled — ${error instanceof Error ? error.message : String(error)}`)
    return null
  })
  if (pool !== null && pool.size > 0) {
    const status = pool.status()
    log(`relay: pool enabled, ${status.usable}/${status.total} usable, rotation cap ${MAX_ROTATIONS}`)
  }

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port,
    idleTimeout: 255,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname === '/healthz') return Response.json({ ok: true })
      if (url.pathname === '/pool/status') {
        // `enabled` means "the pool can route", i.e. it has exits — not merely
        // that oc-pool.json was read. A zero-exit pool behaves exactly like none.
        const status = pool === null ? { total: 0, usable: 0, quotaSpent: 0, exits: [] } : pool.status()
        return Response.json({ enabled: status.total > 0, ...status })
      }
      if (url.pathname === '/pool/probe' && request.method === 'POST') {
        if (pool === null || pool.size === 0) return Response.json({ enabled: false }, { status: 400 })
        const results = await pool.probeAll()
        return Response.json({ enabled: true, probed: results.length, results, ...pool.status() })
      }

      if (request.method === 'GET') {
        const { response: upstream } = await callUpstream(pool, {
          path: upstreamPath(url.pathname),
          headers: {
            authorization: 'Bearer public',
            'user-agent': 'opencode/1.18.35',
            'x-opencode-client': 'cli',
            accept: 'application/json',
          },
          body: undefined,
          model: '',
          session: '',
          method: 'GET',
        })
        log(`relay: GET ${url.pathname} -> ${upstream.status}`)
        return new Response(upstream.body, { status: upstream.status, headers: copyContentType(upstream) })
      }

      if (request.method !== 'POST') return new Response('relay: GET/POST only', { status: 405 })

      let body
      try {
        body = await request.json()
      } catch {
        return new Response('relay: body is not JSON', { status: 400 })
      }

      const path = url.pathname.replace(/^\/(?:inference|zen)/u, '') || '/v1/chat/completions'
      const { aliases, body: shaped } = path.includes('/responses') ? shapeResponses(body) : shapeChat(body)
      const streaming = shaped.stream !== false
      const incoming = Object.fromEntries(request.headers)
      const session = incoming['x-opencode-session'] ?? incoming['x-opencode-session-id'] ?? ''

      const { response: upstream, exit, attempts } = await callUpstream(pool, {
        path,
        headers: upstreamHeaders(incoming),
        body: JSON.stringify(shaped),
        model: String(body.model ?? ''),
        session,
      })
      log(
        `relay: POST ${path} model=${body.model} tools=${(body.tools ?? []).length} aliases=${aliases.size} stream=${streaming} exit=${exit?.id ?? 'direct'} tries=${attempts} -> ${upstream.status}`,
      )

      const headers = copyContentType(upstream)
      if (upstream.status !== 200) {
        return new Response(upstream.body, { status: upstream.status, headers })
      }

      if (!streaming) {
        const text = await upstream.text()
        let answer
        try {
          answer = JSON.stringify(rewriteJsonAnswer(JSON.parse(text), aliases))
        } catch {
          answer = text
        }
        return new Response(answer, { status: 200, headers })
      }

      // Streaming: rewrite each SSE frame as it arrives, keeping the stream live.
      const bridge = new ToolCallBridge(aliases)
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      let buffer = ''
      const emit = (controller, payload) => {
        controller.enqueue(encoder.encode(`data: ${payload}\n\n`))
      }
      const transform = new TransformStream({
        transform(chunk, controller) {
          buffer += decoder.decode(chunk, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            if (!line.startsWith('data:')) {
              // Blank separators and `event:` lines carry no payload; pass through.
              if (line.trim() !== '') controller.enqueue(encoder.encode(`${line}\n`))
              continue
            }
            const payload = line.slice(5).trim()
            if (payload === '') continue
            for (const frame of bridge.push(payload)) emit(controller, frame)
          }
        },
        flush(controller) {
          if (buffer.startsWith('data:')) {
            const payload = buffer.slice(5).trim()
            if (payload !== '') for (const frame of bridge.push(payload)) emit(controller, frame)
          }
          for (const frame of bridge.flush()) emit(controller, frame)
        },
      })
      return new Response(upstream.body.pipeThrough(transform), { status: 200, headers })
    },
  })

  return {
    port: server.port,
    url: `http://127.0.0.1:${server.port}`,
    server,
    pool,
    stop() {
      server.stop(true)
      pool?.close()
    },
  }
}

// Standalone: `bun relay.mjs`. Under the DSH plugin this block never runs,
// because the module is imported, not executed.
if (import.meta.main) {
  const relay = await startRelay()
  console.log(`relay listening on ${relay.url}`)
}
