import { describe, expect, it } from "vitest";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import parallelaudit from "../extensions/parallelaudit";

/**
 * Minimal fixtures: the factory only reads these ExtensionAPI/ExtensionContext
 * fields on the turn_end → feed path under test. The unchecked cast is a
 * deliberate test-seam narrowing, not a shape assertion trusted for logic.
 */

type TurnHandler = (ev: unknown, ctx: unknown) => void;
type LifecycleHandler = () => void;

let turnEnd: TurnHandler | undefined;
let sessionStart: LifecycleHandler | undefined;
let observeRegistered = false;

const promptCalls: string[] = [];
// Resolved the first time the fake monitor session is prompted — the real
// completion signal we await instead of guessing a wall-clock delay.
const { promise: promptDone, resolve: resolvePrompt } = Promise.withResolvers<void>();
let createCalls = 0;

const fakeSession = {
	subscribe() {
		return () => {};
	},
	prompt(text: string) {
		promptCalls.push(text);
		resolvePrompt();
		return Promise.resolve(true);
	},
	abort() {
		return Promise.resolve();
	},
};

const pi = {
	logger: { debug() {}, warn() {}, info() {} },
	on(name: string, h: TurnHandler | LifecycleHandler) {
		if (name === "turn_end") turnEnd = h as TurnHandler;
		else if (name === "session_start") sessionStart = h as LifecycleHandler;
	},
	registerCommand(name: string) {
		if (name === "observe") observeRegistered = true;
	},
	pi: {
		SessionManager: { inMemory() {
			return {};
		} },
		buildSessionContext(entries: { message: AgentMessage }[]) {
			return { messages: entries.map(e => e.message) };
		},
		createAgentSession() {
			createCalls += 1;
			return Promise.resolve({ session: fakeSession });
		},
	},
};

const ctx = {
	sessionManager: {
		getBranch: () => [{ message: { role: "user", content: "hello world", timestamp: 1 } }],
	},
	models: {
		current: () => ({ provider: "test", id: "mon" }),
		resolve: () => undefined,
	},
	modelRegistry: {},
	cwd: "/tmp",
	hasUI: false,
	ui: { notify() {} },
};

parallelaudit(pi as unknown as ExtensionAPI);

describe("parallelaudit wiring", () => {
	it("registers the /observe command and the turn_end handler", () => {
		expect(observeRegistered).toBe(true);
		expect(turnEnd).toBeDefined();
	});

	it("feeds the transcript delta to a freshly created monitor session", async () => {
		sessionStart?.();
		turnEnd?.({}, ctx);
		await promptDone;

		expect(createCalls).toBe(1);
		expect(promptCalls).toHaveLength(1);
		expect(promptCalls[0]).toContain("### Session update");
		expect(promptCalls[0]).toContain("hello world");
	});
});
