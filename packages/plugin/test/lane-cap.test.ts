/**
 * Lane-cap bookkeeping: the shared anonymous credential is metered by the
 * provider, so a 429 with a long window is not an exit-level failure. These
 * tests pin the two independent sources of that signal (an admission header
 * and an adapter error body) and the daily-reset fallback.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  isFreeLaneExhausted,
  laneCapRemainingMs,
  laneCapResetLabel,
  laneCapUntil,
  clearLaneCap,
  nextUtcMidnight,
  noteLaneCap,
  noteLaneCapFromMessage,
} from '../src/pool/lane-cap.ts'

const NOW = Date.UTC(2026, 9, 29, 3, 0, 44) // 2026-10-29T03:00:44Z

test('a short 429 stays exit-level; a long Retry-After records a lane cap', () => {
  clearLaneCap()
  assert.equal(noteLaneCap(15, NOW), 0)
  assert.equal(laneCapRemainingMs(NOW), 0)
  const until = noteLaneCap(75556, NOW)
  assert.equal(until, NOW + 75556 * 1000)
  assert.equal(laneCapRemainingMs(NOW), 75556 * 1000)
  assert.equal(laneCapUntil(), until)
  clearLaneCap()
})

test('the reset the provider actually used is the next UTC midnight', () => {
  assert.equal(nextUtcMidnight(NOW), Date.UTC(2026, 9, 30))
  assert.equal(nextUtcMidnight(Date.UTC(2026, 9, 29, 23, 59, 59)), Date.UTC(2026, 9, 30))
})

test('only the shared lane error body marks a cap', () => {
  assert.equal(isFreeLaneExhausted('Free usage limit reached.'), true)
  assert.equal(isFreeLaneExhausted('{"type":"FreeUsageLimitError"}'), true)
  assert.equal(isFreeLaneExhausted('429 rate limit exceeded'), false)
})

test('an adapter error records the daily reset and a reset label', () => {
  clearLaneCap()
  assert.equal(noteLaneCapFromMessage('429: {"type":"FreeUsageLimitError"}', NOW), Date.UTC(2026, 9, 30))
  assert.match(laneCapResetLabel(NOW), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/)
  clearLaneCap()
})
