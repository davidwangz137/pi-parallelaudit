import { describe, expect, it } from "vitest";
import type {
	AssistantMessage,
	DeveloperMessage,
	ToolResultMessage,
	Usage,
	UserMessage,
} from "@oh-my-pi/pi-ai";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { renderDelta, renderMessage } from "../extensions/delta";

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

// Factories fill provider/usage boilerplate so fixtures stay readable; the
// render logic only reads role + content (+ toolName for results).
function user(content: UserMessage["content"]): UserMessage {
	return { role: "user", content, timestamp: 1 };
}
function developer(content: DeveloperMessage["content"]): DeveloperMessage {
	return { role: "developer", content, timestamp: 0 };
}
function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic",
		provider: "anthropic",
		model: "claude",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 2,
	};
}
function toolResult(toolName: string, text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: "c1",
		toolName,
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
}

describe("renderMessage", () => {
	it("renders a plain user string", () => {
		expect(renderMessage(user("hello world"))).toBe("**user**: hello world");
	});

	it("joins text blocks of array user content", () => {
		const msg = user([
			{ type: "text", text: "part one" },
			{ type: "text", text: "part two" },
		]);
		expect(renderMessage(msg)).toBe("**user**: part onepart two");
	});

	it("renders assistant thinking, text, and tool calls on separate lines", () => {
		const msg = assistant([
			{ type: "thinking", thinking: "should check x" },
			{ type: "text", text: "running it" },
			{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "ls -la" } },
		]);
		const out = renderMessage(msg);
		expect(out).toContain("> _thinking_: should check x");
		expect(out).toContain("**assistant**: running it");
		expect(out).toContain("→ `bash`(");
		expect(out).toContain('"command":"ls -la"');
	});

	it("renders a tool result prefixed with the tool name", () => {
		expect(renderMessage(toolResult("read", "file contents here"))).toBe(
			"  ↳ read: file contents here",
		);
	});

	it("skips non-conversational roles (developer)", () => {
		expect(renderMessage(developer("system preamble"))).toBeNull();
	});

	it("returns null for a whitespace-only user message", () => {
		expect(renderMessage(user("   "))).toBeNull();
	});
});

describe("renderDelta", () => {
	it("renders only the slice after lastCount and advances the cursor", () => {
		const messages: AgentMessage[] = [user("first"), user("second"), user("third")];
		const out = renderDelta(messages, 1);
		expect(out.text).toBe("**user**: second\n\n**user**: third");
		expect(out.nextCount).toBe(3);
	});

	it("returns null text but still advances the cursor when nothing is renderable", () => {
		const messages: AgentMessage[] = [developer("sys")];
		const out = renderDelta(messages, 0);
		expect(out.text).toBeNull();
		expect(out.nextCount).toBe(1);
	});

	it("reseeds when history shrank (compaction/branch)", () => {
		const messages: AgentMessage[] = [user("only")];
		const out = renderDelta(messages, 5);
		expect(out.text).toBeNull();
		expect(out.nextCount).toBe(1);
	});

	it("joins a mixed multi-message slice with blank lines", () => {
		const messages: AgentMessage[] = [
			user("do the thing"),
			assistant([{ type: "text", text: "done" }]),
			toolResult("bash", "ok"),
		];
		const out = renderDelta(messages, 0);
		expect(out.text).toBe("**user**: do the thing\n\n**assistant**: done\n\n  ↳ bash: ok");
	});
});
