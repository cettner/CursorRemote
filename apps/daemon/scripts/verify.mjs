#!/usr/bin/env node
/**
 * End-to-end check of the daemon's contract against a running instance.
 * Exercises the parts that are easy to get subtly wrong: that a question
 * really does suspend the run, that answering resumes it, and that cancelling
 * a live run actually stops it.
 *
 *   node scripts/verify.mjs --project scratch
 */
import { readFileSync, existsSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import WebSocket from "ws";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((pairs, value, index, all) => (index % 2 === 0 ? [...pairs, [value.replace(/^--/, ""), all[index + 1]]] : pairs), []),
);

const config = JSON.parse(readFileSync(join(homedir(), ".cursorremote", "config.json"), "utf8"));
const projectId = args.project ?? config.projects[0]?.id;
const project = config.projects.find((entry) => entry.id === projectId);
if (!project) {
  console.error(`No project "${projectId}" in the config.`);
  process.exit(1);
}

const url = args.url ?? `ws://127.0.0.1:${config.port ?? 4517}/ws`;
const socket = new WebSocket(`${url}?token=${encodeURIComponent(config.token)}`);

const handlers = new Set();
const failures = [];
let passed = 0;

socket.on("message", (raw) => {
  const message = JSON.parse(raw.toString());
  for (const handler of [...handlers]) handler(message);
});

socket.on("error", (error) => {
  console.error(`socket error: ${error.message}`);
  process.exit(1);
});

function send(message) {
  socket.send(JSON.stringify({ requestId: randomUUID(), ...message }));
}

/** Resolves with the first message the predicate accepts, or rejects on timeout. */
function waitFor(label, predicate, timeoutMs = 240_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      handlers.delete(handler);
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs);

    const handler = (message) => {
      let hit;
      try {
        hit = predicate(message);
      } catch {
        return;
      }
      if (!hit) return;
      clearTimeout(timer);
      handlers.delete(handler);
      resolve(message);
    };
    handlers.add(handler);
  });
}

function check(label, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    failures.push(label);
    console.log(`  FAIL  ${label}${detail ? ` -- ${detail}` : ""}`);
  }
}

async function main() {
  const hello = await waitFor("hello", (m) => m.type === "hello", 15_000);
  console.log(`\nConnected to ${hello.hostName} (protocol v${hello.protocolVersion})`);
  check("daemon advertises the project", hello.projects.some((p) => p.id === projectId));

  // --- Scenario 1: the agent asks, blocks, and resumes on the answer. -------
  console.log("\n[1] question -> block -> answer -> resume");

  const marker = `verify-${Date.now().toString(36)}`;
  const targetA = `${marker}-alpha.txt`;
  const targetB = `${marker}-beta.txt`;

  send({
    type: "job.start",
    projectId,
    prompt:
      `Call the ask_user tool to ask which of these two filenames I want: "${targetA}" or "${targetB}". ` +
      `Offer both as options. Wait for my answer. Then create exactly that one file in the project root ` +
      `containing the single word "verified", and nothing else. Do not create the other file.`,
  });

  const created = await waitFor("job.created", (m) => m.type === "job.created", 60_000);
  const jobId = created.job.jobId;
  console.log(`  job ${jobId.slice(0, 8)}`);

  const asked = await waitFor("job.question", (m) => m.type === "job.question");
  check("the agent asked rather than guessing", Boolean(asked.question.question));
  check(
    "the question offered both options",
    (asked.question.options ?? []).length >= 2,
    JSON.stringify(asked.question.options),
  );

  const blocked = await waitFor(
    "status awaiting_answer",
    (m) => m.type === "job.updated" && m.job.jobId === jobId && m.job.status === "awaiting_answer",
    30_000,
  );
  check("the run reports itself blocked on the question", blocked.job.status === "awaiting_answer");

  // Nothing should move while we sit on the question.
  await new Promise((resolve) => setTimeout(resolve, 4000));
  check(
    "no file appeared while the question was outstanding",
    !existsSync(join(project.cwd, targetA)) && !existsSync(join(project.cwd, targetB)),
  );

  send({ type: "job.answer", questionId: asked.question.questionId, answer: targetB });
  const resolved = await waitFor(
    "job.question.resolved",
    (m) => m.type === "job.question.resolved" && m.questionId === asked.question.questionId,
    30_000,
  );
  check("the answer was accepted", resolved.resolution === "answered");

  const finished = await waitFor(
    "terminal status",
    (m) =>
      m.type === "job.updated" &&
      m.job.jobId === jobId &&
      ["finished", "error", "cancelled"].includes(m.job.status),
  );
  check("the job finished", finished.job.status === "finished", finished.job.error);
  check("the agent acted on my answer", existsSync(join(project.cwd, targetB)));
  check("the agent did not act on the option I rejected", !existsSync(join(project.cwd, targetA)));

  // --- Scenario 2: transcript replay. --------------------------------------
  console.log("\n[2] transcript replay");
  send({ type: "job.transcript", jobId });
  const transcript = await waitFor(
    "job.transcript",
    (m) => m.type === "job.transcript" && m.jobId === jobId,
    30_000,
  );
  check("transcript replays events", transcript.events.length > 0, `${transcript.events.length} events`);
  check(
    "transcript includes the answer I gave",
    transcript.events.some((e) => e.delta.kind === "user" && e.delta.text.includes(targetB)),
  );
  check(
    "transcript includes tool calls",
    transcript.events.some((e) => e.delta.kind === "tool_call"),
  );

  // --- Scenario 3: follow-up on a finished job keeps the conversation. ------
  console.log("\n[3] follow-up resumes the same agent");
  send({ type: "job.followup", jobId, prompt: `Delete the file you just created, then say DONE.` });
  // The job is already terminal from scenario 1, so wait for it to leave that
  // state before watching for the next terminal status.
  await waitFor(
    "follow-up picked up",
    (m) =>
      m.type === "job.updated" &&
      m.job.jobId === jobId &&
      ["queued", "running"].includes(m.job.status),
    60_000,
  );
  const followed = await waitFor(
    "follow-up terminal status",
    (m) =>
      m.type === "job.updated" &&
      m.job.jobId === jobId &&
      ["finished", "error", "cancelled"].includes(m.job.status),
  );
  check("the follow-up finished", followed.job.status === "finished", followed.job.error);
  check("the follow-up knew which file I meant", !existsSync(join(project.cwd, targetB)));

  // --- Scenario 4: cancelling a live run. ----------------------------------
  console.log("\n[4] cancel a running job");
  send({
    type: "job.start",
    projectId,
    prompt:
      "Count slowly from 1 to 40. After each number, run a shell command that sleeps for 2 seconds. " +
      "Do not stop early and do not ask any questions.",
  });
  const second = await waitFor("second job.created", (m) => m.type === "job.created", 60_000);
  const secondId = second.job.jobId;

  await waitFor(
    "second job running",
    (m) => m.type === "job.updated" && m.job.jobId === secondId && m.job.status === "running",
    60_000,
  );
  await new Promise((resolve) => setTimeout(resolve, 6000));

  send({ type: "job.cancel", jobId: secondId });
  const cancelled = await waitFor(
    "second job terminal",
    (m) =>
      m.type === "job.updated" &&
      m.job.jobId === secondId &&
      ["finished", "error", "cancelled"].includes(m.job.status),
    90_000,
  );
  check("cancel stops the run", cancelled.job.status === "cancelled", cancelled.job.status);

  // Clean up anything the agent left behind.
  for (const name of [targetA, targetB]) {
    const path = join(project.cwd, name);
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

main()
  .then(() => {
    console.log(`\n${passed} passed, ${failures.length} failed`);
    socket.close();
    process.exit(failures.length === 0 ? 0 : 1);
  })
  .catch((error) => {
    console.error(`\nVERIFY ABORTED: ${error.message}`);
    console.log(`${passed} passed, ${failures.length} failed before the abort`);
    socket.close();
    process.exit(1);
  });
