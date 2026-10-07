import { useState } from "react";
import type { ConnectionStatus } from "../lib/connection";

interface Props {
  status: ConnectionStatus;
  error?: string;
  initialUrl: string;
  initialToken: string;
  onConnect(url: string, token: string): void;
}

export function ConnectScreen({ status, error, initialUrl, initialToken, onConnect }: Props) {
  const [url, setUrl] = useState(initialUrl);
  const [token, setToken] = useState(initialToken);

  const busy = status === "connecting";

  return (
    <div className="connect">
      <form
        className="connect-card"
        onSubmit={(event) => {
          event.preventDefault();
          if (url.trim() && token.trim()) onConnect(url.trim(), token.trim());
        }}
      >
        <h1>Cursor Remote</h1>
        <p className="muted">
          The daemon prints both of these when it starts on the other computer.
        </p>

        <label>
          Daemon address
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="100.x.y.z:4517"
            autoFocus
            spellCheck={false}
          />
        </label>

        <label>
          Token
          <input
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="paste the token"
            type="password"
            spellCheck={false}
          />
        </label>

        {error ? <p className="error">{error}</p> : null}

        <button type="submit" disabled={busy || !url.trim() || !token.trim()}>
          {busy ? "Connecting..." : "Connect"}
        </button>
      </form>
    </div>
  );
}
