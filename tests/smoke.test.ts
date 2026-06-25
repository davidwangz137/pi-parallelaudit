import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import parallelaudit from "../extensions/parallelaudit";

/**
 * Integration tests for the extension's command/event wiring.
 *
 * The mock pi/ctx are deliberately loose (sanctioned `as unknown as ExtensionAPI`
 * narrowing) — they exercise the real factory + handlers, not omp internals.
 */

type AnyHandler = (ev?: unknown, ctx?: unknown) => unknown;
type CommandHandler = (args: string, ctx: unknown) => Promise<void>;

let turnEnd: AnyHandler | undefined;
let sessionStart: AnyHandler | undefined;
let sessionShutdown: AnyHandler | undefined;
let monitorListener: ((ev: unknown) => void) | undefined;
let observeCommand: { description: string; handler: CommandHandler } | undefined;

const promptCalls: string[] = [];
const { promise: promptDone, resolve: resolvePrompt } = Promise.withResolvers<void>();
let createCalls = 0;
let createArgs: Record<string, unknown> | undefined;

let promptTarget = 0;
let promptTargetResolve: (() => void) | null = null;

const fakeSession = {
	subscribe(fn: (ev: unknown) => void) {
		monitorListener = fn;
		return () => {};
	},
	prompt(text: string) {
		promptCalls.push(text);
		resolvePrompt();
		if (promptTargetResolve && promptCalls.length >= promptTarget) {
			const resolve = promptTargetResolve;
			promptTargetResolve = null;
			promptTarget = 0;
			resolve();
		}
		return Promise.resolve(true);
	},
	abort() {
		return Promise.resolve();
	},
};

const pi = {
	logger: { debug() {}, warn() {}, info() {} },
	on(name: string, h: AnyHandler) {
		if (name === "turn_end") turnEnd = h;
		else if (name === "session_start") sessionStart = h;
		else if (name === "session_shutdown") sessionShutdown = h;
	},
	registerCommand(name: string, options: { description?: string; handler: CommandHandler }) {
		if (name === "observe") {
			observeCommand = { description: options.description ?? "", handler: options.handler };
		}
	},
	pi: {
		SessionManager: { inMemory() {
			return {};
		} },
		buildSessionContext(entries: { message: AgentMessage }[]) {
			return { messages: entries.map(e => e.message) };
		},
		createAgentSession(options: Record<string, unknown>) {
			createCalls += 1;
			createArgs = options;
			return Promise.resolve({ session: fakeSession });
		},
	},
};

const transcript = [{ message: { role: "user", content: "hello world", timestamp: 1 } }];

function waitForPromptCount(count: number): Promise<void> {
	if (promptCalls.length >= count) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	promptTarget = count;
	promptTargetResolve = resolve;
	return promise;
}

/** Build a spy-rich ctx so tests can assert on setWidget/setEditorText/custom. */
function makeCtx(overrides: Record<string, unknown> = {}) {
	const widgetCalls: { key: string; content: unknown }[] = [];
	const editorCalls: string[] = [];
	const notifyCalls: Array<{ msg: string; level: string }> = [];
	const customCalls: unknown[] = [];
	return {
		widgetCalls,
		editorCalls,
		notifyCalls,
		customCalls,
		ctx: {
			sessionManager: { getBranch: () => transcript },
			models: { current: () => ({ provider: "test", id: "mon" }), resolve: () => undefined },
			modelRegistry: {},
			cwd: "/tmp",
			hasUI: true,
			ui: {
				setWidget(key: string, content: unknown) {
					widgetCalls.push({ key, content });
				},
				setEditorText(text: string) {
					editorCalls.push(text);
				},
				notify(msg: string, level: string) {
					notifyCalls.push({ msg, level });
				},
				custom: async (factory: unknown) => {
					customCalls.push(factory);
				},
			},
			...overrides,
		},
	};
}

/** Reset module state between tests (disposeMonitor runs async, flush microtasks). */
async function reset(): Promise<void> {
	sessionShutdown?.();
	await Promise.resolve();
}

parallelaudit(pi as unknown as ExtensionAPI);

// ── Registration ──────────────────────────────────────────────────────

describe("registration", () => {
	it("registers /observe with a description and a callable handler", () => {
		expect(observeCommand).toBeDefined();
		expect(observeCommand!.description).toContain("observe");
		expect(typeof observeCommand!.handler).toBe("function");
	});

	it("registers turn_end, session_start, and session_shutdown handlers", () => {
		expect(turnEnd).toBeDefined();
		expect(sessionStart).toBeDefined();
		expect(sessionShutdown).toBeDefined();
	});
});

// ── turn_end → monitor feed ───────────────────────────────────────────

describe("turn_end feed", () => {
	it("creates a monitor session and feeds the transcript delta", async () => {
		await reset();
		turnEnd?.({}, makeCtx().ctx);
		await promptDone;

		expect(createCalls).toBeGreaterThanOrEqual(1);
		expect(promptCalls[0]).toContain("### Session update");
		expect(promptCalls[0]).toContain("hello world");
		expect(createArgs).toMatchObject({
			disableExtensionDiscovery: true,
			additionalExtensionPaths: [],
			tools: ["read", "search", "find"],
		});
	});

	it("handles streaming events without crashing (regression: removed overlay ref)", () => {
		expect(monitorListener).toBeDefined();
		const msg = { role: "assistant", content: [{ type: "text", text: "a thought" }] };
		expect(() => {
			monitorListener?.({ type: "message_update", message: msg });
			monitorListener?.({ type: "message_end", message: msg });
		}).not.toThrow();
	});
});

// ── /observe command ──────────────────────────────────────────────────

describe("/observe command", () => {
	it("opens the widget panel and clears the editor", async () => {
		await reset();
		const fixture = makeCtx();
		await observeCommand!.handler("", fixture.ctx);

		expect(fixture.widgetCalls).toHaveLength(1);
		expect(fixture.widgetCalls[0].key).toBe("parallelaudit");
		expect(fixture.widgetCalls[0].content).toBeDefined();
		expect(fixture.editorCalls).toContain("");
	});

	it("toggles the widget on and off", async () => {
		await reset();
		const fixture = makeCtx();
		await observeCommand!.handler("", fixture.ctx);
		await observeCommand!.handler("", fixture.ctx);

		expect(fixture.widgetCalls).toHaveLength(2);
		// Two calls alternate between show (factory) and hide (undefined),
		// regardless of whether widgetOn started true or false.
		const types = fixture.widgetCalls.map(c => c.content !== undefined);
		expect(types[0]).not.toBe(types[1]);
	});

	it("opens the full-page modal on /observe full", async () => {
		await reset();
		const fixture = makeCtx();
		await observeCommand!.handler("full", fixture.ctx);

		expect(fixture.customCalls).toHaveLength(1);
		expect(fixture.editorCalls).toContain("");
	});

	it("opens the stacked compare modal on /observe full-stacked", async () => {
		await reset();
		const fixture = makeCtx();
		await observeCommand!.handler("full-stacked", fixture.ctx);

		expect(fixture.customCalls).toHaveLength(1);
		expect(fixture.editorCalls).toContain("");
	});

	it("notifies when no UI is available", async () => {
		await reset();
		const fixture = makeCtx({ hasUI: false });
		await observeCommand!.handler("", fixture.ctx);

		expect(fixture.notifyCalls).toHaveLength(1);
		expect(fixture.notifyCalls[0].msg).toContain("no UI");
	});

	it("does not throw even if internal functions are misordered (regression)", async () => {
		await reset();
		const fixture = makeCtx();
		// If showWidget/hideWidget/openFullView were commented out or moved below
		// the call site incorrectly, this throws "X is not defined."
		await expect(observeCommand!.handler("", fixture.ctx)).resolves.toBeUndefined();
		await expect(observeCommand!.handler("full", fixture.ctx)).resolves.toBeUndefined();
	});

	it("replays one prompt per user turn when /observe primes a resumed session", async () => {
		await reset();
		const baseline = promptCalls.length;
		const turns = [
			{ message: { role: "user", content: "first", timestamp: 1 } },
			{ message: { role: "assistant", content: [{ type: "text", text: "reply1" }], timestamp: 2 } },
			{ message: { role: "user", content: "second", timestamp: 3 } },
			{ message: { role: "assistant", content: [{ type: "text", text: "reply2" }], timestamp: 4 } },
		];
		const fixture = makeCtx({ sessionManager: { getBranch: () => turns } });
		const done = waitForPromptCount(baseline + 2);
		await observeCommand!.handler("", fixture.ctx);
		await done;

		const newCalls = promptCalls.slice(baseline);
		expect(newCalls).toHaveLength(2);
		expect(newCalls[0]).toContain("replay 1/2");
		expect(newCalls[1]).toContain("replay 2/2");
	});
});
