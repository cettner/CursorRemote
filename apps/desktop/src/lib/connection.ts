import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type JobSummary,
  type ProjectInfo,
  type Question,
  type TranscriptEvent,
  serverMessageSchema,
} from "@cursorremote/protocol";

export type ConnectionStatus = "disconnected" | "connecting" | "connected" | "error";

export interface Credentials {
  url: string;
  token: string;
}

export interface DaemonSnapshot {
  status: ConnectionStatus;
  error?: string;
  hostName?: string;
  projects: ProjectInfo[];
  defaultModel?: string;
  jobs: JobSummary[];
  transcripts: Record<string, TranscriptEvent[]>;
}

/** Things worth interrupting the user for. */
export type Alert =
  | { kind: "question"; question: Question; projectName: string }
  | { kind: "finished"; job: JobSummary }
  | { kind: "failed"; job: JobSummary };

const EMPTY: DaemonSnapshot = {
  status: "disconnected",
  projects: [],
  jobs: [],
  transcripts: {},
};

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 15000;

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  const withScheme = /^wss?:\/\//i.test(trimmed)
    ? trimmed
    : `ws://${trimmed.replace(/^https?:\/\//i, "")}`;
  return withScheme.replace(/\/+$/, "").endsWith("/ws") ? withScheme : `${withScheme}/ws`;
}

/**
 * Owns the socket and the mirrored daemon state. Exposed to React through
 * useSyncExternalStore, so components re-render from one immutable snapshot
 * instead of each tracking their own copy.
 */
export class DaemonConnection {
  private socket?: WebSocket;
  private readonly listeners = new Set<() => void>();
  private readonly alertListeners = new Set<(alert: Alert) => void>();
  private snapshot: DaemonSnapshot = EMPTY;
  private credentials?: Credentials;
  private reconnectDelay = RECONNECT_MIN_MS;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private closedByUs = false;
  /** Job statuses as of the last message, to spot the transitions worth alerting on. */
  private lastStatus = new Map<string, JobSummary["status"]>();

  getSnapshot = (): DaemonSnapshot => this.snapshot;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  onAlert(listener: (alert: Alert) => void): () => void {
    this.alertListeners.add(listener);
    return () => this.alertListeners.delete(listener);
  }

  connect(credentials: Credentials): void {
    this.disconnect();
    this.credentials = { ...credentials, url: normalizeUrl(credentials.url) };
    this.closedByUs = false;
    this.open();
  }

  disconnect(): void {
    this.closedByUs = true;
    clearTimeout(this.reconnectTimer);
    this.socket?.close(1000, "client closed");
    this.socket = undefined;
    this.lastStatus.clear();
    this.update(EMPTY);
  }

  private open(): void {
    const credentials = this.credentials;
    if (!credentials) return;

    this.update({ ...this.snapshot, status: "connecting", error: undefined });

    const socket = new WebSocket(`${credentials.url}?token=${encodeURIComponent(credentials.token)}`);
    this.socket = socket;

    socket.onopen = () => {
      this.reconnectDelay = RECONNECT_MIN_MS;
    };

    socket.onmessage = (event) => {
      this.handle(event.data);
    };

    socket.onerror = () => {
      this.update({ ...this.snapshot, status: "error", error: "Could not reach the daemon." });
    };

    socket.onclose = (event) => {
      this.socket = undefined;
      if (this.closedByUs) return;

      // 4401 is our own "bad token"; retrying would just fail the same way.
      if (event.code === 4401) {
        this.update({ ...this.snapshot, status: "error", error: "That token was rejected." });
        return;
      }

      this.update({
        ...this.snapshot,
        status: "disconnected",
        error: this.snapshot.error ?? "Connection dropped. Retrying...",
      });
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, RECONNECT_MAX_MS);
  }

  private handle(raw: unknown): void {
    let message;
    try {
      message = serverMessageSchema.parse(JSON.parse(String(raw)));
    } catch {
      return;
    }

    switch (message.type) {
      case "hello": {
        if (message.protocolVersion !== PROTOCOL_VERSION) {
          this.closedByUs = true;
          this.socket?.close();
          this.update({
            ...this.snapshot,
            status: "error",
            error: `This daemon speaks protocol v${message.protocolVersion}, the app speaks v${PROTOCOL_VERSION}. Update whichever is older.`,
          });
          return;
        }
        for (const job of message.jobs) this.lastStatus.set(job.jobId, job.status);
        this.update({
          status: "connected",
          error: undefined,
          hostName: message.hostName,
          projects: message.projects,
          defaultModel: message.defaultModel,
          jobs: message.jobs,
          transcripts: this.snapshot.transcripts,
        });
        return;
      }

      case "job.created":
      case "job.updated": {
        this.noteStatusChange(message.job);
        const jobs = this.snapshot.jobs.filter((job) => job.jobId !== message.job.jobId);
        jobs.unshift(message.job);
        jobs.sort((a, b) => b.createdAt - a.createdAt);
        this.update({ ...this.snapshot, jobs });
        return;
      }

      case "job.delta": {
        const existing = this.snapshot.transcripts[message.jobId] ?? [];
        if (existing.some((event) => event.seq === message.seq)) return;
        this.update({
          ...this.snapshot,
          transcripts: {
            ...this.snapshot.transcripts,
            [message.jobId]: [...existing, { seq: message.seq, at: message.at, delta: message.delta }],
          },
        });
        return;
      }

      case "job.transcript": {
        this.update({
          ...this.snapshot,
          transcripts: { ...this.snapshot.transcripts, [message.jobId]: message.events },
        });
        return;
      }

      case "job.question": {
        const job = this.snapshot.jobs.find((entry) => entry.jobId === message.question.jobId);
        this.emitAlert({
          kind: "question",
          question: message.question,
          projectName: job?.projectName ?? "a job",
        });
        return;
      }

      default:
        return;
    }
  }

  /** Alerts fire on the edge into a terminal state, never on a repeat. */
  private noteStatusChange(job: JobSummary): void {
    const previous = this.lastStatus.get(job.jobId);
    this.lastStatus.set(job.jobId, job.status);
    if (previous === job.status) return;
    if (previous === undefined) return;

    if (job.status === "finished") this.emitAlert({ kind: "finished", job });
    else if (job.status === "error") this.emitAlert({ kind: "failed", job });
  }

  private emitAlert(alert: Alert): void {
    for (const listener of this.alertListeners) listener(alert);
  }

  private update(snapshot: DaemonSnapshot): void {
    this.snapshot = snapshot;
    for (const listener of this.listeners) listener();
  }

  private send(message: ClientMessage): void {
    if (this.socket?.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private requestId(): string {
    return crypto.randomUUID();
  }

  startJob(projectId: string, prompt: string, model?: string): void {
    this.send({ type: "job.start", requestId: this.requestId(), projectId, prompt, model });
  }

  followUp(jobId: string, prompt: string): void {
    this.send({ type: "job.followup", requestId: this.requestId(), jobId, prompt });
  }

  steer(jobId: string, text: string): void {
    this.send({ type: "job.steer", requestId: this.requestId(), jobId, text });
  }

  answer(questionId: string, answer: string): void {
    this.send({ type: "job.answer", requestId: this.requestId(), questionId, answer });
  }

  cancel(jobId: string): void {
    this.send({ type: "job.cancel", requestId: this.requestId(), jobId });
  }

  loadTranscript(jobId: string): void {
    this.send({ type: "job.transcript", requestId: this.requestId(), jobId });
  }
}
