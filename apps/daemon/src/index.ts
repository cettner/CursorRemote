import { Cursor } from "@cursor/sdk";
import { AgentRegistry } from "./agent-registry.js";
import { CONFIG_PATH, JOBS_PATH, loadConfig } from "./config.js";
import { EventBus } from "./events.js";
import { JobStore } from "./job-store.js";
import { describeError, log } from "./logger.js";
import { createServer } from "./server.js";
import { findTailnetAddress } from "./tailnet.js";

function resolveBindAddress(bind: string): string {
  if (bind !== "tailscale") return bind;

  const tailnet = findTailnetAddress();
  if (tailnet) {
    log.info(`Found this machine on the tailnet at ${tailnet}`);
    return tailnet;
  }

  log.warn(
    "No tailnet address found, so falling back to 127.0.0.1. Start Tailscale and " +
      'restart, or set "bind" in the config to listen somewhere else.',
  );
  return "127.0.0.1";
}

async function main(): Promise<void> {
  const { config, created } = loadConfig();
  if (created) {
    log.info(`Wrote a starter config to ${CONFIG_PATH}`);
    log.info("Edit the projects list in it, then start the daemon again.");
  }

  // An explicit key wins; otherwise fall back to a stored `npm run login`,
  // which the SDK reads on its own when apiKey is left undefined.
  const apiKey = process.env.CURSOR_API_KEY?.trim() || undefined;
  if (!apiKey) {
    const auth = await Cursor.auth.status();
    if (auth.status !== "logged-in") {
      log.error(
        "Not signed in. Run `npm run login --workspace @cursorremote/daemon`, " +
          "or set CURSOR_API_KEY with a key from https://cursor.com/dashboard/integrations.",
      );
      process.exitCode = 1;
      return;
    }
    log.info(`Using the stored login for ${auth.email ?? "this account"}`);
  }

  if (config.projects.length === 0) {
    log.error(`No projects configured. Add at least one to ${CONFIG_PATH}.`);
    process.exitCode = 1;
    return;
  }

  const bus = new EventBus(config.transcriptBufferSize);
  const store = new JobStore(JOBS_PATH);
  const registry = new AgentRegistry(config, apiKey, bus, store);
  await registry.recoverFromRestart();

  const server = createServer(config, registry, bus);
  const address = resolveBindAddress(config.bind);

  try {
    await server.listen(address);
  } catch (error) {
    log.error(`Could not listen on ${address}:${config.port}: ${describeError(error)}`);
    process.exitCode = 1;
    return;
  }

  const url = `ws://${address}:${config.port}/ws`;
  log.info("");
  log.info(`  ${config.hostName} is ready.`);
  log.info(`  URL:   ${url}`);
  log.info(`  Token: ${config.token}`);
  log.info(`  Projects: ${config.projects.map((project) => project.id).join(", ")}`);
  log.info("");

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`Got ${signal}; shutting down`);
    await server.close().catch(() => undefined);
    await registry.shutdown();
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error) => {
  log.error(`Daemon failed to start: ${describeError(error)}`);
  process.exit(1);
});
