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
import type { Model, TextContent } from "@oh-my-pi/pi-ai";
import type {
	AgentSession,
	AgentSessionEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@oh-my-pi/pi-coding-agent";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { chunkByTurn, renderDelta } from "./delta";

const MONITOR_SYSTEM_PROMPT = [
	"You are a parallel auditor. Another coding agent is working on a task, and you receive its transcript turn by turn.",
	"For each turn, audit its work as if you were performing the reasoning yourself: verify its assumptions, check the logic, look for bugs it may have introduced, and flag anything you would do differently.",
	"Stream your audit reasoning as you go — this is your own thinking, not a summary or a review. Be specific: quote the exact line or decision you are checking.",
	"If a turn is substantively identical to one you already audited (same calls, same outputs, no new content), respond with only '—' and move on.",
	"You are advisory only: you cannot edit files, run commands, or affect the primary agent. Your tools (read/search/find) let you verify claims against the actual codebase.",
].join(" ");

const BUFFER_MAX_LINES = 500;
/** Default monitor model. gpt-5.4 has a 1M context window — safe for long
 *  transcripts. Override with PARALLELAUDIT_MODEL. */
const DEFAULT_MONITOR_MODEL = "gpt-5.4";

const WIDGET_KEY = "parallelaudit";
/** Lines of thought kept visible in the live panel (a tail — newest only). */
const WIDGET_HEIGHT = 12;

interface PendingDelta {
	text: string;
	label: string | null;
}

/** Lightweight index alongside buffer dividers — no event interception, just
 *  a read-only projection used by the stacked compare view. */
interface TurnSource {
	label: string;
	source: string;
}

/** Detect quota / rate-limit / auth errors from a thrown error string. */
function isQuotaError(errStr: string): boolean {
	const lower = errStr.toLowerCase();
	return (
		lower.includes("quota") ||
		lower.includes("rate_limit") ||
		lower.includes("rate limit") ||
		lower.includes("insufficient") ||
		lower.includes("429") ||
		lower.includes("resource_exhausted") ||
		lower.includes("resource exhausted") ||
		lower.includes("payment required") ||
		lower.includes("billing") ||
		lower.includes("unauthorized") ||
		lower.includes("invalid api key") ||
		lower.includes("no api key") ||
		lower.includes("permission_denied")
	);
}

/** Human-readable label for a turn: `HH:MM:SS · first user snippet`. */
function describeTurn(messages: readonly AgentMessage[]): string | null {
	const user = messages.find(msg => msg.role === "user");
	const anchor = user ?? messages[0];
	const parts: string[] = [];
	if (anchor?.timestamp) {
		parts.push(new Date(anchor.timestamp).toLocaleTimeString());
	}
	if (user) {
		const raw =
			typeof user.content === "string"
				? user.content
				: user.content.filter((b): b is TextContent => b.type === "text").map(b => b.text).join("");
		const oneLine = raw.replace(/\s+/g, " ").trim();
		if (oneLine) {
			parts.push(oneLine.length > 72 ? oneLine.slice(0, 69) + "…" : oneLine);
		}
	}
	return parts.length > 0 ? parts.join(" · ") : null;
}

// ── session-scoped state (reset on session_start / shutdown) ─────────────
let monitor: AgentSession | null = null;
let monitorLabel = "";
let cursor = 0; // last-seen primary message count
let monitorBusy = false;
const pendingDeltas: PendingDelta[] = [];
let consecutiveFailures = 0;
let monitorPrimed = false; // true once the monitor has been fed anything this session

const buffer: string[] = [];
let widgetOn = false;
let widgetRequestRender: (() => void) | null = null;
let widgetForceRender: (() => void) | null = null;
let overlay: { requestRender: () => void; close: () => void } | null = null;
const live: string[] = []; // current streaming message, rebuilt in place each message_update
const turnSources: TurnSource[] = [];
let monitorQuotaExceeded = false;

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
	turnSources.length = 0;
	monitorQuotaExceeded = false;
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
			thinkingLevel: (process.env.PARALLELAUDIT_THINKING as "minimal" | "low" | "medium" | "high" | "xhigh" | undefined) ?? "medium",
			systemPrompt: [MONITOR_SYSTEM_PROMPT],
			tools: ["read", "search", "find"],
			sessionManager: pi.pi.SessionManager.inMemory(),
			// Critical: the monitor session must not load filesystem/user
			// extensions (including parallelaudit itself), or its own turn_end would
			// feed the monitor transcript back into itself and create a feedback loop.
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [],
			// Skip every other discovery path — the monitor needs none of it.
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
function feed(pi: ExtensionAPI, ctx: ExtensionContext, pending: PendingDelta): void {
	monitorPrimed = true;
	void (async () => {
		const session = await ensureMonitor(pi, ctx);
		if (!session) return;
		if (monitorBusy) {
			pendingDeltas.push(pending);
			return;
		}
		await runTurn(pi, session, pending);
	})();
}

async function runTurn(pi: ExtensionAPI, session: AgentSession, pending: PendingDelta): Promise<void> {
	if (monitorQuotaExceeded) return;
	monitorBusy = true;
	const suffix = pending.label ? ` · ${pending.label}` : "";
	const label = `turn${suffix}`;
	pushLine(`\n━━━ ${label} ━━━`);
	turnSources.push({ label, source: pending.text });
	try {
		await session.prompt(`### Session update\n\n${pending.text}`);
		consecutiveFailures = 0;
	} catch (err) {
		const errStr = String(err);
		if (isQuotaError(errStr)) {
			monitorQuotaExceeded = true;
			pendingDeltas.length = 0;
			pushLine("\n⛔ **Monitor stopped: out of quota or auth error.**");
			pushLine(`Error: ${errStr}`);
			pushLine("Set PARALLELAUDIT_MODEL to a different provider and restart.");
			pi.logger.warn("parallelaudit monitor quota exceeded", { err: errStr });
		} else {
			consecutiveFailures++;
			pi.logger.debug("parallelaudit monitor turn failed", { err: errStr, consecutiveFailures });
			if (consecutiveFailures >= 3) {
				pi.logger.warn("parallelaudit monitor failed 3x; dropping");
				consecutiveFailures = 0;
			} else {
				pendingDeltas.unshift(pending);
			}
		}
	} finally {
		const next = pendingDeltas.shift();
		if (next && !monitorQuotaExceeded) {
			await runTurn(pi, session, next);
		} else {
			monitorBusy = false;
		}
	}
}

/** Build the transcript delta since `cursor` and feed it to the monitor,
 *  advancing the cursor whether or not there was anything to show. Shared by
 *  turn_end and the /observe replay/drain path. */
function feedCurrentDelta(pi: ExtensionAPI, ctx: ExtensionContext): void {
	const { messages } = pi.pi.buildSessionContext(ctx.sessionManager.getBranch());
	const slice = messages.slice(cursor);
	const { text, nextCount } = renderDelta(messages, cursor);
	cursor = nextCount;
	if (text) feed(pi, ctx, { text, label: describeTurn(slice) });
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
		description: "Toggle the live panel; `/observe full` for scrollable view, `/observe full-stacked` for compare view.",
		handler: async (args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("parallelaudit: no UI in this mode.", "info");
				return;
			}
			ctx.ui.setEditorText("");
			if (monitorQuotaExceeded) {
				ctx.ui.notify("parallelaudit: monitor is stopped (quota/auth error). Set PARALLELAUDIT_MODEL and restart.", "warning");
			}
			const trimmed = args.trim();
			if (trimmed === "full" || trimmed === "full-stacked" || trimmed === "stacked") {
				primeIfNeeded(pi, ctx);
				const mode = trimmed.includes("stacked") ? "stacked" : "audit";
				await openFullView(pi, ctx, mode);
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
		const markdown = new pi.pi.Markdown("", 0, 0, pi.pi.getMarkdownTheme());
		widgetRequestRender = () => tui.requestRender();
		widgetForceRender = () => tui.requestRender(true);
		// First mount is a structural layout change (widget inserted above the editor).
		// Force one full repaint so the old prompt line doesn't linger in scrollback.
		queueMicrotask(() => tui.requestRender(true));
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
	const force = widgetForceRender;
	ctx.ui.setWidget(WIDGET_KEY, undefined);
	widgetRequestRender = null;
	widgetForceRender = null;
	widgetOn = false;
	// Panel removal is also a structural change; repaint the viewport cleanly.
	force?.();
}

/** Prime the monitor if it hasn't run this session. Instead of feeding the
 *  whole transcript as one blob (which makes the model summarize), splits it
 *  into per-turn chunks and replays each so the monitor comments on each turn
 *  individually — as if /observe had been open from the start of the session. */
function primeIfNeeded(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (monitorPrimed) return;
	try {
		replayTranscript(pi, ctx);
	} catch (err) {
		pi.logger.debug("parallelaudit observe prime error", { err: String(err) });
	}
}

/** Replay the full transcript as per-turn chunks, holding monitorBusy so live
 *  turn_end deltas queue behind the replay rather than interleaving. */
function replayTranscript(pi: ExtensionAPI, ctx: ExtensionContext): void {
	monitorPrimed = true;
	monitorBusy = true; // hold busy until replay finishes
	void (async () => {
		const { messages } = pi.pi.buildSessionContext(ctx.sessionManager.getBranch());
		cursor = messages.length;
		const turns = chunkByTurn(messages)
			.map(chunk => {
				const { text } = renderDelta(chunk, 0);
				return text ? { text, label: describeTurn(chunk) } : null;
			})
			.filter((t): t is PendingDelta => t !== null);
		if (turns.length === 0) {
			monitorBusy = false;
			return;
		}
		const session = await ensureMonitor(pi, ctx);
		if (!session) {
			monitorBusy = false;
			pendingDeltas.length = 0;
			return;
		}
		for (let i = 0; i < turns.length; i++) {
			if (monitorQuotaExceeded) break;
			const turn = turns[i]!;
			const suffix = turn.label ? ` · ${turn.label}` : "";
			const label = `replay ${i + 1}/${turns.length}${suffix}`;
			pushLine(`\n━━━ ${label} ━━━`);
			turnSources.push({ label, source: turn.text });
			try {
				await session.prompt(
					`### Session update (replay ${i + 1}/${turns.length})\n\n${turn.text}`,
				);
				consecutiveFailures = 0;
			} catch (err) {
				const errStr = String(err);
				if (isQuotaError(errStr)) {
					monitorQuotaExceeded = true;
					pendingDeltas.length = 0;
					pushLine("\n⛔ **Monitor stopped: out of quota or auth error.**");
					pushLine(`Error: ${errStr}`);
					pushLine("Set PARALLELAUDIT_MODEL to a different provider and restart.");
					pi.logger.warn("parallelaudit monitor quota exceeded during replay", { err: errStr });
					break;
				}
				pi.logger.debug("parallelaudit replay chunk failed", { err: errStr });
			}
		}
		// Drain any live deltas that arrived during replay, preserving their own
		// turn boundaries one by one.
		const next = pendingDeltas.shift();
		if (next) {
			await runTurn(pi, session, next);
		} else {
			monitorBusy = false;
		}
	})();
}


/** Full-page, scrollable modal. Two modes: 'audit' (the full audit log) and
 *  'stacked' (per-turn compare: primary transcript chunk then audit text).
 *  Press v to toggle. The stacked view reads turnSources + slices buffer between
 *  dividers — no parallel event state, just a read-only projection. */
async function openFullView(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	initialMode: "audit" | "stacked" = "audit",
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let scrollOffset = 0;
		let stick = true;
		let lastRenderedLength = 0;
		let viewMode: "audit" | "stacked" = initialMode;
		const bodyViewport = (): number => Math.max(4, (process.stdout.rows ?? 40) - 8);
		const markdown = new pi.pi.Markdown("", 1, 0, pi.pi.getMarkdownTheme());

		/** Build stacked compare lines. Returns { lines, contexts } where contexts
		 *  maps body-line indices to {turn, section} for the sticky header. */
		const renderStacked = (width: number): { lines: string[]; contexts: Map<number, { turn: string; section: string }> } => {
			if (turnSources.length === 0) {
				return { lines: [theme.fg("dim", "(no turns yet...)")], contexts: new Map() };
			}
			// Find divider positions in buffer to slice audit text per turn.
			const dividerIdx: number[] = [];
			for (let i = 0; i < buffer.length; i++) {
				if (buffer[i]!.includes("━━━")) dividerIdx.push(i);
			}
			const lines: string[] = [];
			const contexts = new Map<number, { turn: string; section: string }>();
			for (let i = 0; i < turnSources.length; i++) {
				const ts = turnSources[i]!;
				const isLast = i === turnSources.length - 1;
				// Use same ━━━ format as audit mode for consistency.
				lines.push(theme.fg("dim", `━━━ ${ts.label} ━━━`));
				contexts.set(lines.length - 1, { turn: ts.label, section: "header" });
				lines.push(theme.fg("muted", "primary:"));
				contexts.set(lines.length - 1, { turn: ts.label, section: "primary" });
				const srcMd = new pi.pi.Markdown(ts.source, 1, 0, pi.pi.getMarkdownTheme());
				for (const line of srcMd.render(width)) {
					lines.push(line);
					contexts.set(lines.length - 1, { turn: ts.label, section: "primary" });
				}
				lines.push("");
				// Audit text: buffer lines after this divider up to the next, OR
				// live[] for the in-progress last turn (streaming).
				let auditLines: string[];
				if (isLast && live.length > 0) {
					// Show streamed partial audit for the active turn.
					auditLines = [...live];
				} else {
					const start = dividerIdx[i] ?? buffer.length;
					const end = dividerIdx[i + 1] ?? buffer.length;
					auditLines = buffer.slice(start + 1, end).filter(l => l.trim() !== "");
				}
				lines.push(theme.fg("muted", "audit:"));
				contexts.set(lines.length - 1, { turn: ts.label, section: "audit" });
				if (auditLines.length > 0) {
					const audMd = new pi.pi.Markdown(auditLines.join("\n"), 1, 0, pi.pi.getMarkdownTheme());
					for (const line of audMd.render(width)) {
						lines.push(line);
						contexts.set(lines.length - 1, { turn: ts.label, section: "audit" });
					}
				} else {
					lines.push(theme.fg("dim", "(waiting for audit...)"));
					contexts.set(lines.length - 1, { turn: ts.label, section: "audit" });
				}
				lines.push("");
				lines.push(theme.fg("dim", theme.boxRound.horizontal.repeat(Math.max(1, width))));
				lines.push("");
			}
			return { lines, contexts };
		};

		const component = {
			render(width: number): readonly string[] {
				const border = theme.fg("dim", theme.boxRound.horizontal.repeat(Math.max(1, width)));
				const all = [...buffer, ...live];
				const title =
					theme.fg("accent", `parallelaudit full · ${viewMode}`) +
					theme.fg(
						"dim",
						viewMode === "audit"
							? ` · ${monitorLabel || "no monitor yet"} · ${all.length} lines`
							: ` · ${monitorLabel || "no monitor yet"} · ${turnSources.length} turns`,
					);
				const footer = theme.fg("muted", "v toggle · pgup/pgdn · j/k · Esc dismiss");

				let rendered: string[];
				let contextLine = "";
				if (viewMode === "audit") {
					markdown.setText(
						all.length > 0
							? all.join("\n\n")
							: "(no thoughts yet — the monitor speaks after the primary's first turn)",
					);
					rendered = [...markdown.render(width)];
				} else {
					const result = renderStacked(width);
					rendered = result.lines;
					// Sticky context: find which turn/section the top visible body line is in.
					const bodyTop = scrollOffset;
					const ctx = result.contexts.get(bodyTop);
					if (ctx) {
						contextLine = theme.fg("accent", ctx.turn) + theme.fg("dim", ` · ${ctx.section}`);
					} else {
						// Scan backwards from bodyTop to find the nearest context marker.
						for (let i = bodyTop; i >= 0; i--) {
							const c = result.contexts.get(i);
							if (c) {
								contextLine = theme.fg("accent", c.turn) + theme.fg("dim", ` · ${c.section}`);
								break;
							}
						}
					}
				}

				lastRenderedLength = rendered.length;
				const maxScroll = Math.max(0, rendered.length - bodyViewport());
				if (stick) scrollOffset = maxScroll;
				if (scrollOffset > maxScroll) scrollOffset = maxScroll;
				if (scrollOffset < 0) scrollOffset = 0;
				const body = rendered.slice(scrollOffset, scrollOffset + bodyViewport());
				while (body.length < bodyViewport()) body.push("");

				// In stacked mode, insert the context line between title and body.
				if (contextLine) {
					return [border, "", title, contextLine, "", ...body, "", footer, "", border];
				}
				return [border, "", title, "", ...body, "", footer, "", border];
			},
			handleInput(data: string): void {
				const maxScroll = Math.max(0, lastRenderedLength - bodyViewport());
				const isPageUp = data === "\x1b[5~" || data === "\x1b[[5~";
				const isPageDown = data === "\x1b[6~" || data === "\x1b[[6~";
				if (data === "\x1b" || data === "q") {
					done(undefined);
					return;
				}
				if (data === "v") {
					viewMode = viewMode === "audit" ? "stacked" : "audit";
					stick = true;
					tui.requestRender();
					return;
				}
				if (data === "j" || data === "\x1b[B") {
					scrollOffset = Math.min(maxScroll, scrollOffset + 1);
					stick = scrollOffset >= maxScroll;
				} else if (data === "k" || data === "\x1b[A") {
					scrollOffset = Math.max(0, scrollOffset - 1);
					stick = false;
				} else if (data === " " || isPageDown) {
					scrollOffset = Math.min(maxScroll, scrollOffset + bodyViewport());
					stick = scrollOffset >= maxScroll;
				} else if (isPageUp) {
					scrollOffset = Math.max(0, scrollOffset - bodyViewport());
					stick = false;
				}
				tui.requestRender();
			},
			invalidate(): void {
				markdown.invalidate();
			},
			dispose(): void {
				overlay = null;
				queueMicrotask(() => tui.requestRender(true));
			},
		};
		overlay = {
			requestRender: () => tui.requestRender(),
			close: () => { done(undefined); },
		};
		queueMicrotask(() => tui.requestRender(true));
		return component;
	}, { overlay: true });
}
