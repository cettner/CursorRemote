import type { TranscriptEvent } from "@cursorremote/protocol";

export type Block =
  | { kind: "assistant" | "thinking" | "user" | "system"; key: string; text: string }
  | { kind: "tool"; key: string; callId: string; name: string; status: string; detail?: string };

/**
 * Turns the raw event log into something readable: streamed text arrives in
 * many small pieces, and each tool call shows up twice (running, then done).
 * Merging here keeps the rendering dumb.
 */
export function toBlocks(events: TranscriptEvent[]): Block[] {
  const blocks: Block[] = [];

  for (const event of events) {
    const { delta } = event;

    if (delta.kind === "tool_call") {
      const existing = blocks.find(
        (block): block is Extract<Block, { kind: "tool" }> =>
          block.kind === "tool" && block.callId === delta.callId,
      );
      if (existing) {
        existing.status = delta.status;
        existing.detail = delta.detail ?? existing.detail;
      } else {
        blocks.push({
          kind: "tool",
          key: `tool-${delta.callId}`,
          callId: delta.callId,
          name: delta.name,
          status: delta.status,
          detail: delta.detail,
        });
      }
      continue;
    }

    const last = blocks[blocks.length - 1];
    const mergeable = delta.kind === "assistant" || delta.kind === "thinking";
    if (mergeable && last && last.kind === delta.kind) {
      last.text += delta.text;
      continue;
    }

    blocks.push({ kind: delta.kind, key: `${delta.kind}-${event.seq}`, text: delta.text });
  }

  return blocks;
}
