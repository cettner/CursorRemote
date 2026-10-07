# Cursor Remote Agent Monitor

Monitor and direct Cursor agents running on another computer.

A daemon on the work machine owns agents through [`@cursor/sdk`](https://cursor.com/docs/sdk/typescript).
A desktop app on your laptop watches them over a Tailscale tailnet, gets notified when a
job finishes or the agent has a question, and sends replies and new jobs back.

## Layout

| Path                | What it is                                                          |
| ------------------- | ------------------------------------------------------------------- |
| `packages/protocol` | Shared Zod schemas and types for every WebSocket message             |
| `apps/daemon`       | Node service that owns the agents and serves the WebSocket API       |
| `apps/desktop`      | Tauri v2 app wrapping a Vite + React UI                              |

## Requirements

- Node.js 22.13 or later
- Rust (stable, MSVC on Windows) for the desktop app
- Tailscale on both machines
- A Cursor API key from [cursor.com/dashboard/integrations](https://cursor.com/dashboard/integrations)

## Setup

```bash
npm install
npm run build
```

### Work machine (runs the agents)

Set your API key, then create `~/.cursorremote/config.json` from `config.example.json`:

```bash
# PowerShell
setx CURSOR_API_KEY "cursor_..."
npm run daemon
```

The daemon prints the tailnet URL and the token to paste into the desktop app.

### Laptop (watches them)

```bash
npm run desktop
```

Enter the daemon's URL and token on first launch.

## Secrets

Nothing secret belongs in this repo. The Cursor API key lives in the `CURSOR_API_KEY`
environment variable on the work machine, and the shared daemon token lives in
`~/.cursorremote/config.json`. Only `config.example.json` is committed.
