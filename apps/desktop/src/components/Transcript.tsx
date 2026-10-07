import { useEffect, useRef } from "react";
import type { TranscriptEvent } from "@cursorremote/protocol";
import { toBlocks } from "../lib/transcript";

interface Props {
  events: TranscriptEvent[];
}

export function Transcript({ events }: Props) {
  const bottom = useRef<HTMLDivElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Only auto-scroll while the user is already at the bottom, so reading back
  // through a long transcript is not yanked away by incoming output.
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const onScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      pinned.current = distance < 80;
    };
    element.addEventListener("scroll", onScroll);
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (pinned.current) bottom.current?.scrollIntoView({ block: "end" });
  }, [events]);

  const blocks = toBlocks(events);

  return (
    <div className="transcript" ref={container}>
      {blocks.length === 0 ? <p className="muted pad">No output yet.</p> : null}

      {blocks.map((block) => {
        if (block.kind === "tool") {
          return (
            <div key={block.key} className={`tool ${block.status}`}>
              <span className="tool-name">{block.name}</span>
              {block.detail ? <code className="tool-detail">{block.detail}</code> : null}
              <span className="tool-status">{block.status}</span>
            </div>
          );
        }

        return (
          <div key={block.key} className={`block ${block.kind}`}>
            {block.kind === "user" ? <span className="block-label">you</span> : null}
            {block.kind === "thinking" ? <span className="block-label">thinking</span> : null}
            <div className="block-text">{block.text}</div>
          </div>
        );
      })}

      <div ref={bottom} />
    </div>
  );
}
