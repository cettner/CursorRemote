type Level = "info" | "warn" | "error";

function emit(level: Level, message: string, detail?: unknown): void {
  const stamp = new Date().toISOString().slice(11, 19);
  const line = `${stamp} ${level.padEnd(5)} ${message}`;
  const sink = level === "error" ? console.error : console.log;
  if (detail === undefined) {
    sink(line);
  } else {
    sink(line, detail);
  }
}

export const log = {
  info: (message: string, detail?: unknown) => emit("info", message, detail),
  warn: (message: string, detail?: unknown) => emit("warn", message, detail),
  error: (message: string, detail?: unknown) => emit("error", message, detail),
};

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return JSON.stringify(error);
}
