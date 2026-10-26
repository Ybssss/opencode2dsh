# opencode2dsh-relay

A supervised Bun relay for the [opencode2dsh](https://github.com/FishBottle7/opencode2dsh)
plugin, plus an exit pool.

**Why it exists.** Since 2026-10-25 the opencode.ai free tier gates on two
independent things, and the plugin satisfies neither:

| Gate | Requirement | Plugin |
|---|---|---|
| 1. Body | CLI harness preamble + the CLI's 12 genuine tool definitions | sends 2 tools, no preamble |
| 2. TLS stack | a BoringSSL ClientHello (Bun); OpenSSL/Node and Schannel are refused | runs on Node |

Measured from one IP with the same body and headers: Bun `fetch` 200, Bun
`node:https` 200, Node `fetch`/`node:https`/`node:http2` 429, `curl.exe` 429.
Repeatable, same egress IP — a handshake fingerprint, not per-IP quota. That is
why no plugin patch can fix it: DSH is a Node process.

This package runs the relay on Bun (gate 2), reshapes each request into the
accepted body (gate 1), and bridges tool calls back to DSH's own names and
argument schemas. It starts and stops with DSH.

## Install

```powershell
# 1. this package into the profile
dsh plugin --profile desktop add github:Ybssss/opencode2dsh#master

# 2. point the opencode2dsh plugin at the relay (it has no base-URL setting)
.\scripts\point-plugin-at-relay.ps1

# 3. restart DSH
```

Step 2 is required and irreversible from inside the plugin: `ZEN_BASE_URL` is a
module constant, and the profile's `node_modules` are pnpm hardlinks, so the
script breaks the link before rewriting it (editing in place would corrupt the
shared store for every other project).

Check it:

```powershell
dsh plugin --profile desktop list          # opencode2dsh-relay should be Running
curl http://127.0.0.1:8899/healthz         # {"ok":true}
```

## Config

`cordis.patch.yml` row, all fields optional:

```yaml
- id: opencode2dsh-relay
  name: opencode2dsh-relay
  config:
    port: 8899            # must match the plugin's base URL
    bunPath: ''           # explicit bun.exe; else auto-detected
    autoStart: true       # false = manage nothing, report only
    restartDelayMs: 2000  # first restart delay, doubles per failure
```

The supervisor is deliberately conservative:

- **Already running?** If the port answers `/healthz` it is adopted, not duplicated.
- **Port taken by something else?** Reported as `port-busy` and left alone.
- **No Bun?** Reported as `no-bun` with the install hint; nothing is spawned.
- **Crashes while DSH runs?** Restarted with exponential backoff, capped at 30s.
- **Plugin unload / DSH shutdown?** `ctx.effect`'s disposer stops the child, so no
  orphan process and no port left bound.

A failed start never throws — the rest of the DSH host keeps working.

## Exit pool

The relay's third gate is the **daily per-IP allowance**. A pool is the only thing
that helps there, so the relay can rotate exits.

```powershell
bun relay/cli.mjs add socks5://user:pass@5.6.7.8:1080
bun relay/cli.mjs add http://1.2.3.4:8080
bun relay/cli.mjs subscribe https://airport.example/sub
bun relay/cli.mjs probe
```

Exits live in `relay/oc-pool.json`, read at relay startup. Behaviour:

| Upstream says | Pool does |
|---|---|
| 200 | serves, marks the exit `ok` |
| 429 + `retry-after` | parks that exit until its reset, retries the next |
| 401 / 403 | bans **that model** on that exit, retries elsewhere |
| transport error | backoff 1→2→4…30 min, `dead` after 3 strikes |

Sessions stick to one exit (prompt cache survives); new conversations go to the
least-used one. Rotation caps at `OC_RELAY_MAX_ROTATIONS` (default 4). When every
exit is parked the relay goes direct rather than failing, so you see the honest
upstream error.

**Supported:** `http`, `https`, `socks5`, `socks5h`. SOCKS5 gets a private
loopback CONNECT bridge because Bun's `fetch` rejects the scheme outright.
**Not supported:** `vmess`, `vless`, `trojan`, `ss`, `hysteria2` — point the pool
at a local sing-box SOCKS5 instead. `bun relay/cli.mjs test-subscription <url>`
reports how many nodes in a subscription are actually dialable.

Endpoints: `GET /healthz`, `GET /pool/status`, `POST /pool/probe`.

## Tests

```powershell
bun test/run-all.mjs        # 72 tests
node test/supervisor.test.mjs   # host half only, under Node (as DSH runs it)
```

The supervisor suite runs under Node on purpose: it is the code DSH loads, so a
Bun-only API leaking into it must fail there rather than in DSH.

## Known limits

- The fingerprint is a **capture**, not a spec. When upstream rotates the preamble
  or the tool definitions, `relay/fingerprint.mjs` needs a fresh capture from a
  real CLI. `relay/` and `POOL.md` in the parent repo document how it was taken.
- Argument translation routes through the matching built-in and maps the first
  required key positionally. Correct for read/write/edit/shell/grep/glob/fetch;
  unverified for other pairings.
- `muse-spark` (Responses lane) answers 401 — region-blocked here, and on the
  plugin's own blocklist.
- Keep `deepseek-v4.1-flash-free` selected: `glm-5.3-flash-free` and `big-pickle`
  narrate instead of emitting tool calls.

## License

MIT, matching the upstream plugin.
