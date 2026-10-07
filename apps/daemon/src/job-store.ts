import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { JobStatus } from "@cursorremote/protocol";
import { z } from "zod";
import { log } from "./logger.js";

const recordSchema = z.object({
  jobId: z.string(),
  agentId: z.string().nullable(),
  projectId: z.string(),
  projectName: z.string(),
  prompt: z.string(),
  status: z.enum(["queued", "running", "awaiting_answer", "finished", "error", "cancelled"]),
  model: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  result: z.string().optional(),
  error: z.string().optional(),
});

export type JobRecord = z.infer<typeof recordSchema>;

const fileSchema = z.object({
  version: z.literal(1),
  jobs: z.array(recordSchema),
});

/** How many finished jobs to keep around before pruning the oldest. */
const MAX_RETAINED = 200;

/**
 * The jobId-to-agentId mapping, persisted so a restarted daemon can still
 * `Agent.resume` a conversation instead of starting over.
 */
export class JobStore {
  private records = new Map<string, JobRecord>();

  constructor(private readonly path: string) {}

  load(): JobRecord[] {
    if (!existsSync(this.path)) return [];

    try {
      const parsed = fileSchema.safeParse(JSON.parse(readFileSync(this.path, "utf8")));
      if (!parsed.success) {
        log.warn(`${this.path} did not parse; starting with an empty job list`);
        return [];
      }
      for (const record of parsed.data.jobs) {
        this.records.set(record.jobId, record);
      }
      return parsed.data.jobs;
    } catch (error) {
      log.warn(`Could not read ${this.path}; starting with an empty job list`, error);
      return [];
    }
  }

  get(jobId: string): JobRecord | undefined {
    return this.records.get(jobId);
  }

  all(): JobRecord[] {
    return [...this.records.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  put(record: JobRecord): void {
    this.records.set(record.jobId, record);
    this.prune();
    this.flush();
  }

  patch(jobId: string, changes: Partial<Omit<JobRecord, "jobId">>): JobRecord | undefined {
    const existing = this.records.get(jobId);
    if (!existing) return undefined;
    const updated: JobRecord = { ...existing, ...changes, updatedAt: Date.now() };
    this.records.set(jobId, updated);
    this.flush();
    return updated;
  }

  setStatus(jobId: string, status: JobStatus): JobRecord | undefined {
    return this.patch(jobId, { status });
  }

  private prune(): void {
    if (this.records.size <= MAX_RETAINED) return;
    const ordered = this.all();
    for (const record of ordered.slice(MAX_RETAINED)) {
      this.records.delete(record.jobId);
    }
  }

  /** Writes to a sibling file first so a crash mid-write cannot truncate the real one. */
  private flush(): void {
    const payload = { version: 1 as const, jobs: this.all() };
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const temp = `${this.path}.tmp`;
      writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      renameSync(temp, this.path);
    } catch (error) {
      log.error(`Could not persist jobs to ${this.path}`, error);
    }
  }
}
