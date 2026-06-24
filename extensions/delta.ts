/**
 * Pure transcript-delta rendering for the parallelaudit monitor.
 *
 * Mirrors the *content* omp's built-in advisor feeds its reviewer model:
 * full (untruncated) user text, assistant thinking + text + tool calls (with
 * their intent), tool results, and the primary's injected constraint context
 * (plan-mode rules / approved plan) expanded verbatim. Other custom/system
 * messages are skipped. Secret obfuscation is handled by the monitor's own
 * AgentSession (createAgentSession wires an obfuscator from the inherited
 * settings), so nothing extra is done here.
 *
 * Kept free of any omp runtime dependency so it is unit-testable in isolation.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

/** Custom message types that carry the primary's injected constraint context
 *  (plan-mode rules, the approved plan) — rendered verbatim, like the advisor's
 *  `expandPrimaryContext`. */
const PRIMARY_CONTEXT_TYPES: ReadonlySet<string> = new Set([
	"plan-mode-context",
	"plan-mode-reference",
]);

/** Concatenate the `text` blocks of a user/toolResult content into one string. */
function messageText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.filter((b): b is TextContent => b.type === "text").map(b => b.text).join("");
}

/** A short summary of a tool call's arguments (the advisor shows a short
 *  `primaryArg`, not the full JSON, to keep tool-call lines readable). */
function summarizeArgs(args: Record<string, unknown>): string {
	try {
		const json = JSON.stringify(args);
		return json.length > 200 ? json.slice(0, 197) + "…" : json;
	} catch {
		return "[unserializable]";
	}
}

function escapeXml(text: string): string {
	return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Pull text out of a custom message's content (string or text-block array). */
function customMessageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b): b is TextContent => typeof b === "object" && b !== null && b.type === "text")
			.map(b => b.text)
			.join("");
	}
	return "";
}

/** Narrow a runtime custom message carrying primary context the compiler can't
 *  see (the `custom` role is merged into AgentSession's union by omp, not by the
 *  bare pi-agent-core type this module imports). */
function isPrimaryContextMessage(
	value: unknown,
): value is { customType: string; content: unknown } {
	return (
		typeof value === "object" &&
		value !== null &&
		"customType" in value &&
		typeof value.customType === "string" &&
		PRIMARY_CONTEXT_TYPES.has(value.customType)
	);
}

/** Render one transcript message as readable markdown, or null to skip it. */
export function renderMessage(msg: AgentMessage): string | null {
	switch (msg.role) {
		case "user": {
			const text = messageText(msg.content).trim();
			return text ? `**user**: ${text}` : null;
		}
		case "assistant": {
			const lines: string[] = [];
			for (const block of msg.content) {
				if (block.type === "thinking") {
					const t = block.thinking.trim();
					if (t) lines.push(`> _thinking_: ${t}`);
				} else if (block.type === "text") {
					const t = block.text.trim();
					if (t) lines.push(`**assistant**: ${t}`);
				} else if (block.type === "toolCall") {
					const intent = typeof block.intent === "string" ? block.intent.trim() : "";
					if (intent) lines.push(`  // ${intent}`);
					lines.push(`  → \`${block.name}\`(${summarizeArgs(block.arguments)})`);
				}
			}
			return lines.length > 0 ? lines.join("\n") : null;
		}
		case "toolResult": {
			const text = messageText(msg.content).trim();
			return text ? `  ↳ ${msg.toolName}: ${text}` : null;
		}
		default: {
			// developer / notification / custom — expand only the primary's
			// injected constraint context, XML-escaped and tagged so the monitor
			// reads it as the primary's instructions rather than its own.
			if (!isPrimaryContextMessage(msg)) return null;
			const text = customMessageText(msg.content).trim();
			if (!text) return null;
			return `<primary-context kind="${escapeXml(msg.customType)}">\n${escapeXml(text)}\n</primary-context>`;
		}
	}
}

export interface DeltaResult {
	/** Formatted markdown for the new slice, or null when nothing renderable. */
	text: string | null;
	/** New cursor to pass as `lastCount` on the next call. */
	nextCount: number;
}

/**
 * Render the transcript slice after `lastCount` as markdown. If the history
 * shrank (compaction / branch / rewind), reseed silently: return null and move
 * the cursor to the new length so the next turn starts fresh rather than
 * feeding a negative/stale slice.
 */
export function renderDelta(messages: readonly AgentMessage[], lastCount: number): DeltaResult {
	if (messages.length < lastCount) {
		return { text: null, nextCount: messages.length };
	}
	const rendered = messages
		.slice(lastCount)
		.map(renderMessage)
		.filter((s): s is string => s !== null);
	return {
		text: rendered.length > 0 ? rendered.join("\n\n") : null,
		nextCount: messages.length,
	};
}
