# Architecture

Detailed architecture of pi-parallelaudit. Start with the [README](./README.md)
for usage and configuration, then read this for internals.

For hard-won gotchas and edge cases, see [README_misc.md](./README_misc.md).

## Overview

```
┌─ Primary AgentSession (omp) ───────────────────────────────┐
│                                                            │
│  turn_end ──▶ feedCurrentDelta                             │
│                  │                                         │
│                  ├─ render messages since cursor           │
│                  ├─ chunk into turns if backlog > 1 user   │
│                  └─ feed() each turn ──────┐               │
│                                           ▼               │
│              ┌─ Monitor AgentSession (in-memory) ──────┐  │
│              │                                          │  │
│              │  session.prompt("### Session update")    │  │
│              │       │                                  │  │
│              │       ▼                                  │  │
│              │  message_update ──▶ live[] (streaming)   │  │
│              │  message_end   ──▶ buffer[] (committed)  │  │
│              │                  turnSources[] (index)   │  │
│              └──────────────────────────────────────────┘  │
│                           │                               │
│                           ▼                               │
│              ┌─ UI ──────────────────────────────────┐    │
│              │  setWidget: live tail panel           │    │
│              │  custom(overlay): /observe full       │    │
│              │    audit mode | stacked compare mode  │    │
│              └───────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────┘
```

## Data flow

### 1. Primary turn ends → `feedCurrentDelta`

`pi.on("turn_end")` fires after each primary turn. `feedCurrentDelta`:

1. Reads the full transcript via `buildSessionContext(ctx.sessionManager.getBranch())`.
2. Slices messages from `cursor` to end.
3. **Multi-turn detection**: if the slice has > 1 user message (backlog after
   resume, or the user sent a follow-up while the monitor was busy),
   `chunkByTurn` splits it at each user message boundary. Each chunk is
   rendered and fed individually.
4. **Single turn**: renders the slice and feeds it as one delta.
5. Advances `cursor` to `messages.length`.

### 2. `feed()` → `runTurn()`

`feed()` is **fire-and-forget** — it never blocks the `turn_end` handler. It
starts a `void (async () => ...)()` IIFE:

1. `ensureMonitor(pi, ctx)` — lazily creates the monitor `AgentSession` on
   first use (idempotent after that).
2. If `monitorBusy`: pushes the delta to `pendingDeltas` queue and returns.
3. If idle: calls `runTurn()`.

`runTurn()`:

1. Sets `monitorBusy = true`.
2. Pushes a `━━━ turn · label ━━━` divider to `buffer`.
3. Records `{ label, source }` in `turnSources` (for the stacked compare view).
4. `await session.prompt("### Session update\n\n" + delta)`.
5. On quota error: sets `monitorQuotaExceeded`, clears queue, pushes visible
   `⛔` message.
6. On other error: retries (up to 3 consecutive failures, then drops).
7. **Finally**: shifts next delta from `pendingDeltas` and recurses. Each
   queued delta gets its own `runTurn` — **no coalescing**, so per-turn
   boundaries are preserved.

### 3. Monitor streaming → `handleMonitorEvent`

The monitor session's events flow through `session.subscribe(handleMonitorEvent)`:

- **`message_update`**: rebuilds `live[]` from the cumulative assistant message
  (in-place, not append — see [streaming gotcha](./README_misc.md#message_update-carries-the-full-cumulative-message-not-a-delta)).
  Calls `requestActiveRender()` to repaint.
- **`message_end`**: appends final content to `buffer[]`, clears `live[]`,
  pushes a blank separator line.

### 4. Rendering

Two surfaces read from `buffer[]` + `live[]`:

**Widget panel** (`/observe`):
- Fixed height (`WIDGET_HEIGHT = 12` body rows + 1 header).
- Renders the last N lines of `[...buffer, ...live]` through `pi.pi.Markdown`.
- Non-modal: never grabs keyboard focus.
- `requestActiveRender()` triggers `tui.requestRender()` on each monitor event.

**Full modal** (`/observe full` / `/observe full-stacked`):
- Modal overlay via `ctx.ui.custom(factory, { overlay: true })`.
- Holds focus until `Esc`/`q`.
- Two modes (toggle with `v`):
  - **audit**: renders `[...buffer, ...live]` through Markdown.
  - **stacked**: per-turn compare using `turnSources[]` + buffer slicing.
- Sticky context header shows which turn/section the viewport is scrolled to.
- Scrollable: `j/k` (line), `pgup/pgdn` (page), `space` (page down).

## Chunking

### `chunkByTurn(messages)` — `delta.ts`

Splits `AgentMessage[]` into per-turn chunks at each `role: "user"` boundary.
Consecutive non-user messages (assistant, tool results, custom context) stay
grouped with the preceding user message.

```
[u1, a1, a1', u2, a2] → [[u1, a1, a1'], [u2, a2]]
```

Used in two places:
- `feedCurrentDelta`: detects multi-turn backlogs and feeds each chunk
  individually.
- `replayTranscript`: splits the full resumed transcript into per-turn chunks
  for sequential replay.

### `renderDelta(messages, lastCount)` — `delta.ts`

Renders a message slice as markdown:
- user → `**user**: text`
- assistant → `> _thinking_: ...` + `**assistant**: ...` + `→ tool(args)`
- toolResult → `↳ toolName: result`
- custom (plan-mode-context, plan-mode-reference) → `<primary-context>` tag

Truncation: none — full content (matching omp's advisor). Secret obfuscation
is handled by the monitor's own `AgentSession` (not in the renderer).

## Replay on resume

When the user opens `/observe` after resuming:

1. `primeIfNeeded` checks `monitorPrimed`. If false → `replayTranscript`.
2. `replayTranscript` reads the full transcript, chunks it via `chunkByTurn`,
   renders each chunk, and feeds them **sequentially** (one prompt per turn).
3. Holds `monitorBusy = true` for the entire replay so live `turn_end` deltas
   queue behind it rather than interleaving.
4. After replay finishes, drains queued live deltas one by one.
5. Sets `monitorPrimed = true` so subsequent `/observe` calls don't re-replay.

Each replay chunk gets a labeled divider:
```
━━━ replay 2/4 · 7:40:39 PM · Yeah I think I was gonna get into that... ━━━
```

## Quota detection

`isQuotaError(errStr)` checks for:
`quota`, `rate_limit`, `429`, `resource_exhausted`, `billing`, `unauthorized`,
`invalid api key`, `permission_denied`, `payment required`.

On detection:
- Sets `monitorQuotaExceeded = true` (blocks all future turns).
- Clears `pendingDeltas`.
- Pushes visible `⛔ Monitor stopped: out of quota or auth error` to buffer.
- `/observe` shows a warning toast when the monitor is stopped.

## Session lifecycle

| Event | Handler | Effect |
|---|---|---|
| `turn_end` | `feedCurrentDelta` | Feed new transcript delta to monitor |
| `session_start` | `disposeMonitor` + re-register widget | Reset all state (cursor, buffer, monitor) |
| `session_shutdown` | `disposeMonitor` | Abort monitor, reset state |

`resetState()` resets: `buffer`, `live`, `turnSources`, `cursor`,
`monitorBusy`, `pendingDeltas`, `consecutiveFailures`, `monitorPrimed`,
`monitorQuotaExceeded`.

`widgetOn` is **not** reset by `resetState()` — it persists across session
switches by design (the widget re-registers on `session_start` if it was on).

## Stacked compare (read-only projection)

The stacked compare view does **not** add parallel event state. Instead:

- `turnSources[]` records `{ label, source }` alongside each buffer divider —
  lightweight, no event interception.
- `renderStacked(width)` slices `buffer[]` between `━━━` divider lines to
  extract audit text per turn, at **render time only**.
- For the in-progress last turn, it reads `live[]` (the streaming partial).
- A `contexts` map tracks which rendered line belongs to which turn/section,
  powering the sticky context header.

The existing event flow (`handleMonitorEvent` → `buffer` / `live`) is
completely untouched by the stacked compare feature.

## Testing

### `tests/delta.test.ts` — 19 tests

Pure unit tests for `delta.ts`:

| Area | Tests |
|---|---|
| `renderMessage` | user string, array user content, assistant thinking+text+toolCall, assistant thinking-only, assistant redacted-only, assistant empty, toolResult, developer (skip), whitespace user (skip), custom primary-context expansion, custom non-primary (skip), toolCall intent |
| `renderDelta` | incremental slice, nothing renderable, shrink reseed, mixed join, empty transcript, no new messages, second-call with grown array |
| `chunkByTurn` | 2-turn split, empty, consecutive non-user grouping |

### `tests/smoke.test.ts` — 18 tests

Integration tests that exercise the real factory + handlers via a mock
`ExtensionAPI`:

| Area | Tests |
|---|---|
| Registration | `/observe` command + description, all 3 event handlers |
| turn_end feed | creates session + feeds delta, streaming events (regression), session config (disableExtensionDiscovery, tools) |
| /observe command | opens widget + clears editor, toggles on/off, opens full modal, opens stacked modal, notifies when no UI, doesn't throw (regression), replays per-turn |
| Resume + extend | resume 3 turns → replays 3 chunks, resume 2 → /observe → live feeds 1 more, resume → turn_end 4-turn backlog chunks all 4, resume → /observe → extend → /observe (no re-replay) |

**Total: 37 tests.** All run under Node.js via vitest — no omp needed.
