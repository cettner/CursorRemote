#!/usr/bin/env node
/**
 * A terminal client for the daemon. Exists to prove the whole loop works
 * (start, stream, question, answer, steer, cancel) without the desktop app in
 * the picture, which also makes it the first place to look when the UI
 * misbehaves and you need to know which side is at fault.
 *
 *   node scripts/probe.mjs [--url ws://host:4517/ws] [--token ...] [--project id]
 *
 * With no arguments it reads ~/.cursorremote/config.json and connects over
 * loopback. Type to talk: plain text answers a pending question, steers a
 * running job, or starts a new one. /jobs /cancel /new /quit for the rest.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key) args[key] = argv[i + 1];
  }
  return args;
}

function loadLocalConfig() {
  try {
    return JSON.parse(readFileSync(join(homedir(), ".cursorremote", "config.json"), "utf8"));
  } catch {
    return {};
  }
}

const args = parseArgs(process.argv.slice(2));
const local = loadLocalConfig();
const token = args.token ?? local.token;
const url = args.url ?? `ws://127.0.0.1:${local.port ?? 4517}/ws`;

if (!token) {
  console.error("No token. Pass --token or let the daemon write ~/.cursorremote/config.json.");
  process.exit(1);
}

const dim = (text) => `\x1b[2m${text}\x1b[0m`;
const bold = (text) => `\x1b[1m${text}\x1b[0m`;
const yellow = (text) => `\x1b[33m${text}\x1b[0m`;
const red = (text) => `\x1b[31m${text}\x1b[0m`;
const green = (text) => `\x1b[32m${text}\x1b[0m`;

const state = {
  projects: [],
  defaultProject: args.project,
  activeJob: null,
  pendingQuestion: null,
  jobs: new Map(),
};

const socket = new WebSocket(`${url}?token=${encodeURIComponent(token)}`);
const rl = createInterface({ input: process.stdin, output: process.stdout, prompt: "> " });

// Anything typed before the handshake finishes waits here rather than throwing.
// Typing that fast is hard, but piping input is not, and over a relayed tailnet
// link the first line regularly beats the connection.
const outbox = [];

function send(message) {
  const payload = JSON.stringify({ requestId: randomUUID(), ...message });
  if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  else outbox.push(payload);
}

socket.on("open", () => {
  console.log(dim(`connected to ${url}`));
  while (outbox.length) socket.send(outbox.shift());
});

socket.on("close", (code, reason) => {
  console.log(red(`\ndisconnected (${code}) ${reason}`));
  process.exit(code === 1000 ? 0 : 1);
});

socket.on("error", (error) => {
  console.error(red(`socket error: ${error.message}`));
});

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());

  switch (message.type) {
    case "hello":
      state.projects = message.projects;
      state.defaultProject ??= message.projects[0]?.id;
      console.log(bold(`\n${message.hostName}`), dim(`protocol v${message.protocolVersion}`));
      console.log(dim(`projects: ${message.projects.map((p) => p.id).join(", ") || "none"}`));
      for (const job of message.jobs) state.jobs.set(job.jobId, job);
      if (message.jobs.length > 0) {
        console.log(dim(`${message.jobs.length} job(s) on record; /jobs to list`));
        const live = message.jobs.find((job) => job.status === "running" || job.status === "awaiting_answer");
        if (live) {
          state.activeJob = live.jobId;
          state.pendingQuestion = live.pendingQuestion;
          console.log(yellow(`following live job ${live.jobId.slice(0, 8)}`));
        }
      }
      rl.prompt();
      break;

    case "job.created":
    case "job.updated":
      state.jobs.set(message.job.jobId, message.job);
      if (message.job.jobId === state.activeJob) {
        state.pendingQuestion = message.job.pendingQuestion;
        if (["finished", "error", "cancelled"].includes(message.job.status)) {
          const colour = message.job.status === "finished" ? green : red;
          console.log(colour(`\n[${message.job.status}] ${message.job.error ?? ""}`));
          rl.prompt();
        }
      }
      break;

    case "job.delta": {
      const { delta } = message;
      if (delta.kind === "assistant") process.stdout.write(delta.text);
      else if (delta.kind === "thinking") process.stdout.write(dim(delta.text));
      else if (delta.kind === "tool_call")
        console.log(dim(`\n  [${delta.name} ${delta.status}] ${delta.detail ?? ""}`));
      else if (delta.kind === "user") console.log(bold(`\nyou: ${delta.text}`));
      else console.log(dim(`\n  ${delta.text}`));
      break;
    }

    case "job.question":
      state.pendingQuestion = message.question;
      state.activeJob = message.question.jobId;
      console.log(yellow(`\n\nQUESTION: ${message.question.question}`));
      if (message.question.context) console.log(dim(message.question.context));
      if (message.question.options)
        console.log(dim(`options: ${message.question.options.join(" | ")}`));
      console.log(yellow("type your answer and press enter"));
      rl.prompt();
      break;

    case "job.question.resolved":
      state.pendingQuestion = null;
      console.log(green(`\n(${message.resolution})`));
      break;

    case "job.transcript":
      console.log(dim(`\n--- ${message.events.length} event(s)${message.truncated ? ", truncated" : ""} ---`));
      for (const event of message.events) {
        const { delta } = event;
        const text = delta.kind === "tool_call" ? `[${delta.name}] ${delta.detail ?? ""}` : delta.text;
        console.log(dim(`${delta.kind.padEnd(10)}`), text);
      }
      rl.prompt();
      break;

    case "ack":
      if (!message.ok) console.log(red(`\nrejected: ${message.detail}`));
      else if (message.detail) {
        state.activeJob = message.detail;
        console.log(dim(`\njob ${message.detail.slice(0, 8)} started`));
      }
      break;

    case "error":
      console.log(red(`\nerror: ${message.message}`));
      break;
  }
});

rl.on("line", (line) => {
  const input = line.trim();
  if (!input) return rl.prompt();

  if (input === "/quit") return socket.close(1000, "bye");

  if (input === "/jobs") {
    for (const job of state.jobs.values()) {
      console.log(
        `${job.jobId.slice(0, 8)}  ${job.status.padEnd(16)} ${job.projectId.padEnd(12)} ${job.prompt.slice(0, 50)}`,
      );
    }
    return rl.prompt();
  }

  if (input === "/cancel") {
    if (!state.activeJob) console.log(red("no active job"));
    else send({ type: "job.cancel", jobId: state.activeJob });
    return rl.prompt();
  }

  if (input.startsWith("/new ")) {
    const rest = input.slice(5);
    const spaceAt = rest.indexOf(" ");
    const projectId = rest.slice(0, spaceAt);
    const prompt = rest.slice(spaceAt + 1);
    send({ type: "job.start", projectId, prompt });
    return rl.prompt();
  }

  // Plain text routes to whatever the job needs right now.
  if (state.pendingQuestion) {
    send({ type: "job.answer", questionId: state.pendingQuestion.questionId, answer: input });
    state.pendingQuestion = null;
  } else if (state.activeJob) {
    const job = state.jobs.get(state.activeJob);
    if (job && ["finished", "error", "cancelled"].includes(job.status)) {
      send({ type: "job.followup", jobId: state.activeJob, prompt: input });
    } else {
      send({ type: "job.steer", jobId: state.activeJob, text: input });
    }
  } else if (state.defaultProject) {
    send({ type: "job.start", projectId: state.defaultProject, prompt: input });
  } else {
    console.log(red("no project configured; use /new <projectId> <prompt>"));
  }
  rl.prompt();
});

rl.on("close", () => socket.close(1000, "bye"));
