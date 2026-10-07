import { randomUUID } from "node:crypto";
import { Agent, type Run, type RunStatus, type SDKAgent, type SDKMessage } from "@cursor/sdk";
import {
  ASK_USER_TOOL_NAME,
  type JobStatus,
  type JobSummary,
  type ProjectInfo,
  isTerminal,
} from "@cursorremote/protocol";
import type { DaemonConfig } from "./config.js";
import type { EventBus } from "./events.js";
import { type JobRecord, JobStore } from "./job-store.js";
import { describeError, log } from "./logger.js";
import { QuestionRegistry, createAskUserTool } from "./questions.js";

/**
 * Appended to every prompt. Without it the agent has no reason to believe
 * anyone is watching, and will guess rather than call `ask_user`.
 */
const REMOTE_DIRECTIVE = [
  "",
  "---",
  "You are running headless on a machine nobody is sitting at. The operator is",
  `watching from another device. If you need a decision, call the ${ASK_USER_TOOL_NAME} tool`,
  "and wait for their reply instead of guessing or stopping. Ask before anything",
  "destructive or hard to undo. When you finish, end with a short summary of what",
  "changed and anything still needing a human.",
].join("\n");

interface JobRuntime {
  agent?: SDKAgent;
  run?: Run;
  /** Resolves when the in-flight turn is done, so cancel and follow-ups can wait. */
  turn?: Promise<void>;
  stopStatusListener?: () => void;
}

export class JobNotFoundError extends Error {
  constructor(jobId: string) {
    super(`No job with id ${jobId}`);
  }
}

export class ProjectNotFoundError extends Error {
  constructor(projectId: string) {
    super(`No project with id ${projectId}`);
  }
}

function firstLine(text: string, max = 60): string {
  const line = text.split(/\r?\n/)[0]?.trim() ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}\u2026` : line;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}\u2026` : text;
}

/** Pulls the one field that makes a tool call recognizable at a glance. */
function summarizeToolArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "target_file", "pattern", "query"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return truncate(value.trim(), 200);
    }
  }
  return undefined;
}

export class AgentRegistry {
  private readonly runtimes = new Map<string, JobRuntime>();
  private readonly questions: QuestionRegistry;
  private readonly projects: Map<string, ProjectInfo>;

  constructor(
    private readonly config: DaemonConfig,
    /** Undefined means "use the key the SDK has stored from `npm run login`". */
    private readonly apiKey: string | undefined,
    private readonly bus: EventBus,
    private readonly store: JobStore,
  ) {
    this.projects = new Map(config.projects.map((project) => [project.id, project]));
    this.questions = new QuestionRegistry(config.questionTimeoutMs, {
      onAsked: (question) => {
        this.bus.broadcast({ type: "job.question", question });
        this.bus.appendDelta(question.jobId, {
          kind: "system",
          text: `Waiting on you: ${question.question}`,
        });
        this.setStatus(question.jobId, "awaiting_answer");
      },
      onResolved: (question, outcome) => {
        this.bus.broadcast({
          type: "job.question.resolved",
          jobId: question.jobId,
          questionId: question.questionId,
          resolution: outcome.resolution,
          answer: outcome.answer,
        });
        this.bus.appendDelta(question.jobId, {
          kind: "user",
          text:
            outcome.resolution === "answered"
              ? outcome.answer
              : `(${outcome.resolution}) ${outcome.answer}`,
        });
        const record = this.store.get(question.jobId);
        if (record && !isTerminal(record.status)) {
          this.setStatus(question.jobId, "running");
        }
      },
    });
  }

  /**
   * Any job still marked live belongs to a process that no longer exists, so
   * it cannot be resumed mid-turn. The agentId survives, which is what lets a
   * follow-up continue the same conversation.
   */
  recoverFromRestart(): void {
    for (const record of this.store.load()) {
      if (isTerminal(record.status)) continue;
      this.store.patch(record.jobId, {
        status: "error",
        error: "Interrupted when the daemon restarted. Send a follow-up to continue.",
      });
      log.warn(`Job ${record.jobId} was mid-flight at shutdown; marked interrupted`);
    }
  }

  listProjects(): ProjectInfo[] {
    return [...this.projects.values()];
  }

  listJobs(): JobSummary[] {
    return this.store.all().map((record) => this.toSummary(record));
  }

  getTranscript(jobId: string) {
    if (!this.store.get(jobId)) throw new JobNotFoundError(jobId);
    return this.bus.getTranscript(jobId);
  }

  private toSummary(record: JobRecord): JobSummary {
    return { ...record, pendingQuestion: this.questions.pendingForJob(record.jobId) };
  }

  private publish(record: JobRecord | undefined): void {
    if (!record) return;
    this.bus.broadcast({ type: "job.updated", job: this.toSummary(record) });
  }

  private setStatus(jobId: string, status: JobStatus): void {
    const current = this.store.get(jobId);
    if (!current || current.status === status) return;
    this.publish(this.store.setStatus(jobId, status));
  }

  /** Starts a brand new conversation in a project. */
  async start(projectId: string, prompt: string, model?: string): Promise<JobSummary> {
    const project = this.projects.get(projectId);
    if (!project) throw new ProjectNotFoundError(projectId);

    const jobId = randomUUID();
    const now = Date.now();
    const record: JobRecord = {
      jobId,
      agentId: null,
      projectId: project.id,
      projectName: project.name,
      prompt,
      status: "queued",
      model: model ?? this.config.defaultModel,
      createdAt: now,
      updatedAt: now,
    };
    this.store.put(record);
    this.runtimes.set(jobId, {});
    this.bus.broadcast({ type: "job.created", job: this.toSummary(record) });
    this.bus.appendDelta(jobId, { kind: "user", text: prompt });

    try {
      const agent = await Agent.create({
        apiKey: this.apiKey,
        model: { id: record.model ?? this.config.defaultModel },
        name: `${project.name}: ${firstLine(prompt)}`,
        local: {
          cwd: project.cwd,
          settingSources: this.config.settingSources,
          autoReview: this.config.autoReview,
          customTools: {
            [ASK_USER_TOOL_NAME]: createAskUserTool(jobId, this.questions),
          },
        },
      });

      const runtime = this.runtimes.get(jobId);
      if (!runtime) {
        // Cancelled between the create call and its resolution.
        agent.close();
        return this.toSummary(this.store.get(jobId) ?? record);
      }
      runtime.agent = agent;
      this.publish(this.store.patch(jobId, { agentId: agent.agentId }));

      await this.beginTurn(jobId, agent, prompt);
    } catch (error) {
      // Thrown here means the run never started: auth, config, or network.
      this.failJob(jobId, `Could not start the agent: ${describeError(error)}`);
    }

    return this.toSummary(this.store.get(jobId) ?? record);
  }

  /**
   * Another turn on an existing job. Falls back to steering when the previous
   * turn is still going, so the caller does not have to race the status.
   */
  async followUp(jobId: string, prompt: string): Promise<JobSummary> {
    const record = this.store.get(jobId);
    if (!record) throw new JobNotFoundError(jobId);

    const runtime = this.runtimes.get(jobId);
    if (runtime?.run && !isTerminal(record.status)) {
      return this.steer(jobId, prompt);
    }

    if (!record.agentId) {
      throw new Error("This job never got an agent, so there is nothing to continue.");
    }

    const project = this.projects.get(record.projectId);
    if (!project) throw new ProjectNotFoundError(record.projectId);

    this.publish(this.store.patch(jobId, { prompt, result: undefined, error: undefined }));
    this.bus.appendDelta(jobId, { kind: "user", text: prompt });

    try {
      let agent = runtime?.agent;
      if (!agent) {
        // Custom tools are not persisted on the agent, so they go in again here.
        agent = await Agent.resume(record.agentId, {
          apiKey: this.apiKey,
          model: { id: record.model ?? this.config.defaultModel },
          local: {
            cwd: project.cwd,
            settingSources: this.config.settingSources,
            autoReview: this.config.autoReview,
            customTools: {
              [ASK_USER_TOOL_NAME]: createAskUserTool(jobId, this.questions),
            },
          },
        });
        this.runtimes.set(jobId, { ...(runtime ?? {}), agent });
      }

      await this.beginTurn(jobId, agent, prompt);
    } catch (error) {
      this.failJob(jobId, `Could not continue the agent: ${describeError(error)}`);
    }

    return this.toSummary(this.store.get(jobId) ?? record);
  }

  /** Injects text into the turn that is already executing. */
  async steer(jobId: string, text: string): Promise<JobSummary> {
    const record = this.store.get(jobId);
    if (!record) throw new JobNotFoundError(jobId);

    const runtime = this.runtimes.get(jobId);
    const run = runtime?.run;
    if (!run) return this.followUp(jobId, text);

    this.bus.appendDelta(jobId, { kind: "user", text });

    const outcome = run.steer ? await run.steer(text).catch(() => "revert_to_followup") : "revert_to_followup";

    if (outcome !== "complete_delivered") {
      // The turn would not take it, so wait it out and deliver as a new turn.
      this.bus.appendDelta(jobId, {
        kind: "system",
        text: "The running turn would not take that mid-flight; sending it as a follow-up.",
      });
      await runtime?.turn;
      const agent = this.runtimes.get(jobId)?.agent;
      if (agent) {
        await this.beginTurn(jobId, agent, text);
      }
    }

    return this.toSummary(this.store.get(jobId) ?? record);
  }

  async cancel(jobId: string): Promise<JobSummary> {
    const record = this.store.get(jobId);
    if (!record) throw new JobNotFoundError(jobId);

    this.questions.cancelForJob(jobId);

    const run = this.runtimes.get(jobId)?.run;
    if (run?.supports("cancel")) {
      try {
        await run.cancel();
      } catch (error) {
        log.warn(`Cancel failed for job ${jobId}`, error);
      }
    }

    if (!isTerminal(this.store.get(jobId)?.status ?? "cancelled")) {
      this.setStatus(jobId, "cancelled");
    }
    return this.toSummary(this.store.get(jobId) ?? record);
  }

  answerQuestion(questionId: string, answer: string): boolean {
    return this.questions.answer(questionId, answer);
  }

  async shutdown(): Promise<void> {
    for (const [jobId, runtime] of this.runtimes) {
      this.questions.cancelForJob(jobId);
      runtime.stopStatusListener?.();
      try {
        runtime.agent?.close();
      } catch {
        // Shutting down anyway.
      }
    }
    this.runtimes.clear();
  }

  private async beginTurn(jobId: string, agent: SDKAgent, prompt: string): Promise<void> {
    const run = await agent.send(`${prompt}\n${REMOTE_DIRECTIVE}`);

    const runtime = this.runtimes.get(jobId) ?? {};
    runtime.agent = agent;
    runtime.run = run;
    runtime.stopStatusListener?.();
    runtime.stopStatusListener = run.onDidChangeStatus((status) =>
      this.onRunStatus(jobId, status),
    );
    this.runtimes.set(jobId, runtime);

    log.info(`Job ${jobId} turn started (run ${run.id}, agent ${agent.agentId})`);
    this.setStatus(jobId, "running");

    runtime.turn = this.driveTurn(jobId, run);
  }

  /** Streams the turn for the transcript, then records how it ended. */
  private async driveTurn(jobId: string, run: Run): Promise<void> {
    try {
      for await (const message of run.stream()) {
        this.onStreamMessage(jobId, message);
      }
    } catch (error) {
      log.warn(`Stream for job ${jobId} ended early`, error);
    }

    try {
      const result = await run.wait();
      const runtime = this.runtimes.get(jobId);
      if (runtime) runtime.run = undefined;

      if (result.status === "finished") {
        this.publish(
          this.store.patch(jobId, {
            status: "finished",
            result: result.result,
            error: undefined,
          }),
        );
      } else if (result.status === "cancelled") {
        this.publish(this.store.patch(jobId, { status: "cancelled" }));
      } else {
        this.publish(
          this.store.patch(jobId, {
            status: "error",
            error: result.error?.message ?? "The run failed without a message.",
          }),
        );
      }
      log.info(`Job ${jobId} turn ended: ${result.status}`);
    } catch (error) {
      this.failJob(jobId, describeError(error));
    } finally {
      this.questions.cancelForJob(jobId);
    }
  }

  private onRunStatus(jobId: string, status: RunStatus): void {
    if (status !== "running") return;
    // Terminal statuses are applied from run.wait(), which carries the result.
    const pending = this.questions.pendingForJob(jobId);
    this.setStatus(jobId, pending ? "awaiting_answer" : "running");
  }

  private onStreamMessage(jobId: string, message: SDKMessage): void {
    switch (message.type) {
      case "assistant":
        for (const block of message.message.content) {
          if (block.type === "text" && block.text.length > 0) {
            this.bus.appendDelta(jobId, { kind: "assistant", text: block.text });
          }
        }
        break;

      case "thinking":
        if (message.text.length > 0) {
          this.bus.appendDelta(jobId, { kind: "thinking", text: message.text });
        }
        break;

      case "tool_call":
        this.bus.appendDelta(jobId, {
          kind: "tool_call",
          callId: message.call_id,
          name: message.name,
          status: message.status,
          detail: summarizeToolArgs(message.args),
        });
        break;

      case "task":
        if (message.text) {
          this.bus.appendDelta(jobId, { kind: "system", text: message.text });
        }
        break;

      // "user" echoes the prompt we already recorded, with the directive
      // appended; showing it again would just be noise. The rest carry no
      // transcript content.
      default:
        break;
    }
  }

  private failJob(jobId: string, message: string): void {
    log.error(`Job ${jobId} failed: ${message}`);
    this.questions.cancelForJob(jobId);
    const runtime = this.runtimes.get(jobId);
    if (runtime) runtime.run = undefined;
    this.publish(this.store.patch(jobId, { status: "error", error: message }));
  }
}
