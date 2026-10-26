// Runs every suite and reports one total.
//
//   bun test/run-all.mjs      # everything (pool suites need Bun)
//   node test/supervisor.test.mjs   # just the host half, under Node
//
// The supervisor suite runs under Node on purpose: it is the code DSH loads, and
// a Bun-only API leaking into it must fail here rather than in DSH.

import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const HERE = import.meta.dir
const BUN = process.execPath

/** Suites that must run under Bun (they use Bun.serve / Bun.file). */
const BUN_SUITES = [
  'pool-parsers.test.mjs',
  'pool-behaviour.test.mjs',
  'pool-relay.test.mjs',
  'pool-live.test.mjs',
]

/** Suites that must run under Node (the DSH host half). */
const NODE_SUITES = ['supervisor.test.mjs', 'apply.test.mjs']

const isBun = typeof globalThis.Bun !== 'undefined'
const nodeExe = process.env.OC_TEST_NODE ?? 'node'

let totalPass = 0
let totalFail = 0
const failures = []

function run(label, command, args) {
  const result = spawnSync(command, args, { cwd: join(HERE, '..'), encoding: 'utf8', timeout: 300_000 })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const summary = /(\d+) passed, (\d+) failed/u.exec(output)
  if (summary === null) {
    totalFail += 1
    failures.push(`${label}: no summary (exit ${result.status})`)
    console.log(`\n### ${label}\n${output.split('\n').slice(-12).join('\n')}`)
    return
  }
  const [, passed, failed] = summary
  totalPass += Number(passed)
  totalFail += Number(failed)
  console.log(`${label.padEnd(28)} ${passed.padStart(3)} passed, ${failed} failed`)
  if (Number(failed) > 0) failures.push(`${label}: ${failed} failed`)
}

console.log(`relay package tests (${isBun ? 'bun' : 'node'} ${process.version})\n`)

// Pool suites: run under Bun. If this runner is Node, hand off to a Bun child.
if (isBun) {
  for (const suite of BUN_SUITES) run(suite, BUN, [join(HERE, suite)])
} else {
  const bun = process.env.OC_TEST_BUN
  if (bun === undefined) {
    console.log(`skipping ${BUN_SUITES.length} Bun suites (set OC_TEST_BUN to the bun executable)`)
  } else {
    for (const suite of BUN_SUITES) run(suite, bun, [join(HERE, suite)])
  }
}

// The supervisor suite always runs under Node — that is the point of it.
if (!isBun) {
  for (const suite of NODE_SUITES) run(suite, nodeExe, [join(HERE, suite)])
} else {
  for (const suite of NODE_SUITES) run(suite, nodeExe, [join(HERE, suite)])
}

console.log(`\n${totalPass} passed, ${totalFail} failed`)
if (failures.length > 0) {
  console.log('failures:')
  for (const failure of failures) console.log(`  - ${failure}`)
}
process.exit(totalFail === 0 ? 0 : 1)
