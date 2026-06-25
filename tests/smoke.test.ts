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
let createCalls = 0;
let createArgs: Record<string, unknown> | undefined;

const fakeSession = {
	subscribe(fn: (ev: unknown) => void) {
		monitorListener = fn;
		return () => {};
	},
	prompt(text: string) {
		promptCalls.push(text);
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

let transcript: { message: AgentMessage }[] = [];

/** Wait until promptCalls reaches the target count, polling microtasks. */
async function flushToPrompts(target: number): Promise<void> {
	let guard = 0;
	while (promptCalls.length < target && guard < 500) {
		await Promise.resolve();
		guard++;
	}
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

/** Reset module state between tests. */
async function reset(): Promise<void> {
	sessionShutdown?.();
	// disposeMonitor is void async — its IIFE + any pending runTurn chains
	// from the previous test need many microtask hops to fully drain.
	for (let i = 0; i < 50; i++) await Promise.resolve();
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
		transcript = [{ message: { role: "user", content: "hello world", timestamp: 1 } }];
		turnEnd?.({}, makeCtx().ctx);
		await flushToPrompts(promptCalls.length + 1);

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
		await observeCommand!.handler("full", fixture.ctx);
		await flushToPrompts(baseline + 2);

		const newCalls = promptCalls.slice(baseline);
		expect(newCalls).toHaveLength(2);
		expect(newCalls[0]).toContain("replay 1/2");
		expect(newCalls[1]).toContain("replay 2/2");
	});
});

// ── Resume + extend scenarios ────────────────────────────────────────

/** Helper: build a transcript with N user+assistant turns. */
function makeTurns(n: number): { message: AgentMessage }[] {
	const entries: { message: AgentMessage }[] = [];
	for (let i = 0; i < n; i++) {
		entries.push({ message: { role: "user", content: `question ${i + 1}`, timestamp: i * 100 + 1 } });
		entries.push({ message: { role: "assistant", content: [{ type: "text", text: `answer ${i + 1}` }], timestamp: i * 100 + 2 } });
	}
	return entries;
}

describe("resume + extend scenarios", () => {
	it("resume 3 turns → /observe full replays 3 chunks", async () => {
		await reset();
		transcript = makeTurns(3);
		const baseline = promptCalls.length;
		const fixture = makeCtx();
		await observeCommand!.handler("full", fixture.ctx);
		await flushToPrompts(baseline + 3);

		const calls = promptCalls.slice(baseline);
		expect(calls).toHaveLength(3);
		expect(calls[0]).toContain("replay 1/3");
		expect(calls[1]).toContain("replay 2/3");
		expect(calls[2]).toContain("replay 3/3");
	});

	it("resume 2 turns → /observe full → live turn_end feeds 1 more", async () => {
		await reset();
		transcript = makeTurns(2);
		const baseline = promptCalls.length;
		const fixture = makeCtx();
		await observeCommand!.handler("full", fixture.ctx);
		await flushToPrompts(baseline + 2);

		transcript = makeTurns(3);
		turnEnd?.({}, fixture.ctx);
		await flushToPrompts(baseline + 3);

		const calls = promptCalls.slice(baseline);
		expect(calls).toHaveLength(3);
		expect(calls[0]).toContain("replay 1/2");
		expect(calls[1]).toContain("replay 2/2");
		expect(calls[2]).not.toContain("replay");
		expect(calls[2]).toContain("question 3");
	});

	it("resume → turn_end with 4-turn backlog chunks all 4 individually", async () => {
		await reset();
		transcript = makeTurns(4);
		const baseline = promptCalls.length;
		const fixture = makeCtx();
		turnEnd?.({}, fixture.ctx);
		await flushToPrompts(baseline + 4);

		const calls = promptCalls.slice(baseline);
		expect(calls).toHaveLength(4);
		expect(calls[0]).toContain("question 1");
		expect(calls[1]).toContain("question 2");
		expect(calls[2]).toContain("question 3");
		expect(calls[3]).toContain("question 4");
		for (const call of calls) {
			const qCount = (call.match(/question \d/g) ?? []).length;
			expect(qCount).toBe(1);
		}
	});

	it("resume → /observe full (2 turns) → extend + turn_end → /observe full (no re-replay)", async () => {
		await reset();
		transcript = makeTurns(2);
		const baseline = promptCalls.length;
		const fixture = makeCtx();

		await observeCommand!.handler("full", fixture.ctx);
		await flushToPrompts(baseline + 2);

		transcript = makeTurns(3);
		turnEnd?.({}, fixture.ctx);
		await flushToPrompts(baseline + 3);

		const beforeSecond = promptCalls.length;
		await observeCommand!.handler("full", fixture.ctx);
		expect(promptCalls.length).toBe(beforeSecond);
	});
});
