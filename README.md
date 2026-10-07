# Cursor Remote Agent Monitor

Monitor and direct Cursor agents running on another computer.

A daemon on the work machine owns agents through [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript).
A desktop app on your laptop watches them over a Tailscale tailnet, notifies you when a job
finishes or the agent has a question, and sends answers and new jobs back.

![status](https://img.shields.io/badge/status-working-brightgreen)

## How it works

```
work machine                          laptop
┌─────────────────────────┐           ┌──────────────────┐
│ daemon                  │           │ Tauri app        │
│  ├─ @cursor/sdk agents  │◄─ ws ────►│  ├─ job list     │
│  ├─ ask_user tool       │  tailnet  │  ├─ transcript   │
│  └─ job store (disk)    │           │  └─ tray + toast │
└─────────────────────────┘           └──────────────────┘
```

The daemon is the only thing that talks to Cursor. Clients render a stream and send commands.

Three SDK calls carry the whole feature:

- `agent.send(prompt)` returns a run whose `stream()` feeds the transcript and whose
  `onDidChangeStatus()` drives the status badge.
- `run.steer(text)` injects a message into a turn that is **already executing**, so you can
  redirect an agent mid-flight instead of waiting for it to finish.
- `local.customTools` registers an `ask_user` tool whose handler returns a promise the daemon
  holds open. That promise is what actually suspends the agent until you answer. Headless SDK
  runs have no human-in-the-loop otherwise, so this is built on purpose rather than inherited.

`Agent.resume(agentId)` plus the on-disk store means the daemon can restart without losing
conversations.

## Layout

| Path                | What it is                                                     |
| ------------------- | -------------------------------------------------------------- |
| `packages/protocol` | Zod schemas and types for every WebSocket message              |
| `apps/daemon`       | Node service that owns the agents and serves the WebSocket API |
| `apps/desktop`      | Tauri v2 app wrapping a Vite + React UI                        |

## Requirements

- Node.js 22.13 or later
- Rust (stable, MSVC on Windows) — only to build the desktop app
- Tailscale installed and signed in to the **same account on both machines** — this is what
  lets the laptop reach the work machine without opening a port or running a server
- A Cursor account on a paid plan

## Setup

```bash
git clone https://github.com/cettner/CursorRemote.git
cd CursorRemote
npm install
npm run build
```

### 1. Work machine (runs the agents)

Sign in once. This mints a 90-day key into `~/.cursor/sdk/auth.json`; no key to copy or paste:

```bash
npm run login --workspace @cursorremote/daemon
```

Start the daemon. The first run writes `~/.cursorremote/config.json` with a generated token:

```bash
npm run daemon
```

Edit the `projects` list in that config to point at the repos you want agents to work in, then
start it again. It prints the address and token to hand to the laptop:

```
  STONEHINGE is ready.
  URL:   ws://100.x.y.z:4517/ws
  Token: ...
```

To keep it running without a terminal open, register it as a scheduled task. It starts at
logon, restarts if it falls over, and runs with no console window:

```powershell
powershell -ExecutionPolicy Bypass -File apps\daemon\scripts\install-service.ps1 -KeepAwake
Start-ScheduledTask -TaskName CursorRemoteDaemon
```

`-KeepAwake` also stops the machine sleeping while plugged in, since tool calls run on it.
Pass `-Remove` to unregister.

A scheduled task rather than a Windows service on purpose: the agents need your user session,
your PATH, your git credentials, and your Cursor login, none of which a LocalSystem service has.

Since there is no console, output goes to `~/.cursorremote/logs/daemon.log`. That is also where
to read the URL and token:

```powershell
Get-Content "$env:USERPROFILE\.cursorremote\logs\daemon.log" -Tail 10
```

### 2. Laptop (watches them)

```bash
npm run desktop          # dev
npm run desktop:build    # installer in apps/desktop/src-tauri/target/release/bundle
```

Paste the URL and token on first launch. Closing the window hides it to the tray so
notifications keep arriving; quit from the tray menu.

You get a toast when a job finishes, when it errors, and when the agent asks a question.
Questions use a distinct sound, since those are the ones holding a run open.

## Config reference

`~/.cursorremote/config.json` on the work machine:

| Key                   | Default              | Notes                                                              |
| --------------------- | -------------------- | ------------------------------------------------------------------ |
| `bind`                | `"tailscale"`        | Resolves the tailnet address. Use `"localhost"` for local testing.  |
| `port`                | `4517`               |                                                                     |
| `token`               | generated            | Shared secret; the second layer behind the tailnet.                 |
| `defaultModel`        | `"composer-2.5"`     |                                                                     |
| `questionTimeoutMs`   | `1800000`            | How long `ask_user` waits before letting the run continue.          |
| `autoReview`          | `false`              | Routes tool calls through Cursor's Auto-review classifier.          |
| `settingSources`      | `["project","user"]` | The SDK default is `[]`, which ignores your rules and skills.       |
| `transcriptBufferSize`| `2000`               | Events retained per job for replay.                                 |
| `projects`            | `[]`                 | `{ id, name, cwd }`; `cwd` must be absolute and exist.              |

## Development

```bash
npm run build                                     # protocol + daemon
npm run typecheck                                 # every workspace
node apps/daemon/scripts/verify.mjs --project X   # end-to-end check
node apps/daemon/scripts/probe.mjs                # terminal client
```

`verify.mjs` drives a live daemon through the cases that are easy to get subtly wrong: that a
question really suspends the run, that answering resumes it, that a follow-up keeps the
conversation, and that cancel stops a live run. Run it against a throwaway project — it asks an
agent to create and delete files.

`probe.mjs` is an interactive terminal client. Reach for it first when the desktop app
misbehaves, to find out which side is at fault.

## Secrets

Nothing secret belongs in this repo. The Cursor credential lives in `~/.cursor/sdk/auth.json`
(or `CURSOR_API_KEY`), and the shared daemon token lives in `~/.cursorremote/config.json`. Only
`config.example.json` is committed.

## Known limits

- The work machine has to stay awake and online; tool calls run on it.
- Headless local agents auto-approve every tool call. Set `autoReview: true` for a safety net.
- The agent only asks when it decides to. The daemon appends a directive to every prompt telling
  it to prefer `ask_user` over guessing, but that is guidance, not a guarantee.
- iOS is not built yet. It needs a relay the daemon dials out to (push notifications cannot
  reach a tailnet address while the app is closed) plus an Apple Developer account.
