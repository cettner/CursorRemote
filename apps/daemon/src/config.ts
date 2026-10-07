import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

export const CONFIG_DIR = resolve(homedir(), ".cursorremote");
export const CONFIG_PATH = resolve(CONFIG_DIR, "config.json");
export const JOBS_PATH = resolve(CONFIG_DIR, "jobs.json");

const settingSourceSchema = z.enum(["project", "user", "team", "mdm", "plugins", "all"]);

const projectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  cwd: z.string().min(1),
});

const configSchema = z.object({
  /** Shown in the client so you can tell two machines apart. */
  hostName: z.string().min(1).default(hostname()),
  port: z.number().int().min(1).max(65535).default(4517),
  /**
   * "tailscale" resolves the machine's tailnet address at startup, which keeps
   * the daemon off every other interface. "localhost" is for local testing.
   * Anything else is used verbatim as a bind address.
   */
  bind: z.string().min(1).default("tailscale"),
  token: z.string().min(16),
  defaultModel: z.string().min(1).default("composer-2.5"),
  /** How long ask_user waits before giving up and letting the run continue. */
  questionTimeoutMs: z
    .number()
    .int()
    .min(10_000)
    .default(30 * 60 * 1000),
  /** Routes local tool calls through Cursor's Auto-review classifier. */
  autoReview: z.boolean().default(false),
  settingSources: z.array(settingSourceSchema).default(["project", "user"]),
  /** Transcript events retained per job before the oldest are dropped. */
  transcriptBufferSize: z.number().int().min(50).default(2000),
  projects: z.array(projectSchema).default([]),
});

export type DaemonConfig = z.infer<typeof configSchema>;

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

function writeConfig(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/**
 * Reads the config, creating a starter one on first run. New configs get a
 * fresh token and the current directory as a sample project so the daemon can
 * start without hand-editing anything.
 */
export function loadConfig(): { config: DaemonConfig; created: boolean } {
  let created = false;

  if (!existsSync(CONFIG_PATH)) {
    writeConfig(CONFIG_PATH, {
      hostName: hostname(),
      port: 4517,
      bind: "tailscale",
      token: generateToken(),
      defaultModel: "composer-2.5",
      questionTimeoutMs: 30 * 60 * 1000,
      autoReview: false,
      settingSources: ["project", "user"],
      transcriptBufferSize: 2000,
      projects: [
        {
          id: "sample",
          name: "Rename me",
          cwd: process.cwd(),
        },
      ],
    });
    created = true;
  }

  // Windows editors and PowerShell's -Encoding utf8 both prepend a BOM, which
  // JSON.parse rejects with a famously unhelpful message.
  const text = readFileSync(CONFIG_PATH, "utf8").replace(/^\uFEFF/, "");

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${CONFIG_PATH} is not valid JSON: ${detail}`);
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `  ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new Error(`${CONFIG_PATH} is not valid:\n${detail}`);
  }

  const config = parsed.data;

  const seen = new Set<string>();
  for (const project of config.projects) {
    if (seen.has(project.id)) {
      throw new Error(`${CONFIG_PATH} has two projects with id "${project.id}"`);
    }
    seen.add(project.id);
    if (!isAbsolute(project.cwd)) {
      throw new Error(`Project "${project.id}" needs an absolute cwd, got "${project.cwd}"`);
    }
    if (!existsSync(project.cwd)) {
      throw new Error(`Project "${project.id}" points at "${project.cwd}", which does not exist`);
    }
  }

  return { config, created };
}
