/**
 * Pure transcript-delta rendering for the parallelaudit monitor.
 *
 * Kept free of any omp runtime dependency so it is unit-testable in isolation.
 * The extension feeds the rendered markdown to the monitor model on each
 * primary `turn_end`.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent } from "@oh-my-pi/pi-ai";

/** Concatenate the `text` blocks of a user/toolResult content into one string. */
function messageText(content: string | readonly (TextContent | ImageContent)[]): string {
	if (typeof content === "string") return content;
	return content.filter((b): b is TextContent => b.type === "text").map(b => b.text).join("");
}

function summarizeArgs(args: Record<string, unknown>): string {
	try {
		const json = JSON.stringify(args);
		return json.length > 80 ? json.slice(0, 77) + "…" : json;
	} catch {
		return "[unserializable]";
	}
}

function truncate(text: string, max = 400): string {
	const collapsed = text.replace(/\s+/g, " ").trim();
	return collapsed.length > max ? collapsed.slice(0, max - 1) + "…" : collapsed;
}

/** Render one transcript message as readable markdown, or null to skip it. */
export function renderMessage(msg: AgentMessage): string | null {
	switch (msg.role) {
		case "user": {
			const text = truncate(messageText(msg.content));
			return text ? `**user**: ${text}` : null;
		}
		case "assistant": {
			const lines: string[] = [];
			for (const block of msg.content) {
				if (block.type === "thinking") {
					const t = block.thinking.trim();
					if (t) lines.push(`> _thinking_: ${truncate(t, 300)}`);
				} else if (block.type === "text") {
					const t = block.text.trim();
					if (t) lines.push(`**assistant**: ${truncate(t)}`);
				} else if (block.type === "toolCall") {
					lines.push(`  → \`${block.name}\`(${truncate(summarizeArgs(block.arguments), 120)})`);
				}
			}
			return lines.length > 0 ? lines.join("\n") : null;
		}
		case "toolResult": {
			const text = truncate(messageText(msg.content));
			return text ? `  ↳ ${msg.toolName}: ${text}` : null;
		}
		default:
			// custom / developer / notification — not useful as monitor input
			return null;
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
