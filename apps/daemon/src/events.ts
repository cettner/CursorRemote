import type { JobDelta, ServerMessage, TranscriptEvent } from "@cursorremote/protocol";

type Subscriber = (message: ServerMessage) => void;

interface Transcript {
  events: TranscriptEvent[];
  nextSeq: number;
  truncated: boolean;
}

/**
 * Fans server messages out to every connected client and keeps a bounded
 * transcript per job. The buffer is what lets a client that connects after a
 * job started show the work so far instead of an empty pane.
 */
export class EventBus {
  private readonly subscribers = new Set<Subscriber>();
  private readonly transcripts = new Map<string, Transcript>();

  constructor(private readonly bufferSize: number) {}

  subscribe(subscriber: Subscriber): () => void {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  broadcast(message: ServerMessage): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(message);
      } catch {
        // A single broken socket must not stop the others from being told.
      }
    }
  }

  /** Records a transcript increment and pushes it to everyone watching. */
  appendDelta(jobId: string, delta: JobDelta): void {
    let transcript = this.transcripts.get(jobId);
    if (!transcript) {
      transcript = { events: [], nextSeq: 0, truncated: false };
      this.transcripts.set(jobId, transcript);
    }

    const event: TranscriptEvent = {
      seq: transcript.nextSeq++,
      at: Date.now(),
      delta,
    };
    transcript.events.push(event);

    if (transcript.events.length > this.bufferSize) {
      transcript.events.splice(0, transcript.events.length - this.bufferSize);
      transcript.truncated = true;
    }

    this.broadcast({ type: "job.delta", jobId, seq: event.seq, at: event.at, delta });
  }

  getTranscript(jobId: string): { events: TranscriptEvent[]; truncated: boolean } {
    const transcript = this.transcripts.get(jobId);
    if (!transcript) return { events: [], truncated: false };
    return { events: [...transcript.events], truncated: transcript.truncated };
  }

  forgetJob(jobId: string): void {
    this.transcripts.delete(jobId);
  }
}
