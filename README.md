# pi-parallelaudit

A silent parallel observer for [omp](https://github.com/can1357/oh-my-pi) / [pi](https://pi.dev).

After each primary turn, parallelaudit feeds a transcript delta to a **second model** that thinks continuously about the primary agent's work — correctness, hidden risks, missed edge cases, better approaches. Its streamed reasoning is buffered and viewable on demand in a floating window via `/observe`.

It never injects anything back into the primary session and has no tools — it is purely an advisory second opinion you can read whenever you want one.

## Install

```bash
# from git
omp install git:github.com/davidwangz137/pi-parallelaudit

# from a local checkout
omp install /absolute/path/to/pi-parallelaudit
```

Then `/reload` inside omp (or restart).

For quick iteration without installing:

```bash
omp -e ./extensions/parallelaudit.ts
```

## Usage

```text
/observe            # toggle the floating thought stream
```

Keys inside the window: `j`/`k` (or arrows) scroll, `space` page-down, `Esc`/`q` close. Run `/observe` again to reopen.

### Monitor model

By default the monitor inherits the primary session's model. Set a different one with an env var (any string `ctx.models.resolve` accepts — provider/id, bare id, or role alias):

```bash
PARALLELAUDIT_MODEL="anthropic/claude-sonnet-4-5:medium" omp -e ./extensions/parallelaudit.ts
```

## Behavior

- **Trigger:** per `turn_end`. After each completed primary turn, the new transcript slice is rendered to markdown and prompted to the monitor once. Cheap (~1 monitor call per turn), and matches how omp's built-in advisor works. **`/observe` also primes on demand** — if the monitor hasn't run yet this session (e.g. right after resuming), opening it feeds the current transcript immediately so you get a second opinion without sending a new message first.
- **Stream:** the monitor runs with thinking on; its `thinking` and `text` tokens stream live into the floating window.
- **Concurrency:** if the primary completes another turn while the monitor is still thinking, only the latest delta is queued (no unbounded backlog). After three consecutive monitor failures the pending delta is dropped so a flaky model never stalls things.
- **Resume / session switch:** any live monitor is disposed on `session_start` so a stale monitor never carries context from a previous session. The cursor resets, so the first monitor turn (whether from `turn_end` or from opening `/observe`) re-primes — it feeds the full resumed transcript once so the monitor has context, then continues incrementally. (For very long resumed conversations that first prompt is large; see "Tuning" below.)

## How it works

Everything runs on public extension APIs — no omp internals:

- `pi.on("turn_end")` + `pi.pi.buildSessionContext(ctx.sessionManager.getBranch())` → render the delta.
- `pi.pi.createAgentSession({ sessionManager: pi.pi.SessionManager.inMemory(), thinkingLevel: "medium", tools: [] })` → the parallel model.
- `session.subscribe(...)` → drive the floating window.
- `ctx.ui.custom` (used only to obtain the live `tui`) → `tui.showOverlay(..., { width: "64%", maxHeight: "68%", anchor: "center" })` for the centered floating window.

All `@oh-my-pi/*` imports are type-only (erased at runtime), so the module loads from any location without package resolution.

## Tuning

- **Lighter resume:** to make the monitor start *blind* (only new turns, no full-history re-prime) instead of seeding the cursor to 0 on `session_start`, seed it to the current transcript length in the `turn_end` handler.
- **Faster startup:** `createAgentSession` spins up a full session. If first-turn latency matters, swap it for the lighter bare `Agent` class (what omp's advisor uses) at the cost of a `@oh-my-pi/pi-agent-core` runtime import.

## Develop

```bash
npm install        # vitest + typescript (dev only)
npm test           # vitest, runs under node — no omp needed
```

The pure delta logic (`extensions/delta.ts`) and the extension wiring are unit-tested. The floating-window render and live model streaming need an interactive omp run to verify visually.

## License

MIT
