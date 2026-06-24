/**
 * parallelaudit — a silent parallel observer extension.
 *
 * After each primary turn it feeds a transcript delta to a second model that
 * thinks continuously about the primary's work. Its streamed reasoning is
 * buffered and viewable on demand via `/observe`. It never injects anything
 * back into the primary session and has no tools.
 *
 * Runtime values come entirely from `pi.pi` (createAgentSession / SessionManager
 * / buildSessionContext), so this module performs no `@oh-my-pi/*` runtime
 * import — it loads from any location without package resolution. Types are
 * type-only (erased at runtime).
 */
import type { Model } from "@oh-my-pi/pi-ai";
import type {
	AgentSession,
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { renderDelta } from "./delta";

const MONITOR_SYSTEM_PROMPT = [
	"You are a silent parallel observer attached to another coding agent's session.",
	"After each of its turns you receive a transcript delta of what it just did.",
	"Think continuously and critically about its work: correctness, hidden risks, missed edge cases, better approaches, wrong assumptions.",
	"Stream your reasoning as you go. You are advisory only — you have no tools, cannot edit files or run commands, and cannot affect the primary agent.",
	"Be concise and specific; quote the exact thing you are concerned about. Do not flatter or restate; raise only substantive observations.",
].join(" ");

const BUFFER_MAX_LINES = 500;
/** Default monitor model (openai-codex). Override with PARALLELAUDIT_MODEL. */
const DEFAULT_MONITOR_MODEL = "gpt-5.5";

const WIDGET_KEY = "parallelaudit";
/** Lines of thought kept visible in the live panel (a tail — newest only). */
const WIDGET_HEIGHT = 12;

// ── session-scoped state (reset on session_start / shutdown) ─────────────
let monitor: AgentSession | null = null;
let monitorLabel = "";
let cursor = 0; // last-seen primary message count
let monitorBusy = false;
const pendingDeltas: string[] = []; // queued transcript slices, drained as one coalesced batch
let consecutiveFailures = 0;
let monitorPrimed = false; // true once the monitor has been fed anything this session

const buffer: string[] = [];
let widgetOn = false;
let widgetRequestRender: (() => void) | null = null;
let overlay: { requestRender: () => void; close: () => void } | null = null;
const live: string[] = []; // current streaming message, rebuilt in place each message_update

function pushLine(line: string): void {
	buffer.push(line);
	if (buffer.length > BUFFER_MAX_LINES) {
		buffer.splice(0, buffer.length - BUFFER_MAX_LINES);
	}
	requestActiveRender();
}

/** Repaint whichever views are active — the live panel and/or the full modal. */
function requestActiveRender(): void {
	widgetRequestRender?.();
	overlay?.requestRender();
}

function resetState(): void {
	buffer.length = 0;
	live.length = 0;
	monitorBusy = false;
	pendingDeltas.length = 0;
	consecutiveFailures = 0;
	monitorPrimed = false;
}

/** Abort any live monitor and reset session-scoped state. Used on both
 *  session_start (resume/switch — a stale monitor must not carry context from
 *  the previous session) and session_shutdown. */
function disposeMonitor(reason: string): void {
	void (async () => {
		try {
			await monitor?.abort(reason);
		} catch {}
		monitor = null;
		resetState();
	})();
}

async function ensureMonitor(pi: ExtensionAPI, ctx: ExtensionContext): Promise<AgentSession | null> {
	if (monitor) return monitor;
	const spec = process.env.PARALLELAUDIT_MODEL ?? DEFAULT_MONITOR_MODEL;
	const model: Model | undefined =
		ctx.models.resolve(spec) ?? ctx.models.current() ?? undefined;
	if (!model) {
		pi.logger.warn(
			`parallelaudit: could not resolve monitor model "${spec}" and no main model is available (set PARALLELAUDIT_MODEL)`,
		);
		return null;
	}
	monitorLabel = `${model.provider}/${model.id}`;
	try {
		const { session } = await pi.pi.createAgentSession({
			cwd: ctx.cwd,
			model,
			modelRegistry: ctx.modelRegistry,
			thinkingLevel: "medium",
			systemPrompt: [MONITOR_SYSTEM_PROMPT],
			tools: ["read", "search", "find"],
			sessionManager: pi.pi.SessionManager.inMemory(),
			// Skip every discovery path — the monitor needs none of it.
			contextFiles: [],
			skills: [],
			slashCommands: [],
			promptTemplates: [],
		});
		session.subscribe(handleMonitorEvent);
		monitor = session;
		pushLine(`_monitor started on ${monitorLabel}_`);
		return session;
	} catch (err) {
		pi.logger.warn("parallelaudit: failed to create monitor session", { err: String(err) });
		return null;
	}
}

/** Push an assistant message's thinking/text blocks into `target`. The caller
 *  resets `target` first, so repeated calls with the cumulative `message_update`
 *  payload replace lines in place instead of stacking growing prefixes. */
function appendAssistantLines(target: string[], msg: AgentMessage): void {
	if (msg.role !== "assistant") return;
	for (const block of msg.content) {
		if (block.type === "thinking") {
			const t = block.thinking.trimEnd();
			if (t) target.push(`  ${t}`);
		} else if (block.type === "text") {
			const t = block.text.trimEnd();
			if (t) target.push(t);
		}
	}
}

function handleMonitorEvent(ev: AgentSessionEvent): void {
	if (ev.type === "message_update") {
		// ev.message is the cumulative partial: rebuild `live` so a growing token
		// stream replaces its line rather than appending every prefix.
		live.length = 0;
		appendAssistantLines(live, ev.message);
		requestActiveRender();
		return;
	}
	if (ev.type === "message_end") {
		appendAssistantLines(buffer, ev.message);
		live.length = 0;
		if (ev.message.role === "assistant") pushLine("");
		else requestActiveRender();
	}
}

/** Fire-and-forget: never blocks the primary turn_end handler. */
function feed(pi: ExtensionAPI, ctx: ExtensionContext, delta: string): void {
	monitorPrimed = true;
	void (async () => {
		const session = await ensureMonitor(pi, ctx);
		if (!session) return;
		if (monitorBusy) {
			pendingDeltas.push(delta);
			return;
		}
		await runTurn(pi, session, delta);
	})();
}

async function runTurn(pi: ExtensionAPI, session: AgentSession, delta: string): Promise<void> {
	monitorBusy = true;
	pushLine(`\n━━━ turn ${new Date().toLocaleTimeString()} ━━━`);
	try {
		await session.prompt(`### Session update\n\n${delta}`);
		consecutiveFailures = 0;
	} catch (err) {
		consecutiveFailures++;
		pi.logger.debug("parallelaudit monitor turn failed", {
			err: String(err),
			consecutiveFailures,
		});
		if (consecutiveFailures >= 3) {
			// A batch that keeps failing would loop forever; shed it and let the
			// queue drain onward. (Only a failing batch is ever dropped.)
			pi.logger.warn("parallelaudit monitor failed 3x on a batch; dropping it and continuing");
			consecutiveFailures = 0;
		} else {
			pendingDeltas.unshift(delta); // retry this batch on the next drain
		}
	} finally {
		if (pendingDeltas.length > 0) {
			// Drain the whole queue as one coalesced batch: a slow monitor
			// catches up in fewer, larger prompts instead of dropping turns.
			const batch = pendingDeltas.splice(0).join("\n\n");
			await runTurn(pi, session, batch);
		} else {
			monitorBusy = false;
		}
	}
}

/** Build the transcript delta since `cursor` and feed it to the monitor,
 *  advancing the cursor whether or not there was anything to show. Shared by
 *  turn_end and the /observe "prime now" path. */
function feedCurrentDelta(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const { messages } = pi.pi.buildSessionContext(ctx.sessionManager.getBranch());
	const { text, nextCount } = renderDelta(messages, cursor);
	cursor = nextCount;
	if (text) feed(pi, ctx, text);
}

export default function parallelaudit(pi: ExtensionAPI): void {
	pi.on("turn_end", (_event, ctx) => {
		try {
			feedCurrentDelta(pi, ctx);
		} catch (err) {
			pi.logger.debug("parallelaudit turn_end handler error", { err: String(err) });
		}
	});

	pi.on("session_start", (_event, ctx) => {
		disposeMonitor("session switch");
		// omp clears widgets on switch — re-show if the user had it on.
		if (widgetOn) showWidget(pi, ctx);
	});

	pi.on("session_shutdown", () => disposeMonitor("session shutdown"));

	pi.registerCommand("observe", {
		description: "Toggle the live thought panel; `/observe full` opens a full-page scrollable view.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("parallelaudit: no UI in this mode.", "info");
				return;
			}
			if (args.trim() === "full") {
				primeIfNeeded(pi, ctx);
				await openFullView(pi, ctx);
				return;
			}
			if (widgetOn) {
				hideWidget(ctx);
				return;
			}
			primeIfNeeded(pi, ctx);
			showWidget(pi, ctx);
		},
	});
}

/** Show the monitor's live tail panel above the editor. Always renders a fixed
 *  height (WIDGET_HEIGHT body rows) to avoid scrollback artifacts from a widget
 *  that grows while streaming. Uses Markdown so bullets/bold read cleanly. */
function showWidget(pi: ExtensionAPI, ctx: ExtensionContext): void {
	ctx.ui.setWidget(WIDGET_KEY, (tui, theme) => {
		const markdown = new pi.pi.Markdown("", 0, 0, theme);
		widgetRequestRender = () => tui.requestRender();
		return {
			render(width: number): readonly string[] {
				const all = [...buffer, ...live];
				const header =
					theme.fg("accent", "parallelaudit") +
					theme.fg(
						"dim",
						` ${monitorLabel || "no monitor yet"} · ${all.length} lines · /observe to hide`,
					);
				markdown.setText(
					all.length > 0
						? all.join("\n\n")
						: "(no thoughts yet — the monitor speaks after the primary's first turn)",
				);
				const rendered = [...markdown.render(width)];
				const tail = rendered.slice(Math.max(0, rendered.length - WIDGET_HEIGHT));
				while (tail.length < WIDGET_HEIGHT) tail.push("");
				return [header, ...tail];
			},
			invalidate(): void {
				markdown.invalidate();
			},
		};
	});
	widgetOn = true;
}

/** Hide the monitor panel. */
function hideWidget(ctx: ExtensionContext): void {
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	widgetRequestRender = null;
	widgetOn = false;
}

/** Prime the monitor with the current transcript if it hasn't run this session
 *  (so /observe yields a second opinion immediately, even right after resume). */
function primeIfNeeded(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (monitorPrimed) return;
	try {
		feedCurrentDelta(pi, ctx);
	} catch (err) {
		pi.logger.debug("parallelaudit observe prime error", { err: String(err) });
	}
}

/** Full-page, scrollable modal of the whole thought log. Renders markdown and
 *  sticks to the tail while streaming unless you scroll up. */
async function openFullView(pi: ExtensionAPI, ctx: ExtensionContext): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let scrollOffset = 0;
		let stick = true;
		let lastRenderedLength = 0;
		const viewport = (): number => Math.max(4, (process.stdout.rows ?? 40) - 3);
		const markdown = new pi.pi.Markdown("", 0, 0, theme);

		const component = {
			render(width: number): readonly string[] {
				const all = [...buffer, ...live];
				const header =
					theme.fg("accent", "parallelaudit") +
					theme.fg(
						"dim",
						` ${monitorLabel || "no monitor yet"} · ${all.length} lines · Esc/q close · j/k/space scroll`,
					);
				markdown.setText(
					all.length > 0
						? all.join("\n\n")
						: "(no thoughts yet — the monitor speaks after the primary's first turn)",
				);
				const lines = [...markdown.render(width)];
				lastRenderedLength = lines.length;
				const maxScroll = Math.max(0, lines.length - viewport());
				if (stick) scrollOffset = maxScroll;
				if (scrollOffset > maxScroll) scrollOffset = maxScroll;
				if (scrollOffset < 0) scrollOffset = 0;
				return [header, ...lines.slice(scrollOffset, scrollOffset + viewport())];
			},
			handleInput(data: string): void {
				const maxScroll = Math.max(0, lastRenderedLength - viewport());
				if (data === "\x1b" || data === "q") {
					done(undefined);
					return;
				}
				if (data === "j" || data === "\x1b[B") {
					scrollOffset = Math.min(maxScroll, scrollOffset + 1);
					stick = scrollOffset >= maxScroll;
				} else if (data === "k" || data === "\x1b[A") {
					scrollOffset = Math.max(0, scrollOffset - 1);
					stick = false;
				} else if (data === " ") {
					scrollOffset = Math.min(maxScroll, scrollOffset + viewport());
					stick = scrollOffset >= maxScroll;
				}
				tui.requestRender();
			},
			invalidate(): void {
				markdown.invalidate();
			},
			dispose(): void {
				overlay = null;
			},
		};
		overlay = {
			requestRender: () => tui.requestRender(),
			close: () => {
				done(undefined);
			},
		};
		return component;
	}, { overlay: true });
}
