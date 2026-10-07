import { randomUUID } from "node:crypto";
import type { SDKCustomTool, SDKJsonValue } from "@cursor/sdk";
import {
  ASK_USER_TOOL_NAME,
  type Question,
  type QuestionResolution,
} from "@cursorremote/protocol";
import { log } from "./logger.js";

export interface AnsweredQuestion {
  answer: string;
  resolution: QuestionResolution;
}

interface Entry {
  question: Question;
  settle: (outcome: AnsweredQuestion) => void;
  timer: NodeJS.Timeout;
}

export interface QuestionRegistryHooks {
  onAsked(question: Question): void;
  onResolved(question: Question, outcome: AnsweredQuestion): void;
}

/**
 * Holds the promises that `ask_user` is blocked on. A question lives here from
 * the moment the agent asks until you answer, the job is cancelled, or the
 * timeout fires. Without the timeout an unanswered question would wedge the run
 * forever, so every entry gets one.
 */
export class QuestionRegistry {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly timeoutMs: number,
    private readonly hooks: QuestionRegistryHooks,
  ) {}

  ask(input: {
    jobId: string;
    question: string;
    context?: string;
    options?: string[];
  }): Promise<AnsweredQuestion> {
    const askedAt = Date.now();
    const question: Question = {
      questionId: randomUUID(),
      jobId: input.jobId,
      question: input.question,
      context: input.context,
      options: input.options,
      askedAt,
      expiresAt: askedAt + this.timeoutMs,
    };

    return new Promise<AnsweredQuestion>((resolve) => {
      const settle = (outcome: AnsweredQuestion) => {
        const entry = this.entries.get(question.questionId);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.entries.delete(question.questionId);
        this.hooks.onResolved(question, outcome);
        resolve(outcome);
      };

      const timer = setTimeout(() => {
        log.warn(`Question ${question.questionId} timed out; letting the run continue`);
        settle({
          answer:
            "No answer came back in time. Proceed with your best judgment, " +
            "state the assumption you made, and keep going.",
          resolution: "timeout",
        });
      }, this.timeoutMs);
      // A pending question must not be the reason the process stays alive.
      timer.unref?.();

      this.entries.set(question.questionId, { question, settle, timer });
      this.hooks.onAsked(question);
    });
  }

  /** Returns false when the question is unknown or already resolved. */
  answer(questionId: string, answer: string): boolean {
    const entry = this.entries.get(questionId);
    if (!entry) return false;
    entry.settle({ answer, resolution: "answered" });
    return true;
  }

  /** Unblocks any question belonging to a job that is going away. */
  cancelForJob(jobId: string): void {
    for (const entry of [...this.entries.values()]) {
      if (entry.question.jobId !== jobId) continue;
      entry.settle({
        answer: "The job was cancelled while this question was outstanding. Stop now.",
        resolution: "cancelled",
      });
    }
  }

  pendingForJob(jobId: string): Question | null {
    for (const entry of this.entries.values()) {
      if (entry.question.jobId === jobId) return entry.question;
    }
    return null;
  }
}

function asString(value: SDKJsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function asStringArray(value: SDKJsonValue | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((entry): entry is string => typeof entry === "string");
  return items.length > 0 ? items : undefined;
}

/**
 * The tool the agent reaches for when it needs a human. Returning a promise
 * from `execute` is what actually suspends the run: the SDK awaits it, so the
 * agent sits still until the registry settles.
 */
export function createAskUserTool(jobId: string, registry: QuestionRegistry): SDKCustomTool {
  return {
    description:
      "Ask the operator a question and wait for their reply. The operator is not at " +
      "this computer, so this is the only way to reach them. Use it whenever you hit a " +
      "decision you should not make alone: ambiguous requirements, a destructive or " +
      "irreversible action, missing credentials, or a choice between approaches that " +
      "would be expensive to undo. Prefer asking over guessing. This tool blocks until " +
      "they answer, which may take a while, so ask one well-formed question with " +
      "everything they need to decide.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "The question, written so it can be answered on a phone screen.",
        },
        context: {
          type: "string",
          description:
            "What you found that led to the question, and what you will do with each answer.",
        },
        options: {
          type: "array",
          items: { type: "string" },
          description:
            "Concrete choices, if the question has them. Rendered as one-tap buttons.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    annotations: {
      title: "Ask the operator",
      readOnlyHint: true,
      openWorldHint: true,
    },
    async execute(args) {
      const question = asString(args.question);
      if (!question) {
        return {
          content: [{ type: "text", text: "ask_user needs a non-empty 'question' argument." }],
          isError: true,
        };
      }

      const outcome = await registry.ask({
        jobId,
        question,
        context: asString(args.context),
        options: asStringArray(args.options),
      });

      return outcome.answer;
    },
  };
}

export { ASK_USER_TOOL_NAME };
