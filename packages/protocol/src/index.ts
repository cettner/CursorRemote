import { z } from "zod";

/**
 * Bumped whenever a message shape changes incompatibly. The daemon sends it in
 * `hello`; clients refuse to connect to a daemon they do not understand.
 */
export const PROTOCOL_VERSION = 1;

export const jobStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_answer",
  "finished",
  "error",
  "cancelled",
]);
export type JobStatus = z.infer<typeof jobStatusSchema>;

/** Statuses a job will never leave. */
export const TERMINAL_STATUSES: readonly JobStatus[] = ["finished", "error", "cancelled"];

export function isTerminal(status: JobStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

export const projectInfoSchema = z.object({
  id: z.string(),
  name: z.string(),
  cwd: z.string(),
});
export type ProjectInfo = z.infer<typeof projectInfoSchema>;

export const questionSchema = z.object({
  questionId: z.string(),
  jobId: z.string(),
  question: z.string(),
  /** Why the agent is asking, so you can answer without opening the transcript. */
  context: z.string().optional(),
  /** Suggested answers the agent offered, rendered as one-tap buttons. */
  options: z.array(z.string()).optional(),
  askedAt: z.number(),
  /** Wall-clock ms when the daemon will give up and let the run continue. */
  expiresAt: z.number(),
});
export type Question = z.infer<typeof questionSchema>;

export const questionResolutionSchema = z.enum(["answered", "timeout", "cancelled"]);
export type QuestionResolution = z.infer<typeof questionResolutionSchema>;

/** One streamed increment of a job's transcript. */
export const jobDeltaSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("assistant"), text: z.string() }),
  z.object({ kind: z.literal("thinking"), text: z.string() }),
  z.object({
    kind: z.literal("tool_call"),
    /** Stable across the running and completed events for one call, so the UI
     * updates a row in place instead of appending a second one. */
    callId: z.string(),
    name: z.string(),
    status: z.string(),
    detail: z.string().optional(),
  }),
  z.object({ kind: z.literal("user"), text: z.string() }),
  z.object({ kind: z.literal("system"), text: z.string() }),
]);
export type JobDelta = z.infer<typeof jobDeltaSchema>;

export const transcriptEventSchema = z.object({
  seq: z.number(),
  at: z.number(),
  delta: jobDeltaSchema,
});
export type TranscriptEvent = z.infer<typeof transcriptEventSchema>;

export const jobSummarySchema = z.object({
  jobId: z.string(),
  /** Null until the SDK hands back an agent, which happens just after create. */
  agentId: z.string().nullable(),
  projectId: z.string(),
  projectName: z.string(),
  /** The most recent prompt sent to this job. */
  prompt: z.string(),
  status: jobStatusSchema,
  model: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  result: z.string().optional(),
  error: z.string().optional(),
  pendingQuestion: questionSchema.nullable(),
});
export type JobSummary = z.infer<typeof jobSummarySchema>;

export const serverMessageSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: z.number(),
    hostId: z.string(),
    hostName: z.string(),
    projects: z.array(projectInfoSchema),
    defaultModel: z.string(),
    jobs: z.array(jobSummarySchema),
  }),
  z.object({ type: z.literal("job.created"), job: jobSummarySchema }),
  z.object({ type: z.literal("job.updated"), job: jobSummarySchema }),
  z.object({
    type: z.literal("job.delta"),
    jobId: z.string(),
    seq: z.number(),
    at: z.number(),
    delta: jobDeltaSchema,
  }),
  z.object({ type: z.literal("job.question"), question: questionSchema }),
  z.object({
    type: z.literal("job.question.resolved"),
    jobId: z.string(),
    questionId: z.string(),
    resolution: questionResolutionSchema,
    answer: z.string(),
  }),
  z.object({
    type: z.literal("job.transcript"),
    jobId: z.string(),
    events: z.array(transcriptEventSchema),
    /** True when the ring buffer already dropped older events. */
    truncated: z.boolean(),
  }),
  z.object({
    type: z.literal("ack"),
    requestId: z.string(),
    ok: z.boolean(),
    detail: z.string().optional(),
  }),
  z.object({ type: z.literal("error"), message: z.string(), requestId: z.string().optional() }),
]);
export type ServerMessage = z.infer<typeof serverMessageSchema>;

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("jobs.list"), requestId: z.string() }),
  z.object({
    type: z.literal("job.start"),
    requestId: z.string(),
    projectId: z.string(),
    prompt: z.string().min(1),
    model: z.string().optional(),
  }),
  /** A new turn on an existing job, so the agent keeps its conversation. */
  z.object({
    type: z.literal("job.followup"),
    requestId: z.string(),
    jobId: z.string(),
    prompt: z.string().min(1),
  }),
  z.object({
    type: z.literal("job.answer"),
    requestId: z.string(),
    questionId: z.string(),
    answer: z.string(),
  }),
  z.object({
    type: z.literal("job.steer"),
    requestId: z.string(),
    jobId: z.string(),
    text: z.string().min(1),
  }),
  z.object({ type: z.literal("job.cancel"), requestId: z.string(), jobId: z.string() }),
  z.object({ type: z.literal("job.transcript"), requestId: z.string(), jobId: z.string() }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export function parseClientMessage(raw: unknown): ClientMessage {
  return clientMessageSchema.parse(raw);
}

export function parseServerMessage(raw: unknown): ServerMessage {
  return serverMessageSchema.parse(raw);
}

/**
 * The tool the agent calls to reach you. Named and described here so the daemon
 * registers it and the client renders it under the same contract.
 */
export const ASK_USER_TOOL_NAME = "ask_user";
