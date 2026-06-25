# Development Learnings & Edge Cases

Hard-won knowledge from building pi-parallelaudit. Read this before extending
this plugin or writing a new omp extension.

## Extension loading & module resolution

### `pi.pi` is the only safe runtime accessor

oh-my-pi loads extensions via **native Bun import** (`loader.ts`), not jiti.
This means:

- All `@oh-my-pi/*` imports must be **type-only** (`import type`) — they are
  erased at runtime and never resolved from `node_modules`.
- Runtime values (`createAgentSession`, `SessionManager`, `Markdown`,
  `getMarkdownTheme`, `buildSessionContext`) must be accessed via **`pi.pi`** —
  the `ExtensionAPI` field that exposes the host's package exports.
- A bare `import { createAgentSession } from "@oh-my-pi/pi-coding-agent"` will
  **crash at runtime** in a compiled omp binary because the package isn't in
  `node_modules`. Always use `pi.pi.createAgentSession(...)`.

### `disableExtensionDiscovery: true` is critical for sub-sessions

`createAgentSession` discovers and loads extensions from the filesystem by
default. If your extension creates its own sub-session (as parallelaudit does
for the monitor), you **must** pass:

```ts
disableExtensionDiscovery: true,
additionalExtensionPaths: [],
```

Otherwise the sub-session loads your extension **again**, and its `turn_end`
handler fires inside the sub-session — creating an infinite feedback loop where
the monitor feeds itself. This was the root cause of mysterious extra "—"
turns that looked like chunking bugs.

## Streaming & TUI rendering

### `message_update` carries the FULL cumulative message, not a delta

Every `message_update` event delivers the complete assistant message so far
(not just the new tokens). If you push it to a buffer on each update, you get
growing prefixes stacked on top of each other. The fix is to **rebuild in
place**: clear the target array and re-append from the full message on every
update.

### Widgets must have a FIXED height

`ctx.ui.setWidget()` renders above the editor. If the widget's line count
changes on every render (e.g., grows from 3→4→5 lines as content streams),
the terminal pushes old widget copies into scrollback, creating ghost
artifacts. Always pad the body to exactly `N` rows.

### `ctx.ui.custom({ overlay: true })` hardcodes a full-width bottom panel

oh-my-pi's `ctx.ui.custom` only accepts `{ overlay?: boolean }` — unlike
upstream pi (`@earendil-works`), there are no `overlayOptions` for centered
floating windows. The overlay is always bottom-anchored, full-width, up to
100% height. If you want a different shape, you must build it inside the
component's `render()` method.

### Force repaints after structural UI changes

When you show/hide a widget or open/close a modal, call
`tui.requestRender(true)` to force a **full repaint**. The normal diff-based
`requestRender()` can leave stale prompt lines in the terminal scrollback
after the layout changes.

### `Markdown` requires `MarkdownTheme`, not the generic UI `Theme`

`new Markdown(text, padX, padY, theme)` expects a `MarkdownTheme` (with
`.heading()`, `.link()`, etc. methods), not the generic extension `Theme`
(which has `.fg()`, `.bg()`, etc.). Passing the wrong type crashes with
`this.#L.heading is not a function`. Use `pi.pi.getMarkdownTheme()`.

### `ctx.ui.setEditorText("")` clears the command from the input bar

Built-in slash commands clear the editor explicitly. Extension commands do
**not** get this for free — you must call `ctx.ui.setEditorText("")` in your
command handler, or `/your-command` stays visible in the input bar after
execution.

## Session lifecycle

### omp clears widgets on session switch

`clearHookWidgets()` runs on `newSession` / `switchSession`. If your extension
shows a widget and the user switches sessions, the widget disappears but your
`widgetOn` flag stays `true` — creating a stale state. Handle this by
re-registering the widget on `session_start`:

```ts
pi.on("session_start", (_event, ctx) => {
    disposeMonitor("session switch");
    if (widgetOn) showWidget(pi, ctx);
});
```

### `recordLocalSubmission` skips known slash commands

Extension-registered commands are recognized as "known slash commands" by
`isKnownSlashCommand()`, so they don't get optimistic local-submission
bookkeeping. This is correct behavior — it means extension commands don't
echo into the transcript as user messages.

## Per-turn replay vs single-blob

Feeding the entire resumed transcript as one prompt makes the model summarize
instead of auditing each turn. The fix is `chunkByTurn()` — split at each
user message and feed sequentially. But:

- Each chunk is a separate API call, so a 50-turn conversation = 50 calls.
- The monitor's context grows with each turn, so later chunks are slower.
- Live `turn_end` deltas that arrive during replay must **queue** behind it
  (hold `monitorBusy = true` for the whole replay).

## Quota / error detection

When the monitor model runs out of quota, `session.prompt()` throws with
strings containing `429`, `quota`, `rate_limit`, `resource_exhausted`, etc.
Without explicit detection, this manifests as **empty audit output** that looks
like a rendering bug. Always detect and surface quota errors visibly:

```ts
if (isQuotaError(errStr)) {
    monitorQuotaExceeded = true;
    pendingDeltas.length = 0;
    pushLine("⛔ Monitor stopped: out of quota");
}
```

## Theme colors available via `theme.fg()`

| Color key      | Typical appearance   | Good for            |
|----------------|----------------------|---------------------|
| `accent`       | blue                 | primary, titles     |
| `success`      | green                | audit, success      |
| `mdHeading`    | pink / magenta       | numbers, highlights |
| `warning`      | yellow / amber       | warnings            |
| `error`        | red                  | errors              |
| `muted`        | dim gray             | secondary labels    |
| `dim`          | dimmer gray          | borders, footers    |

## pgup/pgdn raw key sequences

Terminal PgUp/PgDn keys arrive as raw escape sequences:

- `\x1b[5~` — PageUp
- `\x1b[6~` — PageDown
- `\x1b[[5~` — legacy PageUp (some terminals)
- `\x1b[[6~` — legacy PageDown (some terminals)

Always check both variants.

## Thinking intensity

The monitor's thinking level is set via `createAgentSession({ thinkingLevel:
"medium" })`. This is separate from the model spec — even if the model string
includes a `:high` suffix, `ctx.models.resolve()` strips it. The thinking
level is a hardcoded `"medium"` in the current code. To change it, either edit
the value or add a `PARALLELAUDIT_THINKING` env var.

## Useful omp APIs for extensions

| API | Purpose |
|-----|---------|
| `pi.pi.createAgentSession(...)` | Create a sub-session (monitor, side-session) |
| `pi.pi.SessionManager.inMemory()` | In-memory session (no file persistence) |
| `pi.pi.buildSessionContext(entries)` | Convert session entries to AgentMessage[] |
| `pi.pi.Markdown(text, padX, padY, theme)` | Render markdown to terminal lines |
| `pi.pi.getMarkdownTheme()` | Get the correct MarkdownTheme for Markdown() |
| `ctx.ui.setWidget(key, factory)` | Show a persistent panel above the editor |
| `ctx.ui.custom(factory, { overlay: true })` | Show a modal overlay |
| `ctx.ui.setEditorText("")` | Clear the input bar |
| `ctx.ui.notify(msg, level)` | Show a toast notification |
| `ctx.models.resolve(spec)` | Resolve a model string to a Model object |
| `ctx.sessionManager.getBranch()` | Get the current session entries |
| `pi.on("turn_end", handler)` | Fire after each primary turn |
| `pi.on("session_start", handler)` | Fire on resume/switch/new session |
