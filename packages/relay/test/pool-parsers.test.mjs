// Parser tests for oc-pool.mjs. No network, no exits.
//
//   bun pool-parsers.test.mjs

import { parseClashYaml, parsePlainList, parseProxyUrl, parseSubscription } from '../relay/pool.mjs'

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

// ------------------------------------------------------------ single addresses

const cases = [
  ['http://1.2.3.4:8080', 'http', '1.2.3.4', 8080],
  ['https://5.6.7.8:443', 'https', '5.6.7.8', 443],
  ['socks5://9.9.9.9:1080', 'socks5', '9.9.9.9', 1080],
  ['socks5h://9.9.9.9:1080', 'socks5', '9.9.9.9', 1080],
  ['10.0.0.1:3128', 'http', '10.0.0.1', 3128],
  ['user:p%40ss@1.2.3.4:8080', 'http', '1.2.3.4', 8080],
]
for (const [input, protocol, host, port] of cases) {
  const exit = parseProxyUrl(input, 'test')
  check(
    `parse ${input}`,
    exit !== null && exit.protocol === protocol && exit.host === host && exit.port === port,
    exit === null ? 'null' : `${exit.protocol} ${exit.host}:${exit.port}`,
  )
}

// Credentials survive decoding.
{
  const exit = parseProxyUrl('http://user:p%40ss@1.2.3.4:8080', 'test')
  check('credentials decoded', exit?.username === 'user' && exit?.password === 'p@ss', `${exit?.username}/${exit?.password}`)
}

// Rejected shapes.
for (const bad of ['', '# comment', 'not a proxy', 'ftp://1.2.3.4:21', 'http://1.2.3.4', 'vmess://abc']) {
  check(`reject ${JSON.stringify(bad)}`, parseProxyUrl(bad, 'test') === null)
}

// ----------------------------------------------------------------- plain lists

{
  const list = parsePlainList('1.1.1.1:8080\n2.2.2.2:9090\n# skip me\n\nsocks5://3.3.3.3:1080', 'manual')
  check('plain list: 3 exits', list.length === 3, `${list.length}`)
}

{
  // A base64-wrapped list, as most airports return for the v2ray UA.
  const raw = '4.4.4.4:8080\n5.5.5.5:9090\n'
  const encoded = Buffer.from(raw, 'utf8').toString('base64')
  const list = parsePlainList(encoded, 'sub')
  check('base64 list: 2 exits', list.length === 2, `${list.length}`)
}

// ---------------------------------------------------------------- clash YAML

const clash = `
proxies:
  - name: "us-1"
    type: http
    server: us1.example.com
    port: 8080
    username: u
    password: p
  - name: socks-node
    type: socks5
    server: 6.6.6.6
    port: 1080
  - name: https-node
    type: https
    server: 7.7.7.7
    port: 443
  - name: unsupported-vmess
    type: vmess
    server: 8.8.8.8
    port: 443
    uuid: abc
  - name: trojan-node
    type: trojan
    server: 9.9.9.9
    port: 443
proxy-groups:
  - name: auto
    type: url-test
`
{
  const exits = parseClashYaml(clash, 'clash')
  check('clash: 3 dialable of 5', exits.length === 3, `${exits.length}: ${exits.map(e => e.label).join(', ')}`)
  check('clash: http node credentials', exits[0]?.username === 'u' && exits[0]?.password === 'p')
  check('clash: hostnames kept', exits[0]?.host === 'us1.example.com', exits[0]?.host)
  check('clash: socks5 detected', exits[1]?.protocol === 'socks5', exits[1]?.protocol)
  check('clash: https detected', exits[2]?.protocol === 'https', exits[2]?.protocol)
}

{
  // Inline flow style, which some generators emit.
  const inline = 'proxies:\n  - {name: a, type: http, server: 1.1.1.1, port: 8080}\n'
  const exits = parseClashYaml(inline, 'clash')
  check('clash: inline flow style', exits.length === 1, `${exits.length}`)
}

// ------------------------------------------------------------ format dispatch

{
  const fromClash = parseSubscription(clash, 'sub')
  check('dispatch: clash body', fromClash.length === 3, `${fromClash.length}`)
  const fromPlain = parseSubscription('1.1.1.1:8080\n2.2.2.2:8080\n', 'sub')
  check('dispatch: plain body', fromPlain.length === 2, `${fromPlain.length}`)
}

// ------------------------------------------------------------------- summary

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail === 0 ? 0 : 1
