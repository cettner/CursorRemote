import { createHash, timingSafeEqual } from "node:crypto";
import websocketPlugin from "@fastify/websocket";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type ServerMessage,
  clientMessageSchema,
} from "@cursorremote/protocol";
import Fastify from "fastify";
import type { WebSocket } from "ws";
import { AgentRegistry, JobNotFoundError, ProjectNotFoundError } from "./agent-registry.js";
import type { DaemonConfig } from "./config.js";
import type { EventBus } from "./events.js";
import { describeError, log } from "./logger.js";

const HEARTBEAT_MS = 30_000;

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on length mismatch, so compare digests of fixed size.
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

function hostIdFor(hostName: string): string {
  return createHash("sha256").update(hostName).digest("hex").slice(0, 12);
}

export interface DaemonServer {
  listen(address: string): Promise<string>;
  close(): Promise<void>;
}

export function createServer(
  config: DaemonConfig,
  registry: AgentRegistry,
  bus: EventBus,
): DaemonServer {
  const app = Fastify({ logger: false });
  const hostId = hostIdFor(config.hostName);

  app.register(websocketPlugin, { options: { maxPayload: 1024 * 1024 } });

  // Deliberately unauthenticated and contentless: lets a client check that
  // something is listening without handing anything out.
  app.get("/health", async () => ({ ok: true, protocolVersion: PROTOCOL_VERSION }));

  app.register(async (scope) => {
    scope.get("/ws", { websocket: true }, (socket, request) => {
      const query = request.query as Record<string, string | undefined>;
      const header = request.headers.authorization;
      const provided = query.token ?? (header?.startsWith("Bearer ") ? header.slice(7) : undefined);

      if (!provided || !tokensMatch(provided, config.token)) {
        log.warn(`Rejected a connection from ${request.ip}: bad token`);
        socket.close(4401, "unauthorized");
        return;
      }

      attachClient(socket, request.ip);
    });
  });

  function attachClient(socket: WebSocket, ip: string): void {
    const send = (message: ServerMessage) => {
      if (socket.readyState !== socket.OPEN) return;
      socket.send(JSON.stringify(message));
    };

    log.info(`Client connected from ${ip}`);
    const unsubscribe = bus.subscribe(send);

    send({
      type: "hello",
      protocolVersion: PROTOCOL_VERSION,
      hostId,
      hostName: config.hostName,
      projects: registry.listProjects(),
      defaultModel: config.defaultModel,
      jobs: registry.listJobs(),
    });

    let alive = true;
    socket.on("pong", () => {
      alive = true;
    });
    const heartbeat = setInterval(() => {
      if (!alive) {
        log.warn(`Client at ${ip} stopped responding; dropping it`);
        socket.terminate();
        return;
      }
      alive = false;
      socket.ping();
    }, HEARTBEAT_MS);

    socket.on("message", (raw) => {
      void handleRaw(raw.toString(), send);
    });

    socket.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      log.info(`Client at ${ip} disconnected`);
    });

    socket.on("error", (error) => {
      log.warn(`Socket error from ${ip}`, error);
    });
  }

  async function handleRaw(raw: string, send: (message: ServerMessage) => void): Promise<void> {
    let message: ClientMessage;
    try {
      message = clientMessageSchema.parse(JSON.parse(raw));
    } catch (error) {
      send({ type: "error", message: `Could not read that message: ${describeError(error)}` });
      return;
    }

    try {
      await dispatch(message, send);
    } catch (error) {
      const detail =
        error instanceof JobNotFoundError || error instanceof ProjectNotFoundError
          ? error.message
          : describeError(error);
      log.warn(`Command ${message.type} failed: ${detail}`);
      send({ type: "ack", requestId: message.requestId, ok: false, detail });
    }
  }

  async function dispatch(
    message: ClientMessage,
    send: (message: ServerMessage) => void,
  ): Promise<void> {
    switch (message.type) {
      case "jobs.list": {
        for (const job of registry.listJobs()) {
          send({ type: "job.updated", job });
        }
        send({ type: "ack", requestId: message.requestId, ok: true });
        return;
      }

      case "job.start": {
        // Not awaited to completion by design: start resolves once the first
        // turn is under way, and progress arrives over the event stream.
        const job = await registry.start(message.projectId, message.prompt, message.model);
        send({ type: "ack", requestId: message.requestId, ok: true, detail: job.jobId });
        return;
      }

      case "job.followup": {
        await registry.followUp(message.jobId, message.prompt);
        send({ type: "ack", requestId: message.requestId, ok: true });
        return;
      }

      case "job.answer": {
        const accepted = registry.answerQuestion(message.questionId, message.answer);
        send({
          type: "ack",
          requestId: message.requestId,
          ok: accepted,
          detail: accepted ? undefined : "That question was already answered or timed out.",
        });
        return;
      }

      case "job.steer": {
        await registry.steer(message.jobId, message.text);
        send({ type: "ack", requestId: message.requestId, ok: true });
        return;
      }

      case "job.cancel": {
        await registry.cancel(message.jobId);
        send({ type: "ack", requestId: message.requestId, ok: true });
        return;
      }

      case "job.transcript": {
        const { events, truncated } = registry.getTranscript(message.jobId);
        send({ type: "job.transcript", jobId: message.jobId, events, truncated });
        send({ type: "ack", requestId: message.requestId, ok: true });
        return;
      }
    }
  }

  return {
    async listen(address: string): Promise<string> {
      await app.listen({ host: address, port: config.port });
      return `${address}:${config.port}`;
    },
    async close(): Promise<void> {
      await app.close();
    },
  };
}
