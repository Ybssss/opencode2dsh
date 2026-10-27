# Compaction deadlocks when the history already exceeds the routed window

Status: **upstream report, not fixed locally.** This document is the evidence
packet for a defect in `@deepseek-ai/dsh-compaction-basic`. Nothing in this
repository changes the behaviour described here; the tunable workaround that
*is* applied lives in the `compaction-basic` row of the desktop profile patch.

Line numbers below are from the **shipped bundle** as extracted from
`DeepSeek Harness/resources/app.asar` →
`dsh/node_modules/@deepseek-ai/dsh-compaction-basic/lib/index.js`
(DSH desktop `0.2.0-rc.2`, runtime Node `24.21.0`). Treat them as anchors into
the built artifact, not into a source tree.

## Summary

Compaction cannot reduce a history that is already larger than the model's
context window, because **the compaction request is itself as large as the span
it is asked to summarize**. Summarizing a 650k-token history requires sending
~650k tokens to the same model that just rejected a 650k-token request. It fails
with the identical error, in about a second, having generated no output.

The turn fails with `CONTEXT_WINDOW_EXCEEDED`; automatic overflow recovery fails
identically; and a manual `/compact` fails identically. The only mechanism that
could reduce the history requires the history to already fit. The session is
unrecoverable without dropping messages externally.

## Symptom

```
This turn failed  400 {"message":"Your request resulted in more tokens than this
model's maximum context length allows. Please reduce the length of the messages or
run compaction.","type":"invalid_request_error","code":"context_length_exceeded"}
CONTEXT_WINDOW_EXCEEDED

compact
Compaction could not produce a useful summary. The attempt is recorded in the
session log.
```

The `/compact` line is misleading: no summary was attempted and rejected for
quality. The summarization request never reached the model.

## Measured evidence

Session log: `$DSH_HOME/sessions/…/session-f02b7812-1626-45c9-802d-e3a35dac7f08`
(4,088 durable records; the log is a multi-frame zstd JSONL, 139 frames,
15.5 MB decompressed).

Recorded routes (`request/context`):

| seq | provider/model | contextWindow |
| --- | --- | --- |
| 13 | `opencode2dsh/deepseek-v4.1-flash-free` | 300,000 |
| 53 | `xdpool-global/deepseek-v4.1-flash` | 1,000,000 |
| 3768 | `xdpool-global/deepseek-v4.1-flash-sg` | 1,000,000 |
| 3827 | `xdpool-global/deepseek-v4.1-flash` | 1,000,000 |
| 4045 | `xdpool-global/deepseek-v4.1-flash-sg` | 1,000,000 |
| 4059 | `opencode2dsh/deepseek-v4.1-flash-free` | 300,000 |

The session lived on a 1,000,000-token route for ~4,000 records. Peak wire
`usage.input` observed: **651,658**. Pressure compaction never fired there
(threshold on that route: 800,000) — correctly, since there was room.

At record 4049 the model selection changed to the 300,000-token free route, and
the **first** request on the new route (turn 33, record 4060) was the entire
651,658-token history:

```
4049  model/selection     opencode2dsh/deepseek-v4.1-flash-free
4051  agent/inbox/spliced "continue"
4052  turn/start          turn 33
4059  request/context     contextWindow: 300000
4060  assistant/attempt   finish: { kind: 'error', code: 'CONTEXT_WINDOW_EXCEEDED' }
4061  compaction/prune    first prune event (8 total)
4077  compaction/start    automatic overflow recovery
4078  compaction/end      error: 400 … context_length_exceeded   (1,030 ms later)
4083  command/run         name: compact
4084  compaction/start
4085  compaction/end      error: 400 … context_length_exceeded   (1,966 ms later)
4086  command/done        "Compaction could not produce a useful summary."
```

Budget arithmetic for that route (from `resolveCompactSpec`):

```
contextWindow                 300,000
reservedCompletionTokens       32,000   (the request's declared maxTokens)
messageBudgetTokens           268,000
headroomTokens                 65,536   (default)
pressureBudgetTokens          202,464
thresholdTokens               202,464   (= floor(min(0.8 × 300000, 202464)))
```

The history exceeded the threshold by **449,194 tokens** when compaction was
first consulted. The tool-result pruner, which runs first, freed **39,888
tokens across 8 nodes** — about 6% of the shortfall, and it can only rewrite
`tool/result` nodes, never assistant text.

## Root cause

### The compaction request is the size of the span it condenses

`compactIfNeeded` on the overflow trigger (line 927) requests a maximal head
reduction:

```js
const range = selectCompactableRange(agent.session, measurement, 0);
if (range === null) return null;
return this.compactRegion(range.start, range.end, agent, signal);
```

Manual `/compact` does the same (`compactNow`, line 992). `retainTokens = 0`
means "retain as little as possible". Reading `selectCompactableRange`
(lines 411–434), the retained tail under that value is the **last balanced
unit** — typically one step — because the accumulation loop breaks immediately:

```js
for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
  accumulated += pricedNodes[index].tokens;
  keepFromIdx = index;
  if (accumulated >= retainTokens) break;      // retainTokens = 0 -> breaks at once
}
```

The selected range is therefore everything **except** that final unit:
`[firstIdx .. keepFromIdx - 1]`. Everything in that range is then replayed:

```js
function buildSummarizationInput(session, shadowedSeqs) {
  const header = session.requestHeader();
  const head = systemHead(session, session.surface.nodes[0]);
  const system = head === void 0 ? null : session.deriveEventMessage(head);
  const regionMessages = shadowedSeqs.map((seq) => session.deriveEventMessage(session.eventAt(seq))).filter((message) => message !== null);
  return {
    ...header?.tools === void 0 ? {} : { tools: header.tools },
    messages: system === null ? regionMessages : [system, ...regionMessages]
  };
}
```

and sent with no size comparison:

```js
const options = {
  provider: target.provider,
  model: target.model,
  messages,                          // system head + the whole shadowed span
  toolHistory: agent.session.toolHistory(),
  ...input.tools === void 0 ? {} : { tools: [...input.tools] },
  maxTokens: config.maxTokens,
  sessionId: agent.session.id,
  purpose: 'compaction',
  ...signal === void 0 ? {} : { signal }
};
for await (const chunk of ctx.llm.stream(options)) assembler.push(chunk);
```

So for the failing session the summarization request carried roughly
**640k–650k tokens** against a 268,000-token message budget, and the provider
answered with the same 400 in ~1 s. This is not a ratio problem or a tuning
problem: any attempt to summarize a span larger than the window produces a
request larger than the window.

The package README acknowledges a related boundary:

> **Some indivisible-unit and envelope-only overflow remains outside surface
> compaction** — recovery cannot shrink system/tools/prefix, split an
> indivisible non-tool node, or repair a tool unit whose non-prunable remainder
> still exceeds the window.

The failing case is the general form of that limit: recovery needs a reduction
larger than the window, and the reduction mechanism transmits the whole thing.

### Consequence: recovery is not a recovery

`agent/request-error` (line 862) attempts compaction, which throws, and logs:

```
context-overflow compaction failed: … ; preserving the original request error
```

The retry guard requires `surface.replaceGeneration` to advance (line 884); no
replacement was written, so no retry is possible and `maxOverflowRetries` never
comes into play. `compaction/summary-error` is dispatched, but the only
subscriber in this installation — `dsh-compaction-image-offload` — handles
`IMAGE_OFFLOAD_REQUIRED_CODE` only and calls `next()` for everything else,
reaching the `() => false` default (lines 1018–1023).

### The second, independent trigger: route downshift

Compaction is route-relative — `resolveTargetPolicy` keys on `provider/model`
and `thresholdTokens` derives from that route's `contextWindow` — while the
conversation history is route-absolute. A model switch to a **smaller** window
therefore admits an immediate overflow with no pre-flight check: the new
route's pressure listener has never seen this history, and the first request on
the new route is already over budget. That is how this session reached the
deadlock on its first turn after the switch, having been healthy before it.

## Proposed fixes (in priority order)

1. **Bound the summarization request (required).** Before `ctx.llm.stream()` in
   `summarizeWithLlm`, price the replayed messages and, while
   `replayedTokens + maxTokens > contextWindow`, drop the oldest non-system
   message (or elide its middle with the existing prune marker) until it fits.
   The compaction instruction is appended last, so the most recent content —
   the part that carries continuity — survives. A summary of the newest N
   tokens of an oversized span is still a useful checkpoint; a failed request
   is not.

2. **Make overflow reduction iterative.** If one pass cannot bring the surface
   under the window (because it could only shadow a prefix), repeat with the
   next bounded chunk until it does, recording durable progress between passes
   so the retry guard can fire. Today `compactionRetries` only applies to the
   pressure path; the overflow path makes a single attempt.

3. **Add a pre-flight downshift check.** On a route change to a smaller
   `contextWindow`, compare the projected history against the new window and
   either compact before the first request or fail fast with an actionable
   message ("history 651k exceeds this model's 300k window; start a new session
   or switch back") instead of spending a request to learn it.

4. **Give `compaction/summary-error` a listener for this class** that records
   durable progress (e.g. the trimming from fix 1) so the retry guard can fire.
   The image-offload subscriber demonstrates the pattern; it simply does not
   cover context errors.

## Workaround available today (config only)

Bounding the summarizer is a code change, so it cannot be done from
configuration. Configuration can restore the documented threshold and shrink
the summarizer's own output reservation:

```yaml
- id: compaction-basic
  name: "@deepseek-ai/dsh-compaction-basic"
  config:
    thresholdRatio: 0.8
    headroomTokens: 16384     # also sets maxTokens (resolveConfig)
    retainRatio: 0.16
    compactionRetries: 2
    maxOverflowRetries: 3
```

With the shipped `headroomTokens: 65536`, `pressureBudgetTokens` (202,464)
binds before `0.8 × contextWindow` (240,000), so the documented 0.8 behaviour
silently does not apply. The values above restore the 240,000 threshold and cut
the summarizer's output reservation from 65,536 to 16,384, buying margin on
every compaction that does fit.

**This does not fix the deadlock.** It lowers how often history approaches the
boundary; it cannot compact a history that is already over the window, for the
structural reason above.

## Reproduction

Deterministic, no provider needed:

1. Give a route an advertised `contextWindow` of `W` and accumulate a surface
   whose total priced size exceeds `W - maxTokens`.
2. Trigger `compactNow` (or an `agent/request-error` with
   `CONTEXT_WINDOW_EXCEEDED`).
3. Observe `compaction/start` immediately followed by `compaction/end` carrying
   the provider's context error, with no `compaction/summary` record and no
   surface replacement.

A unit test can assert the invariant directly: for any surface,
`priced(summarizationInput) + maxTokens <= contextWindow`, or the input is
trimmed until it holds.
