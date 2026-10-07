import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";

const CLI_CANDIDATES = [
  "tailscale",
  "C:\\Program Files\\Tailscale\\tailscale.exe",
  "/usr/bin/tailscale",
  "/usr/local/bin/tailscale",
  "/opt/homebrew/bin/tailscale",
  "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
];

/**
 * Tailscale hands out addresses from the 100.64.0.0/10 carrier-grade NAT
 * range, which is how we recognize a tailnet address without the CLI.
 */
function isTailnetAddress(address: string): boolean {
  const parts = address.split(".");
  if (parts.length !== 4) return false;
  const first = Number(parts[0]);
  const second = Number(parts[1]);
  return first === 100 && second >= 64 && second <= 127;
}

function fromCli(): string | undefined {
  for (const candidate of CLI_CANDIDATES) {
    if (candidate.includes("\\") || candidate.startsWith("/")) {
      if (!existsSync(candidate)) continue;
    }
    try {
      const output = execFileSync(candidate, ["ip", "-4"], {
        encoding: "utf8",
        timeout: 5000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      const address = output.trim().split(/\r?\n/)[0]?.trim();
      if (address && isTailnetAddress(address)) return address;
    } catch {
      // Not installed on this path, or not logged in. Try the next one.
    }
  }
  return undefined;
}

function fromInterfaces(): string | undefined {
  for (const addresses of Object.values(networkInterfaces())) {
    for (const entry of addresses ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isTailnetAddress(entry.address)) {
        return entry.address;
      }
    }
  }
  return undefined;
}

/** The machine's tailnet address, or undefined when Tailscale is not up. */
export function findTailnetAddress(): string | undefined {
  return fromCli() ?? fromInterfaces();
}
