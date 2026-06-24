# pi-parallelaudit

A silent parallel observer for [omp](https://github.com/can1357/oh-my-pi) / [pi](https://pi.dev).

After each primary turn, parallelaudit feeds a transcript delta to a **second model** that thinks continuously about the primary agent's work — correctness, hidden risks, missed edge cases, better approaches. Its streamed reasoning is shown in a live panel above the editor, toggled with `/observe`, so you can keep working while glancing at a second opinion.

It never injects anything back into the primary session. It sees exactly what omp's built-in `/advisor` sees: the full transcript (assistant thinking, tool calls + intent, tool results, plan-mode context), the `read`/`search`/`find` tools to dig deeper, and automatic secret obfuscation — purely an advisory second opinion you can read whenever you want one.

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
/observe            # toggle the live thought panel (above the editor)
/observe full       # full-page, scrollable view of the whole thought log
```

The panel docks above the editor and shows the monitor's latest thoughts (a live tail of the last few lines), so you can keep working in the main editor while glancing at it. It auto-follows the newest output and stays out of the way until you toggle it off with `/observe` again. It's non-modal, so it never grabs keyboard focus.

`/observe full` opens a modal with the **entire** log when you want more than the tail — `j`/`k` (or arrows) scroll, `space` pages, `Esc`/`q` closes. It sticks to the tail while the monitor streams unless you scroll up.

### Monitor model

By default the monitor uses **gpt-5.5** (openai-codex). Override it with an env var (any string `ctx.models.resolve` accepts — provider/id, bare id, or role alias); if the chosen model can't be resolved it falls back to the primary session's model:

```bash
PARALLELAUDIT_MODEL="openai-codex/gpt-5.5:medium" omp -e ./extensions/parallelaudit.ts
```

## Behavior

- **Trigger:** per `turn_end`. After each completed primary turn, the new transcript slice is rendered to markdown and prompted to the monitor once. Cheap (~1 monitor call per turn), and matches how omp's built-in advisor works. **`/observe` also primes on demand** — if the monitor hasn't run yet this session (e.g. right after resuming), opening it feeds the current transcript immediately so you get a second opinion without sending a new message first.
- **Stream:** the monitor runs with thinking on; its `thinking` and `text` tokens stream live into the panel (newest lines visible, auto-following).
- **Concurrency:** if the primary completes more turns while the monitor is still thinking, those deltas are **queued, never dropped** — when the monitor frees up it drains the whole queue as one coalesced batch, so a slow monitor catches up in fewer, larger prompts while still seeing every turn. Only a batch that fails three times in a row is shed, so a persistently failing model can't stall the queue.
- **Resume / session switch:** any live monitor is disposed on `session_start` so a stale monitor never carries context from a previous session. The cursor resets, so the first monitor turn (whether from `turn_end` or from opening `/observe`) re-primes — it feeds the full resumed transcript once so the monitor has context, then continues incrementally. (For very long resumed conversations that first prompt is large; see "Tuning" below.)

## How it works

Everything runs on public extension APIs — no omp internals:

- `pi.on("turn_end")` + `pi.pi.buildSessionContext(ctx.sessionManager.getBranch())` → the monitor is fed the same content the advisor gets: full (untruncated) thinking/text/tool-calls/tool-results plus the primary's plan-mode context, rendered by the extension's `renderDelta`.
- `pi.pi.createAgentSession({ sessionManager: pi.pi.SessionManager.inMemory(), thinkingLevel: "medium", tools: ["read","search","find"] })` → the parallel model. Because it's a full `AgentSession`, it builds its own `SecretObfuscator` from the inherited settings, so secrets in the delta are redacted before reaching the model — same as the primary.
- `session.subscribe(...)` → stream the monitor's thinking/text into the panel.
- `ctx.ui.setWidget("parallelaudit", factory)` → the live, non-modal panel above the editor (re-rendered on every monitor event via `tui.requestRender()`; re-registered on session switch since omp clears widgets). `/observe` toggles it on/off.

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
