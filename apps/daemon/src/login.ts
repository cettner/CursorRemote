import { Cursor } from "@cursor/sdk";
import { describeError, log } from "./logger.js";

/**
 * Signs this machine in and persists a minted key to ~/.cursor/sdk/auth.json,
 * which every SDK call falls back to. Avoids having to mint and paste a key by
 * hand, and avoids a long-lived secret in the environment.
 */
async function main(): Promise<void> {
  const existing = await Cursor.auth.status();
  if (existing.status === "logged-in") {
    const expires = existing.apiKeyExpiresAtMs
      ? new Date(existing.apiKeyExpiresAtMs).toLocaleDateString()
      : "unknown";
    log.info(`Already signed in as ${existing.email ?? "this account"} (key expires ${expires}).`);
    log.info("Run `npm run logout --workspace @cursorremote/daemon` to sign out first.");
    return;
  }

  log.info("Opening your browser to sign in to Cursor...");
  const result = await Cursor.auth.login({
    apiKeyName: "cursor-remote-daemon",
    onLoginUrl: (url) => log.info(`If the browser did not open, go to: ${url}`),
  });

  log.info(`Signed in as ${result.email ?? "your account"}.`);
  log.info(`Key expires ${new Date(result.apiKeyExpiresAtMs).toLocaleDateString()}.`);
  log.info("You can start the daemon now.");
}

main().catch((error) => {
  log.error(`Login failed: ${describeError(error)}`);
  process.exit(1);
});
