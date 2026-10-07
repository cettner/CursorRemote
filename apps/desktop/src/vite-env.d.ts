/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Dev-only: pre-fills the daemon address so reloads do not need retyping. */
  readonly VITE_DAEMON_URL?: string;
  readonly VITE_DAEMON_TOKEN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
