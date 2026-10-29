#!/usr/bin/env node
// Flip opencode2dsh onto a locally built @opencode2dsh/dsh-plugin so the
// opt-in v2 Bun transport (PR #110) exists in the running adapter.
//   --check   report only, no network, no writes
//   --revert  restore the profile from the last backup
// Nothing is written unless the build produced lib/index.js + lib/bun-worker.mjs.
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PLUGIN = join(REPO, 'packages', 'plugin')
const HOME = process.env.USERPROFILE ?? ''
const PROFILE = join(HOME, '.dsh', 'profiles', 'desktop')
const PNPM = join(HOME, '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.cjs')
const DSH = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd')
const PKG = join(PROFILE, 'package.json')
const PATCH = join(PROFILE, 'cordis.patch.yml')
const KEY = '@opencode2dsh/dsh-plugin'
const args = new Set(process.argv.slice(2))
const run = (file, argv, cwd) => execFileSync(file, argv, { cwd, stdio: 'inherit' })
const json = (file) => JSON.parse(readFileSync(file, 'utf8'))
const stamp = () => new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 19)
const built = () => existsSync(join(PLUGIN, 'lib', 'index.js')) && existsSync(join(PLUGIN, 'lib', 'bun-worker.mjs'))
const carried = () => existsSync(join(PLUGIN, 'lib', 'index.js'))
  ? readFileSync(join(PLUGIN, 'lib', 'index.js'), 'utf8').includes('bunTransport')
  : false
// --- part 2 ---
function status() {
  const pkg = json(PKG)
  const override = pkg.pnpm?.overrides?.[KEY] ?? null
  const installed = join(PROFILE, 'node_modules', '@opencode2dsh', 'dsh-plugin', 'lib', 'index.js')
  const version = existsSync(join(PROFILE, 'node_modules', '@opencode2dsh', 'dsh-plugin', 'package.json'))
    ? json(join(PROFILE, 'node_modules', '@opencode2dsh', 'dsh-plugin', 'package.json')).version
    : '(not installed)'
  const live = existsSync(installed) && readFileSync(installed, 'utf8').includes('bunTransport')
  console.log(`repo        ${REPO}`)
  console.log(`profile     ${PROFILE}`)
  console.log(`source lib  ${built() ? 'built' : 'NOT BUILT'}  bunTransport=${carried()}`)
  console.log(`override    ${override ?? '(none)'}`)
  console.log(`installed   ${version}  bunTransport=${live}`)
  console.log(`enabled     ${pkg.pnpm?.overrides?.[KEY] && live ? 'yes' : 'no'}`)
  const anchor = /(- id: opencode2dsh\s*\r?\n\s+name: "?@opencode2dsh\/dsh-plugin"?,?\s*\r?\n\s+config:\s*\r?\n)/u
  console.log(`patch point ${anchor.test(readFileSync(PATCH, 'utf8')) ? 'found' : 'NOT FOUND'}  hasBun=${readFileSync(PATCH, 'utf8').includes('bunTransport:')}`)
  return { override, live }
}

function newest(prefix) {
  const dir = readdirSync(PROFILE)
  const hits = dir.filter((name) => name.startsWith(prefix)).sort()
  return hits.length > 0 ? join(PROFILE, hits[hits.length - 1]) : null
}

function revert() {
  const pkgBak = newest('package.json.bak-bun-')
  const patchBak = newest('cordis.patch.yml.bak-bun-')
  if (!pkgBak || !patchBak) {
    console.log('revert: no backups found (package.json.bak-bun-* / cordis.patch.yml.bak-bun-*)')
    return
  }
  copyFileSync(pkgBak, PKG)
  copyFileSync(patchBak, PATCH)
  console.log(`revert: restored ${pkgBak.replace(PROFILE, '.')} and ${patchBak.replace(PROFILE, '.')}`)
  run('cmd.exe', ['/c', DSH, 'plugin', '--profile', 'desktop', 'install'], REPO)
  status()
}
// --- part 3 ---
function build() {
  if (!existsSync(PNPM)) throw new Error(`pnpm not found: ${PNPM}`)
  if (!existsSync(join(PLUGIN, 'node_modules'))) {
    console.log('build: installing devDependencies (needs npm registry access)...')
    run(process.execPath, [PNPM, 'install', '--ignore-scripts'], PLUGIN)
  }
  console.log('build: tsdown ...')
  run(process.execPath, [PNPM, 'run', 'build'], PLUGIN)
  if (!built() || !carried()) {
    throw new Error(`build produced no usable lib (built=${built()} bunTransport=${carried()})`)
  }
  console.log('build: OK — lib/index.js carries bunTransport, lib/bun-worker.mjs present')
}

function wire() {
  if (!built() || !carried()) throw new Error('refusing to wire: build artifacts missing')
  const tag = `bak-bun-${stamp()}`
  copyFileSync(PKG, `${PKG}.${tag}`)
  copyFileSync(PATCH, `${PATCH}.${tag}`)

  const pkg = json(PKG)
  pkg.pnpm ??= {}
  pkg.pnpm.overrides ??= {}
  pkg.pnpm.overrides[KEY] = `file:${PLUGIN.replace(/\\/gu, '/')}`
  writeFileSync(PKG, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8')

  let text = readFileSync(PATCH, 'utf8')
  if (!text.includes('bunTransport:')) {
    const anchor = /(- id: opencode2dsh\s*\r?\n\s+name: "?@opencode2dsh\/dsh-plugin"?,?\s*\r?\n\s+config:\s*\r?\n)/u
    if (!anchor.test(text)) throw new Error('could not find the opencode2dsh row config block to patch')
    text = text.replace(anchor, `$1    bunTransport:\n      enabled: true\n      clientVersion: '2.2.0'\n`)
    writeFileSync(PATCH, text, 'utf8')
  }

  console.log(`wire: override ${KEY} -> file:${PLUGIN}`)
  run('cmd.exe', ['/c', DSH, 'plugin', '--profile', 'desktop', 'install'], REPO)
  status()
}

if (args.has('--revert')) revert()
else if (args.has('--check')) status()
else {
  build()
  wire()
}


